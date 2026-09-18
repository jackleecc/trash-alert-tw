import test from 'node:test';
import assert from 'node:assert/strict';
import { sendLinePushMessage } from '../lib/lineClient.js';

test('sendLinePushMessage - respects DRY_RUN', async () => {
  const originalDryRun = process.env.DRY_RUN;
  process.env.DRY_RUN = 'true';

  let fetchCalled = false;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    fetchCalled = true;
    return { ok: true, status: 200 };
  };

  try {
    const res = await sendLinePushMessage('U123', 'Test Message');
    assert.equal(res.ok, true);
    assert.equal(res.dryRun, true);
    assert.equal(fetchCalled, false, 'Fetch should not be called in DRY_RUN mode');
  } finally {
    process.env.DRY_RUN = originalDryRun;
    global.fetch = originalFetch;
  }
});

test('sendLinePushMessage - executes fetch when not in DRY_RUN', async () => {
  const originalDryRun = process.env.DRY_RUN;
  const originalToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  
  process.env.DRY_RUN = 'false';
  process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test-token';

  let fetchCalled = false;
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    fetchCalled = true;
    assert.equal(url, 'https://api.line.me/v2/bot/message/push');
    assert.ok(options.headers.Authorization.includes('test-token'));
    return { ok: true, status: 200 };
  };

  try {
    const res = await sendLinePushMessage('U123', 'Test Message');
    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.equal(fetchCalled, true, 'Fetch should be called when not in DRY_RUN');
  } finally {
    process.env.DRY_RUN = originalDryRun;
    process.env.LINE_CHANNEL_ACCESS_TOKEN = originalToken;
    global.fetch = originalFetch;
  }
});

test('broadcastLineAlert - filters recipient groups by targetCities when specified', async () => {
  const { supabase } = await import('../lib/supabaseClient.js');
  const { broadcastLineAlert } = await import('../lib/lineClient.js');
  const { mock } = await import('node:test');

  const sentGroups = [];
  const originalDryRun = process.env.DRY_RUN;
  const originalToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  process.env.DRY_RUN = 'false';
  process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test-token';

  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    sentGroups.push(body.to);
    return { ok: true, status: 200 };
  };

  mock.method(supabase, 'from', (table) => {
    if (table === 'subscriptions') {
      return {
        select: () => Promise.resolve({
          data: [
            {
              group_id: 'G_NTPC',
              stops: { route_id: 'R_XIZHI', routes: { name: '新北汐止清運線', city: '新北市' } },
            },
            {
              group_id: 'G_TY',
              stops: { route_id: 'R_YANGMEI', routes: { name: '桃園楊梅清運線', city: '桃園市' } },
            },
          ],
          error: null,
        }),
      };
    }
    if (table === 'line_groups') {
      return {
        select: () => ({
          eq: () => Promise.resolve({
            data: [
              { group_id: 'G_NTPC', is_active: true },
              { group_id: 'G_TY', is_active: true },
            ],
            error: null,
          }),
        }),
      };
    }
    return {};
  });

  try {
    // 僅向新北市廣播故障
    await broadcastLineAlert('新北市端點異常告警', ['新北市']);
    assert.deepEqual(sentGroups, ['G_NTPC'], '應只向新北市訂閱群組發送，不應波及桃園群組');

    // 全域廣播（未指定 targetCities）
    sentGroups.length = 0;
    await broadcastLineAlert('全系統公告');
    assert.deepEqual(sentGroups.sort(), ['G_NTPC', 'G_TY'].sort(), '未指定目標縣市時應全域廣播');
  } finally {
    process.env.DRY_RUN = originalDryRun;
    process.env.LINE_CHANNEL_ACCESS_TOKEN = originalToken;
    global.fetch = originalFetch;
    mock.restoreAll();
  }
});

test('sendLinePushMessage - gracefully handles AbortError timeout (FIX-9)', async () => {
  const originalDryRun = process.env.DRY_RUN;
  const originalToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  process.env.DRY_RUN = 'false';
  process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test-token';

  const originalFetch = global.fetch;
  global.fetch = async () => {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    throw abortErr;
  };

  try {
    const res = await sendLinePushMessage('U123', 'Test Timeout');
    assert.equal(res.ok, false);
    assert.equal(res.status, 504);
    assert.equal(res.error, 'LINE_PUSH_TIMEOUT');
  } finally {
    process.env.DRY_RUN = originalDryRun;
    process.env.LINE_CHANNEL_ACCESS_TOKEN = originalToken;
    global.fetch = originalFetch;
  }
});


