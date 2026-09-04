import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { fetchTrucksWithRetry } from '../lib/truckApi.js';

import { supabase } from '../lib/supabaseClient.js';
import * as lineClient from '../lib/lineClient.js';

test('fetchTrucksWithRetry - success on first try', async () => {
  mock.method(supabase, 'from', () => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    update: () => ({ eq: async () => ({ error: null }) })
  }));

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    text: async () => JSON.stringify({
      data: [{ linid: 'R1', x: '120.3', y: '22.6', car: 'CAR1', time: '2026-09-02T17:00:00' }]
    })
  });

  try {
    const res = await fetchTrucksWithRetry('2026-09-02');
    assert.equal(res.ok, true);
    assert.equal(res.data.length, 1);
    assert.equal(res.data[0].route_id, 'R1');
    assert.equal(res.retryCount, 0);
  } finally {
    global.fetch = originalFetch;
    mock.restoreAll();
  }
});

test('fetchTrucksWithRetry - increments fail count on failure', async () => {
  mock.method(supabase, 'from', () => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { api_fail_count: 0 }, error: null }) }) }),
    upsert: async () => ({ error: null })
  }));

  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('Network error'); };

  try {
    const res = await fetchTrucksWithRetry('2026-09-02');
    assert.equal(res.ok, false);
    assert.equal(res.paused, false);
    assert.equal(res.retryCount, 1);
  } finally {
    global.fetch = originalFetch;
    mock.restoreAll();
  }
});

test('fetchTrucksWithRetry - pauses and alerts after max failures', async () => {
  const originalDryRun = process.env.DRY_RUN;
  process.env.DRY_RUN = 'true';
  mock.method(supabase, 'from', () => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { api_fail_count: 2 }, error: null }) }) }),
    upsert: async () => ({ error: null })
  }));

  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('Network error forever'); };

  try {
    const res = await fetchTrucksWithRetry('2026-09-02');
    assert.equal(res.ok, false);
    assert.equal(res.paused, true); // 2 + 1 = 3 >= MAX_RETRY_COUNT (3)
    assert.equal(res.retryCount, 3);
  } finally {
    process.env.DRY_RUN = originalDryRun;
    global.fetch = originalFetch;
    mock.restoreAll();
  }
});
