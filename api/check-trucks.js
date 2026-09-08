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
import { getTodaySuspendedCities } from '../lib/dailyStatus.js';
import { fetchTrucksWithRetry } from '../lib/truckApi.js';
import { processTruckArrivals, getActiveSubscriptionContext } from '../lib/coreProcessor.js';
import { recordExecutionLog, extractTriggerSource } from '../lib/logger.js';

// ── 常數 ────────────────────────────────────────────────────────────────────

// ── 主要 Handler ─────────────────────────────────────────────────────────────

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

export default async function handler(req, res) {
  const CRON_SECRET = process.env.CRON_SECRET;
  const triggerSource = extractTriggerSource(req);

  // ── 防禦層 1：Cron Secret 驗證 ───────────────────────────────────────────
  // Vercel Cron 會在 Authorization header 附加 Bearer <CRON_SECRET>
  const authHeader = req.headers['authorization'] ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (!CRON_SECRET || !safeCompare(token, CRON_SECRET)) {
    console.warn(`[Auth] 授權失敗，拒絕請求 (來源: ${triggerSource})。`);
    await recordExecutionLog({
      status: 'unauthorized',
      reason: 'invalid-cron-secret',
      triggerSource,
      details: {
        hasHeader: Boolean(authHeader),
        headerPrefix: authHeader ? authHeader.slice(0, 10) + '...' : 'none',
      },
    });
    return res.status(401).json({ ok: false, reason: 'Unauthorized', triggerSource });
  }

  // ── 防禦層 2：時間窗校驗（二次防線） ────────────────────────────────────
  const taiwanNowInfo = getTaiwanNow();
  const { hour, minute, dateStr } = taiwanNowInfo;

  if (!isWithinServiceWindow()) {
    console.log(
      `[TimeWindow] 目前台灣時間 ${hour}:${String(minute).padStart(2, '0')}，不在清運時段（17-21），略過執行。`
    );
    await recordExecutionLog({
      status: 'skipped',
      reason: 'outside-service-window',
      triggerSource,
      details: { hour, minute },
      dateStr,
    });
    return res
      .status(200)
      .json({ ok: true, skipped: true, reason: 'outside-service-window', triggerSource });
  }

  // ── 防禦層 3：天災停收快取（daily_status Lazy Load） ────────────────────
  let suspendedCities;
  try {
    suspendedCities = await getTodaySuspendedCities(dateStr);
  } catch (err) {
    // DGPA 或 DB 查詢異常：記錄錯誤並安全跳過，避免誤判為停收
    console.error(`[DailyStatus] 查詢異常，跳過本次執行：${err.message}`);
    await recordExecutionLog({
      status: 'error',
      reason: 'daily-status-check-failed',
      triggerSource,
      details: { error: err.message },
      dateStr,
    });
    return res.status(500).json({
      ok: false,
      reason: 'daily-status-check-failed',
      error: err.message,
      triggerSource,
    });
  }

  // '__ALL__' 為舊版相容標記，代表全部停收
  if (suspendedCities.includes('__ALL__')) {
    console.log(
      `[Suspension] 今日（${dateStr}）天然災害全面停收，系統靜默休眠。`
    );
    await recordExecutionLog({
      status: 'skipped',
      reason: 'suspension-day',
      triggerSource,
      details: { suspendedCities },
      dateStr,
    });
    return res
      .status(200)
      .json({ ok: true, skipped: true, reason: 'suspension-day', triggerSource });
  }

  if (suspendedCities.length > 0) {
    console.log(
      `[Suspension] 今日（${dateStr}）以下縣市天災停收：${suspendedCities.join('、')}，其餘縣市照常。`
    );
  }

  // ── 通過所有防禦層，開始核心邏輯 ────────────────────────────────────────
  console.log(
    `[Main] 台灣時間 ${hour}:${String(minute).padStart(2, '0')}（${dateStr}），開始執行垃圾車追蹤核心邏輯 (來源: ${triggerSource})...`
  );

  try {
    // 智慧過濾：先取得今日活躍的路線與訂閱站點所屬縣市
    const subContext = await getActiveSubscriptionContext(taiwanNowInfo, suspendedCities);
    if (!subContext.ok) {
      console.error(`[Main] 查詢訂閱上下文失敗: ${subContext.error}`);
      await recordExecutionLog({
        status: 'error',
        reason: subContext.reason || 'db-context-error',
        triggerSource,
        details: { error: subContext.error },
        dateStr,
      });
      return res.status(500).json({ ok: false, reason: subContext.reason, error: subContext.error, triggerSource });
    }

    if (!subContext.hasActiveSubscriptions) {
      console.log(`[Main] 今日無排定營運之清運路線或活躍群組訂閱，安全略過。`);
      await recordExecutionLog({
        status: 'skipped',
        reason: subContext.reason || 'no-active-subscriptions',
        triggerSource,
        dateStr,
      });
      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: subContext.reason || 'no-active-subscriptions',
        triggerSource,
      });
    }

    console.log(`[Main] 今日有訂閱之目標縣市：${subContext.activeCities.join('、')}，啟動專屬精準抓取...`);

    // Task 4：外部 API Adapter（依目標縣市精準抓取，非訂閱縣市完全不連線）
    const { ok, data: truckData, paused, retryCount, error: fetchErr } =
      await fetchTrucksWithRetry(dateStr, undefined, subContext.activeCities);

    if (!ok) {
      console.warn(
        `[Main] 車輛資料抓取未完成 (paused=${paused}, retryCount=${retryCount}): ${fetchErr}`
      );
      await recordExecutionLog({
        status: 'warning',
        reason: paused ? 'api-retry-paused' : 'api-fetch-failed',
        triggerSource,
        recordsCount: 0,
        details: { retryCount, error: fetchErr },
        dateStr,
      });
      return res.status(200).json({
        ok: false,
        skipped: true,
        reason: paused ? 'api-retry-paused' : 'api-fetch-failed',
        retryCount,
        error: fetchErr,
        triggerSource,
      });
    }

    console.log(`[Main] 成功取得 ${truckData.length} 筆有效車輛動態資料。`);

    // Task 5：核心運算（Geofence、冷卻、配額熔斷、LINE 推播）
    const processResult = await processTruckArrivals(truckData, taiwanNowInfo, suspendedCities, subContext);

    // 產生各站點最近車輛摘要字串 (供 Log 檢索)
    const closestSummary = (processResult.closestTrucks || [])
      .map((st) => {
        if (!st.closestTruck) return `${st.stopName}: 無在線車輛`;
        return `${st.stopName}: ${st.closestTruck.carId} (${st.closestTruck.distanceMeters}m)`;
      })
      .join('; ');

    const executionStatus = (processResult.failedNotifications > 0)
      ? 'warning'
      : 'success';

    await recordExecutionLog({
      status: executionStatus,
      reason: processResult.reason || 'processed-successfully',
      triggerSource,
      recordsCount: truckData.length,
      matchedArrivals: processResult.matchedArrivals,
      sentNotifications: processResult.sentNotifications,
      details: {
        closestSummary,
        closestTrucks: processResult.closestTrucks || [],
        lineErrors: processResult.lineErrors || [],
      },
      dateStr,
    });

    return res.status(200).json({
      ok: true,
      skipped: false,
      recordsCount: truckData.length,
      matchedArrivals: processResult.matchedArrivals,
      sentNotifications: processResult.sentNotifications,
      failedNotifications: processResult.failedNotifications || 0,
      lineErrors: processResult.lineErrors || [],
      closestTrucks: processResult.closestTrucks || [],
      reason: processResult.reason || 'processed-successfully',
      triggerSource,
    });
  } catch (err) {
    console.error(`[Main] 核心邏輯發生未預期錯誤：${err.message}`);
    await recordExecutionLog({
      status: 'error',
      reason: 'internal-error',
      triggerSource,
      details: { error: err.message },
      dateStr,
    });
    return res.status(500).json({ ok: false, reason: 'internal-error', error: err.message, triggerSource });
  }
}

