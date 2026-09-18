/**
 * lib/truckIntake.js
 * 環保局車輛即時動態資料擷取與正規化深模組
 *
 * 封裝跨縣市 (新北、高雄、桃園、臺南) 外部 API 連線協定、重試與資料清洗。
 */

import { adaptTruckData } from './truckAdapter.js';
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

// 臺南市環保局即時動態 API（支援代理伺服器轉發或環境變數自訂覆寫）
export const TAINAN_DIRECT_API_URL =
  'https://clean.tnepb.gov.tw/WebService/WsSkyeyes.asmx/NewgetCarsinfo';

export const TAINAN_TRUCK_API_URL =
  process.env.TAINAN_PROXY_URL ||
  process.env.TAINAN_TRUCK_API_URL ||
  TAINAN_DIRECT_API_URL;

export const TAINAN_BACKUP_PROXY_URL = process.env.TAINAN_BACKUP_PROXY_URL || null;

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
  if (!url) return null;
  for (const city of MONITORED_CITIES) {
    if (CITY_API_URL_MAP[city] === url || url.includes(city) || (city === '桃園市' && url.includes('tyoem')) || (city === '新北市' && url.includes('ntpc')) || (city === '高雄市' && url.includes('kcg')) || (city === '台南市' && url.includes('tnepb'))) {
      return city;
    }
  }
  if (url.includes('kcg')) return '高雄市';
  if (url.includes('ntpc')) return '新北市';
  if (url.includes('tyoem')) return '桃園市';
  if (url.includes('tnepb') || url.includes('backup-proxy')) return '台南市';
  return null;
}

const FETCH_TIMEOUT_MS = 12000;
const SINGLE_FETCH_RETRIES = 1;

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
 * 取得欲抓取的目標 API URL 清單
 * @param {string} [overrideUrl]
 * @param {string[]} [targetCities]
 * @param {string[]} [pausedCities]
 * @returns {string[]}
 */
export function getTargetApiUrls(overrideUrl, targetCities, pausedCities = []) {
  if (overrideUrl) return [overrideUrl];

  const pausedSet = new Set((pausedCities || []).map((c) => normalizeCity(c)));

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
 * 抓取高雄市環保局原始車輛資料
 * @param {string} url
 * @param {AbortSignal} signal
 * @returns {Promise<any>}
 */
export async function fetchKcgTrucks(url, signal) {
  const response = await fetch(url, {
    signal,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 (compatible; TrashAlertBot/1.0; +https://github.com/jackleecc/trash-alert-tw)',
      Accept: 'application/json, text/plain, */*',
    },
  });
  if (!response.ok) {
    throw new Error(`外部 API 回傳錯誤狀態碼: HTTP ${response.status} (${url})`);
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`外部 API 回傳非合法的 JSON 格式內容 (${url})`);
  }
}

/**
 * 抓取新北市環保局原始車輛資料
 * @param {string} url
 * @param {AbortSignal} signal
 * @returns {Promise<any>}
 */
export async function fetchNtpcTrucks(url, signal) {
  const response = await fetch(url, {
    signal,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 (compatible; TrashAlertBot/1.0; +https://github.com/jackleecc/trash-alert-tw)',
      Accept: 'application/json, text/plain, */*',
    },
  });
  if (!response.ok) {
    throw new Error(`外部 API 回傳錯誤狀態碼: HTTP ${response.status} (${url})`);
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`外部 API 回傳非合法的 JSON 格式內容 (${url})`);
  }
}

/**
 * 抓取臺南市環保局原始車輛資料
 * @param {string} url
 * @param {AbortSignal} signal
 * @returns {Promise<any>}
 */
export async function fetchTainanTrucks(url, signal) {
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 (compatible; TrashAlertBot/1.0; +https://github.com/jackleecc/trash-alert-tw)',
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json; charset=utf-8',
    Referer: 'https://clean.tnepb.gov.tw/index.aspx',
  };
  if (process.env.TAINAN_PROXY_SECRET) {
    headers['x-proxy-secret'] = process.env.TAINAN_PROXY_SECRET;
  }

  const response = await fetch(url, {
    method: 'POST',
    signal,
    headers,
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    throw new Error(`外部 API 回傳錯誤狀態碼: HTTP ${response.status} (${url})`);
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`外部 API 回傳非合法的 JSON 格式內容 (${url})`);
  }
}

export { fetchTaoyuanTruckData as fetchTaoyuanTrucks };

async function fetchCityRawData(url, signal) {
  const city = getCityFromApiUrl(url);
  if (city === '桃園市' || (typeof url === 'string' && url.includes('tyoem.gov.tw'))) {
    return fetchTaoyuanTruckData(url, signal);
  }
  if (
    city === '台南市' ||
    city === '臺南市' ||
    (typeof url === 'string' && (url.includes('tnepb.gov.tw') || url.includes('.asmx')))
  ) {
    return fetchTainanTrucks(url, signal);
  }
  if (city === '新北市' || (typeof url === 'string' && url.includes('ntpc.gov.tw'))) {
    return fetchNtpcTrucks(url, signal);
  }
  if (city === '高雄市' || (typeof url === 'string' && url.includes('kcg.gov.tw'))) {
    return fetchKcgTrucks(url, signal);
  }
  // 預設通用 GET 抓取
  return fetchNtpcTrucks(url, signal);
}

async function fetchRawTruckData(url, isFallback = false) {
  let lastError;
  const isTainanEndpoint =
    typeof url === 'string' &&
    (url === TAINAN_TRUCK_API_URL ||
      url === TAINAN_BACKUP_PROXY_URL ||
      url === TAINAN_DIRECT_API_URL ||
      url.includes('.asmx') ||
      url.includes('clean.tnepb.gov.tw') ||
      url.includes('backup-proxy'));

  const maxRetries = isFallback ? 0 : SINGLE_FETCH_RETRIES;
  const effectiveTimeout = FETCH_TIMEOUT_MS;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);

    try {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 800 * attempt));
      }

      return await fetchCityRawData(url, controller.signal);
    } catch (err) {
      lastError = err;
      if (err.name === 'AbortError') {
        lastError = new Error(`外部 API 請求逾時 (${effectiveTimeout}ms): ${url}`);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  if (!isFallback && isTainanEndpoint) {
    const backupUrl = process.env.TAINAN_BACKUP_PROXY_URL || TAINAN_BACKUP_PROXY_URL;
    const candidates = [
      process.env.TAINAN_PROXY_URL,
      backupUrl,
      TAINAN_DIRECT_API_URL,
    ].filter((target, idx, arr) => target && target !== url && arr.indexOf(target) === idx);

    for (const fallbackTarget of candidates) {
      try {
        return await fetchRawTruckData(fallbackTarget, true);
      } catch (backupErr) {
        lastError = backupErr;
      }
    }
  }

  throw lastError;
}

/**
 * 擷取活躍垃圾車資料
 * @param {object} [options]
 * @param {string[]} [options.targetCities]
 * @param {string[]} [options.pausedCities]
 * @param {string} [options.overrideUrl]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ ok: boolean, data: any[], sourceStats: any[], errors: string[] }>}
 */
export async function fetchActiveTrucks(options = {}) {
  const { targetCities, overrideUrl, pausedCities = [] } = options;
  const targetUrls = getTargetApiUrls(overrideUrl, targetCities, pausedCities);

  const fetchPromises = targetUrls.map(async (url) => {
    const rawData = await fetchRawTruckData(url);
    return adaptTruckData(rawData);
  });

  const settledResults = await Promise.allSettled(fetchPromises);
  const allCleanedData = [];
  const errors = [];

  const sourceStats = targetUrls.map((url, index) => {
    const res = settledResults[index];
    const city = getCityFromApiUrl(url);
    if (res.status === 'fulfilled') {
      allCleanedData.push(...res.value);
      return { city, url, ok: true, count: res.value.length };
    } else {
      const errMsg = res.reason?.message || '未知錯誤';
      errors.push(`${url}: ${errMsg}`);
      return { city, url, ok: false, error: errMsg };
    }
  });

  const ok = allCleanedData.length > 0 || errors.length < targetUrls.length;

  return {
    ok,
    data: allCleanedData,
    sourceStats,
    errors,
  };
}
