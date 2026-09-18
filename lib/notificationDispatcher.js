/**
 * lib/notificationDispatcher.js
 * 核心到站通知發送調度器 (Notification Dispatcher)
 *
 * 負責單一或批次通知的冷卻認領、額度保留、推播與錯誤復原回滾。
 */

import {
  claimNotification as defaultClaimNotification,
  releaseNotificationClaim as defaultReleaseNotificationClaim
} from './cooldownService.js';

import {
  reserveQuota as defaultReserveQuota,
  releaseQuotaReservation as defaultReleaseQuotaReservation,
  getYearMonth as defaultGetYearMonth
} from './quotaService.js';

import {
  sendLinePushMessage as defaultSendLinePushMessage
} from './lineClient.js';

/**
 * 調度並發送單一到站通知
 *
 * @param {Object} intent - 通知意圖
 * @param {string} intent.groupId - LINE 群組 ID
 * @param {string} intent.routeId - 路線代碼
 * @param {string|number} intent.stopId - 站點代碼
 * @param {string} [intent.carId] - 車牌或車輛識別代碼
 * @param {string} intent.msgText - 推播訊息內容
 * @param {string} [intent.yearMonth] - 當前年月份 (YYYY-MM)，預設為當前台北時間年月
 * @param {Object} [adapters={}] - 依賴介面適配器 (便於單元測試與自訂注入)
 * @returns {Promise<{ ok: boolean, status: string, logId?: number, error?: any }>}
 */
export async function dispatchNotification(intent, adapters = {}) {
  const claimNotification = adapters.claimNotification || defaultClaimNotification;
  const reserveQuota = adapters.reserveQuota || defaultReserveQuota;
  const sendLinePushMessage = adapters.sendLinePushMessage || defaultSendLinePushMessage;
  const releaseNotificationClaim = adapters.releaseNotificationClaim || defaultReleaseNotificationClaim;
  const releaseQuotaReservation = adapters.releaseQuotaReservation || defaultReleaseQuotaReservation;
  const getYearMonth = adapters.getYearMonth || defaultGetYearMonth;

  const yearMonth = intent.yearMonth || getYearMonth();

  try {
    // 1. Atomic claim
    const logId = await claimNotification(
      intent.groupId,
      intent.routeId,
      intent.stopId,
      intent.carId,
      intent.cooldownMinutes ?? 30
    );

    if (logId === null || logId === undefined) {
      return { ok: true, status: 'in_cooldown' };
    }

    // 2. Quota reserve
    let quotaRes;
    try {
      quotaRes = await reserveQuota(yearMonth);
    } catch (err) {
      await releaseNotificationClaim(logId);
      throw err;
    }

    if (!quotaRes || !quotaRes.reserved) {
      await releaseNotificationClaim(logId);
      return { ok: false, status: 'quota_melted' };
    }

    const message = intent.messageText || intent.msgText;

    // 3. Line push
    let pushRes;
    try {
      pushRes = await sendLinePushMessage(intent.groupId, message);
    } catch (err) {
      await Promise.all([
        releaseNotificationClaim(logId),
        releaseQuotaReservation(yearMonth)
      ]);
      return {
        ok: false,
        status: 'delivery_failed',
        error: err.message || String(err)
      };
    }

    // 4. If push fails
    if (!pushRes || !pushRes.ok) {
      await Promise.all([
        releaseNotificationClaim(logId),
        releaseQuotaReservation(yearMonth)
      ]);
      return {
        ok: false,
        status: 'delivery_failed',
        error: pushRes?.error,
        httpStatus: pushRes?.status
      };
    }

    // 5. Success
    return {
      ok: true,
      status: 'sent',
      logId
    };
  } catch (err) {
    return {
      ok: false,
      status: 'error',
      error: err.message || err
    };
  }
}

/**
 * 批次調度並發送多個到站通知
 *
 * @param {Array<Object>} intents - 通知意圖陣列
 * @param {Object} [adapters={}] - 依賴介面適配器
 * @returns {Promise<{ total: number, sent: number, suppressed: number, failed: number, errors: Array<any> }>}
 */
export async function dispatchNotificationBatch(intents, adapters = {}) {
  if (!Array.isArray(intents) || intents.length === 0) {
    return { total: 0, sent: 0, suppressed: 0, failed: 0, errors: [] };
  }

  const results = await Promise.allSettled(
    intents.map(intent => dispatchNotification(intent, adapters))
  );

  let sent = 0;
  let suppressed = 0;
  let failed = 0;
  const errors = [];

  for (let i = 0; i < intents.length; i++) {
    const intent = intents[i];
    const res = results[i];

    if (res.status === 'fulfilled') {
      const data = res.value;
      if (data.status === 'sent') {
        sent++;
      } else if (data.status === 'in_cooldown') {
        suppressed++;
      } else if (
        data.status === 'quota_melted' ||
        data.status === 'delivery_failed' ||
        data.status === 'error' ||
        !data.ok
      ) {
        failed++;
        errors.push({
          groupId: intent.groupId,
          status: data.status,
          error: data.error
        });
      }
    } else {
      failed++;
      errors.push({
        groupId: intent.groupId,
        status: 'rejected',
        error: res.reason?.message || String(res.reason)
      });
    }
  }

  return {
    total: intents.length,
    sent,
    suppressed,
    failed,
    errors
  };
}

