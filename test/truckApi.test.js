import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchTrucksWithRetry,
  getTargetApiUrls,
  parsePausedCitiesFromError,
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

test('parsePausedCitiesFromError - correctly extracts paused cities from last_api_error string', () => {
  assert.deepEqual(parsePausedCitiesFromError('[PAUSED_CITIES:桃園市,台南市] Network error'), ['桃園市', '台南市']);
  assert.deepEqual(parsePausedCitiesFromError('[PAUSED_CITIES: 新北市 ] Timeout'), ['新北市']);
  assert.deepEqual(parsePausedCitiesFromError('一般連線逾時錯誤'), []);
  assert.deepEqual(parsePausedCitiesFromError(null), []);
});

test('fetchTrucksWithRetry - isolates paused cities (failure in one city does NOT pause other cities)', async () => {
  // 模擬今日 DB 狀態：桃園市因多次失敗處於暫停名單中
  mock.method(supabase, 'from', () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({
          data: {
            api_fail_count: 3,
            is_paused: true,
            paused_cities: ['桃園市'],
          },
          error: null,
        }),
      }),
    }),
    update: () => ({ eq: async () => ({ error: null }) }),
  }));

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    text: async () => JSON.stringify({
      data: [{ linid: 'R_NTPC', x: '121.5', y: '25.0', car: 'NTPC-1', time: '2026-09-02T17:00:00' }],
    }),
  });

  try {
    // 1. 查詢新北市：不在暫停名單中，應正常執行，不被桃園暫停拖累！
    const ntpcRes = await fetchTrucksWithRetry('2026-09-02', undefined, ['新北市']);
    assert.equal(ntpcRes.ok, true, '新北市應正常抓取，不受桃園市暫停影響');
    assert.equal(ntpcRes.paused, false);
    assert.equal(ntpcRes.data.length, 1);

    // 2. 查詢桃園市：已在暫停名單中，應安全略過
    const tyRes = await fetchTrucksWithRetry('2026-09-02', undefined, ['桃園市']);
    assert.equal(tyRes.ok, false);
    assert.equal(tyRes.paused, true, '桃園市處於暫停狀態應略過');
    assert.equal(tyRes.error, 'API_CHECK_PAUSED_FOR_TODAY');
  } finally {
    global.fetch = originalFetch;
    mock.restoreAll();
  }
});

test('getTargetApiUrls - filters out pausedCities in both targeted and global modes', () => {
  const targetedFiltered = getTargetApiUrls(undefined, ['新北市', '桃園市'], ['桃園市']);
  assert.deepEqual(targetedFiltered, [NTPC_TRUCK_API_URL]);

  const globalFiltered = getTargetApiUrls(undefined, undefined, ['桃園市']);
  assert.deepEqual(globalFiltered, [
    KCG_TRUCK_API_URL,
    NTPC_TRUCK_API_URL,
    TAINAN_TRUCK_API_URL,
  ]);
});

test('fetchTrucksWithRetry - does not accidentally unpause paused cities when another city succeeds', async () => {
  let updatedPayload = null;
  mock.method(supabase, 'from', () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({
          data: {
            api_fail_count: 3,
            is_paused: false,
            paused_cities: ['桃園市'],
          },
          error: null,
        }),
      }),
    }),
    update: (payload) => ({
      eq: async () => {
        updatedPayload = payload;
        return { error: null };
      },
    }),
  }));

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    text: async () => JSON.stringify({
      data: [{ linid: 'R_NTPC', x: '121.5', y: '25.0', car: 'NTPC-1', time: '2026-09-02T17:00:00' }],
    }),
  });

  try {
    // 請求包含已暫停的桃園市與未暫停的新北市
    const res = await fetchTrucksWithRetry('2026-09-02', undefined, ['新北市', '桃園市']);
    assert.equal(res.ok, true);
    assert.ok(updatedPayload, '應有執行 update');
    assert.deepEqual(updatedPayload.paused_cities, ['桃園市'], '桃園市未曾恢復連線，不得被誤解除暫停');
    assert.equal(updatedPayload.is_paused, false, '尚有可用縣市時不應全域暫停');
  } finally {
    global.fetch = originalFetch;
    mock.restoreAll();
  }
});

test('fetchTrucksWithRetry - partial failure accumulates city fail counts without premature pause (FIX-2)', async () => {
  let upsertPayload = null;
  mock.method(supabase, 'from', () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({
          data: { api_fail_count: 0, is_paused: false, paused_cities: [] },
          error: null,
        }),
      }),
    }),
    upsert: async (payload) => {
      upsertPayload = payload;
      return { error: null };
    },
  }));

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (url === NTPC_TRUCK_API_URL) {
      return {
        ok: true,
        text: async () => JSON.stringify({
          data: [{ linid: 'R_NTPC', x: '121.5', y: '25.0', car: 'NTPC-1', time: '2026-09-02T17:00:00' }],
        }),
      };
    }
    // 台南連線失敗
    throw new Error('Connection refused by tainan proxy');
  };

  try {
    const res = await fetchTrucksWithRetry('2026-09-02', undefined, ['新北市', '台南市']);
    assert.equal(res.ok, true, '部分成功整體仍應回傳 ok: true');
    assert.equal(res.data.length, 1);
    assert.ok(upsertPayload, '應有執行 upsert 記錄失敗統計');
    assert.ok(upsertPayload.last_api_error.includes('"台南市":1'), '台南市應累積 1 次失敗');
    assert.deepEqual(upsertPayload.paused_cities, [], '未達 3 次失敗門檻前不得過早暫停鎖定');
  } finally {
    global.fetch = originalFetch;
    mock.restoreAll();
  }
});

test('fetchTrucksWithRetry - partial failure pauses city when reaching MAX_RETRY_COUNT (FIX-2)', async () => {
  let upsertPayload = null;
  mock.method(supabase, 'from', () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({
          data: {
            api_fail_count: 0,
            is_paused: false,
            paused_cities: [],
            last_api_error: '[CITY_FAILS:{"台南市":2}]', // 已累積 2 次
          },
          error: null,
        }),
      }),
    }),
    upsert: async (payload) => {
      upsertPayload = payload;
      return { error: null };
    },
  }));

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (url === NTPC_TRUCK_API_URL) {
      return {
        ok: true,
        text: async () => JSON.stringify({
          data: [{ linid: 'R_NTPC', x: '121.5', y: '25.0', car: 'NTPC-1', time: '2026-09-02T17:00:00' }],
        }),
      };
    }
    throw new Error('Connection refused by tainan proxy');
  };

  try {
    const res = await fetchTrucksWithRetry('2026-09-02', undefined, ['新北市', '台南市']);
    assert.equal(res.ok, true);
    assert.ok(upsertPayload);
    assert.ok(upsertPayload.last_api_error.includes('"台南市":3'), '台南市應累積至 3 次失敗');
    assert.deepEqual(upsertPayload.paused_cities, ['台南市'], '達 3 次門檻後應加入 paused_cities');
  } finally {
    global.fetch = originalFetch;
    mock.restoreAll();
  }
});

test('fetchTrucksWithRetry - clears paused city upon recovery even if failCount is 0 (FIX-3)', async () => {
  let updatePayload = null;
  mock.method(supabase, 'from', () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({
          data: {
            api_fail_count: 0, // 先前已被其他成功請求歸零
            is_paused: false,
            paused_cities: ['桃園市'], // 但桃園市仍在暫停名單中
          },
          error: null,
        }),
      }),
    }),
    update: (payload) => ({
      eq: async () => {
        updatePayload = payload;
        return { error: null };
      },
    }),
  }));

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    text: async () => JSON.stringify({
      data: [{ linid: 'R_TY', x: '121.2', y: '24.9', car: 'TY-1', time: '2026-09-02T17:00:00' }],
    }),
  });

  try {
    const res = await fetchTrucksWithRetry('2026-09-02', TAOYUAN_TRUCK_API_URL);
    assert.equal(res.ok, true);
    assert.ok(updatePayload, '應有執行 update 解除暫停');
    assert.deepEqual(updatePayload.paused_cities, [], '桃園市成功連線後應從 paused_cities 清除');
  } finally {
    global.fetch = originalFetch;
    mock.restoreAll();
  }
});

test('fetchTrucksWithRetry - global failure with empty targetCities correctly maps failedCities (FIX-4)', async () => {
  let upsertPayload = null;
  mock.method(supabase, 'from', () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({
          data: {
            api_fail_count: 2, // 2+1=3 達到 MAX_RETRY_COUNT
            is_paused: false,
            paused_cities: [],
          },
          error: null,
        }),
      }),
    }),
    upsert: async (payload) => {
      upsertPayload = payload;
      return { error: null };
    },
  }));

  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('All external APIs down');
  };

  try {
    // 全域呼叫，不傳 targetCities
    const res = await fetchTrucksWithRetry('2026-09-02');
    assert.equal(res.ok, false);
    assert.equal(res.paused, true);
    assert.ok(upsertPayload, '應寫入 upsert');
    assert.equal(upsertPayload.is_paused, true, '所有縣市均失敗應全域暫停');
    assert.ok(upsertPayload.paused_cities.includes('高雄市'));
    assert.ok(upsertPayload.paused_cities.includes('新北市'));
    assert.ok(upsertPayload.paused_cities.includes('桃園市'));
    assert.ok(upsertPayload.paused_cities.includes('台南市'));
  } finally {
    global.fetch = originalFetch;
    mock.restoreAll();
  }
});



