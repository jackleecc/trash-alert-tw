/**
 * lib/cityCircuitBreaker.js
 * 縣市層級 API 熔斷狀態管理與資料庫同步
 *
 * 專職處理 daily_status 狀態讀取、縣市熔斷降級編解碼、重試計數與熔斷標記。
 */

import { supabase } from './supabaseClient.js';
import { broadcastLineAlert } from './lineClient.js';
import { MONITORED_CITIES, getCityFromApiUrl } from './truckIntake.js';

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
  let error = null;
  let updated = false;

  if (isUpdateOnly) {
    try {
      const table = supabase.from('daily_status');
      if (table && typeof table.update === 'function') {
        const updateFn = table.update(payload);
        if (updateFn && typeof updateFn.eq === 'function') {
          const res = await updateFn.eq('date', dateStr);
          error = res.error;
          updated = true;
        }
      }
    } catch (err) {
      error = err;
    }
  }

  if (!updated || error) {
    const upsertPayload = { date: dateStr, ...payload };
    const upsertRes = await supabase.from('daily_status').upsert(upsertPayload, { onConflict: 'date' });
    error = upsertRes.error;
  }

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
    const fallbackUpsertRes = await supabase.from('daily_status').upsert({ date: dateStr, ...fallbackPayload }, { onConflict: 'date' });
    error = fallbackUpsertRes.error;
  }
  return error;
}

/**
 * 讀取特定日期的縣市 API 熔斷狀態
 * @param {string} dateStr
 * @returns {Promise<{ currentFailCount: number, isPaused: boolean, pausedCities: string[], cityFailCounts: Record<string, number> }>}
 */
export async function loadCityStatus(dateStr) {
  const { data: statusRecord, error: selectErr } = await supabase
    .from('daily_status')
    .select('*')
    .eq('date', dateStr)
    .maybeSingle();

  if (selectErr || !statusRecord) {
    return { currentFailCount: 0, isPaused: false, pausedCities: [], cityFailCounts: {} };
  }

  const currentFailCount = statusRecord.api_fail_count || 0;
  const isPaused = Boolean(statusRecord.is_paused);
  const pausedCities = Array.isArray(statusRecord.paused_cities)
    ? statusRecord.paused_cities
    : parsePausedCitiesFromError(statusRecord.last_api_error);
  const cityFailCounts = parseCityFailCountsFromError(statusRecord.last_api_error);

  return { currentFailCount, isPaused, pausedCities, cityFailCounts };
}

/**
 * 當抓取成功時更新或重置縣市狀態
 * @param {object} params
 * @param {string} params.dateStr
 * @param {string[]} params.succeededCities
 * @param {Record<string, number>} [params.cityFailCounts]
 * @param {string[]} [params.pausedCities]
 * @returns {Promise<any>}
 */
export async function updateStatusOnSuccess(params) {
  const { dateStr, succeededCities = [], cityFailCounts = {}, pausedCities = [] } = params;

  const nextCityFails = { ...cityFailCounts };
  for (const city of succeededCities) {
    delete nextCityFails[city];
  }

  const nextPaused = pausedCities.filter((c) => !succeededCities.includes(c));

  const failJson =
    Object.keys(nextCityFails).length > 0
      ? `[CITY_FAILS:${JSON.stringify(nextCityFails)}] `
      : '';
  const pausedTag = nextPaused.length > 0 ? `[PAUSED_CITIES:${nextPaused.join(',')}]` : '';
  const lastErrorStr = (failJson + pausedTag).trim() || null;

  const updatePayload = {
    api_fail_count: 0,
    is_paused: nextPaused.length >= MONITORED_CITIES.length,
    last_api_error: lastErrorStr,
    paused_cities: nextPaused,
    updated_at: new Date().toISOString(),
  };

  const updateErr = await upsertDailyStatusSafe(updatePayload, dateStr, true);
  if (updateErr) {
    console.error(`[CityCircuitBreaker] 更新 daily_status 失敗: ${updateErr.message}`);
  }

  return {
    pausedCities: nextPaused,
    cityFailCounts: nextCityFails,
  };
}

/**
 * 當抓取失敗時累積計數並評估是否熔斷
 * @param {object} params
 * @param {string} params.dateStr
 * @param {string[]} [params.failedCities]
 * @param {Record<string, number>} [params.cityFailCounts]
 * @param {string[]} [params.pausedCities]
 * @param {number} [params.maxRetries=10]
 * @param {string} [params.errorMessage]
 * @param {string[]} [params.targetCities]
 * @param {number} [params.currentFailCount=0]
 * @returns {Promise<{ shouldPause: boolean, pausedCities: string[], cityFailCounts: Record<string, number>, failCount: number }>}
 */
export async function updateStatusOnFailure(params) {
  const {
    dateStr,
    failedCities = [],
    cityFailCounts = {},
    pausedCities = [],
    maxRetries = 10,
    errorMessage = '',
    targetCities = [],
    currentFailCount = 0,
  } = params;

  const nextCityFails = { ...cityFailCounts };
  const newlyPaused = [];

  for (const city of failedCities) {
    const existing = nextCityFails[city] !== undefined ? nextCityFails[city] : currentFailCount;
    nextCityFails[city] = existing + 1;
    if (nextCityFails[city] >= maxRetries && !pausedCities.includes(city) && !newlyPaused.includes(city)) {
      newlyPaused.push(city);
    }
  }

  const updatedPaused = Array.from(new Set([...pausedCities, ...newlyPaused]));
  const isAllCitiesPaused = MONITORED_CITIES.every((c) => updatedPaused.includes(c));
  const nextFailCount = currentFailCount + 1;
  const maxCityFail = Math.max(0, ...Object.values(nextCityFails));
  const effectiveFailCount = Math.max(nextFailCount, maxCityFail);

  const shouldPauseThisTarget = effectiveFailCount >= maxRetries || newlyPaused.length > 0;
  const shouldGlobalPause = shouldPauseThisTarget && (!targetCities || targetCities.length === 0 || isAllCitiesPaused);

  const failJson =
    Object.keys(nextCityFails).length > 0
      ? `[CITY_FAILS:${JSON.stringify(nextCityFails)}] `
      : '';
  const pausedTag = updatedPaused.length > 0 ? `[PAUSED_CITIES:${updatedPaused.join(',')}]` : '';
  const lastErrorStr = (failJson + pausedTag + (errorMessage ? ` ${errorMessage}` : '')).trim() || null;

  const updatePayload = {
    date: dateStr,
    api_fail_count: effectiveFailCount,
    is_paused: shouldGlobalPause,
    last_api_error: lastErrorStr,
    paused_cities: updatedPaused,
    updated_at: new Date().toISOString(),
  };

  const upsertErr = await upsertDailyStatusSafe(updatePayload, dateStr, false);
  if (upsertErr) {
    console.error(`[CityCircuitBreaker] 更新 daily_status 失敗: ${upsertErr.message}`);
  }

  for (const city of newlyPaused) {
    console.warn(
      `[CityCircuitBreaker] ${city} 連續失敗達 ${maxRetries} 次，發送 LINE 故障告警並暫停今日檢核。`
    );
    const alertMsg = `⚠️【系統告警】${city}環保局車輛即時 API 連續 ${maxRetries} 次連線失敗，已暫停今日該縣市即時追蹤檢核。\n最後錯誤原因：${errorMessage}`;
    await broadcastLineAlert(alertMsg, [city]);
  }

  return {
    shouldPause: shouldPauseThisTarget,
    pausedCities: updatedPaused,
    cityFailCounts: nextCityFails,
    failCount: effectiveFailCount,
  };
}
