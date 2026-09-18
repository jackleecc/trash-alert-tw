import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import tainanRelayHandler from '../api/tainan-relay.js';
import { supabase } from '../lib/supabaseClient.js';

function createMockReqRes({ method = 'POST', headers = {}, body = {}, query = {} } = {}) {
  const req = {
    method,
    headers,
    body,
    query,
  };

  const res = {
    statusCode: 200,
    bodyData: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.bodyData = data;
      return this;
    },
  };

  return { req, res };
}

test('tainanRelayHandler - rejects unauthorized request', async () => {
  process.env.CRON_SECRET = 'test-secret-123';
  const { req, res } = createMockReqRes({
    headers: { 'x-cron-secret': 'wrong-secret' },
    body: { text: '垃圾車即將到站' },
  });

  const originalFrom = supabase.from;
  supabase.from = () => ({
    insert: async () => ({ error: null }),
  });

  try {
    await tainanRelayHandler(req, res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.bodyData.ok, false);
  } finally {
    supabase.from = originalFrom;
  }
});

test('tainanRelayHandler - successfully processes notification and triggers push', async () => {
  process.env.CRON_SECRET = 'test-secret-123';
  process.env.LINE_CHANNEL_ACCESS_TOKEN = 'mock-line-token';

  const originalFrom = supabase.from;
  const originalFetch = global.fetch;

  let linePushCalled = false;
  let pushedPayload = null;

  global.fetch = async (url, options) => {
    if (url.includes('api.line.me')) {
      linePushCalled = true;
      pushedPayload = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
      };
    }
    return { ok: true, status: 200, text: async () => '' };
  };

  supabase.from = (table) => {
    if (table === 'stops') {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({
              data: {
                id: 6,
                name: '永康區文化路40號',
                route_id: 70,
                routes: { id: 70, name: '永康-夜間31', city: '台南市' },
              },
              error: null,
            }),
          }),
        }),
      };
    }
    if (table === 'subscriptions') {
      return {
        select: () => ({
          eq: () => ({
            eq: async () => ({
              data: [
                { group_id: 'G12345', line_groups: { group_id: 'G12345', is_active: true } },
              ],
              error: null,
            }),
          }),
        }),
      };
    }
    if (table === 'notification_logs') {
      const chain = {
        eq: () => chain,
        gte: () => chain,
        limit: async () => ({ data: [], error: null }),
      };
      return {
        select: () => chain,
        insert: async () => ({ error: null }),
      };
    }
    return {
      insert: async () => ({ error: null }),
    };
  };

  const { req, res } = createMockReqRes({
    headers: { 'x-cron-secret': 'test-secret-123' },
    body: {
      title: '臺南環保通',
      text: '您設定的清運點 [永康區文化路40號] 垃圾車即將抵達',
      stop_id: 6,
      car_id: '218-UW',
    },
  });

  const originalRpc = supabase.rpc;
  supabase.rpc = async (fn) => {
    if (fn === 'claim_notification') {
      return { data: 101, error: null };
    }
    if (fn === 'reserve_quota') {
      return { data: [{ reserved: true, used_count: 5, newly_melted: false }], error: null };
    }
    return { data: null, error: null };
  };

  try {
    await tainanRelayHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.bodyData.ok, true);
    assert.equal(res.bodyData.stopId, 6);
    assert.equal(res.bodyData.successCount, 1);
    assert.equal(res.bodyData.cooldownCount, 0);
    assert.equal(linePushCalled, true);
    assert.match(pushedPayload.messages[0].text, /永康區文化路40號/);
    assert.match(pushedPayload.messages[0].text, /臺南環保通/);
  } finally {
    supabase.from = originalFrom;
    supabase.rpc = originalRpc;
    global.fetch = originalFetch;
  }
});

test('tainanRelayHandler - blocks duplicate notification during cooldown period', async () => {
  process.env.CRON_SECRET = 'test-secret-123';
  const originalFrom = supabase.from;

  supabase.from = (table) => {
    if (table === 'stops') {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({
              data: {
                id: 6,
                name: '永康區文化路40號',
                route_id: 70,
                routes: { id: 70, name: '永康-夜間31', city: '台南市' },
              },
              error: null,
            }),
          }),
        }),
      };
    }
    if (table === 'subscriptions') {
      return {
        select: () => ({
          eq: () => ({
            eq: async () => ({
              data: [
                { group_id: 'G12345', line_groups: { group_id: 'G12345', is_active: true } },
              ],
              error: null,
            }),
          }),
        }),
      };
    }
    if (table === 'notification_logs') {
      const chain = {
        eq: () => chain,
        gte: () => chain,
        limit: async () => ({
          data: [{ id: 999, sent_at: new Date().toISOString() }],
          error: null,
        }),
      };
      return {
        select: () => chain,
      };
    }
    return {
      insert: async () => ({ error: null }),
    };
  };

  const { req, res } = createMockReqRes({
    headers: { 'x-cron-secret': 'test-secret-123' },
    body: {
      stop_id: 6,
      text: '重複的到站提醒',
    },
  });

  const originalRpc = supabase.rpc;
  supabase.rpc = async (fn) => {
    if (fn === 'claim_notification') {
      return { data: null, error: null };
    }
    return { data: null, error: null };
  };

  try {
    await tainanRelayHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.bodyData.ok, true);
    assert.equal(res.bodyData.successCount, 0);
    assert.equal(res.bodyData.cooldownCount, 1);
  } finally {
    supabase.from = originalFrom;
    supabase.rpc = originalRpc;
  }
});
