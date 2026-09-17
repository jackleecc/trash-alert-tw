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
export const TAINAN_DIRECT_API_URL =
  'https://clean.tnepb.gov.tw/WebService/WsSkyeyes.asmx/NewgetCarsinfo';

export const TAINAN_TRUCK_API_URL =
  process.env.TAINAN_PROXY_URL ||
  process.env.TAINAN_TRUCK_API_URL ||
  TAINAN_DIRECT_API_URL;

// 支援備用代理端點（例如 Cloudflare Worker 或 GCP Proxy 作為自動容錯備援）
export const TAINAN_BACKUP_PROXY_URL = process.env.TAINAN_BACKUP_PROXY_URL || null;

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

const FETCH_TIMEOUT_MS = 12000; // 12 秒逾時（兼顧公家機關 ASMX 尖峰延遲與 cron-job.org 30 秒中斷防線）
const MAX_RETRY_COUNT = 10; // 容錯熔斷門檻放寬至連續 10 次排程失敗（增強抗公家 API 短暫重啟或網路抖動能力）
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
 * 取得欲抓取的目標 API URL 清單（支援依目標縣市精準過濾）
 * @param {string} [overrideUrl]
 * @param {string[]} [targetCities]
 * @returns {string[]}
 */
export function getTargetApiUrls(overrideUrl, targetCities) {
  if (overrideUrl) return [overrideUrl];

  // 若有指定目標縣市，優先精準回傳該縣市的 API URL 清單（防止全域環境變數覆蓋多縣市）
  if (Array.isArray(targetCities) && targetCities.length > 0) {
    const matchedUrls = [];
    for (const city of targetCities) {
      const url = CITY_API_URL_MAP[city];
      if (url && !matchedUrls.includes(url)) {
        matchedUrls.push(url);
      }
    }
    if (matchedUrls.length > 0) return matchedUrls;
  }

  // 次之：全域指定 TRUCK_API_URL
  if (process.env.TRUCK_API_URL) {
    return process.env.TRUCK_API_URL.split(',')
      .map((u) => u.trim())
      .filter(Boolean);
  }

  return DEFAULT_TRUCK_API_URLS;
}

/**
 * 發送 HTTP 請求抓取外部車輛 API 資料（含單次重試，支援 ASMX WebService POST 與代理伺服器轉發）
 * @param {string} url
 * @returns {Promise<any>}
 */
async function fetchRawTruckData(url, isFallback = false) {
  let lastError;
  const isAsmx = typeof url === 'string' && url.includes('.asmx');
  const isTainanEndpoint =
    typeof url === 'string' &&
    (url === TAINAN_TRUCK_API_URL ||
      url === TAINAN_BACKUP_PROXY_URL ||
      url === TAINAN_DIRECT_API_URL ||
      isAsmx ||
      url.includes('clean.tnepb.gov.tw'));
  const isTaoyuanEndpoint =
    typeof url === 'string' && (url === TAOYUAN_TRUCK_API_URL || url.includes('tyoem.gov.tw'));

  const isProxyUrl = typeof url === 'string' && (url.includes('workers.dev') || url.includes('.run.app'));
  const maxRetries = isFallback || isProxyUrl ? 0 : SINGLE_FETCH_RETRIES;
  const effectiveTimeout = isFallback ? 6000 : isProxyUrl ? 8000 : FETCH_TIMEOUT_MS;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);

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
        lastError = new Error(`外部 API 請求逾時 (${effectiveTimeout}ms): ${url}`);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // 自動無縫切換備用端點機制：
  // 若為台南端點抓取失敗，且尚未進入備用切換時，自動依序嘗試所有候選備援端點
  if (!isFallback && isTainanEndpoint) {
    const backupUrl = process.env.TAINAN_BACKUP_PROXY_URL || TAINAN_BACKUP_PROXY_URL;
    const candidates = [
      process.env.TAINAN_PROXY_URL,
      backupUrl,
      TAINAN_DIRECT_API_URL,
    ].filter((target, idx, arr) => target && target !== url && arr.indexOf(target) === idx);

    for (const fallbackTarget of candidates) {
      console.warn(
        `[TruckAPI] ⚠️ 臺南端點連線失敗 (${url}: ${lastError?.message})，自動無縫切換備援端點: ${fallbackTarget}`
      );
      try {
        return await fetchRawTruckData(fallbackTarget, true);
      } catch (backupErr) {
        console.error(
          `[TruckAPI] ❌ 臺南備援端點亦抓取失敗 (${fallbackTarget}): ${backupErr.message}`
        );
        lastError = backupErr;
      }
    }
  }

  throw lastError;
}

/**
 * 抓取環保局車輛動態資料（支援依活躍訂閱縣市智慧精準抓取），並處理非同步重試與告警邏輯
 *
 * @param {string} dateStr - 台灣今日日期 (YYYY-MM-DD)
 * @param {string} [overrideUrl] - 可選的自訂 API URL (用於測試或環境變數覆寫)
 * @param {string[]} [targetCities] - 目標縣市清單 (例如: ['新北市'])
 * @returns {Promise<{ ok: boolean, data: any[], paused: boolean, retryCount: number, error?: string }>}
 */
export async function fetchTrucksWithRetry(dateStr, overrideUrl, targetCities) {
  const targetUrls = getTargetApiUrls(overrideUrl, targetCities);

  // 1. 取得今日 DB 狀態中的失敗計數與暫停狀態
  let currentFailCount = 0;
  let isPaused = false;

  const { data: statusRecord, error: selectErr } = await supabase
    .from('daily_status')
    .select('api_fail_count, is_paused')
    .eq('date', dateStr)
    .maybeSingle();

  if (!selectErr && statusRecord) {
    currentFailCount = statusRecord.api_fail_count || 0;
    isPaused = Boolean(statusRecord.is_paused);
  }

  // 若當日已被暫停檢核，直接略過
  if (isPaused) {
    console.log(
      `[TruckAPI] 今日 (${dateStr}) 車輛檢核已因多次失敗暫停，略過請求。`
    );
    return {
      ok: false,
      data: [],
      paused: true,
      retryCount: currentFailCount,
      error: 'API_CHECK_PAUSED_FOR_TODAY',
    };
  }

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
      if (currentFailCount > 0 && errors.length === 0) {
        await supabase
          .from('daily_status')
          .update({
            api_fail_count: 0,
            last_api_error: null,
            updated_at: new Date().toISOString(),
          })
          .eq('date', dateStr);
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
    const shouldPause = nextFailCount >= MAX_RETRY_COUNT;

    console.error(
      `[TruckAPI] 抓取車輛資料失敗 (第 ${nextFailCount}/${MAX_RETRY_COUNT} 次): ${err.message}`
    );

    // 更新 DB 失敗計數與暫停旗標
    const updatePayload = {
      date: dateStr,
      api_fail_count: nextFailCount,
      is_paused: shouldPause,
      last_api_error: err.message,
      updated_at: new Date().toISOString(),
    };

    const { error: upsertErr } = await supabase
      .from('daily_status')
      .upsert(updatePayload, { onConflict: 'date' });

    if (upsertErr) {
      console.error(`[TruckAPI] 更新 daily_status 失敗: ${upsertErr.message}`);
    }

    // 連續失敗達到 3 次時觸發 LINE 告警
    if (shouldPause) {
      console.warn(
        `[TruckAPI] 連續失敗達 ${MAX_RETRY_COUNT} 次，發送 LINE 故障告警並暫停當日檢核。`
      );
      const alertMsg = `⚠️【系統告警】環保局車輛即時 API 連續 ${MAX_RETRY_COUNT} 次連線失敗，已暫停今日即時追蹤檢核。\n最後錯誤原因：${err.message}`;
      await broadcastLineAlert(alertMsg);
    }

    return {
      ok: false,
      data: [],
      paused: shouldPause,
      retryCount: nextFailCount,
      error: err.message,
    };
  }
}
