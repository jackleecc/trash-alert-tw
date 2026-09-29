import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchNotification } from '../lib/notificationDispatcher.js';
import { CHANNEL_TAOYUAN, CHANNEL_DEFAULT } from '../lib/channelService.js';

test('multiChannelDispatch - routes Taoyuan intent to Taoyuan channel and independent quota', async () => {
  const calls = {
    claimNotification: [],
    reserveQuota: [],
    sendLinePushMessage: [],
    releaseNotificationClaim: [],
    releaseQuotaReservation: [],
  };

  const adapters = {
    claimNotification: async (groupId, routeId, stopId, carId) => {
      calls.claimNotification.push({ groupId, routeId, stopId, carId });
      return 201;
    },
    reserveQuota: async (quotaKey) => {
      calls.reserveQuota.push(quotaKey);
      return { reserved: true, usedCount: 1, newlyMelted: false };
    },
    sendLinePushMessage: async (groupId, msgText, options) => {
      calls.sendLinePushMessage.push({ groupId, msgText, options });
      return { ok: true, status: 200 };
    },
    releaseNotificationClaim: async (logId) => {
      calls.releaseNotificationClaim.push(logId);
    },
    releaseQuotaReservation: async (quotaKey) => {
      calls.releaseQuotaReservation.push(quotaKey);
    },
  };

  const taoyuanIntent = {
    groupId: 'Cbc0aef28eb6226fafe1ea7e5a6e4487e',
    routeId: 'lagi2-006_2_21',
    stopId: 9,
    city: '桃園市',
    carId: 'KEK-3178',
    msgText: '【桃園楊梅垃圾車即將到站】',
    yearMonth: '2026-09',
  };

  const res = await dispatchNotification(taoyuanIntent, adapters);
  assert.equal(res.ok, true);
  assert.equal(res.status, 'sent');

  // Verify Taoyuan channel quota and push
  assert.equal(calls.reserveQuota[0], '2026-09:taoyuan', 'Quota key must be channel-specific for Taoyuan');
  assert.equal(calls.sendLinePushMessage[0].options?.channelId, CHANNEL_TAOYUAN, 'sendLinePushMessage options must include channelId=taoyuan');
});

test('multiChannelDispatch - routes Xizhi and Tainan intents to default channel', async () => {
  const calls = {
    reserveQuota: [],
    sendLinePushMessage: [],
  };

  const adapters = {
    claimNotification: async () => 301,
    reserveQuota: async (quotaKey) => {
      calls.reserveQuota.push(quotaKey);
      return { reserved: true, usedCount: 150, newlyMelted: false };
    },
    sendLinePushMessage: async (groupId, msgText, options) => {
      calls.sendLinePushMessage.push({ groupId, msgText, options });
      return { ok: true, status: 200 };
    },
  };

  const xizhiIntent = {
    groupId: 'C8b514cecb1141d158bb44a19f33eb291',
    routeId: '221010',
    stopId: 3,
    city: '新北市',
    msgText: '【汐止垃圾車到站】',
    yearMonth: '2026-09',
  };

  await dispatchNotification(xizhiIntent, adapters);
  assert.equal(calls.reserveQuota[0], '2026-09', 'Quota key for default channel should be YYYY-MM');
  assert.equal(calls.sendLinePushMessage[0].options?.channelId, CHANNEL_DEFAULT, 'options must include channelId=default');
});

test('multiChannelDispatch - Taoyuan failure rolls back independent quota', async () => {
  const calls = {
    releaseNotificationClaim: [],
    releaseQuotaReservation: [],
  };

  const adapters = {
    claimNotification: async () => 401,
    reserveQuota: async () => ({ reserved: true, usedCount: 5, newlyMelted: false }),
    sendLinePushMessage: async () => ({ ok: false, status: 500, error: 'LINE_API_ERROR' }),
    releaseNotificationClaim: async (logId) => calls.releaseNotificationClaim.push(logId),
    releaseQuotaReservation: async (quotaKey) => calls.releaseQuotaReservation.push(quotaKey),
  };

  const taoyuanIntent = {
    groupId: 'Cbc0aef28eb6226fafe1ea7e5a6e4487e',
    routeId: 'lagi2-006_2_21',
    stopId: 9,
    city: '桃園市',
    msgText: '【桃園楊梅垃圾車即將到站】',
    yearMonth: '2026-09',
  };

  const res = await dispatchNotification(taoyuanIntent, adapters);
  assert.equal(res.ok, false);
  assert.equal(res.status, 'delivery_failed');
  assert.equal(calls.releaseQuotaReservation[0], '2026-09:taoyuan', 'Quota release must target Taoyuan quota key');
});
