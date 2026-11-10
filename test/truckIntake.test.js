import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchActiveTrucks, TAOYUAN_TRUCK_API_URL } from '../lib/truckIntake.js';

test('fetchActiveTrucks - with mocked fetch returns normalized truck records and correct sourceStats', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    return {
      ok: true,
      text: async () =>
        JSON.stringify({
          data: [
            {
              linid: 'R101',
              x: '121.5',
              y: '25.0',
              car: 'TRUCK-1',
              time: '2026-09-18T16:00:00',
            },
          ],
        }),
    };
  };

  try {
    const res = await fetchActiveTrucks({ targetCities: ['新北市', '高雄市'] });
    assert.equal(res.ok, true, 'Result should be ok: true');
    assert.ok(Array.isArray(res.data), 'Data should be an array');
    assert.ok(res.data.length > 0, 'Data array should not be empty');

    // 驗證回傳物件具備正規化欄位
    const firstTruck = res.data[0];
    assert.equal(firstTruck.route_id, 'R101');
    assert.equal(typeof firstTruck.lat, 'number');
    assert.equal(typeof firstTruck.lng, 'number');

    // 驗證 sourceStats 統計資訊
    assert.ok(Array.isArray(res.sourceStats), 'sourceStats should be an array');
    assert.equal(res.sourceStats.length, 2);
    assert.ok(res.sourceStats.every((s) => s.ok === true && s.count > 0));
  } finally {
    global.fetch = originalFetch;
  }
});

test('fetchActiveTrucks - isolates errors when one city fails and others succeed (partial success)', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (typeof url === 'string' && (url.includes('api.kcg.gov.tw') || url.includes('kcg'))) {
      throw new Error('KCG upstream service unavailable');
    }
    return {
      ok: true,
      text: async () =>
        JSON.stringify({
          data: [
            {
              linid: 'NTPC-1',
              x: '121.6',
              y: '25.1',
              car: 'CAR-NTPC',
              time: '2026-09-18T16:00:00',
            },
          ],
        }),
    };
  };

  try {
    const res = await fetchActiveTrucks({ targetCities: ['新北市', '高雄市'] });
    assert.equal(res.ok, true, 'Partial success should still return ok: true');
    assert.ok(Array.isArray(res.data), 'Data should be an array');
    assert.ok(res.data.length > 0, 'Data should contain records from successful cities');
    assert.ok(Array.isArray(res.errors), 'Errors should be an array');
    assert.ok(res.errors.length > 0, 'Errors should record failed cities');

    // 驗證 sourceStats 確實隔離成功與失敗狀態
    const kcgStat = res.sourceStats.find(
      (s) => s.city === '高雄市' || (s.url && s.url.includes('kcg'))
    );
    const ntpcStat = res.sourceStats.find(
      (s) => s.city === '新北市' || (s.url && s.url.includes('ntpc'))
    );
    assert.ok(kcgStat, 'KCG sourceStat should exist');
    assert.equal(kcgStat.ok, false, 'KCG sourceStat should be marked as ok: false');
    assert.ok(ntpcStat, 'NTPC sourceStat should exist');
    assert.equal(ntpcStat.ok, true, 'NTPC sourceStat should be marked as ok: true');
  } finally {
    global.fetch = originalFetch;
  }
});

test('fetchActiveTrucks - filters out paused cities from HTTP requests', async () => {
  const originalFetch = global.fetch;
  const requestedUrls = [];
  global.fetch = async (url) => {
    requestedUrls.push(String(url));
    return {
      ok: true,
      text: async () =>
        JSON.stringify({
          data: [
            {
              linid: 'NTPC-1',
              x: '121.6',
              y: '25.1',
              car: 'CAR-NTPC',
              time: '2026-09-18T16:00:00',
            },
          ],
        }),
    };
  };

  try {
    const res = await fetchActiveTrucks({
      targetCities: ['新北市', '桃園市'],
      pausedCities: ['桃園市'],
    });
    assert.equal(res.ok, true, 'Result should be ok: true');
    assert.equal(requestedUrls.length, 1, 'Only non-paused cities should be requested');
    assert.ok(
      !requestedUrls.some((u) => u.includes('tyoem') || u.includes('route.tyoem.gov.tw')),
      'Paused city (桃園市) should not be requested'
    );
    assert.ok(
      requestedUrls.some((u) => u.includes('data.ntpc.gov.tw') || u.includes('ntpc')),
      'Active city (新北市) should be requested'
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('fetchActiveTrucks - marks canonical Taoyuan endpoint records with valid gpstime as taoyuan-primary gps', async () => {
  const originalFetch = global.fetch;
  const requestedRoutingIds = [];

  global.fetch = async (url, init) => {
    const urlStr = String(url);
    if (urlStr === 'https://route.tyoem.gov.tw/') {
      return {
        ok: true,
        headers: {
          get: (h) => (h && h.toLowerCase() === 'set-cookie' ? 'JSESSIONID=dummy-cookie; Path=/;' : null),
        },
        text: async () => '<html><input id="random_form" value="rf-token" /></html>',
      };
    }

    if (urlStr === TAOYUAN_TRUCK_API_URL || urlStr.includes('tyoem.gov.tw')) {
      const bodyStr = init?.body ? String(init.body) : '';
      if (bodyStr.includes('dcfid=carGpsAllQuery1')) {
        return {
          ok: true,
          text: async () => JSON.stringify({ result: [] }),
        };
      }
      if (bodyStr.includes('dcfid=lagifQueryRealtimeByRoute')) {
        const match = bodyStr.match(/routing_id=([^&]+)/);
        const routingId = match ? decodeURIComponent(match[1]) : '';
        if (routingId) requestedRoutingIds.push(routingId);

        if (routingId === 'lagi2-006_2_21') {
          return {
            ok: true,
            text: async () =>
              JSON.stringify({
                result: [
                  {
                    carno: 'KEK-3178',
                    py: 24.908077,
                    px: 121.144473,
                    gpstime: { year: 126, month: 10, date: 9, hours: 17, minutes: 10, seconds: 15 },
                  },
                  {
                    carno: 'BAD-TIME',
                    py: 24.908077,
                    px: 121.144473,
                  },
                ],
              }),
          };
        }
        return {
          ok: true,
          text: async () => JSON.stringify({ result: [] }),
        };
      }
    }

    return {
      ok: true,
      text: async () => JSON.stringify({ data: [] }),
    };
  };

  try {
    const res = await fetchActiveTrucks({
      targetCities: ['桃園市'],
      requiredTaoyuanRouteIds: ['lagi2-006_2_21', 'custom-route-2'],
    });

    assert.equal(res.ok, true, 'Result should be ok');
    const kekTruck = res.data.find((t) => t.car_id === 'KEK-3178');
    assert.ok(kekTruck, 'KEK-3178 should exist');
    assert.equal(kekTruck.source, 'taoyuan-primary', 'KEK-3178 should have source taoyuan-primary');
    assert.equal(kekTruck.timestamp_kind, 'gps', 'KEK-3178 should have timestamp_kind gps');
    assert.equal(
      kekTruck.source_timestamp,
      '2026-11-09T09:10:15.000Z',
      'KEK-3178 should have ISO source_timestamp converted from gpstime'
    );

    const badTruck = res.data.find((t) => t.car_id === 'BAD-TIME');
    assert.ok(badTruck, 'BAD-TIME should exist');
    assert.notEqual(badTruck.timestamp_kind, 'gps', 'BAD-TIME should not have timestamp_kind gps');

    assert.ok(
      requestedRoutingIds.includes('custom-route-2'),
      'lagifQueryRealtimeByRoute should have been requested for custom-route-2'
    );
  } finally {
    global.fetch = originalFetch;
  }
});
