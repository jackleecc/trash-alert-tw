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

export const DEFAULT_TRUCK_API_URLS = [
  // 高雄市環保局即時動態 API
  'https://api.kcg.gov.tw/api/service/Get/aaf4ce4b-4ca8-43de-bfaf-6dc97e89cac0',
  // 新北市環保局即時動態 API (涵蓋汐止區等全區)
  'https://data.ntpc.gov.tw/api/datasets/28ab4122-60e1-4065-98e5-abccb69aaca6/json?page=0&size=1000',
];

const FETCH_TIMEOUT_MS = 8000; // 8 秒逾時
const MAX_RETRY_COUNT = 3;

/**
 * 取得欲抓取的目標 API URL 清單
 * @param {string} [overrideUrl]
 * @returns {string[]}
 */
export function getTargetApiUrls(overrideUrl) {
  if (overrideUrl) return [overrideUrl];
  if (process.env.TRUCK_API_URL) {
    return process.env.TRUCK_API_URL.split(',')
      .map((u) => u.trim())
      .filter(Boolean);
  }
  return DEFAULT_TRUCK_API_URLS;
}

/**
 * 發送 HTTP 請求抓取外部車輛 API 資料
 * @param {string} url
 * @returns {Promise<any>}
 */
async function fetchRawTruckData(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; TrashAlertBot/1.0; +https://github.com/jackleecc/trash-alert-tw)',
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
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 抓取環保局車輛動態資料（支援多縣市 API 同步抓取），並處理非同步重試與告警邏輯
 *
 * @param {string} dateStr - 台灣今日日期 (YYYY-MM-DD)
 * @param {string} [overrideUrl] - 可選的自訂 API URL (用於測試或環境變數覆寫)
 * @returns {Promise<{ ok: boolean, data: any[], paused: boolean, retryCount: number, error?: string }>}
 */
export async function fetchTrucksWithRetry(dateStr, overrideUrl) {
  const targetUrls = getTargetApiUrls(overrideUrl);

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

    settledResults.forEach((res, index) => {
      if (res.status === 'fulfilled') {
        allCleanedData.push(...res.value);
      } else {
        const failedUrl = targetUrls[index];
        console.warn(`[TruckAPI] 來源抓取失敗 (${failedUrl}): ${res.reason?.message}`);
        errors.push(res.reason?.message || '未知錯誤');
      }
    });

    // 只要有任何一個來源成功，即視為抓取成功
    if (allCleanedData.length > 0 || errors.length < targetUrls.length) {
      if (currentFailCount > 0) {
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
