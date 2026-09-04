import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.CRON_SECRET = 'valid-secret';

import handler from '../api/check-trucks.js';
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

test('check-trucks - blocks missing CRON_SECRET', async () => {
  const req = { headers: {} };
  const res = mockResponse();
  
  await handler(req, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.ok, false);
});

test('check-trucks - early exit outside service window', async () => {
  const originalSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'valid-secret';

  const OriginalDate = Date;
  global.Date = class extends OriginalDate {
    constructor(...args) {
      if (args.length === 0) return new OriginalDate('2026-09-02T04:00:00Z'); // 12:00 TW
      return new OriginalDate(...args);
    }
    static now() { return new OriginalDate('2026-09-02T04:00:00Z').getTime(); }
  };

  const req = { headers: { authorization: 'Bearer valid-secret' } };
  const res = mockResponse();
  
  try {
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.skipped, true);
    assert.equal(res.body.reason, 'outside-service-window');
  } finally {
    process.env.CRON_SECRET = originalSecret;
    global.Date = OriginalDate;
  }
});

test('check-trucks - early exit on suspension day', async () => {
  const originalSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'valid-secret';

  const OriginalDate = Date;
  global.Date = class extends OriginalDate {
    constructor(...args) {
      if (args.length === 0) return new OriginalDate('2026-09-02T10:00:00Z'); // 18:00 TW
      return new OriginalDate(...args);
    }
  };

  mock.method(supabase, 'from', () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: { is_suspended: true }, error: null })
      })
    })
  }));

  const req = { headers: { authorization: 'Bearer valid-secret' } };
  const res = mockResponse();
  
  try {
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.skipped, true);
    assert.equal(res.body.reason, 'suspension-day');
  } finally {
    process.env.CRON_SECRET = originalSecret;
    global.Date = OriginalDate;
    mock.restoreAll();
  }
});
