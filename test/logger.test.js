import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractTriggerSource,
  formatTaiwanTimestamp,
  recordExecutionLog,
} from '../lib/logger.js';
import { supabase } from '../lib/supabaseClient.js';

test('logger - extractTriggerSource detects various callers', () => {
  assert.equal(extractTriggerSource(null), 'unknown');
  assert.equal(extractTriggerSource({}), 'unknown');

  assert.equal(
    extractTriggerSource({ headers: { 'user-agent': 'cron-job.org/1.0' } }),
    'cron-job.org'
  );

  assert.equal(
    extractTriggerSource({ headers: { 'user-agent': 'vercel-cron/1.0' } }),
    'vercel-cron'
  );

  assert.equal(
    extractTriggerSource({ headers: { 'x-vercel-cron': '1' } }),
    'vercel-cron'
  );

  assert.equal(
    extractTriggerSource({ headers: { 'user-agent': 'curl/8.1.0' } }),
    'curl'
  );
});

test('logger - formatTaiwanTimestamp returns valid format', () => {
  const ts = formatTaiwanTimestamp();
  assert.match(ts, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test('logger - recordExecutionLog writes to execution_logs when available', async () => {
  let insertedData = null;
  mock.method(supabase, 'from', (table) => {
    if (table === 'execution_logs') {
      return {
        insert: async (data) => {
          insertedData = data;
          return { error: null };
        },
      };
    }
    return {};
  });

  try {
    const result = await recordExecutionLog({
      status: 'success',
      reason: 'test-reason',
      triggerSource: 'test-caller',
      recordsCount: 10,
      matchedArrivals: 1,
      sentNotifications: 1,
      details: { foo: 'bar' },
    });

    assert.equal(result.ok, true);
    assert.equal(result.target, 'execution_logs');
    assert.equal(insertedData.status, 'success');
    assert.equal(insertedData.reason, 'test-reason');
    assert.equal(insertedData.trigger_source, 'test-caller');
  } finally {
    mock.restoreAll();
  }
});

test('logger - recordExecutionLog gracefully falls back to daily_status when execution_logs table missing', async () => {
  let updatedPayload = null;
  mock.method(supabase, 'from', (table) => {
    if (table === 'execution_logs') {
      return {
        insert: async () => ({
          error: { code: '42P01', message: 'relation "execution_logs" does not exist' },
        }),
      };
    }
    if (table === 'daily_status') {
      return {
        update: (payload) => ({
          eq: async () => {
            updatedPayload = payload;
            return { error: null };
          },
        }),
      };
    }
    return {};
  });

  try {
    const result = await recordExecutionLog({
      status: 'unauthorized',
      reason: 'invalid-cron-secret',
      triggerSource: 'cron-job.org',
      dateStr: '2026-09-08',
    });

    assert.equal(result.ok, true);
    assert.equal(result.target, 'daily_status');
    assert.ok(updatedPayload);
    assert.ok(updatedPayload.last_api_error.includes('AUTH_FAIL'));
    assert.ok(updatedPayload.last_api_error.includes('cron-job.org'));
  } finally {
    mock.restoreAll();
  }
});
