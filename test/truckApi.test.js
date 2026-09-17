import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchTrucksWithRetry,
  getTargetApiUrls,
  NTPC_TRUCK_API_URL,
  KCG_TRUCK_API_URL,
  TAOYUAN_TRUCK_API_URL,
  TAINAN_TRUCK_API_URL,
} from '../lib/truckApi.js';

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
    assert.equal(res.data.length, 4);
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
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { api_fail_count: 9 }, error: null }) }) }),
    upsert: async () => ({ error: null })
  }));

  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('Network error forever'); };

  try {
    const res = await fetchTrucksWithRetry('2026-09-02');
    assert.equal(res.ok, false);
    assert.equal(res.paused, true); // 9 + 1 = 10 >= MAX_RETRY_COUNT (10)
    assert.equal(res.retryCount, 10);
  } finally {
    process.env.DRY_RUN = originalDryRun;
    global.fetch = originalFetch;
    mock.restoreAll();
  }
});

test('fetchTrucksWithRetry - automatically fails over to TAINAN_BACKUP_PROXY_URL when primary fails', async () => {
  const originalBackup = process.env.TAINAN_BACKUP_PROXY_URL;
  process.env.TAINAN_BACKUP_PROXY_URL = 'https://backup-proxy.test/cars';

  mock.method(supabase, 'from', () => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { api_fail_count: 0 }, error: null }) }) }),
    update: () => ({ eq: async () => ({ error: null }) }),
  }));

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (url.includes('backup-proxy.test')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          DATA: [
            { route_id: '70', car_id: 'BACKUP-888', caption: '台南市永康區', dt: '2026-09-17 19:40:00', lng: 120.26, lat: 23.01 }
          ]
        })
      };
    }
    throw new Error('Primary failed');
  };

  try {
    const res = await fetchTrucksWithRetry('2026-09-17', undefined, ['台南市']);
    assert.equal(res.ok, true);
    assert.equal(res.data.length, 1);
    assert.equal(res.data[0].car_id, 'BACKUP-888');
  } finally {
    process.env.TAINAN_BACKUP_PROXY_URL = originalBackup;
    global.fetch = originalFetch;
    mock.restoreAll();
  }
});

test('getTargetApiUrls - filters URLs dynamically based on target cities', () => {
  const originalEnv = process.env.TRUCK_API_URL;
  delete process.env.TRUCK_API_URL;

  try {
    const ntpcOnly = getTargetApiUrls(undefined, ['新北市']);
    assert.deepEqual(ntpcOnly, [NTPC_TRUCK_API_URL]);

    const kcgOnly = getTargetApiUrls(undefined, ['高雄市']);
    assert.deepEqual(kcgOnly, [KCG_TRUCK_API_URL]);

    const multiCities = getTargetApiUrls(undefined, ['新北市', '桃園市']);
    assert.deepEqual(multiCities, [NTPC_TRUCK_API_URL, TAOYUAN_TRUCK_API_URL]);

    const tainanOnly = getTargetApiUrls(undefined, ['台南市']);
    assert.deepEqual(tainanOnly, [TAINAN_TRUCK_API_URL]);

    const defaultAll = getTargetApiUrls(undefined, []);
    assert.deepEqual(defaultAll, [
      KCG_TRUCK_API_URL,
      NTPC_TRUCK_API_URL,
      TAOYUAN_TRUCK_API_URL,
      TAINAN_TRUCK_API_URL,
    ]);
  } finally {
    if (originalEnv !== undefined) {
      process.env.TRUCK_API_URL = originalEnv;
    }
  }
});

test('getTargetApiUrls - targetCities takes precedence over TRUCK_API_URL', () => {
  const originalEnv = process.env.TRUCK_API_URL;
  process.env.TRUCK_API_URL = NTPC_TRUCK_API_URL;

  try {
    const multiCities = getTargetApiUrls(undefined, ['新北市', '台南市']);
    assert.deepEqual(multiCities, [NTPC_TRUCK_API_URL, TAINAN_TRUCK_API_URL]);
  } finally {
    if (originalEnv !== undefined) {
      process.env.TRUCK_API_URL = originalEnv;
    } else {
      delete process.env.TRUCK_API_URL;
    }
  }
});

test('fetchTrucksWithRetry - reports sourceStats and attaches x-proxy-secret when configured', async () => {
  mock.method(supabase, 'from', () => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    update: () => ({ eq: async () => ({ error: null }) }),
  }));

  const originalSecret = process.env.TAINAN_PROXY_SECRET;
  process.env.TAINAN_PROXY_SECRET = 'test-secret-key-123';

  const capturedHeaders = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    capturedHeaders.push({ url, headers: options?.headers, method: options?.method });
    return {
      ok: true,
      text: async () =>
        JSON.stringify({
          data: [{ linid: 'R1', x: '120.3', y: '22.6', car: 'CAR1', time: '2026-09-02T17:00:00' }],
        }),
    };
  };

  try {
    const res = await fetchTrucksWithRetry('2026-09-02', undefined, ['台南市']);
    assert.equal(res.ok, true);
    assert.ok(Array.isArray(res.sourceStats));
    assert.equal(res.sourceStats.length, 1);
    assert.equal(res.sourceStats[0].ok, true);

    // 驗證是否有帶入 x-proxy-secret
    const tainanCall = capturedHeaders.find((c) => c.url === TAINAN_TRUCK_API_URL);
    assert.ok(tainanCall, '應有呼叫台南端點');
    assert.equal(tainanCall.method, 'POST');
    assert.equal(tainanCall.headers['x-proxy-secret'], 'test-secret-key-123');
  } finally {
    if (originalSecret !== undefined) {
      process.env.TAINAN_PROXY_SECRET = originalSecret;
    } else {
      delete process.env.TAINAN_PROXY_SECRET;
    }
    global.fetch = originalFetch;
    mock.restoreAll();
  }
});

