import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  dispatchNotification,
  dispatchNotificationBatch
} from '../lib/notificationDispatcher.js';

test('Case 1: Success path - claim succeeds, quota reserved, push succeeds', async () => {
  const calls = {
    claimNotification: [],
    reserveQuota: [],
    sendLinePushMessage: [],
    releaseNotificationClaim: [],
    releaseQuotaReservation: []
  };

  const adapters = {
    claimNotification: async (groupId, routeId, stopId, carId) => {
      calls.claimNotification.push({ groupId, routeId, stopId, carId });
      return 101;
    },
    reserveQuota: async (yearMonth) => {
      calls.reserveQuota.push(yearMonth);
      return { reserved: true, usedCount: 15, newlyMelted: false };
    },
    sendLinePushMessage: async (groupId, msgText) => {
      calls.sendLinePushMessage.push({ groupId, msgText });
      return { ok: true, status: 200 };
    },
    releaseNotificationClaim: async (logId) => {
      calls.releaseNotificationClaim.push(logId);
    },
    releaseQuotaReservation: async (yearMonth) => {
      calls.releaseQuotaReservation.push(yearMonth);
    }
  };

  const intent = {
    groupId: 'test-group-1',
    routeId: 'R-100',
    stopId: 5,
    carId: 'TRUCK-888',
    msgText: '垃圾車即將抵達！',
    yearMonth: '2026-09'
  };

  const result = await dispatchNotification(intent, adapters);

  assert.equal(result.ok, true, 'Should return ok: true');
  assert.equal(result.status, 'sent', 'Should return status: sent');
  assert.equal(result.logId, 101, 'Should return the claimed logId');

  assert.equal(calls.claimNotification.length, 1, 'claimNotification should be called once');
  assert.deepEqual(calls.claimNotification[0], {
    groupId: 'test-group-1',
    routeId: 'R-100',
    stopId: 5,
    carId: 'TRUCK-888'
  });

  assert.equal(calls.reserveQuota.length, 1, 'reserveQuota should be called once');
  assert.equal(calls.reserveQuota[0], '2026-09');

  assert.equal(calls.sendLinePushMessage.length, 1, 'sendLinePushMessage should be called once');
  assert.deepEqual(calls.sendLinePushMessage[0], {
    groupId: 'test-group-1',
    msgText: '垃圾車即將抵達！'
  });

  assert.equal(calls.releaseNotificationClaim.length, 0, 'Should not release claim on success');
  assert.equal(calls.releaseQuotaReservation.length, 0, 'Should not release quota on success');
});

test('Case 2: Cooldown suppression - claim returns null', async () => {
  const calls = {
    claimNotification: [],
    reserveQuota: [],
    sendLinePushMessage: []
  };

  const adapters = {
    claimNotification: async (groupId, routeId, stopId, carId) => {
      calls.claimNotification.push({ groupId, routeId, stopId, carId });
      return null; // Indicates in cooldown
    },
    reserveQuota: async (yearMonth) => {
      calls.reserveQuota.push(yearMonth);
      return { reserved: true, usedCount: 15, newlyMelted: false };
    },
    sendLinePushMessage: async (groupId, msgText) => {
      calls.sendLinePushMessage.push({ groupId, msgText });
      return { ok: true, status: 200 };
    }
  };

  const intent = {
    groupId: 'test-group-2',
    routeId: 'R-200',
    stopId: 12,
    carId: 'TRUCK-999',
    msgText: '垃圾車即將抵達！',
    yearMonth: '2026-09'
  };

  const result = await dispatchNotification(intent, adapters);

  assert.equal(result.ok, true, 'Should return ok: true for cooldown suppression');
  assert.equal(result.status, 'in_cooldown', 'Should return status: in_cooldown');
  assert.equal(calls.reserveQuota.length, 0, 'reserveQuota must NOT be called when in cooldown');
  assert.equal(calls.sendLinePushMessage.length, 0, 'sendLinePushMessage must NOT be called when in cooldown');
});

test('Case 3: Quota melt suppression - claim succeeds, but reserveQuota returns reserved: false', async () => {
  const calls = {
    claimNotification: [],
    reserveQuota: [],
    sendLinePushMessage: [],
    releaseNotificationClaim: []
  };

  const adapters = {
    claimNotification: async (groupId, routeId, stopId, carId) => {
      calls.claimNotification.push({ groupId, routeId, stopId, carId });
      return 102;
    },
    reserveQuota: async (yearMonth) => {
      calls.reserveQuota.push(yearMonth);
      return { reserved: false, usedCount: 200, newlyMelted: false };
    },
    sendLinePushMessage: async (groupId, msgText) => {
      calls.sendLinePushMessage.push({ groupId, msgText });
      return { ok: true, status: 200 };
    },
    releaseNotificationClaim: async (logId) => {
      calls.releaseNotificationClaim.push(logId);
    }
  };

  const intent = {
    groupId: 'test-group-3',
    routeId: 'R-300',
    stopId: 8,
    carId: 'TRUCK-777',
    msgText: '垃圾車即將抵達！',
    yearMonth: '2026-09'
  };

  const result = await dispatchNotification(intent, adapters);

  assert.equal(result.ok, false, 'Should return ok: false for quota melted');
  assert.equal(result.status, 'quota_melted', 'Should return status: quota_melted');
  assert.equal(calls.releaseNotificationClaim.length, 1, 'releaseNotificationClaim should be called once');
  assert.equal(calls.releaseNotificationClaim[0], 102, 'Should release the exact claim logId');
  assert.equal(calls.sendLinePushMessage.length, 0, 'sendLinePushMessage must NOT be called when quota melted');
});

test('Case 4: Delivery failure - push fails, rollbacks claim and quota reservation', async () => {
  const calls = {
    claimNotification: [],
    reserveQuota: [],
    sendLinePushMessage: [],
    releaseNotificationClaim: [],
    releaseQuotaReservation: []
  };

  const adapters = {
    claimNotification: async (groupId, routeId, stopId, carId) => {
      calls.claimNotification.push({ groupId, routeId, stopId, carId });
      return 103;
    },
    reserveQuota: async (yearMonth) => {
      calls.reserveQuota.push(yearMonth);
      return { reserved: true, usedCount: 16, newlyMelted: false };
    },
    sendLinePushMessage: async (groupId, msgText) => {
      calls.sendLinePushMessage.push({ groupId, msgText });
      return { ok: false, status: 500, error: 'LINE server 500 internal error' };
    },
    releaseNotificationClaim: async (logId) => {
      calls.releaseNotificationClaim.push(logId);
    },
    releaseQuotaReservation: async (yearMonth) => {
      calls.releaseQuotaReservation.push(yearMonth);
    }
  };

  const intent = {
    groupId: 'test-group-4',
    routeId: 'R-400',
    stopId: 3,
    carId: 'TRUCK-666',
    msgText: '垃圾車即將抵達！',
    yearMonth: '2026-09'
  };

  const result = await dispatchNotification(intent, adapters);

  assert.equal(result.ok, false, 'Should return ok: false on delivery failure');
  assert.equal(result.status, 'delivery_failed', 'Should return status: delivery_failed');
  assert.equal(calls.releaseNotificationClaim.length, 1, 'releaseNotificationClaim should be called on push failure');
  assert.equal(calls.releaseNotificationClaim[0], 103, 'Should release the exact claim logId');
  assert.equal(calls.releaseQuotaReservation.length, 1, 'releaseQuotaReservation should be called on push failure');
  assert.equal(calls.releaseQuotaReservation[0], '2026-09', 'Should release quota for the correct yearMonth');
});

test('Case 5: Batch dispatch - handles multiple intents concurrently with summary counts', async () => {
  const adapters = {
    claimNotification: async (groupId, routeId, stopId, carId) => {
      if (groupId === 'group-cooldown') {
        return null;
      }
      return groupId === 'group-success' ? 201 : 202;
    },
    reserveQuota: async () => ({ reserved: true, usedCount: 10, newlyMelted: false }),
    sendLinePushMessage: async (groupId) => {
      if (groupId === 'group-fail') {
        return { ok: false, status: 400, error: 'Invalid group token' };
      }
      return { ok: true, status: 200 };
    },
    releaseNotificationClaim: async () => {},
    releaseQuotaReservation: async () => {}
  };

  const intents = [
    {
      groupId: 'group-success',
      routeId: 'R-1',
      stopId: 10,
      carId: 'T-1',
      msgText: 'Success truck',
      yearMonth: '2026-09'
    },
    {
      groupId: 'group-cooldown',
      routeId: 'R-2',
      stopId: 20,
      carId: 'T-2',
      msgText: 'Cooldown truck',
      yearMonth: '2026-09'
    },
    {
      groupId: 'group-fail',
      routeId: 'R-3',
      stopId: 30,
      carId: 'T-3',
      msgText: 'Fail truck',
      yearMonth: '2026-09'
    }
  ];

  const summary = await dispatchNotificationBatch(intents, adapters);

  assert.equal(summary.total, 3, 'Total dispatched intents should be 3');
  assert.equal(summary.sent, 1, 'Sent notifications should be 1');
  assert.equal(summary.suppressed, 1, 'Suppressed notifications should be 1');
  assert.equal(summary.failed, 1, 'Failed notifications should be 1');
  assert.equal(Array.isArray(summary.errors), true, 'Summary errors should be an array');
  assert.equal(summary.errors.length, 1, 'Errors array should contain 1 failure entry');
  assert.equal(summary.errors[0].groupId, 'group-fail', 'Error should capture the failed group ID');
});
