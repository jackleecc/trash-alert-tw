import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  resolveChannelForIntent,
  getChannelCredentials,
  verifyWebhookSignature,
  getQuotaMonthKey,
  CHANNEL_DEFAULT,
  CHANNEL_TAOYUAN,
} from '../lib/channelService.js';

test('channelService - resolveChannelForIntent identifies Taoyuan vs Default channels', () => {
  // 1. Explicit channelId
  assert.equal(
    resolveChannelForIntent({ channelId: CHANNEL_TAOYUAN }),
    CHANNEL_TAOYUAN,
    'explicit taoyuan channelId should resolve to taoyuan'
  );

  // 2. By city: 桃園市
  assert.equal(
    resolveChannelForIntent({ city: '桃園市' }),
    CHANNEL_TAOYUAN,
    'city 桃園市 should resolve to taoyuan'
  );

  // 3. By routeId: lagi2...
  assert.equal(
    resolveChannelForIntent({ routeId: 'lagi2-006_2_21' }),
    CHANNEL_TAOYUAN,
    'route lagi2-006_2_21 should resolve to taoyuan'
  );

  // 4. By known Taoyuan group ID
  assert.equal(
    resolveChannelForIntent({ groupId: 'Cbc0aef28eb6226fafe1ea7e5a6e4487e' }),
    CHANNEL_TAOYUAN,
    'known Yangmei group should resolve to taoyuan'
  );

  // 5. Default cases: 新北市 / 汐止
  assert.equal(
    resolveChannelForIntent({ city: '新北市', routeId: '221010' }),
    CHANNEL_DEFAULT,
    'Xizhi route should resolve to default'
  );

  // 6. Default cases: 台南市 / 永康
  assert.equal(
    resolveChannelForIntent({ city: '台南市', routeId: '70' }),
    CHANNEL_DEFAULT,
    'Tainan route should resolve to default'
  );

  // 7. By stopName: 楊梅...
  assert.equal(
    resolveChannelForIntent({ stopName: '楊梅區中山南路146號' }),
    CHANNEL_TAOYUAN,
    'stopName containing 楊梅 should resolve to taoyuan'
  );

  // 8. Unknown or empty intent
  assert.equal(
    resolveChannelForIntent({}),
    CHANNEL_DEFAULT,
    'empty intent should safely fallback to default'
  );
});

test('channelService - getChannelCredentials retrieves correct tokens for channels', () => {
  const originalDefaultToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const originalDefaultSecret = process.env.LINE_CHANNEL_SECRET;
  const originalTyToken = process.env.LINE_CHANNEL_ACCESS_TOKEN_TAOYUAN;
  const originalTySecret = process.env.LINE_CHANNEL_SECRET_TAOYUAN;

  try {
    process.env.LINE_CHANNEL_ACCESS_TOKEN = 'mock-default-token';
    process.env.LINE_CHANNEL_SECRET = 'mock-default-secret';
    process.env.LINE_CHANNEL_ACCESS_TOKEN_TAOYUAN = 'mock-ty-token';
    process.env.LINE_CHANNEL_SECRET_TAOYUAN = 'mock-ty-secret';

    const defaultCreds = getChannelCredentials(CHANNEL_DEFAULT);
    assert.equal(defaultCreds.token, 'mock-default-token');
    assert.equal(defaultCreds.secret, 'mock-default-secret');
    assert.equal(defaultCreds.channelId, CHANNEL_DEFAULT);

    const tyCreds = getChannelCredentials(CHANNEL_TAOYUAN);
    assert.equal(tyCreds.token, 'mock-ty-token');
    assert.equal(tyCreds.secret, 'mock-ty-secret');
    assert.equal(tyCreds.channelId, CHANNEL_TAOYUAN);

    // Fallback for null or undefined
    const fallbackCreds = getChannelCredentials();
    assert.equal(fallbackCreds.token, 'mock-default-token');
  } finally {
    process.env.LINE_CHANNEL_ACCESS_TOKEN = originalDefaultToken;
    process.env.LINE_CHANNEL_SECRET = originalDefaultSecret;
    process.env.LINE_CHANNEL_ACCESS_TOKEN_TAOYUAN = originalTyToken;
    process.env.LINE_CHANNEL_SECRET_TAOYUAN = originalTySecret;
  }
});

test('channelService - verifyWebhookSignature correctly identifies caller channel from signature', () => {
  const originalDefaultSecret = process.env.LINE_CHANNEL_SECRET;
  const originalTySecret = process.env.LINE_CHANNEL_SECRET_TAOYUAN;

  const defaultSecret = 'secret-default-key-12345';
  const tySecret = '117874bc8bdea8f5c64b82d1c0f5eb4e';

  try {
    process.env.LINE_CHANNEL_SECRET = defaultSecret;
    process.env.LINE_CHANNEL_SECRET_TAOYUAN = tySecret;

    const payload = JSON.stringify({ events: [{ type: 'message', text: 'hello' }] });

    // Compute signature for Taoyuan
    const tySig = crypto
      .createHmac('SHA256', tySecret)
      .update(payload)
      .digest('base64');

    // Compute signature for Default
    const defaultSig = crypto
      .createHmac('SHA256', defaultSecret)
      .update(payload)
      .digest('base64');

    const tyResult = verifyWebhookSignature(payload, tySig);
    assert.equal(tyResult.ok, true);
    assert.equal(tyResult.channelId, CHANNEL_TAOYUAN);

    const defResult = verifyWebhookSignature(payload, defaultSig);
    assert.equal(defResult.ok, true);
    assert.equal(defResult.channelId, CHANNEL_DEFAULT);

    const invalidResult = verifyWebhookSignature(payload, 'invalid-signature-value');
    assert.equal(invalidResult.ok, false);
  } finally {
    process.env.LINE_CHANNEL_SECRET = originalDefaultSecret;
    process.env.LINE_CHANNEL_SECRET_TAOYUAN = originalTySecret;
  }
});

test('channelService - getQuotaMonthKey formats independent keys per channel', () => {
  assert.equal(getQuotaMonthKey('2026-09', CHANNEL_DEFAULT), '2026-09');
  assert.equal(getQuotaMonthKey('2026-09'), '2026-09');
  assert.equal(getQuotaMonthKey('2026-09', CHANNEL_TAOYUAN), '2026-09:taoyuan');
});
