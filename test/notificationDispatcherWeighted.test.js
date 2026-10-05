import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchNotification } from '../lib/notificationDispatcher.js';

test('dispatchNotification - reserves and rolls back member-weighted quota', async () => {
  const calls = {
    reserveQuota: [],
    releaseQuotaReservation: [],
    sendLinePushMessage: [],
  };

  const adapters = {
    claimNotification: async () => 999,
    releaseNotificationClaim: async () => {},
    reserveQuota: async (key, amount) => {
      calls.reserveQuota.push({ key, amount });
      return { reserved: true, usedCount: 45 };
    },
    releaseQuotaReservation: async (key, amount) => {
      calls.releaseQuotaReservation.push({ key, amount });
    },
    sendLinePushMessage: async () => ({ ok: false, error: 'Simulated network error' }),
    getYearMonth: () => '2026-10',
  };

  const intent = {
    groupId: 'Cbc0aef28eb6226fafe1ea7e5a6e4487e',
    routeId: 'lagi2-006_2_21',
    stopId: 9,
    city: '桃園市',
    messageText: 'Test alert',
    memberCount: 9,
  };

  const res = await dispatchNotification(intent, adapters);
  assert.equal(res.ok, false);
  assert.equal(res.status, 'delivery_failed');

  // Verify reserveQuota was called with amount = 9
  assert.equal(calls.reserveQuota.length, 1);
  assert.deepEqual(calls.reserveQuota[0], {
    key: '2026-10:taoyuan',
    amount: 9,
  });

  // Verify releaseQuotaReservation was called with amount = 9
  assert.equal(calls.releaseQuotaReservation.length, 1);
  assert.deepEqual(calls.releaseQuotaReservation[0], {
    key: '2026-10:taoyuan',
    amount: 9,
  });
});
