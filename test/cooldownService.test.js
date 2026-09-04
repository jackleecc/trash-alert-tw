import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { supabase } from '../lib/supabaseClient.js';
import {
  isInCooldown,
  recordNotificationLog,
  claimNotification,
  releaseNotificationClaim
} from '../lib/cooldownService.js';

test('isInCooldown - returns true when log exists', async () => {
  mock.method(supabase, 'from', () => ({
    select: () => {
      const q = {
        eq: () => q,
        gte: () => q,
        limit: () => q,
        then: function(resolve) {
          resolve({ data: [{ id: 1, sent_at: '2026-09-02T10:00:00Z' }], error: null });
        }
      };
      return q;
    }
  }));

  const res = await isInCooldown('G1', 'R1', 1);
  assert.equal(res, true);
  mock.restoreAll();
});

test('isInCooldown - returns false when no log exists', async () => {
  mock.method(supabase, 'from', () => ({
    select: () => {
      const q = {
        eq: () => q,
        gte: () => q,
        limit: () => q,
        then: function(resolve) {
          resolve({ data: [], error: null });
        }
      };
      return q;
    }
  }));

  const res = await isInCooldown('G1', 'R1', 1);
  assert.equal(res, false);
  mock.restoreAll();
});

test('recordNotificationLog - inserts log', async () => {
  let insertedData = null;
  mock.method(supabase, 'from', () => ({
    insert: async (data) => {
      insertedData = data;
      return { error: null };
    }
  }));

  const res = await recordNotificationLog('G1', 'R1', 1, 'CAR1');
  assert.equal(res, true);
  assert.equal(insertedData.group_id, 'G1');
  assert.equal(insertedData.route_id, 'R1');
  assert.equal(insertedData.stop_id, 1);
  assert.equal(insertedData.car_id, 'CAR1');
  mock.restoreAll();
});

test('claimNotification - handles RPC response', async () => {
  mock.method(supabase, 'rpc', async () => ({ data: 123, error: null }));
  const res = await claimNotification('G1', 'R1', 1, 'CAR1');
  assert.equal(res, 123);
  mock.restoreAll();
});

test('releaseNotificationClaim - calls RPC', async () => {
  let calledRpc = '';
  mock.method(supabase, 'rpc', async (rpcName) => {
    calledRpc = rpcName;
    return { error: null };
  });
  await releaseNotificationClaim(123);
  assert.equal(calledRpc, 'release_notification_claim');
  mock.restoreAll();
});
