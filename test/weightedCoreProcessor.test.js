import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { supabase } from '../lib/supabaseClient.js';
import { processTruckArrivals, recentTruckHistory } from '../lib/coreProcessor.js';

test('processTruckArrivals - builds per-group messages and intents with weighted member counts', async () => {
  recentTruckHistory.clear();

  const approachRows = new Map();
  const collectionApproachStore = {
    async read(key) { return approachRows.get(JSON.stringify(key)) || null; },
    async commit({ key, expectedVersion, nextState }) {
      const serializedKey = JSON.stringify(key);
      const current = approachRows.get(serializedKey) || { version: 0, state: null };
      if (current.version !== expectedVersion) return { applied: false, version: current.version };
      const version = current.version + 1;
      approachRows.set(serializedKey, { version, state: nextState });
      return { applied: true, version };
    },
  };

  const ymStops = [
    {
      id: 101,
      route_id: 'lagi2-006_2_21',
      order_index: 1,
      name: '大平街246號(右邊)',
      lat: 24.910226,
      lng: 121.140549,
      schedule_time: '17:10:00',
    },
    {
      id: 8,
      route_id: 'lagi2-006_2_21',
      order_index: 2,
      name: '中山南路100號',
      lat: 24.907498,
      lng: 121.137464,
      schedule_time: '17:14:00',
    },
    {
      id: 9,
      route_id: 'lagi2-006_2_21',
      order_index: 3,
      name: '楊梅區中山南路146號',
      lat: 24.907648,
      lng: 121.136540,
      schedule_time: '17:15:00',
    },
  ];

  const mockContext = {
    ok: true,
    activeRoutesMap: new Map([
      [
        'lagi2-006_2_21',
        {
          id: 'lagi2-006_2_21',
          name: '楊梅區 垃圾清運路十七線',
          city: '桃園市',
        },
      ],
    ]),
    stops: [ymStops[2]],
    allRouteStops: ymStops,
    stopSubscribersMap: new Map([
      ['9', new Set(['G_TY_9', 'G_OTHER_3'])],
    ]),
    groupMemberCountMap: new Map([
      ['G_TY_9', 9],
      ['G_OTHER_3', 3],
    ]),
  };

  let dispatchedIntents = null;
  const mockDispatchBatch = async (intents) => {
    dispatchedIntents = intents;
    return {
      total: intents.length,
      sent: intents.length,
      suppressed: 0,
      failed: 0,
      errors: [],
    };
  };

  mock.method(supabase, 'from', (table) => {
    if (table === 'system_quota') {
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { month: '2026-10', used_count: 0, is_melted: false }, error: null }) }) }) };
    }
    if (table === 'route_linids') {
      return { select: () => ({ in: () => ({ gte: async () => ({ data: [{ route_id: 'lagi2-006_2_21', linid: 'lagi2-006_2_21', observed_count: 3 }, { route_id: 'lagi2-006_2_21', linid: 'KEK-3178', observed_count: 3 }], error: null }) }) }) };
    }
    return {};
  });
  mock.method(supabase, 'rpc', async () => ({ data: null, error: null }));

  // Mock globalThis.fetch to avoid slow network timeouts in test
  mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({
      current: { precipitation_probability: 0, pm2_5: 10 },
      hourly: { precipitation_probability: [0, 0] },
    }),
  }));

  try {
    // Step 1: 17:10:00 TW (09:10:00Z) at 大平街246號
    const truckStep1 = [
      {
        car_id: 'KEK-3178',
        route_id: 'lagi2-006_2_21',
        lat: 24.910226,
        lng: 121.140549,
        speed: 10,
        waste_type: 'garbage',
        source: 'taoyuan-primary',
        timestamp_kind: 'gps',
        source_timestamp: '2026-10-06T09:10:00Z',
      },
    ];

    const taiwanNowInfo1 = {
      now: new Date('2026-10-06T09:10:00Z'),
      hour: 17,
      minute: 10,
      dateStr: '2026-10-06',
    };

    await processTruckArrivals(
      truckStep1,
      taiwanNowInfo1,
      [],
      mockContext,
      {
        collectionApproachStore,
        dispatchNotificationBatch: mockDispatchBatch,
        observationNow: new Date('2026-10-06T09:10:00Z'),
      }
    );

    // Step 2: 17:11:00 TW (09:11:00Z) at 24.90951, 121.13932
    const truckStep2 = [
      {
        car_id: 'KEK-3178',
        route_id: 'lagi2-006_2_21',
        lat: 24.90951,
        lng: 121.13932,
        speed: 10,
        waste_type: 'garbage',
        source: 'taoyuan-primary',
        timestamp_kind: 'gps',
        source_timestamp: '2026-10-06T09:11:00Z',
      },
    ];

    const taiwanNowInfo2 = {
      now: new Date('2026-10-06T09:11:00Z'),
      hour: 17,
      minute: 11,
      dateStr: '2026-10-06',
    };

    const result = await processTruckArrivals(
      truckStep2,
      taiwanNowInfo2,
      [],
      mockContext,
      {
        collectionApproachStore,
        dispatchNotificationBatch: mockDispatchBatch,
        observationNow: new Date('2026-10-06T09:11:00Z'),
      }
    );

    assert.equal(result.ok, true);
    assert.equal(result.matchedArrivals, 1);
    assert.ok(dispatchedIntents, 'dispatchNotificationBatch should be called');
    assert.equal(dispatchedIntents.length, 2);

    const tyIntent = dispatchedIntents.find((i) => i.groupId === 'G_TY_9');
    assert.equal(tyIntent.memberCount, 9);
    assert.match(tyIntent.messageText, /📊 本月推播額度：已用/);

    const otherIntent = dispatchedIntents.find((i) => i.groupId === 'G_OTHER_3');
    assert.equal(otherIntent.memberCount, 3);
    assert.match(otherIntent.messageText, /📊 本月推播額度：已用/);
  } finally {
    recentTruckHistory.clear();
    mock.restoreAll();
  }
});
