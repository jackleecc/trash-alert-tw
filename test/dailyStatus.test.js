import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { supabase } from '../lib/supabaseClient.js';
import * as dgpa from '../lib/dgpa.js';
import {
  getTodaySuspensionStatus
} from '../lib/dailyStatus.js';

test('getTodaySuspensionStatus - returns cached value if exists', async () => {
  mock.method(supabase, 'from', () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: { is_suspended: true }, error: null })
      })
    })
  }));

  const res = await getTodaySuspensionStatus('2026-09-02');
  assert.equal(res, true);
  mock.restoreAll();
});

test('getTodaySuspensionStatus - fetches and caches if missing', async () => {
  let upsertedData = null;
  mock.method(supabase, 'from', () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: null, error: null })
      })
    }),
    upsert: async (data) => {
      upsertedData = data;
      return { error: null };
    }
  }));

  // Mock global fetch for the DGPA URL
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    text: async () => '<html><tr><td class="table-city">高雄市</td><td class="table-status">停止上班、停止上課。</td></tr></html>'
  });

  try {
    const res = await getTodaySuspensionStatus('2026-09-02');
    assert.equal(res, true);
    assert.equal(upsertedData.date, '2026-09-02');
    assert.equal(upsertedData.is_suspended, true);
  } finally {
    global.fetch = originalFetch;
    mock.restoreAll();
  }
});

test('getTodaySuspendedCities - ignores row without fetched_at (treats as cache miss) (FIX-1)', async () => {
  let upsertCalled = false;
  mock.method(supabase, 'from', () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({
          data: {
            date: '2026-09-02',
            api_fail_count: 2,
            is_suspended: false,
            suspended_cities: [],
            fetched_at: null,
          },
          error: null,
        }),
      }),
    }),
    upsert: async () => {
      upsertCalled = true;
      return { error: null };
    },
  }));

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    text: async () => '<html><tr><td class="table-city">高雄市</td><td class="table-status">停止上班、停止上課。</td></tr></html>',
  });

  try {
    const res = await getTodaySuspensionStatus('2026-09-02');
    assert.equal(res, true);
    assert.equal(upsertCalled, true, '應向 DGPA 查詢並執行 upsert，而非誤判快取命中');
  } finally {
    global.fetch = originalFetch;
    mock.restoreAll();
  }
});

test('getTodaySuspendedCities - recognizes valid cache with fetched_at as cache hit (FIX-1)', async () => {
  let fetchCalled = false;
  mock.method(supabase, 'from', () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({
          data: {
            date: '2026-09-02',
            is_suspended: false,
            suspended_cities: [],
            fetched_at: '2026-09-02T08:00:00.000Z',
          },
          error: null,
        }),
      }),
    }),
  }));

  const originalFetch = global.fetch;
  global.fetch = async () => {
    fetchCalled = true;
    return { ok: true, text: async () => '' };
  };

  try {
    const res = await getTodaySuspensionStatus('2026-09-02');
    assert.equal(res, false);
    assert.equal(fetchCalled, false, '有 fetched_at 快取時不應呼叫外部 DGPA');
  } finally {
    global.fetch = originalFetch;
    mock.restoreAll();
  }
});

