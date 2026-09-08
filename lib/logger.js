/**
 * lib/logger.js
 * 排程執行稽核日誌與除錯追蹤服務 (Execution & Audit Logger)
 *
 * 核心功能：
 *   1. 記錄每次 /api/check-trucks 的執行結果、觸發來源與授權狀態至 Supabase execution_logs。
 *   2. 支援資料庫自動降級 (Graceful Fallback)：
 *      若 execution_logs 資料表尚未建立，自動轉寫入 daily_status，絕不中斷核心檢核流程。
 *   3. 提供標準化 console 輸出與觸發來源自動解析。
 */

import { supabase } from './supabaseClient.js';
import { getTaiwanNow } from './timeUtils.js';

/**
 * 從 HTTP Request 解析觸發來源識別字串
 * @param {object} req - HTTP Request 物件
 * @returns {string}
 */
export function extractTriggerSource(req) {
  if (!req || typeof req !== 'object') return 'unknown';

  const userAgent = req.headers?.['user-agent'] || '';
  const xVercelCron = req.headers?.['x-vercel-cron'];

  if (xVercelCron || userAgent.toLowerCase().includes('vercel-cron')) {
    return 'vercel-cron';
  }
  if (userAgent.toLowerCase().includes('cron-job.org')) {
    return 'cron-job.org';
  }
  if (userAgent.toLowerCase().includes('github-actions')) {
    return 'github-actions';
  }
  if (userAgent.toLowerCase().includes('curl')) {
    return 'curl';
  }

  return userAgent ? userAgent.slice(0, 50) : 'unknown';
}

/**
 * 格式化目前台灣時間字串 'YYYY-MM-DD HH:mm:ss'
 * @returns {string}
 */
export function formatTaiwanTimestamp() {
  const { now } = getTaiwanNow();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  const hour = String(now.getUTCHours()).padStart(2, '0');
  const minute = String(now.getUTCMinutes()).padStart(2, '0');
  const second = String(now.getUTCSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

/**
 * 寫入排程執行紀錄 (含 execution_logs 寫入與 daily_status 備援)
 *
 * @param {object} logEntry
 * @param {'success' | 'unauthorized' | 'skipped' | 'warning' | 'error'} logEntry.status - 執行狀態
 * @param {string} logEntry.reason - 關鍵原因代碼
 * @param {string} [logEntry.triggerSource] - 觸發來源 (如 'cron-job.org')
 * @param {number} [logEntry.recordsCount=0] - 抓取到的車輛總數
 * @param {number} [logEntry.matchedArrivals=0] - 到站匹配數
 * @param {number} [logEntry.sentNotifications=0] - 發送通知數
 * @param {object} [logEntry.details] - 詳細資料 (如最近車輛距離、錯誤物件)
 * @param {string} [logEntry.dateStr] - 台灣日期 'YYYY-MM-DD'
 * @returns {Promise<{ ok: boolean, target: 'execution_logs' | 'daily_status', error?: string }>}
 */
export async function recordExecutionLog(logEntry) {
  const twTime = formatTaiwanTimestamp();
  const {
    status,
    reason,
    triggerSource = 'unknown',
    recordsCount = 0,
    matchedArrivals = 0,
    sentNotifications = 0,
    details = {},
    dateStr = getTaiwanNow().dateStr,
  } = logEntry;

  // 1. 本地 console 結構化輸出
  const logPrefix = `[Audit][${status.toUpperCase()}][${triggerSource}]`;
  const summaryMsg = `${logPrefix} ${twTime} | reason=${reason} | trucks=${recordsCount} | arrivals=${matchedArrivals} | sent=${sentNotifications}`;
  
  if (status === 'error' || status === 'unauthorized') {
    console.warn(summaryMsg, details);
  } else {
    console.log(summaryMsg);
  }

  const payload = {
    taiwan_time: twTime,
    trigger_source: triggerSource,
    status,
    reason,
    records_count: recordsCount,
    matched_arrivals: matchedArrivals,
    sent_notifications: sentNotifications,
    details,
  };

  // 2. 優先嘗試寫入 public.execution_logs
  try {
    const { error: insertErr } = await supabase
      .from('execution_logs')
      .insert(payload);

    if (!insertErr) {
      return { ok: true, target: 'execution_logs' };
    }

    // 若錯誤原因非「表不存在」，記錄警告
    const isTableMissing =
      insertErr.code === '42P01' ||
      insertErr.message?.includes('does not exist') ||
      insertErr.message?.includes('schema cache');

    if (!isTableMissing) {
      console.warn(`[Audit] 寫入 execution_logs 失敗: ${insertErr.message}`);
    }
  } catch (err) {
    // 忽略連線或初始化例外，轉入降級處理
  }

  // 3. 降級備援：更新 daily_status，確保留下除錯軌跡
  try {
    const updatePayload = {
      updated_at: new Date().toISOString(),
    };

    // 若為授權失敗或例外錯誤，標記在 last_api_error
    if (status === 'unauthorized') {
      updatePayload.last_api_error = `[AUTH_FAIL ${twTime}] 授權失敗 (來源: ${triggerSource}): ${reason}`;
    } else if (status === 'error') {
      updatePayload.last_api_error = `[ERROR ${twTime}] 執行例外: ${details?.error || reason}`;
    } else if (details?.closestSummary) {
      // 正常但無通知時，記錄最近車輛摘要以供查閱
      updatePayload.last_api_error = `[INFO ${twTime}] 最近車輛: ${details.closestSummary}`;
    }

    const { error: dsErr } = await supabase
      .from('daily_status')
      .update(updatePayload)
      .eq('date', dateStr);

    if (dsErr) {
      console.warn(`[Audit] 降級更新 daily_status 失敗: ${dsErr.message}`);
      return { ok: false, target: 'daily_status', error: dsErr.message };
    }

    return { ok: true, target: 'daily_status' };
  } catch (err) {
    return { ok: false, target: 'daily_status', error: err.message };
  }
}

/**
 * 查詢最近的排程執行日誌
 * @param {number} [limit=20]
 * @returns {Promise<{ ok: boolean, logs: any[], source: 'execution_logs' | 'daily_status', error?: string }>}
 */
export async function getRecentExecutionLogs(limit = 20) {
  try {
    const { data, error } = await supabase
      .from('execution_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (!error && Array.isArray(data)) {
      return { ok: true, logs: data, source: 'execution_logs' };
    }
  } catch {
    // execution_logs 不存在時降級
  }

  // 降級讀取 daily_status
  try {
    const { data, error } = await supabase
      .from('daily_status')
      .select('*')
      .order('date', { ascending: false })
      .limit(limit);

    return {
      ok: !error,
      logs: data || [],
      source: 'daily_status',
      error: error?.message,
    };
  } catch (err) {
    return { ok: false, logs: [], source: 'daily_status', error: err.message };
  }
}
