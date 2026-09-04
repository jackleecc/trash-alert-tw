import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { supabase } from '../lib/supabaseClient.js';
import * as dgpa from '../lib/dgpa.js';
import {
  getTodaySuspensionStatus
} from '../lib/dailyStatus.js';

test('getTodaySuspensionStatus - returns cached value if exists', async () => {
  mock.method(supabase, 'from', () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: { is_suspended: true }, error: null })
      })
    })
  }));

  const res = await getTodaySuspensionStatus('2026-09-02');
  assert.equal(res, true);
  mock.restoreAll();
});

test('getTodaySuspensionStatus - fetches and caches if missing', async () => {
  let upsertedData = null;
  mock.method(supabase, 'from', () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: null, error: null })
      })
    }),
    upsert: async (data) => {
      upsertedData = data;
      return { error: null };
    }
  }));

  // Mock global fetch for the DGPA URL
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    text: async () => '<html><tr><td class="table-city">高雄市</td><td class="table-status">停止上班、停止上課。</td></tr></html>'
  });

  try {
    const res = await getTodaySuspensionStatus('2026-09-02');
    assert.equal(res, true);
    assert.equal(upsertedData.date, '2026-09-02');
    assert.equal(upsertedData.is_suspended, true);
  } finally {
    global.fetch = originalFetch;
    mock.restoreAll();
  }
});
