/**
 * api/check-trucks.js
 * Vercel Serverless Function — 主要 Cron 入口點
 *
 * 觸發排程：`0 9 * * *`（UTC），對應台灣時間每日 17:00 執行一次。
 *
 * 防禦層（按執行順序）：
 *   1. Cron Secret 驗證       — 阻斷非授權的外部呼叫
 *   2. 時間窗校驗 (17-21 TW)  — 阻斷非清運時段的無效運算（二次校驗）
 *   3. 天災停收快取 (daily_status) — DGPA Lazy Load，停收則靜默休眠
 *
 * 後續核心邏輯（Task 4 / Task 5）在通過防禦層後才被呼叫。
 */

import crypto from 'node:crypto';
import { isWithinServiceWindow, getTaiwanNow } from '../lib/timeUtils.js';
import { getTodaySuspensionStatus } from '../lib/dailyStatus.js';
import { fetchTrucksWithRetry } from '../lib/truckApi.js';
import { processTruckArrivals } from '../lib/coreProcessor.js';

// ── 常數 ────────────────────────────────────────────────────────────────────

const CRON_SECRET = process.env.CRON_SECRET;

/**
 * 安全字串比對，防禦 Timing Attack
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ── 主要 Handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // ── 防禦層 1：Cron Secret 驗證 ───────────────────────────────────────────
  // Vercel Cron 會在 Authorization header 附加 Bearer <CRON_SECRET>
  const authHeader = req.headers['authorization'] ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (!CRON_SECRET || !safeCompare(token, CRON_SECRET)) {
    console.warn('[Auth] 授權失敗，拒絕請求。');
    return res.status(401).json({ ok: false, reason: 'Unauthorized' });
  }

  // ── 防禦層 2：時間窗校驗（二次防線） ────────────────────────────────────
  const taiwanNowInfo = getTaiwanNow();
  const { hour, minute, dateStr } = taiwanNowInfo;

  if (!isWithinServiceWindow()) {
    console.log(
      `[TimeWindow] 目前台灣時間 ${hour}:${String(minute).padStart(2, '0')}，不在清運時段（17-21），略過執行。`
    );
    return res
      .status(200)
      .json({ ok: true, skipped: true, reason: 'outside-service-window' });
  }

  // ── 防禦層 3：天災停收快取（daily_status Lazy Load） ────────────────────
  let isSuspended;
  try {
    isSuspended = await getTodaySuspensionStatus(dateStr);
  } catch (err) {
    // DGPA 或 DB 查詢異常：記錄錯誤並安全跳過，避免誤判為停收
    console.error(`[DailyStatus] 查詢異常，跳過本次執行：${err.message}`);
    return res.status(500).json({
      ok: false,
      reason: 'daily-status-check-failed',
      error: err.message,
    });
  }

  if (isSuspended) {
    console.log(
      `[Suspension] 今日（${dateStr}）高雄市天然災害停收，系統靜默休眠。`
    );
    return res
      .status(200)
      .json({ ok: true, skipped: true, reason: 'suspension-day' });
  }

  // ── 通過所有防禦層，開始核心邏輯 ────────────────────────────────────────
  console.log(
    `[Main] 台灣時間 ${hour}:${String(minute).padStart(2, '0')}（${dateStr}），開始執行垃圾車追蹤核心邏輯...`
  );

  try {
    // Task 4：外部 API Adapter（環保局 API 抓取、Schema 清洗與非同步重試）
    const { ok, data: truckData, paused, retryCount, error: fetchErr } =
      await fetchTrucksWithRetry(dateStr);

    if (!ok) {
      console.warn(
        `[Main] 車輛資料抓取未完成 (paused=${paused}, retryCount=${retryCount}): ${fetchErr}`
      );
      return res.status(200).json({
        ok: false,
        skipped: true,
        reason: paused ? 'api-retry-paused' : 'api-fetch-failed',
        retryCount,
        error: fetchErr,
      });
    }

    console.log(`[Main] 成功取得 ${truckData.length} 筆有效車輛動態資料。`);

    // Task 5：核心運算（Geofence、冷卻、配額熔斷、LINE 推播）
    const processResult = await processTruckArrivals(truckData, taiwanNowInfo);

    return res.status(200).json({
      ok: true,
      skipped: false,
      recordsCount: truckData.length,
      matchedArrivals: processResult.matchedArrivals,
      sentNotifications: processResult.sentNotifications,
      reason: processResult.reason || 'processed-successfully',
    });
  } catch (err) {
    console.error(`[Main] 核心邏輯發生未預期錯誤：${err.message}`);
    return res.status(500).json({ ok: false, reason: 'internal-error', error: err.message });
  }
}

