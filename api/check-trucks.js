/**
 * api/check-trucks.js
 * Cloud Run HTTP Handler — 主要 Cron 入口點
 *
 * 觸發排程：cron-job.org / Cloud Scheduler / GitHub Actions
 *
 * 防禦層（按執行順序）：
 *   1. Cron Secret 驗證       — 阻斷非授權的外部呼叫
 *   2. 時間窗校驗 (17-21 TW)  — 阻斷非清運時段的無效運算（二次校驗）
 *   3. 天災停收快取 (daily_status) — DGPA Lazy Load，停收則靜默休眠
 *
 * 後續核心邏輯（Task 4 / Task 5）在通過防禦層後才被呼叫。
 */

import { isWithinServiceWindow, getTaiwanNow } from '../lib/timeUtils.js';
import { getTodaySuspendedCities } from '../lib/dailyStatus.js';
import { fetchTrucksWithRetry } from '../lib/truckApi.js';
import { executeTruckTrackingCycle } from '../lib/coreProcessor.js';
import { recordExecutionLog, extractTriggerSource } from '../lib/logger.js';
import { guardEndpoint } from '../lib/endpointGuard.js';

// ── 常數 ────────────────────────────────────────────────────────────────────

// ── 主要 Handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // 臺南市已全面遷移為 Android 手機端原生 App 中繼 (/api/tainan-relay)，雲端排程預設永久略過輪詢以防熔斷
  if (process.env.SKIP_TAINAN_POLLING === undefined) {
    process.env.SKIP_TAINAN_POLLING = 'true';
  }

  const guardResult = await guardEndpoint(req, res, { endpointName: '/api/check-trucks' });
  if (!guardResult.authorized) return;
  const { triggerSource } = guardResult;

  const taiwanNowInfo = getTaiwanNow();
  const { hour, minute, dateStr } = taiwanNowInfo;

  // ── 診斷模式：允許已授權 (Bearer CRON_SECRET) 之測試請求診斷代理狀態 ────
  const isDiagTest = req.query && (req.query.test_proxy === 'true' || req.query.diag === 'true');
  if (isDiagTest) {
    console.log(`[Diag] 觸發代理連線診斷測試 (來源: ${triggerSource})...`);
    const proxyUrl = process.env.TAINAN_PROXY_URL || null;
    const fetchResult = await fetchTrucksWithRetry(dateStr, undefined, ['台南市']);
    return res.status(200).json({
      ok: fetchResult.ok,
      isDiagTest: true,
      hasProxyUrl: Boolean(proxyUrl),
      proxyUrl: proxyUrl ? proxyUrl.slice(0, 20) + '...' : null,
      recordsCount: fetchResult.data ? fetchResult.data.length : 0,
      sourceStats: fetchResult.sourceStats,
      error: fetchResult.error,
      partialErrors: fetchResult.errors,
    });
  }

  // ── 防禦層 2：時間窗校驗（二次防線，支援已授權 force 測試） ───────────────
  const forceRun = req.query && (req.query.force === 'true' || req.query.bypass_window === 'true');

  if (!isWithinServiceWindow() && !forceRun) {
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
    const cycleResult = await executeTruckTrackingCycle({
      taiwanNowInfo,
      suspendedCities,
      forceRun,
    });

    if (cycleResult.skipped) {
      if (!cycleResult.ok) {
        const isDbContextError = cycleResult.reason === 'db-context-error' || (cycleResult.reason && cycleResult.reason.startsWith('db-'));
        await recordExecutionLog({
          status: isDbContextError ? 'error' : 'warning',
          reason: cycleResult.reason,
          triggerSource,
          recordsCount: 0,
          details: {
            retryCount: cycleResult.retryCount,
            error: cycleResult.error,
            sourceStats: cycleResult.sourceStats || [],
          },
          dateStr,
        });
        const statusCode = isDbContextError ? 500 : 200;
        return res.status(statusCode).json({ ...cycleResult, triggerSource });
      }

      await recordExecutionLog({
        status: 'skipped',
        reason: cycleResult.reason || 'no-active-subscriptions',
        triggerSource,
        details: {
          sleepingStops: cycleResult.sleepingStops || [],
          outOfWindowStops: cycleResult.outOfWindowStops || [],
        },
        dateStr,
      });
      return res.status(200).json({
        ...cycleResult,
        triggerSource,
      });
    }

    const closestSummary = (cycleResult.closestTrucks || [])
      .map((st) => {
        if (!st.closestTruck) return `${st.stopName}: 無在線車輛`;
        return `${st.stopName}: ${st.closestTruck.carId} (${st.closestTruck.distanceMeters}m)`;
      })
      .join('; ');

    const hasErrors =
      cycleResult.failedNotifications > 0 ||
      (cycleResult.partialErrors && cycleResult.partialErrors.length > 0);
    const executionStatus = hasErrors ? 'warning' : 'success';

    await recordExecutionLog({
      status: executionStatus,
      reason:
        cycleResult.reason ||
        (cycleResult.partialErrors?.length ? 'partial-fetch-error' : 'processed-successfully'),
      triggerSource,
      recordsCount: cycleResult.recordsCount,
      matchedArrivals: cycleResult.matchedArrivals,
      sentNotifications: cycleResult.sentNotifications,
      details: {
        closestSummary,
        closestTrucks: cycleResult.closestTrucks || [],
        lineErrors: cycleResult.lineErrors || [],
        sourceStats: cycleResult.sourceStats || [],
        partialErrors: cycleResult.partialErrors || [],
      },
      dateStr,
    });

    return res.status(200).json({
      ...cycleResult,
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

