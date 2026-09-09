import test from 'node:test';
import assert from 'node:assert/strict';
import { checkUpcomingRain } from '../lib/weatherApi.js';

test('checkUpcomingRain - accurately parses rainy conditions when prob >= 60', async () => {
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

test('checkUpcomingRain - ignores rain when probability is under 60% even with precipitation', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('air-quality-api')) {
      return {
        ok: true,
        json: async () => ({
          hourly: {
            time: ['2026-09-07T11:00', '2026-09-07T12:00'],
            pm2_5: [10, 15],
          },
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        hourly: {
          time: ['2026-09-07T11:00', '2026-09-07T12:00'],
          precipitation: [0, 2.5], // 有降雨量
          precipitation_probability: [10, 55], // 但機率 55% (< 60%)
          uv_index: [1, 2],
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

test('checkUpcomingRain - triggers rain when probability is exactly 60%', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('air-quality-api')) {
      return {
        ok: true,
        json: async () => ({
          hourly: {
            time: ['2026-09-07T11:00', '2026-09-07T12:00'],
            pm2_5: [10, 15],
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
          precipitation_probability: [10, 60], // 恰好 60%
          uv_index: [1, 2],
        },
      }),
    };
  };

  try {
    const res = await checkUpcomingRain(25.0, 121.5);
    assert.equal(res.shouldNotify, true);
    assert.equal(res.willRain, true);
    assert.ok(res.desc.includes('降雨'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('checkUpcomingRain - accurately bundles rain, UV, and PM2.5 in a single notification', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('air-quality-api')) {
      return {
        ok: true,
        json: async () => ({
          hourly: {
            time: ['2026-09-07T11:00', '2026-09-07T12:00'],
            pm2_5: [10, 48.0], // > 35.5 (PM2.5 Warning)
          },
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        hourly: {
          time: ['2026-09-07T11:00', '2026-09-07T12:00'],
          precipitation: [0, 3.5],
          precipitation_probability: [10, 75], // >= 60% (Rain Warning)
          uv_index: [5, 9.0], // >= 8 (UV Warning)
        },
      }),
    };
  };

  try {
    const res = await checkUpcomingRain(25.0, 121.5);
    assert.equal(res.shouldNotify, true);
    assert.equal(res.willRain, true);
    assert.equal(res.uvWarning, true);
    assert.equal(res.pmWarning, true);
    assert.ok(res.desc.includes('降雨'));
    assert.ok(res.desc.includes('紫外線過量'));
    assert.ok(res.desc.includes('空氣品質不良'));
    // 驗證三項合併在同一個換行文字中
    const lines = res.desc.split('\n');
    assert.equal(lines.length, 3);
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

