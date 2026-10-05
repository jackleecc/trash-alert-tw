import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { supabase } from '../lib/supabaseClient.js';
import { reserveQuota, releaseQuotaReservation } from '../lib/quotaService.js';

test('reserveQuota - passes weighted amount to RPC', async () => {
  let calledParams = null;
  mock.method(supabase, 'rpc', async (name, params) => {
    if (name === 'reserve_quota') {
      calledParams = params;
      return {
        data: [{ reserved: true, used_count: 45, newly_melted: false }],
        error: null,
      };
    }
    return { data: null, error: null };
  });

  const res = await reserveQuota('2026-10:taoyuan', 9);
  assert.equal(res.reserved, true);
  assert.equal(res.usedCount, 45);
  assert.deepEqual(calledParams, {
    p_month: '2026-10:taoyuan',
    p_amount: 9,
  });

  mock.restoreAll();
});

test('reserveQuota - backwards compatibility when second param is channelId string', async () => {
  let calledParams = null;
  mock.method(supabase, 'rpc', async (name, params) => {
    if (name === 'reserve_quota') {
      calledParams = params;
      return {
        data: [{ reserved: true, used_count: 5, newly_melted: false }],
        error: null,
      };
    }
    return { data: null, error: null };
  });

  const res = await reserveQuota('2026-10', 'taoyuan');
  assert.equal(res.reserved, true);
  assert.deepEqual(calledParams, {
    p_month: '2026-10:taoyuan',
    p_amount: 1,
  });

  mock.restoreAll();
});

test('releaseQuotaReservation - passes weighted amount to RPC', async () => {
  let calledParams = null;
  mock.method(supabase, 'rpc', async (name, params) => {
    if (name === 'release_quota_reservation') {
      calledParams = params;
      return { error: null };
    }
    return { error: null };
  });

  await releaseQuotaReservation('2026-10:taoyuan', 9);
  assert.deepEqual(calledParams, {
    p_month: '2026-10:taoyuan',
    p_amount: 9,
  });

  mock.restoreAll();
});
