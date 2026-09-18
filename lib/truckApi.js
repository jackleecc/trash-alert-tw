/**
 * lib/truckApi.js
 * 環保局車輛即時 API 資料抓取與 DB 非同步重試狀態管理 (Facade)
 */

import { supabase } from './supabaseClient.js';
import { adaptTruckData } from './truckAdapter.js';
import { broadcastLineAlert } from './lineClient.js';
import { normalizeCity } from './geoUtils.js';

import {
  fetchActiveTrucks,
  getTargetApiUrls,
  getCityFromApiUrl,
  KCG_TRUCK_API_URL,
  NTPC_TRUCK_API_URL,
  TAOYUAN_TRUCK_API_URL,
  TAINAN_DIRECT_API_URL,
  TAINAN_TRUCK_API_URL,
  TAINAN_BACKUP_PROXY_URL,
  MONITORED_CITIES,
  CITY_API_URL_MAP,
  DEFAULT_TRUCK_API_URLS,
} from './truckIntake.js';

import {
  loadCityStatus,
  updateStatusOnSuccess,
  updateStatusOnFailure,
  parsePausedCitiesFromError,
  parseCityFailCountsFromError,
  upsertDailyStatusSafe,
} from './cityCircuitBreaker.js';

export {
  fetchActiveTrucks,
  getTargetApiUrls,
  getCityFromApiUrl,
  KCG_TRUCK_API_URL,
  NTPC_TRUCK_API_URL,
  TAOYUAN_TRUCK_API_URL,
  TAINAN_DIRECT_API_URL,
  TAINAN_TRUCK_API_URL,
  TAINAN_BACKUP_PROXY_URL,
  MONITORED_CITIES,
  CITY_API_URL_MAP,
  DEFAULT_TRUCK_API_URLS,
  loadCityStatus,
  updateStatusOnSuccess,
  updateStatusOnFailure,
  parsePausedCitiesFromError,
  parseCityFailCountsFromError,
  upsertDailyStatusSafe,
};

/**
 * 抓取環保局車輛動態資料（透過 truckIntake 與 cityCircuitBreaker 協調）
 * @param {string} dateStr - 台灣今日日期 (YYYY-MM-DD)
 * @param {string} [overrideUrl] - 可選的自訂 API URL
 * @param {string[]} [targetCities] - 目標縣市清單
 * @param {object} [options] - 額外選項
 * @returns {Promise<{ ok: boolean, data: any[], paused: boolean, retryCount: number, error?: string, errors?: string[], sourceStats?: any[] }>}
 */
export async function fetchTrucksWithRetry(dateStr, overrideUrl, targetCities, options = {}) {
  const maxRetries = Number(process.env.MAX_RETRY_COUNT || 10);
  const { currentFailCount, isPaused, pausedCities, cityFailCounts } = await loadCityStatus(dateStr);

  const effectiveTargetCities = Array.isArray(targetCities)
    ? targetCities.filter((c) => !pausedCities.includes(c))
    : targetCities;

  const isCityLevelPaused =
    Array.isArray(targetCities) &&
    targetCities.length > 0 &&
    pausedCities.length > 0 &&
    effectiveTargetCities.length === 0;

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

  try {
    const intakeResult = await fetchActiveTrucks({
      targetCities: effectiveTargetCities,
      overrideUrl,
      pausedCities,
      timeoutMs: options.timeoutMs,
    });

    if (intakeResult.ok || intakeResult.data.length > 0 || (intakeResult.sourceStats && intakeResult.sourceStats.some(s => s.ok))) {
      const succeededUrls = intakeResult.sourceStats.filter((s) => s.ok).map((s) => s.url);
      const succeededCities = MONITORED_CITIES.filter((city) => {
        const url = CITY_API_URL_MAP[city];
        return succeededUrls.includes(url);
      });

      const successResult = await updateStatusOnSuccess({
        dateStr,
        succeededCities,
        cityFailCounts,
        pausedCities,
      });

      const failedSources = intakeResult.sourceStats.filter((s) => !s.ok);
      let partialShouldPause = false;
      let latestPaused = successResult.pausedCities;
      let latestFailCounts = successResult.cityFailCounts;

      if (failedSources.length > 0) {
        const failedCities = failedSources.map((s) => s.city || getCityFromApiUrl(s.url)).filter(Boolean);
        if (failedCities.length > 0) {
          const failRes = await updateStatusOnFailure({
            dateStr,
            failedCities,
            cityFailCounts: successResult.cityFailCounts,
            pausedCities: successResult.pausedCities,
            maxRetries,
            errorMessage: intakeResult.errors ? intakeResult.errors.join('; ') : '部分來源失敗',
            targetCities,
            currentFailCount,
          });
          partialShouldPause = failRes.shouldPause;
          latestPaused = failRes.pausedCities;
          latestFailCounts = failRes.cityFailCounts;
        }
      }

      return {
        ok: true,
        data: intakeResult.data,
        paused: partialShouldPause,
        retryCount: 0,
        errors: intakeResult.errors,
        sourceStats: intakeResult.sourceStats,
      };
    } else {
      throw new Error(`所有車輛 API 來源皆連線失敗: ${intakeResult.errors ? intakeResult.errors.join('; ') : '未知錯誤'}`);
    }
  } catch (err) {
    const failedCities = (effectiveTargetCities && effectiveTargetCities.length > 0)
      ? effectiveTargetCities
      : (targetCities && targetCities.length > 0)
        ? targetCities
        : MONITORED_CITIES;

    const failRes = await updateStatusOnFailure({
      dateStr,
      failedCities,
      cityFailCounts,
      pausedCities,
      maxRetries,
      errorMessage: err.message,
      targetCities,
      currentFailCount,
    });

    const nextFailCount = failRes.failCount || (currentFailCount + 1);

    return {
      ok: false,
      data: [],
      paused: failRes.shouldPause,
      retryCount: nextFailCount,
      error: err.message,
    };
  }
}
