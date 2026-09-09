import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.CRON_SECRET = 'valid-secret';

import handler from '../api/check-weather.js';
import { supabase } from '../lib/supabaseClient.js';

const mockResponse = () => {
  const res = {};
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (data) => {
    res.body = data;
    return res;
  };
  return res;
};

test('check-weather - blocks unauthorized requests', async () => {
  const req = { headers: {} };
  const res = mockResponse();

  await handler(req, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.ok, false);
});

test('check-weather - skips execution during quiet hours (00:00~07:00)', async () => {
  const originalSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'valid-secret';

  const OriginalDate = Date;
  // 03:00 TW = 前一天 19:00 UTC
  global.Date = class extends OriginalDate {
    constructor(...args) {
      if (args.length === 0) return new OriginalDate('2026-09-02T19:00:00Z');
      return new OriginalDate(...args);
    }
    static now() {
      return new OriginalDate('2026-09-02T19:00:00Z').getTime();
    }
  };

  const req = { headers: { authorization: 'Bearer valid-secret' } };
  const res = mockResponse();

  try {
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.skipped, true);
    assert.equal(res.body.reason, 'quiet-hours');
  } finally {
    process.env.CRON_SECRET = originalSecret;
    global.Date = OriginalDate;
  }
});

test('check-weather - respects 30m (unnotified) and 6h (notified) cooldowns', async () => {
  const originalSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'valid-secret';

  // 設定當前時間為 10:00 TW (02:00 UTC)
  const OriginalDate = Date;
  const currentIso = '2026-09-02T02:00:00Z';
  global.Date = class extends OriginalDate {
    constructor(...args) {
      if (args.length === 0) return new OriginalDate(currentIso);
      return new OriginalDate(...args);
    }
    static now() {
      return new OriginalDate(currentIso).getTime();
    }
  };

  // 模擬資料庫訂閱資料：有 3 個站點
  // 站點 101: 15 分鐘前剛查過未通知 -> 仍在 30 分鐘冷卻期內 -> 略過
  // 站點 102: 4 小時前查過有通知 -> 仍在 6 小時冷卻期內 -> 略過
  // 站點 103: 40 分鐘前查過未通知 -> 超過 30 分鐘 -> 執行查詢
  const mockSubs = [
    {
      group_id: 'G1',
      stop_id: 101,
      line_groups: { is_active: true },
      stops: { lat: 25.0, lng: 121.5, name: '測試站點101' }
    },
    {
      group_id: 'G1',
      stop_id: 102,
      line_groups: { is_active: true },
      stops: { lat: 25.01, lng: 121.51, name: '測試站點102' }
    },
    {
      group_id: 'G1',
      stop_id: 103,
      line_groups: { is_active: true },
      stops: { lat: 25.02, lng: 121.52, name: '測試站點103' }
    }
  ];

  const mockWeatherStatus = [
    {
      stop_id: 101,
      last_checked_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(), // 15 分鐘前 (< 30m)
      last_notified_at: null
    },
    {
      stop_id: 102,
      last_checked_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
      last_notified_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString() // 4 小時前有通知 (未滿6h)
    },
    {
      stop_id: 103,
      last_checked_at: new Date(Date.now() - 40 * 60 * 1000).toISOString(), // 40 分鐘前 (滿30m)
      last_notified_at: null
    }
  ];

  mock.method(supabase, 'from', (table) => {
    if (table === 'subscriptions') {
      return {
        select: () => ({
          eq: async () => ({ data: mockSubs, error: null })
        })
      };
    }
    if (table === 'weather_check_status') {
      return {
        select: () => ({
          in: async () => ({ data: mockWeatherStatus, error: null })
        }),
        upsert: async () => ({ error: null })
      };
    }
    return {};
  });

  // Mock fetch 回傳正常天氣
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('air-quality-api')) {
      return {
        ok: true,
        json: async () => ({
          hourly: {
            time: ['2026-09-02T10:00', '2026-09-02T11:00'],
            pm2_5: [10, 15]
          }
        })
      };
    }
    return {
      ok: true,
      json: async () => ({
        hourly: {
          time: ['2026-09-02T10:00', '2026-09-02T11:00'],
          precipitation: [0, 0],
          precipitation_probability: [0, 20],
          uv_index: [1, 2]
        }
      })
    };
  };

  const req = { headers: { authorization: 'Bearer valid-secret' } };
  const res = mockResponse();

  try {
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.totalStops, 3);
    assert.equal(res.body.skippedStops, 2); // 101 與 102 跳過
    assert.equal(res.body.checkedStops, 1); // 僅 103 執行查詢
    assert.equal(res.body.notificationsSent, 0); // 正常天氣無推播
  } finally {
    process.env.CRON_SECRET = originalSecret;
    global.Date = OriginalDate;
    globalThis.fetch = originalFetch;
    mock.reset();
  }
});

test('check-weather - sends notification and records last_notified_at when conditions trigger', async () => {
  const originalSecret = process.env.CRON_SECRET;
  const originalDryRun = process.env.DRY_RUN;
  process.env.CRON_SECRET = 'valid-secret';
  process.env.DRY_RUN = 'true';

  const OriginalDate = Date;
  const currentIso = '2026-09-02T02:00:00Z'; // 10:00 TW
  global.Date = class extends OriginalDate {
    constructor(...args) {
      if (args.length === 0) return new OriginalDate(currentIso);
      return new OriginalDate(...args);
    }
    static now() {
      return new OriginalDate(currentIso).getTime();
    }
  };

  const mockSubs = [
    {
      group_id: 'G1',
      stop_id: 201,
      line_groups: { is_active: true },
      stops: { lat: 25.0, lng: 121.5, name: '下雨測試站' }
    }
  ];

  let upsertPayload = null;

  mock.method(supabase, 'from', (table) => {
    if (table === 'subscriptions') {
      return {
        select: () => ({
          eq: async () => ({ data: mockSubs, error: null })
        })
      };
    }
    if (table === 'weather_check_status') {
      return {
        select: () => ({
          in: async () => ({ data: [], error: null }) // 第一次查詢，無舊紀錄
        }),
        upsert: async (payload) => {
          upsertPayload = payload;
          return { error: null };
        }
      };
    }
    return {};
  });

  mock.method(supabase, 'rpc', (fn) => {
    if (fn === 'claim_notification') {
      return { data: 999, error: null };
    }
    if (fn === 'reserve_quota') {
      return { data: [{ reserved: true, used_count: 10, newly_melted: false }], error: null };
    }
    return { data: null, error: null };
  });

  // Mock fetch 回傳降雨機率 70%
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('air-quality-api')) {
      return {
        ok: true,
        json: async () => ({
          hourly: {
            time: ['2026-09-02T10:00', '2026-09-02T11:00'],
            pm2_5: [10, 10]
          }
        })
      };
    }
    return {
      ok: true,
      json: async () => ({
        hourly: {
          time: ['2026-09-02T10:00', '2026-09-02T11:00'],
          precipitation: [0, 2.0],
          precipitation_probability: [10, 70], // >= 60%
          uv_index: [1, 2]
        }
      })
    };
  };

  const req = { headers: { authorization: 'Bearer valid-secret' } };
  const res = mockResponse();

  try {
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.totalStops, 1);
    assert.equal(res.body.checkedStops, 1);
    assert.equal(res.body.notificationsSent, 1);
    // 驗證 upsert 包含了 last_notified_at
    assert.ok(upsertPayload);
    assert.equal(upsertPayload.stop_id, 201);
    assert.ok(upsertPayload.last_checked_at);
    assert.ok(upsertPayload.last_notified_at);
  } finally {
    process.env.CRON_SECRET = originalSecret;
    process.env.DRY_RUN = originalDryRun;
    global.Date = OriginalDate;
    globalThis.fetch = originalFetch;
    mock.reset();
  }
});

