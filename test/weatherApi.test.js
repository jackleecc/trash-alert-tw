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
            pm2_5: [10, 75.0], // >= 70 (PM2.5 Warning)
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
            pm2_5: [10, 70.0], // >= 70 (PM2.5 Warning threshold)
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

test('checkUpcomingRain - PM2.5 boundary check (69.9 does not trigger, 70.0 triggers)', async () => {
  const originalFetch = globalThis.fetch;
  try {
    // 1. 69.9 should NOT trigger warning
    globalThis.fetch = async (url) => {
      if (url.includes('air-quality-api')) {
        return {
          ok: true,
          json: async () => ({
            hourly: {
              time: ['2026-09-07T11:00', '2026-09-07T12:00'],
              pm2_5: [10, 69.9],
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
            uv_index: [0, 2],
          },
        }),
      };
    };

    const resBelow = await checkUpcomingRain(25.0, 121.5);
    assert.equal(resBelow.pmWarning, false);
    assert.equal(resBelow.shouldNotify, false);

    // 2. 70.0 SHOULD trigger warning
    globalThis.fetch = async (url) => {
      if (url.includes('air-quality-api')) {
        return {
          ok: true,
          json: async () => ({
            hourly: {
              time: ['2026-09-07T11:00', '2026-09-07T12:00'],
              pm2_5: [10, 70.0],
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
            uv_index: [0, 2],
          },
        }),
      };
    };

    const resExact = await checkUpcomingRain(25.0, 121.5);
    assert.equal(resExact.pmWarning, true);
    assert.equal(resExact.shouldNotify, true);
    assert.ok(resExact.desc.includes('PM2.5 濃度 70μg/m³ ≥ 70'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});


