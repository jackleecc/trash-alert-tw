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
  syncLineConsumption,
  getQuotaSnapshot,
  MELT_THRESHOLD,
  MAX_MONTHLY_QUOTA
} from '../lib/quotaService.js';
import * as lineClient from '../lib/lineClient.js';

test('quotaService - getYearMonth formats YYYY-MM correctly', () => {
  const date = new Date('2026-09-02T00:00:00Z');
  assert.equal(getYearMonth(date), '2026-09');
});

test('quotaService - constants match specification', () => {
  assert.equal(MELT_THRESHOLD, 200);
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
        maybeSingle: async () => ({ data: { month: '2026-09', used_count: 200, is_melted: false }, error: null })
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
        maybeSingle: async () => ({ data: { month: '2026-09', used_count: 199, is_melted: false }, error: null })
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
    assert.equal(count, 200);
    assert.equal(updatedCount, 200);
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

test('syncLineConsumption - syncs higher LINE usage and triggers melt if reaching threshold', async () => {
  const originalDryRun = process.env.DRY_RUN;
  const originalToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  process.env.DRY_RUN = 'true';
  process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test_token';

  let updatedPayload = null;
  mock.method(supabase, 'from', () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({
          data: { month: '2026-09', used_count: 29, is_melted: false },
          error: null,
        }),
      }),
    }),
    update: (data) => {
      updatedPayload = data;
      return { eq: async () => ({ error: null }) };
    },
  }));

  // Mock fetch returning totalUsage: 199
  const customFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ totalUsage: 199 }),
  });

  try {
    const res = await syncLineConsumption('2026-09', customFetch);
    assert.equal(res.ok, true);
    assert.equal(res.synced, true);
    assert.equal(res.localCount, 29);
    assert.equal(res.lineCount, 199);
    assert.equal(res.remaining, 1);
    assert.equal(res.isMelted, false);
    assert.equal(updatedPayload?.used_count, 199);
    assert.equal(updatedPayload?.is_melted, false);
  } finally {
    process.env.DRY_RUN = originalDryRun;
    process.env.LINE_CHANNEL_ACCESS_TOKEN = originalToken;
    mock.restoreAll();
  }
});

test('syncLineConsumption - triggers melt protection when LINE usage reaches 200', async () => {
  const originalDryRun = process.env.DRY_RUN;
  const originalToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  process.env.DRY_RUN = 'true';
  process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test_token';

  let updatedPayload = null;
  mock.method(supabase, 'from', () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({
          data: { month: '2026-09', used_count: 50, is_melted: false },
          error: null,
        }),
      }),
    }),
    update: (data) => {
      updatedPayload = data;
      return { eq: async () => ({ error: null }) };
    },
  }));

  const customFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ totalUsage: 200 }),
  });

  try {
    const res = await syncLineConsumption('2026-09', customFetch);
    assert.equal(res.ok, true);
    assert.equal(res.synced, true);
    assert.equal(res.lineCount, 200);
    assert.equal(res.remaining, 0);
    assert.equal(res.isMelted, true);
    assert.equal(updatedPayload?.used_count, 200);
    assert.equal(updatedPayload?.is_melted, true);
  } finally {
    process.env.DRY_RUN = originalDryRun;
    process.env.LINE_CHANNEL_ACCESS_TOKEN = originalToken;
    mock.restoreAll();
  }
});

test('syncLineConsumption - does not downgrade when local count is higher than LINE count', async () => {
  const originalToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test_token';

  let updated = false;
  mock.method(supabase, 'from', () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({
          data: { month: '2026-09', used_count: 50, is_melted: false },
          error: null,
        }),
      }),
    }),
    update: () => {
      updated = true;
      return { eq: async () => ({ error: null }) };
    },
  }));

  const customFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ totalUsage: 30 }),
  });

  try {
    const res = await syncLineConsumption('2026-09', customFetch);
    assert.equal(res.ok, true);
    assert.equal(res.synced, false);
    assert.equal(updated, false);
    assert.equal(res.localCount, 50);
  } finally {
    process.env.LINE_CHANNEL_ACCESS_TOKEN = originalToken;
    mock.restoreAll();
  }
});

test('syncLineConsumption - handles missing token gracefully', async () => {
  const originalToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  delete process.env.LINE_CHANNEL_ACCESS_TOKEN;

  try {
    const res = await syncLineConsumption('2026-09');
    assert.equal(res.ok, false);
    assert.equal(res.error, 'MISSING_LINE_TOKEN');
  } finally {
    process.env.LINE_CHANNEL_ACCESS_TOKEN = originalToken;
  }
});

test('getQuotaSnapshot - calculates remaining quota and snapshot correctly', async () => {
  mock.method(supabase, 'from', () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({
          data: { month: '2026-09', used_count: 45, is_melted: false },
          error: null,
        }),
      }),
    }),
  }));

  try {
    const snapshot = await getQuotaSnapshot('2026-09');
    assert.equal(snapshot.month, '2026-09');
    assert.equal(snapshot.usedCount, 45);
    assert.equal(snapshot.maxQuota, 200);
    assert.equal(snapshot.remaining, 155);
    assert.equal(snapshot.isMelted, false);
  } finally {
    mock.restoreAll();
  }
});
