/**
 * lib/truckApi.js
 * 環保局車輛即時 API 資料抓取與 DB 非同步重試狀態管理
 *
 * 容錯與重試規格：
 *   - 外部 API 抓取失敗時，更新 Supabase daily_status 的連續失敗計數 (api_fail_count)。
 *   - 每日 Cron 觸發一次；失敗會記錄至 Supabase，供下一次排程診斷。
 *   - 連續失敗達到 3 次時：
 *       1. 發送 LINE 故障告警至所有已註冊群組。
 *       2. 設定 is_paused = true 暫停當日檢核，避免重試風暴與重複告警。
 *   - 成功抓取時，若先前有失敗計數則歸零。
 */

import { supabase } from './supabaseClient.js';
import { adaptTruckData } from './truckAdapter.js';
import { broadcastLineAlert } from './lineClient.js';
import { normalizeCity } from './geoUtils.js';

// 高雄市環保局即時動態 API
export const KCG_TRUCK_API_URL =
  'https://api.kcg.gov.tw/api/service/Get/aaf4ce4b-4ca8-43de-bfaf-6dc97e89cac0';

// 新北市環保局即時動態 API (涵蓋汐止區等全區)
export const NTPC_TRUCK_API_URL =
  'https://data.ntpc.gov.tw/api/datasets/28ab4122-60e1-4065-98e5-abccb69aaca6/json?page=0&size=5000';

// 桃園市環保局即時動態 API（支援環境變數自訂）
export const TAOYUAN_TRUCK_API_URL =
  process.env.TAOYUAN_TRUCK_API_URL ||
  'https://route.tyoem.gov.tw/web/dataManagerAgentWeb.jsp';

// 臺南市環保局即時動態 API（支援代理伺服器轉發或環境變數自訂覆寫，預設接便民查詢網天眼 WebService）
export const TAINAN_TRUCK_API_URL =
  process.env.TAINAN_PROXY_URL ||
  process.env.TAINAN_TRUCK_API_URL ||
  'https://clean.tnepb.gov.tw/WebService/WsSkyeyes.asmx/NewgetCarsinfo';

export const MONITORED_CITIES = ['高雄市', '新北市', '桃園市', '台南市'];

export const CITY_API_URL_MAP = {
  '高雄市': KCG_TRUCK_API_URL,
  '新北市': NTPC_TRUCK_API_URL,
  '桃園市': TAOYUAN_TRUCK_API_URL,
  '台南市': TAINAN_TRUCK_API_URL,
  '臺南市': TAINAN_TRUCK_API_URL,
};

export const DEFAULT_TRUCK_API_URLS = [
  KCG_TRUCK_API_URL,
  NTPC_TRUCK_API_URL,
  TAOYUAN_TRUCK_API_URL,
  TAINAN_TRUCK_API_URL,
];

/**
 * 依 API URL 反查對應之受監控縣市
 * @param {string} url
 * @returns {string | null}
 */
export function getCityFromApiUrl(url) {
  for (const city of MONITORED_CITIES) {
    if (CITY_API_URL_MAP[city] === url) return city;
  }
  return null;
}

const FETCH_TIMEOUT_MS = 12000; // 12 秒逾時（兼顧公家機關 ASMX 尖峰延遲與 cron-job.org 30 秒中斷防線）
const MAX_RETRY_COUNT = 3;
const SINGLE_FETCH_RETRIES = 1; // 單一 URL 重試 1 次（兼顧容錯與總執行時間防線）

let tySessionCache = {
  cookieHeader: '',
  randomForm: '',
  expiresAt: 0,
};

async function getTaoyuanSession(signal) {
  const now = Date.now();
  if (tySessionCache.cookieHeader && tySessionCache.randomForm && now < tySessionCache.expiresAt) {
    return tySessionCache;
  }

  const homeRes = await fetch('https://route.tyoem.gov.tw/', {
    signal,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 (compatible; TrashAlertBot/1.0; +https://github.com/jackleecc/trash-alert-tw)',
    },
  });
  const rawCookies = homeRes.headers?.get ? homeRes.headers.get('set-cookie') || '' : '';
  const cookieHeader = rawCookies.split(';')[0];
  const html = typeof homeRes.text === 'function' ? await homeRes.text() : '';
  const match = html ? html.match(/id=["']random_form["'][^>]*value=["']([^"']+)["']/) : null;
  const randomForm = match ? match[1] : '';

  tySessionCache = {
    cookieHeader,
    randomForm,
    expiresAt: now + 5 * 60 * 1000,
  };
  return tySessionCache;
}

async function fetchTaoyuanTruckData(url, signal) {
  let session = await getTaoyuanSession(signal);
  const postUrl = url || TAOYUAN_TRUCK_API_URL;

  const postHeaders = {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 (compatible; TrashAlertBot/1.0; +https://github.com/jackleecc/trash-alert-tw)',
    Cookie: session.cookieHeader,
    Referer: 'https://route.tyoem.gov.tw/',
    Origin: 'https://route.tyoem.gov.tw',
  };

  let res = await fetch(postUrl, {
    method: 'POST',
    signal,
    headers: postHeaders,
    body: new URLSearchParams({
      dcfid: 'carGpsAllQuery1',
      random_form: session.randomForm,
    }),
  });

  const text = typeof res.text === 'function' ? await res.text() : '';
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = {};
  }

  if (json && json.errCode === '0022') {
    tySessionCache = { cookieHeader: '', randomForm: '', expiresAt: 0 };
    session = await getTaoyuanSession(signal);
    postHeaders.Cookie = session.cookieHeader;
    res = await fetch(postUrl, {
      method: 'POST',
      signal,
      headers: postHeaders,
      body: new URLSearchParams({
        dcfid: 'carGpsAllQuery1',
        random_form: session.randomForm,
      }),
    });
    const retryText = typeof res.text === 'function' ? await res.text() : '';
    try {
      json = JSON.parse(retryText);
    } catch {
      json = {};
    }
  }

  const allTrucks = Array.isArray(json?.result)
    ? [...json.result]
    : Array.isArray(json?.data)
      ? [...json.data]
      : [];

  // 同步抓取已註冊之桃園路線即時班表車輛 (例如楊梅 lagi2-006_2_21)
  const targetTaoyuanRoutes = ['lagi2-006_2_21'];
  for (const rid of targetTaoyuanRoutes) {
    try {
      const rRes = await fetch(postUrl, {
        method: 'POST',
        signal,
        headers: postHeaders,
        body: new URLSearchParams({
          dcfid: 'lagifQueryRealtimeByRoute',
          routing_id: rid,
          random_form: session.randomForm,
        }),
      });
      const rText = typeof rRes.text === 'function' ? await rRes.text() : '';
      const rJson = JSON.parse(rText);
      if (Array.isArray(rJson.result)) {
        for (const t of rJson.result) {
          allTrucks.push({ ...t, route_id: rid });
        }
      }
    } catch {
      // 容錯略過單一路線失敗
    }
  }

  return allTrucks;
}

/**
 * 取得欲抓取的目標 API URL 清單（支援依目標縣市與暫停名單精準過濾）
 * @param {string} [overrideUrl]
 * @param {string[]} [targetCities]
 * @param {string[]} [pausedCities]
 * @returns {string[]}
 */
export function getTargetApiUrls(overrideUrl, targetCities, pausedCities = []) {
  if (overrideUrl) return [overrideUrl];

  const pausedSet = new Set((pausedCities || []).map((c) => normalizeCity(c)));

  // 若有指定目標縣市，優先精準回傳該縣市的 API URL 清單（防止全域環境變數覆蓋多縣市），且過濾掉暫停縣市
  if (Array.isArray(targetCities) && targetCities.length > 0) {
    const matchedUrls = [];
    for (const city of targetCities) {
      const normalized = normalizeCity(city);
      if (pausedSet.has(normalized)) continue;
      const url = CITY_API_URL_MAP[city] || CITY_API_URL_MAP[normalized];
      if (url && !matchedUrls.includes(url)) {
        matchedUrls.push(url);
      }
    }
    if (matchedUrls.length > 0) return matchedUrls;
  }

  // 次之：全域指定 TRUCK_API_URL
  if (process.env.TRUCK_API_URL) {
    const envUrls = process.env.TRUCK_API_URL.split(',')
      .map((u) => u.trim())
      .filter(Boolean);
    if (pausedSet.size > 0) {
      const filtered = envUrls.filter((url) => {
        const city = getCityFromApiUrl(url);
        return !city || !pausedSet.has(city);
      });
      if (filtered.length > 0) return filtered;
    }
    return envUrls;
  }

  // 全域預設清單：自動排除處於暫停名單中之縣市，避免在故障端點上徒耗逾時
  if (pausedSet.size > 0) {
    const activeUrls = DEFAULT_TRUCK_API_URLS.filter((url) => {
      const city = getCityFromApiUrl(url);
      return !city || !pausedSet.has(city);
    });
    if (activeUrls.length > 0) return activeUrls;
  }

  return DEFAULT_TRUCK_API_URLS;
}

/**
 * 發送 HTTP 請求抓取外部車輛 API 資料（含單次重試，支援 ASMX WebService POST 與代理伺服器轉發）
 * @param {string} url
 * @returns {Promise<any>}
 */
async function fetchRawTruckData(url) {
  let lastError;
  const isAsmx = typeof url === 'string' && url.includes('.asmx');
  const isTainanEndpoint = typeof url === 'string' && (url === TAINAN_TRUCK_API_URL || isAsmx);
  const isTaoyuanEndpoint =
    typeof url === 'string' && (url === TAOYUAN_TRUCK_API_URL || url.includes('tyoem.gov.tw'));

  for (let attempt = 0; attempt <= SINGLE_FETCH_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      if (attempt > 0) {
        console.log(`[TruckAPI] 重試第 ${attempt} 次: ${url}`);
        await new Promise((r) => setTimeout(r, 800 * attempt)); // 指數退避
      }

      if (isTaoyuanEndpoint) {
        return await fetchTaoyuanTruckData(url, controller.signal);
      }

      const headers = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 (compatible; TrashAlertBot/1.0; +https://github.com/jackleecc/trash-alert-tw)',
        Accept: 'application/json, text/plain, */*',
      };

      const fetchOptions = {
        signal: controller.signal,
        headers,
      };

      // 若為台南端點或代理伺服器，自動帶入 POST 協議與必要標頭
      if (isTainanEndpoint) {
        fetchOptions.method = 'POST';
        fetchOptions.headers['Content-Type'] = 'application/json; charset=utf-8';
        fetchOptions.headers['Referer'] = 'https://clean.tnepb.gov.tw/index.aspx';
        if (process.env.TAINAN_PROXY_SECRET) {
          fetchOptions.headers['x-proxy-secret'] = process.env.TAINAN_PROXY_SECRET;
        }
        fetchOptions.body = JSON.stringify({});
      }

      const response = await fetch(url, fetchOptions);

      if (!response.ok) {
        throw new Error(`外部 API 回傳錯誤狀態碼: HTTP ${response.status} (${url})`);
      }

      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`外部 API 回傳非合法的 JSON 格式內容 (${url})`);
      }
    } catch (err) {
      lastError = err;
      if (err.name === 'AbortError') {
        lastError = new Error(`外部 API 請求逾時 (${FETCH_TIMEOUT_MS}ms): ${url}`);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }
  throw lastError;
}

/**
 * 從錯誤訊息字串中解析已暫停縣市名單（降級備援相容）
 * @param {string | null | undefined} lastApiError
 * @returns {string[]}
 */
/**
 * 從錯誤訊息字串中解析已暫停縣市名單（降級備援相容）
 * @param {string | null | undefined} lastApiError
 * @returns {string[]}
 */
export function parsePausedCitiesFromError(lastApiError) {
  if (!lastApiError || typeof lastApiError !== 'string') return [];
  const match = lastApiError.match(/\[PAUSED_CITIES:([^\]]+)\]/);
  return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * 從錯誤訊息字串中解析各縣市累計失敗次數
 * @param {string | null | undefined} lastApiError
 * @returns {Record<string, number>}
 */
export function parseCityFailCountsFromError(lastApiError) {
  if (!lastApiError || typeof lastApiError !== 'string') return {};
  const match = lastApiError.match(/\[CITY_FAILS:([^\]]+)\]/);
  if (!match) return {};
  try {
    return JSON.parse(match[1]) || {};
  } catch {
    return {};
  }
}

/**
 * 安全寫入或更新 daily_status，若 DB 尚未套用 paused_cities 欄位則自動降級編碼寫入 last_api_error
 * @param {object} payload - 要寫入的資料
 * @param {string} dateStr - 台灣今日日期
 * @param {boolean} [isUpdateOnly=false] - 是否僅執行 update
 * @returns {Promise<any>}
 */
export async function upsertDailyStatusSafe(payload, dateStr, isUpdateOnly = false) {
  let query = isUpdateOnly
    ? supabase.from('daily_status').update(payload).eq('date', dateStr)
    : supabase.from('daily_status').upsert({ date: dateStr, ...payload }, { onConflict: 'date' });

  let { error } = await query;

  if (error && (error.message?.includes('paused_cities') || error.code === '42703')) {
    const fallbackPayload = { ...payload };
    delete fallbackPayload.paused_cities;
    if (
      payload.paused_cities &&
      payload.paused_cities.length > 0 &&
      !fallbackPayload.last_api_error?.includes('[PAUSED_CITIES:')
    ) {
      fallbackPayload.last_api_error = `[PAUSED_CITIES:${payload.paused_cities.join(',')}] ${fallbackPayload.last_api_error || ''}`.trim();
    }
    const fallbackQuery = isUpdateOnly
      ? supabase.from('daily_status').update(fallbackPayload).eq('date', dateStr)
      : supabase.from('daily_status').upsert({ date: dateStr, ...fallbackPayload }, { onConflict: 'date' });
    const fallbackRes = await fallbackQuery;
    error = fallbackRes.error;
  }
  return error;
}

/**
 * 抓取環保局車輛動態資料（支援依活躍訂閱縣市智慧精準抓取），並處理非同步重試與縣市隔離告警邏輯
 *
 * @param {string} dateStr - 台灣今日日期 (YYYY-MM-DD)
 * @param {string} [overrideUrl] - 可選的自訂 API URL (用於測試或環境變數覆寫)
 * @param {string[]} [targetCities] - 目標縣市清單 (例如: ['新北市'])
 * @returns {Promise<{ ok: boolean, data: any[], paused: boolean, retryCount: number, error?: string }>}
 */
export async function fetchTrucksWithRetry(dateStr, overrideUrl, targetCities) {
  // 1. 取得今日 DB 狀態中的失敗計數與暫停狀態
  let currentFailCount = 0;
  let isPaused = false;
  let pausedCities = [];
  let cityFailCounts = {};

  const { data: statusRecord, error: selectErr } = await supabase
    .from('daily_status')
    .select('*')
    .eq('date', dateStr)
    .maybeSingle();

  if (!selectErr && statusRecord) {
    currentFailCount = statusRecord.api_fail_count || 0;
    isPaused = Boolean(statusRecord.is_paused);
    pausedCities = Array.isArray(statusRecord.paused_cities)
      ? statusRecord.paused_cities
      : parsePausedCitiesFromError(statusRecord.last_api_error);
    cityFailCounts = parseCityFailCountsFromError(statusRecord.last_api_error);
  }

  // 縣市級暫停檢查：過濾掉已暫停的縣市，避免在已知故障端點上重複耗費逾時等待
  const effectiveTargetCities = Array.isArray(targetCities)
    ? targetCities.filter((c) => !pausedCities.includes(c))
    : targetCities;

  const isCityLevelPaused =
    Array.isArray(targetCities) &&
    targetCities.length > 0 &&
    pausedCities.length > 0 &&
    effectiveTargetCities.length === 0;

  // 若當日已被標記全域暫停（且無未暫停縣市），或當前目標縣市全數暫停，才略過請求（但若有 overrideUrl 則允許強制探測與恢復）
  if (
    !overrideUrl &&
    ((isPaused && (!targetCities || targetCities.length === 0 || pausedCities.length === 0)) ||
      isCityLevelPaused)
  ) {
    const pausedDesc = isCityLevelPaused ? `目標縣市 (${targetCities.join('、')})` : '全域';
    console.log(
      `[TruckAPI] 今日 (${dateStr}) ${pausedDesc}車輛檢核已因多次失敗暫停，略過請求。`
    );
    return {
      ok: false,
      data: [],
      paused: true,
      retryCount: currentFailCount,
      error: 'API_CHECK_PAUSED_FOR_TODAY',
    };
  }

  const targetUrls = getTargetApiUrls(overrideUrl, effectiveTargetCities, pausedCities);

  // 2. 嘗試抓取外部資料（支援多縣市來源並行請求與容錯）
  try {
    const fetchPromises = targetUrls.map(async (url) => {
      const rawData = await fetchRawTruckData(url);
      return adaptTruckData(rawData);
    });

    const settledResults = await Promise.allSettled(fetchPromises);
    const allCleanedData = [];
    const errors = [];

    const sourceStats = targetUrls.map((url, index) => {
      const res = settledResults[index];
      if (res.status === 'fulfilled') {
        allCleanedData.push(...res.value);
        return { url, ok: true, count: res.value.length };
      } else {
        const failedUrl = targetUrls[index];
        console.warn(`[TruckAPI] 來源抓取失敗 (${failedUrl}): ${res.reason?.message}`);
        errors.push(`${failedUrl}: ${res.reason?.message || '未知錯誤'}`);
        return { url, ok: false, error: res.reason?.message || '未知錯誤' };
      }
    });

    // 只要有任何一個來源成功，即視為抓取成功
    if (allCleanedData.length > 0 || errors.length < targetUrls.length) {
      // 僅針對「本次實際請求且成功連線」的端點解析縣市，避免誤解未請求的暫停縣市
      const succeededUrls = sourceStats.filter((s) => s.ok).map((s) => s.url);
      const succeededCities = MONITORED_CITIES.filter((city) => {
        const url = CITY_API_URL_MAP[city];
        return succeededUrls.includes(url);
      });
      const remainingPausedCities = pausedCities.filter((c) => !succeededCities.includes(c));

      // 成功連線的縣市：將其累計失敗次數歸零
      const nextCityFails = { ...cityFailCounts };
      for (const city of succeededCities) {
        delete nextCityFails[city];
      }

      // 部分來源失敗 (FIX-2)：針對失敗的來源累計該縣市失敗次數，達 MAX_RETRY_COUNT 門檻時才加入暫停
      const failedSources = sourceStats.filter((s) => !s.ok);
      const newlyPausedThisRound = [];
      if (failedSources.length > 0) {
        for (const s of failedSources) {
          const c = getCityFromApiUrl(s.url);
          if (c) {
            nextCityFails[c] = (nextCityFails[c] || 0) + 1;
            if (nextCityFails[c] >= MAX_RETRY_COUNT && !remainingPausedCities.includes(c)) {
              newlyPausedThisRound.push(c);
            }
          }
        }
      }

      const mergedPaused = Array.from(
        new Set([...remainingPausedCities, ...newlyPausedThisRound])
      );

      const hasPausedChanged =
        mergedPaused.length !== pausedCities.length ||
        !mergedPaused.every((c) => pausedCities.includes(c));

      const hasCityFailsChanged =
        JSON.stringify(nextCityFails) !== JSON.stringify(cityFailCounts);

      // 若所有端點皆連線成功且有失敗計數需重置，或暫停清單/失敗統計有變更時，更新 DB (FIX-3, FIX-2)
      if (
        (currentFailCount > 0 && errors.length === 0) ||
        hasPausedChanged ||
        hasCityFailsChanged
      ) {
        const errorDetails = errors.length > 0 ? ` 部分來源失敗: ${errors.join('; ')}` : '';
        const failJson =
          Object.keys(nextCityFails).length > 0
            ? `[CITY_FAILS:${JSON.stringify(nextCityFails)}] `
            : '';
        const pausedTag =
          mergedPaused.length > 0 ? `[PAUSED_CITIES:${mergedPaused.join(',')}]` : '';
        const lastErrorStr = (failJson + pausedTag + errorDetails).trim() || null;

        const updatePayload = {
          api_fail_count: errors.length === 0 ? 0 : currentFailCount,
          is_paused: mergedPaused.length >= MONITORED_CITIES.length,
          last_api_error: lastErrorStr,
          paused_cities: mergedPaused,
          updated_at: new Date().toISOString(),
        };

        const isUpdateOnly = errors.length === 0;
        const updateErr = await upsertDailyStatusSafe(updatePayload, dateStr, isUpdateOnly);
        if (updateErr) {
          console.error(`[TruckAPI] 更新 daily_status 失敗: ${updateErr.message}`);
        }

        // 若本次有新縣市達到 3 次失敗門檻，發送 LINE 告警
        for (const city of newlyPausedThisRound) {
          console.warn(
            `[TruckAPI] ${city} 連續失敗達 ${MAX_RETRY_COUNT} 次，發送 LINE 故障告警並暫停今日檢核。`
          );
          const alertMsg = `⚠️【系統告警】${city}環保局車輛即時 API 連續 ${MAX_RETRY_COUNT} 次連線失敗，已暫停今日該縣市即時追蹤檢核。`;
          await broadcastLineAlert(alertMsg, [city]);
        }
      }

      return {
        ok: true,
        data: allCleanedData,
        paused: false,
        retryCount: 0,
        errors: errors.length > 0 ? errors : undefined,
        sourceStats,
      };
    }

    // 全部來源皆失敗
    throw new Error(`所有車輛 API 來源皆連線失敗: ${errors.join('; ')}`);
  } catch (err) {
    const nextFailCount = currentFailCount + 1;
    const shouldPauseThisTarget = nextFailCount >= MAX_RETRY_COUNT;

    console.error(
      `[TruckAPI] 抓取車輛資料失敗 (第 ${nextFailCount}/${MAX_RETRY_COUNT} 次): ${err.message}`
    );

    // 累積本次失敗的暫停縣市名單（僅隔離本次連線失敗的縣市） (FIX-4)
    const failedCities = (effectiveTargetCities && effectiveTargetCities.length > 0)
      ? effectiveTargetCities
      : (targetCities && targetCities.length > 0)
        ? targetCities
        : targetUrls.map((url) => getCityFromApiUrl(url)).filter(Boolean);
    const updatedPausedCities = shouldPauseThisTarget
      ? Array.from(new Set([...pausedCities, ...failedCities]))
      : pausedCities;

    // 全域 is_paused 判定：僅在未指定 targetCities，或所有受監控縣市皆已暫停時，才標記全域暫停
    const isAllCitiesPaused = MONITORED_CITIES.every((c) => updatedPausedCities.includes(c));
    const shouldGlobalPause = shouldPauseThisTarget && (!targetCities || targetCities.length === 0 || isAllCitiesPaused);

    // 更新 DB 失敗計數與暫停旗標
    const updatePayload = {
      date: dateStr,
      api_fail_count: nextFailCount,
      is_paused: shouldGlobalPause,
      last_api_error: err.message,
      paused_cities: updatedPausedCities,
      updated_at: new Date().toISOString(),
    };

    const upsertErr = await upsertDailyStatusSafe(updatePayload, dateStr, false);
    if (upsertErr) {
      console.error(`[TruckAPI] 更新 daily_status 失敗: ${upsertErr.message}`);
    }

    // 連續失敗達到 3 次時觸發 LINE 告警
    if (shouldPauseThisTarget) {
      const cityLabel =
        targetCities && targetCities.length > 0 ? targetCities.join('、') : '目標';
      console.warn(
        `[TruckAPI] 連續失敗達 ${MAX_RETRY_COUNT} 次，發送 LINE 故障告警並暫停 ${cityLabel} 今日檢核。`
      );
      const alertMsg = `⚠️【系統告警】${cityLabel}環保局車輛即時 API 連續 ${MAX_RETRY_COUNT} 次連線失敗，已暫停今日該縣市即時追蹤檢核。\n最後錯誤原因：${err.message}`;
      await broadcastLineAlert(alertMsg, targetCities);
    }

    return {
      ok: false,
      data: [],
      paused: shouldPauseThisTarget,
      retryCount: nextFailCount,
      error: err.message,
    };
  }
}
