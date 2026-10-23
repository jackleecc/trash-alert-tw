import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { supabase } from '../lib/supabaseClient.js';
import { processTruckArrivals, recentTruckHistory } from '../lib/coreProcessor.js';

test('processTruckArrivals - does not notify on the first 19m observation at Xizhi Stop 3', async () => {
  const touchedTables = [];
  const rpcCalls = [];
  const approachEvents = [];
  const approachRows = new Map();
  const collectionApproachStore = {
    async read(key) { return approachRows.get(JSON.stringify(key)) || null; },
    async commit({ key, expectedVersion, nextState, event }) {
      const serializedKey = JSON.stringify(key);
      const current = approachRows.get(serializedKey) || { version: 0, state: null };
      if (current.version !== expectedVersion) return { applied: false, version: current.version };
      const version = current.version + 1;
      approachRows.set(serializedKey, { version, state: nextState });
      approachEvents.push(event);
      return { applied: true, version };
    },
  };
  let dispatchCalls = 0;

  mock.method(supabase, 'from', (table) => {
    touchedTables.push(table);
    if (table === 'system_quota') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { month: '2026-10', used_count: 0, is_melted: false },
              error: null,
            }),
          }),
        }),
      };
    }
    if (table === 'route_linids') {
      return {
        select: () => ({
          in: () => ({
            gte: async () => ({
              data: [{ route_id: '221010', linid: '221010', observed_count: 3 }],
              error: null,
            }),
          }),
        }),
      };
    }
    return {};
  });
  mock.method(supabase, 'rpc', async (name, args) => {
    rpcCalls.push({ name, args });
    return { data: null, error: null };
  });
  mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({
      hourly: {
        time: ['2026-10-22T20:00', '2026-10-22T21:00'],
        precipitation: [0, 0],
        precipitation_probability: [0, 0],
        uv_index: [0, 0],
        pm2_5: [0, 0],
      },
    }),
  }));

  try {
    const targetStop = {
      id: 3,
      route_id: '221010',
      rank: 17,
      order_index: 17,
      name: '汐萬路一段333巷口',
      lat: 25.076252,
      lng: 121.649942,
      schedule_time: '19:56:00',
    };
    const predecessor = {
      id: 25,
      route_id: '221010',
      rank: 16,
      order_index: 16,
      name: '汐萬路一段343巷口',
      lat: 25.077625,
      lng: 121.649992,
      schedule_time: '19:52:00',
    };
    const context = {
      ok: true,
      activeRoutesMap: new Map([
        ['221010', { id: '221010', name: '汐止區第1區路線(晚上)', city: '新北市' }],
      ]),
      stops: [targetStop],
      allRouteStops: [predecessor, targetStop],
      stopSubscribersMap: new Map([
        ['3', new Set(['XIZHI-TEST-GROUP'])],
      ]),
      groupsMap: new Map([
        ['XIZHI-TEST-GROUP', { member_count: 1 }],
      ]),
    };
    const truck = {
      car_id: '647-BX',
      route_id: '221010',
      lat: 25.076423,
      lng: 121.649942,
      speed: 3,
      waste_type: 'garbage',
      source: 'ntpc-primary',
      timestamp_kind: 'gps',
      source_timestamp: '2026-10-22T11:45:00Z',
    };
    const taiwanNowInfo = {
      now: new Date('2026-10-22T11:45:00Z'),
      hour: 19,
      minute: 45,
      dateStr: '2026-10-22',
    };

    const result = await processTruckArrivals(
      [truck],
      taiwanNowInfo,
      [],
      context,
      {
        observationNow: new Date('2026-10-22T11:45:00Z'),
        collectionApproachStore,
        dispatchNotificationBatch: async (intents) => {
          dispatchCalls += 1;
          return {
            total: intents.length,
            sent: intents.length,
            suppressed: 0,
            failed: 0,
            errors: [],
          };
        },
      }
    );

    assert.deepEqual(
      { matchedArrivals: result.matchedArrivals, dispatchCalls },
      { matchedArrivals: 0, dispatchCalls: 0 },
      'a first observation 19m from protected Stop 3 must remain pending before notification dispatch'
    );
    assert.equal(result.sentNotifications, 0);
    assert.ok(approachEvents.some(({ status, reason }) => status === 'pending' && reason === 'first_sample'),
      'the valid store should persist the first-sample pending decision rather than mask it as storage unavailable');
    assert.equal(touchedTables.includes('notification_logs'), false);
    assert.equal(rpcCalls.some(({ name }) => name === 'claim_notification'), false);
    assert.equal(rpcCalls.some(({ name }) => name === 'reserve_quota'), false);
  } finally {
    mock.restoreAll();
  }
});

test('processTruckArrivals - preserves raw website response timestamps without treating them as GPS time', async () => {
  const events = [];
  const rows = new Map();
  const collectionApproachStore = {
    async read(key) { return rows.get(JSON.stringify(key)) || null; },
    async commit({ key, expectedVersion, nextState, event }) {
      const serializedKey = JSON.stringify(key);
      const current = rows.get(serializedKey) || { version: 0, state: null };
      if (current.version !== expectedVersion) return { applied: false, version: current.version };
      const version = current.version + 1;
      rows.set(serializedKey, { version, state: nextState });
      events.push(event);
      return { applied: true, version };
    },
  };
  let dispatchCalls = 0;

  mock.method(supabase, 'from', (table) => {
    if (table === 'system_quota') {
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { month: '2026-10', used_count: 0, is_melted: false }, error: null }) }) }) };
    }
    if (table === 'route_linids') {
      return { select: () => ({ in: () => ({ gte: async () => ({ data: [{ route_id: '221010', linid: '221010', observed_count: 3 }], error: null }) }) }) };
    }
    return {};
  });
  mock.method(supabase, 'rpc', async () => ({ data: null, error: null }));
  mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ hourly: { time: ['2026-10-22T20:00', '2026-10-22T21:00'], precipitation: [0, 0], precipitation_probability: [0, 0], uv_index: [0, 0], pm2_5: [0, 0] } }),
  }));

  try {
    const targetStop = {
      id: 3, route_id: '221010', rank: 17, order_index: 17,
      name: '汐萬路一段333巷口', lat: 25.076252, lng: 121.649942, schedule_time: '19:56:00',
    };
    const predecessor = {
      id: 25, route_id: '221010', rank: 16, order_index: 16,
      name: '汐萬路一段343巷口', lat: 25.077625, lng: 121.649992, schedule_time: '19:52:00',
    };
    const context = {
      ok: true,
      activeRoutesMap: new Map([['221010', { id: '221010', name: '汐止區第1區路線(晚上)', city: '新北市' }]]),
      stops: [targetStop],
      allRouteStops: [predecessor, targetStop],
      stopSubscribersMap: new Map([['3', new Set(['XIZHI-TEST-GROUP'])]]),
      groupsMap: new Map([['XIZHI-TEST-GROUP', { member_count: 1 }]]),
    };
    const result = await processTruckArrivals([{
      car_id: '647-BX', route_id: '221010', lat: 25.076423, lng: 121.649942,
      waste_type: 'garbage', source: 'ntpc-website', timestamp_kind: 'response',
      source_timestamp: '2026-10-22T11:56:00Z', time: 'malformed-gps-time',
    }], {
      now: new Date('2026-10-22T11:56:00Z'), hour: 19, minute: 56, dateStr: '2026-10-22',
    }, [], context, {
      observationNow: new Date('2026-10-22T11:56:10Z'),
      collectionApproachStore,
      dispatchNotificationBatch: async (intents) => {
        dispatchCalls += 1;
        return { total: intents.length, sent: intents.length, suppressed: 0, failed: 0, errors: [] };
      },
    });

    assert.deepEqual(
      { matchedArrivals: result.matchedArrivals, sentNotifications: result.sentNotifications, dispatchCalls },
      { matchedArrivals: 0, sentNotifications: 0, dispatchCalls: 0 },
      'a fresh website response must not create a GPS-confirmed arrival intent'
    );
    assert.ok(events.some(({ status, reason }) => status === 'pending' && reason === 'untrusted_sample_time'),
      'the successful shared-store commit must persist an untrusted_sample_time decision');
    const event = events.find(({ status, reason }) => status === 'pending' && reason === 'untrusted_sample_time');
    assert.deepEqual(
      {
        sampledAt: event?.sampledAt,
        rawSourceTimestamp: event?.details?.rawSourceTimestamp,
        rawTime: event?.details?.rawTime,
      },
      {
        sampledAt: null,
        rawSourceTimestamp: '2026-10-22T11:56:00Z',
        rawTime: 'malformed-gps-time',
      },
      'audit details must preserve response metadata independently without inventing GPS sampledAt'
    );
  } finally {
    mock.restoreAll();
  }
});

test('processTruckArrivals - confirms a fresh southbound approach from the predecessor on a separate instance', async () => {
  const sharedRows = new Map();
  const sharedStore = {
    async read(key) {
      return sharedRows.get(JSON.stringify(key)) || null;
    },
    async commit({ key, expectedVersion, nextState }) {
      const serializedKey = JSON.stringify(key);
      const current = sharedRows.get(serializedKey) || { version: 0, state: null };
      if (current.version !== expectedVersion) {
        return { applied: false, version: current.version };
      }
      const version = current.version + 1;
      sharedRows.set(serializedKey, { version, state: nextState });
      return { applied: true, version };
    },
  };
  let dispatchCalls = 0;
  let dispatchedIntents = [];

  mock.method(supabase, 'from', (table) => {
    if (table === 'system_quota') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { month: '2026-10', used_count: 0, is_melted: false },
              error: null,
            }),
          }),
        }),
      };
    }
    if (table === 'route_linids') {
      return {
        select: () => ({
          in: () => ({
            gte: async () => ({
              data: [{ route_id: '221010', linid: '221010', observed_count: 3 }],
              error: null,
            }),
          }),
        }),
      };
    }
    return {};
  });
  mock.method(supabase, 'rpc', async () => ({ data: null, error: null }));
  mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({
      hourly: {
        time: ['2026-10-22T20:00', '2026-10-22T21:00'],
        precipitation: [0, 0],
        precipitation_probability: [0, 0],
        uv_index: [0, 0],
        pm2_5: [0, 0],
      },
    }),
  }));

  try {
    const targetStop = {
      id: 3,
      route_id: '221010',
      rank: 17,
      order_index: 17,
      name: '汐萬路一段333巷口',
      lat: 25.076252,
      lng: 121.649942,
      schedule_time: '19:56:00',
    };
    const predecessor = {
      id: 25,
      route_id: '221010',
      rank: 16,
      order_index: 16,
      name: '汐萬路一段343巷口',
      lat: 25.077625,
      lng: 121.649992,
      schedule_time: '19:52:00',
    };
    const context = {
      ok: true,
      activeRoutesMap: new Map([
        ['221010', { id: '221010', name: '汐止區第1區路線(晚上)', city: '新北市' }],
      ]),
      stops: [targetStop],
      allRouteStops: [predecessor, targetStop],
      stopSubscribersMap: new Map([
        ['3', new Set(['XIZHI-TEST-GROUP'])],
      ]),
      groupsMap: new Map([
        ['XIZHI-TEST-GROUP', { member_count: 1 }],
      ]),
    };
    const dispatchNotificationBatch = async (intents) => {
      dispatchCalls += 1;
      dispatchedIntents = intents;
      return {
        total: intents.length,
        sent: intents.length,
        suppressed: 0,
        failed: 0,
        errors: [],
      };
    };
    const sharedOptions = {
      collectionApproachStore: sharedStore,
      dispatchNotificationBatch,
    };

    recentTruckHistory.clear();
    const firstResult = await processTruckArrivals(
      [{
        car_id: '647-BX',
        route_id: '221010',
        lat: 25.077625,
        lng: 121.649992,
        waste_type: 'garbage',
        source: 'ntpc-primary',
        timestamp_kind: 'gps',
        source_timestamp: '2026-10-22T11:54:00Z',
      }],
      {
        now: new Date('2026-10-22T11:54:00Z'),
        hour: 19,
        minute: 54,
        dateStr: '2026-10-22',
      },
      [],
      context,
      { ...sharedOptions, observationNow: new Date('2026-10-22T11:54:00Z') }
    );

    assert.equal(firstResult.sentNotifications, 0, 'the predecessor observation establishes evidence but does not notify');

    // Simulate another process: discard the legacy in-memory telemetry while keeping only the shared store.
    recentTruckHistory.clear();
    const secondResult = await processTruckArrivals(
      [{
        car_id: '647-BX',
        route_id: '221010',
        lat: 25.076423,
        lng: 121.649942,
        waste_type: 'garbage',
        source: 'ntpc-primary',
        timestamp_kind: 'gps',
        source_timestamp: '2026-10-22T11:56:00Z',
      }],
      {
        now: new Date('2026-10-22T11:56:00Z'),
        hour: 19,
        minute: 56,
        dateStr: '2026-10-22',
      },
      [],
      context,
      { ...sharedOptions, observationNow: new Date('2026-10-22T11:56:00Z') }
    );

    assert.deepEqual(
      {
        matchedArrivals: secondResult.matchedArrivals,
        sentNotifications: secondResult.sentNotifications,
        dispatchCalls,
        stopId: dispatchedIntents[0]?.stopId,
      },
      { matchedArrivals: 1, sentNotifications: 1, dispatchCalls: 1, stopId: 3 },
      'a fresh southbound GPS movement from the predecessor into the target geofence should confirm at the first sample'
    );
  } finally {
    recentTruckHistory.clear();
    mock.restoreAll();
  }
});
