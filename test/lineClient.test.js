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
