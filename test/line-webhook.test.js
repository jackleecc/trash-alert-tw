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

test('line-webhook - accepts valid signature and processes events (FIX-6)', async () => {
  const secret = 'valid-test-secret';
  const originalSecret = process.env.LINE_CHANNEL_SECRET;
  process.env.LINE_CHANNEL_SECRET = secret;

  mock.method(supabase, 'from', () => ({
    upsert: async () => ({ error: null }),
  }));

  const payloadStr = JSON.stringify({
    events: [
      {
        type: 'join',
        replyToken: 'token-123',
        source: { groupId: 'G_TEST_1' },
      },
    ],
  });

  const validSig = crypto
    .createHmac('SHA256', secret)
    .update(Buffer.from(payloadStr, 'utf8'))
    .digest('base64');

  const req = {
    method: 'POST',
    headers: {
      'x-line-signature': validSig,
    },
    rawBody: payloadStr,
    body: JSON.parse(payloadStr),
  };
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
