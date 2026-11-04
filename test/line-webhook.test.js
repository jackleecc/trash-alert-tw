import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import handler from '../api/line-webhook.js';
import { supabase } from '../lib/supabaseClient.js';

function mockResponse() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
    send(data) {
      this.body = data;
      return this;
    },
  };
  return res;
}

function signedWebhookRequest(payload, secret) {
  const rawBody = JSON.stringify(payload);
  return {
    method: 'POST',
    headers: {
      'x-line-signature': crypto.createHmac('SHA256', secret).update(rawBody).digest('base64'),
    },
    rawBody,
    body: JSON.parse(rawBody),
  };
}

test('line-webhook - rejects invalid signature with 401 when LINE_CHANNEL_SECRET is set (FIX-6)', async () => {
  const originalSecret = process.env.LINE_CHANNEL_SECRET;
  process.env.LINE_CHANNEL_SECRET = 'test-secret';

  const req = {
    method: 'POST',
    headers: {
      'x-line-signature': 'invalid-signature-value',
    },
    rawBody: '{"events":[]}',
    body: { events: [] },
  };
  const res = mockResponse();

  try {
    await handler(req, res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error, 'Invalid signature');
  } finally {
    process.env.LINE_CHANNEL_SECRET = originalSecret;
  }
});

test('line-webhook - rejects missing signature with 401 when LINE_CHANNEL_SECRET is set', async () => {
  const originalSecret = process.env.LINE_CHANNEL_SECRET;
  process.env.LINE_CHANNEL_SECRET = 'test-secret';

  const req = {
    method: 'POST',
    headers: {},
    rawBody: '{"events":[]}',
    body: { events: [] },
  };
  const res = mockResponse();

  try {
    await handler(req, res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error, 'Invalid signature');
  } finally {
    process.env.LINE_CHANNEL_SECRET = originalSecret;
  }
});

test('line-webhook - accepts valid signature and processes events (FIX-6)', async () => {
  const secret = 'valid-test-secret';
  const originalSecret = process.env.LINE_CHANNEL_SECRET;
  process.env.LINE_CHANNEL_SECRET = secret;

  mock.method(supabase, 'from', () => ({
    upsert: async () => ({ error: null }),
  }));

  const req = signedWebhookRequest({
    events: [
      {
        type: 'join',
        replyToken: 'token-123',
        source: { groupId: 'G_TEST_1' },
      },
    ],
  }, secret);
  const res = mockResponse();

  try {
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
  } finally {
    process.env.LINE_CHANNEL_SECRET = originalSecret;
    mock.restoreAll();
  }
});

test('line-webhook - accepts valid Taoyuan signature and processes events', async () => {
  const tySecret = '117874bc8bdea8f5c64b82d1c0f5eb4e';
  const originalTySecret = process.env.LINE_CHANNEL_SECRET_TAOYUAN;
  process.env.LINE_CHANNEL_SECRET_TAOYUAN = tySecret;

  mock.method(supabase, 'from', () => ({
    upsert: async () => ({ error: null }),
  }));

  const req = signedWebhookRequest({
    events: [
      {
        type: 'join',
        replyToken: 'token-ty-123',
        source: { groupId: 'G_TAOYUAN_1' },
      },
    ],
  }, tySecret);
  const res = mockResponse();

  try {
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
  } finally {
    process.env.LINE_CHANNEL_SECRET_TAOYUAN = originalTySecret;
    mock.restoreAll();
  }
});

async function postSignedText(text, source = { type: 'group', groupId: 'G_QUERY_TEST' }) {
  const secret = 'group-id-query-test-secret';
  const env = {
    LINE_CHANNEL_SECRET: process.env.LINE_CHANNEL_SECRET,
    LINE_CHANNEL_ACCESS_TOKEN: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    DRY_RUN: process.env.DRY_RUN,
  };
  process.env.LINE_CHANNEL_SECRET = secret;
  process.env.LINE_CHANNEL_ACCESS_TOKEN = 'offline-test-token';
  delete process.env.DRY_RUN;

  const replies = [];
  mock.method(supabase, 'from', () => ({ upsert: async () => ({ error: null }) }));
  mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const requestUrl = String(url);
    if (requestUrl.endsWith(`/group/${source.groupId || source.roomId}/members/count`)) {
      return { ok: true, json: async () => ({ count: 3 }) };
    }
    if (requestUrl === 'https://api.line.me/v2/bot/message/reply') {
      replies.push({ url: requestUrl, ...JSON.parse(options.body) });
      return { ok: true, status: 200 };
    }
    throw new Error(`Unexpected offline fetch endpoint: ${requestUrl}`);
  });

  const req = signedWebhookRequest({
    events: [{
      type: 'message',
      replyToken: 'offline-reply-token',
      source,
      message: { type: 'text', text },
    }],
  }, secret);
  const res = mockResponse();
  try {
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    return replies;
  } finally {
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    mock.restoreAll();
  }
}

test('line-webhook - exact /id replies with the group ID once', async () => {
  const replies = await postSignedText('/id');
  assert.equal(replies.length, 1);
  assert.match(replies[0].messages[0].text, /G_QUERY_TEST/);
});

test('line-webhook - trims whitespace and ignores case for /ID', async () => {
  const replies = await postSignedText('  /ID  ');
  assert.equal(replies.length, 1);
  assert.match(replies[0].messages[0].text, /G_QUERY_TEST/);
});

for (const text of ['id', '群組', 'group', '查詢', '請輸入 /id', '這個群組', 'video']) {
  test(`line-webhook - does not reply to ordinary text ${JSON.stringify(text)}`, async () => {
    const replies = await postSignedText(text);
    assert.equal(replies.length, 0);
  });
}

for (const text of [
  'https://example.test/docs/id',
  'https://example.test/search?next=/id',
  'https://example.test/share\n/id',
]) {
  test(`line-webhook - does not reply to URL content ${JSON.stringify(text)}`, async () => {
    const replies = await postSignedText(text);
    assert.equal(replies.length, 0);
  });
}

test('line-webhook - room text retains the existing query keyword behavior', async () => {
  const replies = await postSignedText('查詢', { type: 'room', roomId: 'R_QUERY_TEST' });
  assert.equal(replies.length, 1);
  assert.match(replies[0].messages[0].text, /R_QUERY_TEST/);
});

test('line-webhook - private text retains the existing query keyword behavior', async () => {
  const replies = await postSignedText('查詢', { type: 'user', userId: 'U_QUERY_TEST' });
  assert.equal(replies.length, 1);
  assert.match(replies[0].messages[0].text, /U_QUERY_TEST/);
});
