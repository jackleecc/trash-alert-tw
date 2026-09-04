import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { supabase } from '../lib/supabaseClient.js';
import {
  getYearMonth,
  getOrCreateQuotaRecord,
  checkQuotaStatus,
  consumeQuota,
  reserveQuota,
  releaseQuotaReservation,
  MELT_THRESHOLD,
  MAX_MONTHLY_QUOTA
} from '../lib/quotaService.js';
import * as lineClient from '../lib/lineClient.js';

test('quotaService - getYearMonth formats YYYY-MM correctly', () => {
  const date = new Date('2026-09-02T00:00:00Z');
  assert.equal(getYearMonth(date), '2026-09');
});

test('quotaService - constants match specification', () => {
  assert.equal(MELT_THRESHOLD, 195);
  assert.equal(MAX_MONTHLY_QUOTA, 200);
});

test('getOrCreateQuotaRecord - creates when not found', async (t) => {
  mock.method(supabase, 'from', () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: null, error: null })
      })
    }),
    upsert: (record) => ({
      select: () => ({
        maybeSingle: async () => ({ data: { ...record }, error: null })
      })
    })
  }));

  const res = await getOrCreateQuotaRecord('2026-09');
  assert.equal(res.month, '2026-09');
  assert.equal(res.used_count, 0);
  assert.equal(res.is_melted, false);
  
  mock.restoreAll();
});

test('getOrCreateQuotaRecord - returns existing', async () => {
  mock.method(supabase, 'from', () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: { month: '2026-09', used_count: 50, is_melted: false }, error: null })
      })
    })
  }));

  const res = await getOrCreateQuotaRecord('2026-09');
  assert.equal(res.used_count, 50);
  mock.restoreAll();
});

test('checkQuotaStatus - allows when under threshold', async () => {
  mock.method(supabase, 'from', () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: { month: '2026-09', used_count: 100, is_melted: false }, error: null })
      })
    })
  }));

  const res = await checkQuotaStatus('2026-09');
  assert.equal(res.allowed, true);
  assert.equal(res.isMelted, false);
  mock.restoreAll();
});

test('checkQuotaStatus - melts when reaching threshold', async () => {
  const originalDryRun = process.env.DRY_RUN;
  process.env.DRY_RUN = 'true';
  let updatedMelted = false;
  mock.method(supabase, 'from', () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: { month: '2026-09', used_count: 195, is_melted: false }, error: null })
      })
    }),
    update: (data) => {
      updatedMelted = data.is_melted;
      return { eq: async () => ({ error: null }) };
    }
  }));

  try {
    const res = await checkQuotaStatus('2026-09');
    assert.equal(res.allowed, false);
    assert.equal(res.isMelted, true);
    assert.equal(updatedMelted, true);
  } finally {
    process.env.DRY_RUN = originalDryRun;
    mock.restoreAll();
  }
});

test('consumeQuota - updates count and triggers melt if needed', async () => {
  const originalDryRun = process.env.DRY_RUN;
  process.env.DRY_RUN = 'true';
  let updatedCount = 0;
  let updatedMelted = false;
  mock.method(supabase, 'from', () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: { month: '2026-09', used_count: 194, is_melted: false }, error: null })
      })
    }),
    update: (data) => {
      updatedCount = data.used_count;
      updatedMelted = data.is_melted;
      return { eq: async () => ({ error: null }) };
    }
  }));

  try {
    const count = await consumeQuota('2026-09', 1);
    assert.equal(count, 195);
    assert.equal(updatedCount, 195);
    assert.equal(updatedMelted, true);
  } finally {
    process.env.DRY_RUN = originalDryRun;
    mock.restoreAll();
  }
});

test('reserveQuota - handles RPC response', async () => {
  mock.method(supabase, 'rpc', async () => ({
    data: [{ reserved: true, used_count: 5, newly_melted: false }],
    error: null
  }));

  const res = await reserveQuota('2026-09');
  assert.equal(res.reserved, true);
  assert.equal(res.usedCount, 5);
  mock.restoreAll();
});

test('releaseQuotaReservation - handles RPC response', async () => {
  let calledRpc = '';
  mock.method(supabase, 'rpc', async (rpcName) => {
    calledRpc = rpcName;
    return { error: null };
  });

  await releaseQuotaReservation('2026-09');
  assert.equal(calledRpc, 'release_quota_reservation');
  mock.restoreAll();
});
