import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  safeCompare,
  extractIncomingSecret,
  validateEndpointAuth,
  guardEndpoint,
  withEndpointGuard,
} from '../lib/endpointGuard.js';
import { supabase } from '../lib/supabaseClient.js';

function createMockResponse() {
  const res = {
    statusCode: null,
    body: null,
    get bodyData() {
      return this.body;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
  };
  return res;
}

test('Case 1: safeCompare returns true for identical strings, and false for different strings, different lengths, null, undefined, numbers', () => {
  // Identical strings -> true
  assert.equal(safeCompare('my-secret-token-123', 'my-secret-token-123'), true);
  assert.equal(safeCompare('a', 'a'), true);
  assert.equal(safeCompare('', ''), true);

  // Different strings -> false
  assert.equal(safeCompare('my-secret-token-123', 'my-secret-token-456'), false);
  assert.equal(safeCompare('abc', 'def'), false);

  // Different lengths -> false
  assert.equal(safeCompare('short', 'longer-string'), false);
  assert.equal(safeCompare('token', 'token-extra'), false);

  // Null, undefined, numbers, non-strings -> false
  assert.equal(safeCompare(null, 'secret'), false);
  assert.equal(safeCompare('secret', null), false);
  assert.equal(safeCompare(undefined, 'secret'), false);
  assert.equal(safeCompare('secret', undefined), false);
  assert.equal(safeCompare(12345, '12345'), false);
  assert.equal(safeCompare('12345', 12345), false);
  assert.equal(safeCompare({}, {}), false);
  assert.equal(safeCompare(null, null), false);
  assert.equal(safeCompare(undefined, undefined), false);
});

test('Case 2: extractIncomingSecret extracts secret correctly from various request sources', () => {
  // req.headers['authorization'] = 'Bearer my-token'
  const reqBearer = {
    headers: {
      authorization: 'Bearer my-token',
    },
  };
  assert.equal(extractIncomingSecret(reqBearer), 'my-token');

  // req.headers['x-cron-secret'] = 'x-cron-token'
  const reqCronHeader = {
    headers: {
      'x-cron-secret': 'x-cron-token',
    },
  };
  assert.equal(extractIncomingSecret(reqCronHeader), 'x-cron-token');

  // req.headers['x-relay-secret'] = 'x-relay-token'
  const reqRelayHeader = {
    headers: {
      'x-relay-secret': 'x-relay-token',
    },
  };
  assert.equal(extractIncomingSecret(reqRelayHeader), 'x-relay-token');

  // req.body.secret = 'body-token'
  const reqBody = {
    headers: {},
    body: {
      secret: 'body-token',
    },
  };
  assert.equal(extractIncomingSecret(reqBody), 'body-token');

  // req.query.secret = 'query-token'
  const reqQuery = {
    headers: {},
    query: {
      secret: 'query-token',
    },
  };
  assert.equal(extractIncomingSecret(reqQuery), 'query-token');

  // Empty or invalid req
  assert.equal(extractIncomingSecret({}), '');
  assert.equal(extractIncomingSecret(null), '');
});

test('Case 3: guardEndpoint returns { authorized: true, triggerSource } and does NOT send 401 when token matches CRON_SECRET or options.expectedSecret', async () => {
  const originalSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'env-secret-123';

  try {
    // 3a. Matches process.env.CRON_SECRET
    const reqEnv = {
      headers: {
        authorization: 'Bearer env-secret-123',
        'user-agent': 'curl/8.1.0',
      },
    };
    const resEnv = createMockResponse();
    const resultEnv = await guardEndpoint(reqEnv, resEnv);

    assert.equal(resultEnv.authorized, true);
    assert.equal(resultEnv.triggerSource, 'curl');
    assert.equal(resEnv.statusCode, null);

    // 3b. Matches options.expectedSecret
    const reqCustom = {
      headers: {
        'x-relay-secret': 'custom-relay-token',
        'user-agent': 'cron-job.org',
      },
    };
    const resCustom = createMockResponse();
    const resultCustom = await guardEndpoint(reqCustom, resCustom, {
      expectedSecret: 'custom-relay-token',
    });

    assert.equal(resultCustom.authorized, true);
    assert.equal(resultCustom.triggerSource, 'cron-job.org');
    assert.equal(resCustom.statusCode, null);
  } finally {
    process.env.CRON_SECRET = originalSecret;
  }
});

test('Case 4: guardEndpoint writes an audit log with status unauthorized and sends HTTP 401 { ok: false, error: ... } when secret is missing or wrong', async () => {
  const originalSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'env-secret-123';

  const insertedLogs = [];
  mock.method(supabase, 'from', (table) => {
    if (table === 'execution_logs') {
      return {
        insert: async (data) => {
          insertedLogs.push(data);
          return { error: null };
        },
      };
    }
    return {};
  });

  try {
    // 4a. Missing secret
    const reqMissing = {
      headers: {
        'user-agent': 'curl/8.1.0',
      },
    };
    const resMissing = createMockResponse();
    const resultMissing = await guardEndpoint(reqMissing, resMissing);

    assert.equal(resultMissing.authorized, false);
    assert.equal(resMissing.statusCode, 401);
    assert.equal(resMissing.body.ok, false);
    assert.match(resMissing.body.error, /unauthorized/i);

    // 4b. Wrong secret
    const reqWrong = {
      headers: {
        authorization: 'Bearer wrong-secret-token',
        'user-agent': 'cron-job.org',
      },
    };
    const resWrong = createMockResponse();
    const resultWrong = await guardEndpoint(reqWrong, resWrong);

    assert.equal(resultWrong.authorized, false);
    assert.equal(resWrong.statusCode, 401);
    assert.equal(resWrong.body.ok, false);
    assert.match(resWrong.body.error, /unauthorized/i);

    // Verify audit logs were written with status 'unauthorized'
    assert.ok(insertedLogs.length >= 2, 'Should write at least two audit logs for unauthorized requests');
    assert.equal(insertedLogs[0].status, 'unauthorized');
    assert.equal(insertedLogs[1].status, 'unauthorized');
  } finally {
    process.env.CRON_SECRET = originalSecret;
    mock.restoreAll();
  }
});

test('Case 5: guardEndpoint supports custom endpoint identifier and options (e.g. endpointName for audit log details)', async () => {
  const originalSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'expected-env-secret';

  const insertedLogs = [];
  mock.method(supabase, 'from', (table) => {
    if (table === 'execution_logs') {
      return {
        insert: async (data) => {
          insertedLogs.push(data);
          return { error: null };
        },
      };
    }
    return {};
  });

  try {
    const req = {
      headers: {
        'x-cron-secret': 'invalid-token',
        'user-agent': 'google-cloud-scheduler',
      },
    };
    const res = createMockResponse();
    const result = await guardEndpoint(req, res, {
      endpointName: '/api/tainan-relay',
    });

    assert.equal(result.authorized, false);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.ok, false);

    assert.ok(insertedLogs.length >= 1, 'Should have written an audit log');
    const log = insertedLogs[insertedLogs.length - 1];
    assert.equal(log.status, 'unauthorized');
    const hasEndpointInfo =
      log.details?.endpoint === '/api/tainan-relay' ||
      log.details?.path === '/api/tainan-relay' ||
      log.details?.endpointName === '/api/tainan-relay';
    assert.ok(hasEndpointInfo, 'Audit log details should include the custom endpointName or path');
  } finally {
    process.env.CRON_SECRET = originalSecret;
    mock.restoreAll();
  }
});

test('Case 6: validateEndpointAuth and withEndpointGuard function correctly without HTTP leak', async () => {
  const originalSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'guard-secret-456';

  try {
    // Test validateEndpointAuth
    const validReq = { headers: { authorization: 'Bearer guard-secret-456' } };
    const validAuth = await validateEndpointAuth(validReq);
    assert.equal(validAuth.authorized, true);
    assert.equal(validAuth.incomingSecret, 'guard-secret-456');

    const invalidReq = { headers: { authorization: 'Bearer wrong-secret' } };
    const invalidAuth = await validateEndpointAuth(invalidReq);
    assert.equal(invalidAuth.authorized, false);

    // Test withEndpointGuard wrapper
    let handlerInvoked = false;
    const guarded = withEndpointGuard({ endpointName: '/test' }, async (req, res, guard) => {
      handlerInvoked = true;
      return res.status(200).json({ ok: true, guard });
    });

    // 1. Rejection stops execution
    const resBlocked = createMockResponse();
    await guarded(invalidReq, resBlocked);
    assert.equal(handlerInvoked, false);
    assert.equal(resBlocked.statusCode, 401);

    // 2. Acceptance executes handler
    const resAllowed = createMockResponse();
    await guarded(validReq, resAllowed);
    assert.equal(handlerInvoked, true);
    assert.equal(resAllowed.statusCode, 200);
    assert.equal(resAllowed.body.ok, true);
  } finally {
    process.env.CRON_SECRET = originalSecret;
  }
});

