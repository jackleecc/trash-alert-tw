import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { supabase } from '../lib/supabaseClient.js';
import {
  loadCityStatus,
  updateStatusOnSuccess,
  updateStatusOnFailure,
  parsePausedCitiesFromError,
  parseCityFailCountsFromError,
} from '../lib/cityCircuitBreaker.js';

test('parsePausedCitiesFromError and parseCityFailCountsFromError extract JSON/tags correctly', () => {
  // 1. parsePausedCitiesFromError
  assert.deepEqual(
    parsePausedCitiesFromError('[PAUSED_CITIES:桃園市,台南市] Network error'),
    ['桃園市', '台南市']
  );
  assert.deepEqual(
    parsePausedCitiesFromError('[PAUSED_CITIES: 新北市 ] Timeout'),
    ['新北市']
  );
  assert.deepEqual(parsePausedCitiesFromError('一般連線逾時錯誤'), []);
  assert.deepEqual(parsePausedCitiesFromError(null), []);
  assert.deepEqual(parsePausedCitiesFromError(undefined), []);

  // 2. parseCityFailCountsFromError
  const withCounts =
    '[CITY_FAILS:{"桃園市":3,"新北市":1}] [PAUSED_CITIES:桃園市] Connection refused';
  assert.deepEqual(parseCityFailCountsFromError(withCounts), { 桃園市: 3, 新北市: 1 });
  assert.deepEqual(parseCityFailCountsFromError('無統計資訊的錯誤'), {});
  assert.deepEqual(parseCityFailCountsFromError(null), {});
  assert.deepEqual(parseCityFailCountsFromError('[CITY_FAILS:invalid_json]'), {});
});

test('updateStatusOnFailure - increments city failure count and marks city as paused when reaching maxRetries', async () => {
  let capturedPayload = null;
  mock.method(supabase, 'from', () => ({
    update: (payload) => {
      capturedPayload = payload;
      return { eq: async () => ({ error: null }) };
    },
    upsert: async (payload) => {
      capturedPayload = payload;
      return { error: null };
    },
  }));

  try {
    const result = await updateStatusOnFailure({
      dateStr: '2026-09-18',
      failedCities: ['桃園市'],
      cityFailCounts: { 桃園市: 2 },
      pausedCities: [],
      maxRetries: 3,
      errorMessage: '連線逾時 (ETIMEDOUT)',
    });

    assert.equal(result.shouldPause, true, 'City should be paused when fail count reaches maxRetries');
    assert.deepEqual(result.pausedCities, ['桃園市'], 'pausedCities should contain newly paused city');
    assert.equal(result.cityFailCounts?.['桃園市'], 3, 'Failure count should be incremented to 3');
  } finally {
    mock.restoreAll();
  }
});

test('updateStatusOnSuccess - clears failure count and unpauses recovered cities', async () => {
  let capturedPayload = null;
  mock.method(supabase, 'from', () => ({
    update: (payload) => {
      capturedPayload = payload;
      return { eq: async () => ({ error: null }) };
    },
    upsert: async (payload) => {
      capturedPayload = payload;
      return { error: null };
    },
  }));

  try {
    const result = await updateStatusOnSuccess({
      dateStr: '2026-09-18',
      succeededCities: ['桃園市'],
      cityFailCounts: { 桃園市: 3, 高雄市: 1 },
      pausedCities: ['桃園市'],
    });

    assert.ok(result, 'Result should be returned from updateStatusOnSuccess');
    assert.deepEqual(result.pausedCities, [], 'Recovered city should be removed from pausedCities');
    assert.equal(result.cityFailCounts?.['桃園市'], undefined, 'Recovered city failure count should be cleared');
    assert.equal(result.cityFailCounts?.['高雄市'], 1, 'Other city failure counts should remain intact');
  } finally {
    mock.restoreAll();
  }
});
