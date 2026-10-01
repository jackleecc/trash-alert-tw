import test from 'node:test';
import assert from 'node:assert/strict';
import tainanRelayHandler from '../api/tainan-relay.js';
import { supabase } from '../lib/supabaseClient.js';

function createMockReqRes({ method = 'POST', headers = {}, body = {} } = {}) {
  const req = { method, headers, body, query: {} };
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

test('tainanRelayRouting - prioritizes active subscribed stop (Stop 6) over unsubscribed stop (Stop 5) on ambiguous keyword', async () => {
  process.env.CRON_SECRET = 'test-secret-123';
  process.env.LINE_CHANNEL_ACCESS_TOKEN = 'mock-line-token';

  const originalFrom = supabase.from;
  const originalRpc = supabase.rpc;
  const originalFetch = global.fetch;

  let pushedMessage = null;

  global.fetch = async (url, options) => {
    if (url.includes('api.line.me')) {
      pushedMessage = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({}) };
    }
    return { ok: true, status: 200, text: async () => '' };
  };

  supabase.from = (table) => {
    if (table === 'stops') {
      return {
        select: () => ({
          // 返回全量站點：Stop 5（未訂閱）排在 Stop 6（有訂閱）前面
          data: [
            {
              id: 5,
              name: '文化路128巷10號',
              route_id: 70,
              routes: { id: 70, name: '永康-夜間31', city: '台南市' },
            },
            {
              id: 6,
              name: '永康區文化路40號',
              route_id: 70,
              routes: { id: 70, name: '永康-夜間31', city: '台南市' },
            },
          ],
          error: null,
        }),
      };
    }
    if (table === 'subscriptions') {
      return {
        select: () => ({
          eq: (field, val) => {
            if (field === 'line_groups.is_active' && val === true) {
              return {
                data: [
                  { stop_id: 6, line_groups: { group_id: 'G_TAINAN', is_active: true } },
                ],
                error: null,
                eq: async () => ({
                  data: [
                    { group_id: 'G_TAINAN', line_groups: { group_id: 'G_TAINAN', is_active: true } },
                  ],
                  error: null,
                }),
              };
            }
            if (field === 'stop_id') {
              return {
                eq: async () => ({
                  data: val === 6 ? [{ group_id: 'G_TAINAN', line_groups: { group_id: 'G_TAINAN', is_active: true } }] : [],
                  error: null,
                }),
              };
            }
            return {
              eq: async () => ({ data: [], error: null }),
              data: [],
              error: null,
            };
          },
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
    return { insert: async () => ({ error: null }) };
  };

  supabase.rpc = async (fn) => {
    if (fn === 'claim_notification') return { data: 201, error: null };
    if (fn === 'reserve_quota') return { data: [{ reserved: true, used_count: 1, newly_melted: false }], error: null };
    return { data: null, error: null };
  };

  // 模擬 MacroDroid 轉發官方通知（僅有「文化路」模糊關鍵字，無 stop_id）
  const { req, res } = createMockReqRes({
    headers: { 'x-cron-secret': 'test-secret-123' },
    body: {
      title: '臺南環保通',
      text: '清運點提醒：文化路即將到站',
    },
  });

  try {
    await tainanRelayHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.bodyData.ok, true);
    // 關鍵斷言：必須命中擁有活躍訂閱的 Stop 6，而非未訂閱的 Stop 5
    assert.equal(res.bodyData.stopId, 6, 'Must match active subscribed stop 6 instead of stop 5');
    assert.equal(res.bodyData.successCount, 1, 'Must notify 1 group');
    assert.ok(pushedMessage, 'LINE push must be called');
  } finally {
    supabase.from = originalFrom;
    supabase.rpc = originalRpc;
    global.fetch = originalFetch;
  }
});
