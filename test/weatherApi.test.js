import test from 'node:test';
import assert from 'node:assert/strict';
import { checkUpcomingRain } from '../lib/weatherApi.js';

test('checkUpcomingRain - accurately parses rainy conditions', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('air-quality-api')) {
      return {
        ok: true,
        json: async () => ({
          hourly: {
            time: ['2026-09-07T11:00', '2026-09-07T12:00'],
            pm2_5: [10, 15], // Normal AQ
          },
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        hourly: {
          time: ['2026-09-07T11:00', '2026-09-07T12:00'],
          precipitation: [0, 1.2],
          precipitation_probability: [10, 80],
          uv_index: [1, 2],
        },
      }),
    };
  };

  try {
    const res = await checkUpcomingRain(25.0, 121.5);
    assert.equal(res.shouldNotify, true);
    assert.equal(res.willRain, true);
    assert.equal(res.uvWarning, false);
    assert.equal(res.pmWarning, false);
    assert.ok(res.desc.includes('降雨'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('checkUpcomingRain - accurately parses PM2.5 and UV warnings', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('air-quality-api')) {
      return {
        ok: true,
        json: async () => ({
          hourly: {
            time: ['2026-09-07T11:00', '2026-09-07T12:00'],
            pm2_5: [10, 45.0], // > 35.5 (Unhealthy for sensitive groups)
          },
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        hourly: {
          time: ['2026-09-07T11:00', '2026-09-07T12:00'],
          precipitation: [0, 0],
          precipitation_probability: [0, 0],
          uv_index: [5, 9.5], // >= 8 (Very High UV)
        },
      }),
    };
  };

  try {
    const res = await checkUpcomingRain(25.0, 121.5);
    assert.equal(res.shouldNotify, true);
    assert.equal(res.willRain, false);
    assert.equal(res.uvWarning, true);
    assert.equal(res.pmWarning, true);
    assert.ok(res.desc.includes('紫外線過量'));
    assert.ok(res.desc.includes('空氣品質不良'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('checkUpcomingRain - correctly identifies dry and normal conditions', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('air-quality-api')) {
      return {
        ok: true,
        json: async () => ({
          hourly: {
            time: ['2026-09-07T11:00', '2026-09-07T12:00'],
            pm2_5: [10, 12],
          },
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        hourly: {
          time: ['2026-09-07T11:00', '2026-09-07T12:00'],
          precipitation: [0, 0],
          precipitation_probability: [0, 5],
          uv_index: [0, 3],
        },
      }),
    };
  };

  try {
    const res = await checkUpcomingRain(25.0, 121.5);
    assert.equal(res.shouldNotify, false);
    assert.equal(res.willRain, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
