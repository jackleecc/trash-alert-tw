import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { supabase } from '../lib/supabaseClient.js';
import { processTruckArrivals, recentTruckHistory } from '../lib/coreProcessor.js';

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
function createSharedStore() {
  const rows = new Map();
  const events = [];
  return {
    events,
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
}
function installBoundaryMocks() {
  mock.method(supabase, 'from', (table) => {
    if (table === 'system_quota') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { month: '2026-10', used_count: 0, is_melted: false }, error: null }) }) }) };
    if (table === 'route_linids') return { select: () => ({ in: () => ({ gte: async () => ({ data: [{ route_id: '221010', linid: '221010', observed_count: 3 }], error: null }) }) }) };
    return {};
  });
  mock.method(supabase, 'rpc', async () => ({ data: null, error: null }));
  mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ hourly: { time: ['2026-10-22T20:00', '2026-10-22T21:00'], precipitation: [0, 0], precipitation_probability: [0, 0], uv_index: [0, 0], pm2_5: [0, 0] } }),
  }));
}
function observation(carId, lat, lng, sampledAt, extra = {}) {
  return {
    car_id: carId, route_id: '221010', lat, lng, waste_type: 'garbage',
    source: 'ntpc-primary', timestamp_kind: 'gps', source_timestamp: sampledAt, ...extra,
  };
}
function taiwanInfo(instant) {
  return { now: new Date(instant), hour: 19, minute: Number(instant.slice(14, 16)), dateStr: '2026-10-22' };
}
async function run(trucks, instant, store, dispatchNotificationBatch, providedContext = context) {
  return processTruckArrivals(trucks, taiwanInfo(instant), [], providedContext, {
    observationNow: new Date(instant), collectionApproachStore: store, dispatchNotificationBatch,
  });
}

test('only the latest pending protected sample governs a same-round truck candidate', async () => {
  installBoundaryMocks();
  recentTruckHistory.clear();
  const store = createSharedStore();
  let dispatchCalls = 0;
  const dispatchNotificationBatch = async (intents) => {
    dispatchCalls++;
    return { total: intents.length, sent: intents.length, suppressed: 0, failed: 0, errors: [] };
  };
  try {
    await run([observation('647-BX', predecessor.lat, predecessor.lng, '2026-10-22T11:54:00Z')], '2026-10-22T11:54:00Z', store, dispatchNotificationBatch);
    recentTruckHistory.clear();
    const result = await run([
      observation('647-BX', 25.076423, 121.649942, '2026-10-22T11:56:00Z'),
      observation('647-BX', 25.07505, 121.649942, '2026-10-22T11:57:00Z'),
    ], '2026-10-22T11:57:00Z', store, dispatchNotificationBatch);
    assert.deepEqual(
      { matchedArrivals: result.matchedArrivals, sentNotifications: result.sentNotifications, dispatchCalls },
      { matchedArrivals: 0, sentNotifications: 0, dispatchCalls: 0 },
      'a later pending sample outside the target radius must suppress an earlier confirmed coordinate from the same batch'
    );
  } finally {
    recentTruckHistory.clear();
    mock.restoreAll();
  }
});

test('a latest northbound sample suppresses an earlier confirmed coordinate in the same batch', async () => {
  installBoundaryMocks();
  recentTruckHistory.clear();
  const store = createSharedStore();
  let dispatchCalls = 0;
  const dispatchNotificationBatch = async (intents) => {
    dispatchCalls++;
    return { total: intents.length, sent: intents.length, suppressed: 0, failed: 0, errors: [] };
  };
  try {
    await run([observation('647-BX', predecessor.lat, predecessor.lng, '2026-10-22T11:54:00Z')], '2026-10-22T11:54:00Z', store, dispatchNotificationBatch);
    recentTruckHistory.clear();
    const result = await run([
      observation('647-BX', 25.076423, 121.649942, '2026-10-22T11:56:00Z'),
      observation('647-BX', 25.076603, 121.649942, '2026-10-22T11:57:00Z'),
    ], '2026-10-22T11:57:00Z', store, dispatchNotificationBatch);
    assert.deepEqual(
      { matchedArrivals: result.matchedArrivals, dispatchCalls },
      { matchedArrivals: 0, dispatchCalls: 0 },
      'a later northbound sample in the same batch must override an earlier confirmed candidate'
    );
  } finally {
    recentTruckHistory.clear();
    mock.restoreAll();
  }
});

test('conflicting positions at the same GPS sample time remain pending with an audit reason', async () => {
  installBoundaryMocks();
  recentTruckHistory.clear();
  const store = createSharedStore();
  let dispatchCalls = 0;
  const dispatchNotificationBatch = async (intents) => {
    dispatchCalls++;
    return { total: intents.length, sent: intents.length, suppressed: 0, failed: 0, errors: [] };
  };
  try {
    await run([observation('647-BX', predecessor.lat, predecessor.lng, '2026-10-22T11:54:00Z')], '2026-10-22T11:54:00Z', store, dispatchNotificationBatch);
    store.events.length = 0;
    recentTruckHistory.clear();
    const result = await run([
      observation('647-BX', 25.076423, 121.649942, '2026-10-22T11:56:00Z'),
      observation('647-BX', 25.076423, 121.650192, '2026-10-22T11:56:00Z'),
    ], '2026-10-22T11:56:00Z', store, dispatchNotificationBatch);
    assert.deepEqual(
      { matchedArrivals: result.matchedArrivals, dispatchCalls },
      { matchedArrivals: 0, dispatchCalls: 0 },
      'contradictory latest locations must never form a protected arrival candidate'
    );
    assert.ok(store.events.length > 0 && store.events.every(({ reason }) => reason === 'batch_conflict'),
      'the shared audit should preserve that the batch contained conflicting positions');
  } finally {
    recentTruckHistory.clear();
    mock.restoreAll();
  }
});

test('identical protected observations in one batch create only one notification intent', async () => {
  installBoundaryMocks();
  recentTruckHistory.clear();
  const store = createSharedStore();
  let dispatchedIntents = [];
  const dispatchNotificationBatch = async (intents) => {
    dispatchedIntents = intents;
    return { total: intents.length, sent: intents.length, suppressed: 0, failed: 0, errors: [] };
  };
  try {
    await run([observation('647-BX', predecessor.lat, predecessor.lng, '2026-10-22T11:54:00Z')], '2026-10-22T11:54:00Z', store, dispatchNotificationBatch);
    recentTruckHistory.clear();
    const target = observation('647-BX', 25.076423, 121.649942, '2026-10-22T11:56:00Z');
    const result = await run([target, { ...target }], '2026-10-22T11:56:00Z', store, dispatchNotificationBatch);
    assert.deepEqual(
      { matchedArrivals: result.matchedArrivals, intentCount: dispatchedIntents.length },
      { matchedArrivals: 1, intentCount: 1 },
      'an identical GPS observation repeated by intake sources must not duplicate an arrival intent'
    );
  } finally {
    recentTruckHistory.clear();
    mock.restoreAll();
  }
});

test('conflicting primary and website samples for one truck cannot confirm from the primary sample', async () => {
  installBoundaryMocks();
  recentTruckHistory.clear();
  const store = createSharedStore();
  let dispatchCalls = 0;
  const dispatchNotificationBatch = async (intents) => {
    dispatchCalls++;
    return { total: intents.length, sent: intents.length, suppressed: 0, failed: 0, errors: [] };
  };
  try {
    await run([observation('647-BX', predecessor.lat, predecessor.lng, '2026-10-22T11:54:00Z')], '2026-10-22T11:54:00Z', store, dispatchNotificationBatch);
    store.events.length = 0;
    recentTruckHistory.clear();
    const result = await run([
      observation('647-BX', 25.076423, 121.649942, '2026-10-22T11:56:00Z'),
      observation('647-BX', 25.076423, 121.650192, '2026-10-22T11:56:00Z', {
        source: 'ntpc-website', timestamp_kind: 'response',
      }),
    ], '2026-10-22T11:56:00Z', store, dispatchNotificationBatch);
    assert.deepEqual(
      { matchedArrivals: result.matchedArrivals, dispatchCalls },
      { matchedArrivals: 0, dispatchCalls: 0 },
      'a response-only backup coordinate contradicting a GPS primary coordinate must keep the vehicle pending'
    );
    assert.ok(store.events.length > 0 && store.events.every(({ reason }) => reason === 'batch_conflict'), JSON.stringify(store.events));
    assert.ok(store.events.some(({ conflictingObservations }) =>
      conflictingObservations?.some(({ source }) => source === 'ntpc-website')),
    'the audit event should retain the website source evidence');
    const websiteEvidence = store.events.flatMap(({ conflictingObservations = [] }) => conflictingObservations)
      .find(({ source }) => source === 'ntpc-website');
    assert.deepEqual(
      { sampledAt: websiteEvidence?.sampledAt, rawSourceTimestamp: websiteEvidence?.rawSourceTimestamp },
      { sampledAt: null, rawSourceTimestamp: '2026-10-22T11:56:00Z' },
      'a website response time must remain raw response metadata rather than GPS sampledAt'
    );
  } finally {
    recentTruckHistory.clear();
    mock.restoreAll();
  }
});

test('a recycling-truck predecessor cannot establish garbage collection evidence', async () => {
  installBoundaryMocks();
  recentTruckHistory.clear();
  const store = createSharedStore();
  let dispatchCalls = 0;
  const dispatchNotificationBatch = async (intents) => {
    dispatchCalls++;
    return { total: intents.length, sent: intents.length, suppressed: 0, failed: 0, errors: [] };
  };
  try {
    await run([observation('647-BX', predecessor.lat, predecessor.lng, '2026-10-22T11:54:00Z', { waste_type: 'recycling' })], '2026-10-22T11:54:00Z', store, dispatchNotificationBatch);
    recentTruckHistory.clear();
    const result = await run([observation('647-BX', 25.076423, 121.649942, '2026-10-22T11:56:00Z')], '2026-10-22T11:56:00Z', store, dispatchNotificationBatch);
    assert.deepEqual(
      { matchedArrivals: result.matchedArrivals, dispatchCalls },
      { matchedArrivals: 0, dispatchCalls: 0 },
      'a recycling vehicle must not seed the predecessor anchor used by a later garbage vehicle'
    );
  } finally {
    recentTruckHistory.clear();
    mock.restoreAll();
  }
});

test('a latest recycling observation prevents an older garbage coordinate from notifying', async () => {
  installBoundaryMocks();
  recentTruckHistory.clear();
  const store = createSharedStore();
  let dispatchCalls = 0;
  const dispatchNotificationBatch = async (intents) => {
    dispatchCalls++;
    return { total: intents.length, sent: intents.length, suppressed: 0, failed: 0, errors: [] };
  };
  try {
    await run([observation('647-BX', predecessor.lat, predecessor.lng, '2026-10-22T11:54:00Z')], '2026-10-22T11:54:00Z', store, dispatchNotificationBatch);
    recentTruckHistory.clear();
    const result = await run([
      observation('647-BX', 25.076423, 121.649942, '2026-10-22T11:56:00Z'),
      observation('647-BX', 25.076300, 121.649942, '2026-10-22T11:57:00Z', { waste_type: 'recycling' }),
    ], '2026-10-22T11:57:00Z', store, dispatchNotificationBatch);
    assert.deepEqual(
      { matchedArrivals: result.matchedArrivals, dispatchCalls },
      { matchedArrivals: 0, dispatchCalls: 0 },
      'a newer recycling observation cannot reuse an earlier garbage sample as the current arrival candidate'
    );
  } finally {
    recentTruckHistory.clear();
    mock.restoreAll();
  }
});

test('a later pending truck decision does not suppress a different truck confirmed in the same batch', async () => {
  installBoundaryMocks();
  recentTruckHistory.clear();
  const store = createSharedStore();
  let dispatchedIntents = [];
  const dispatchNotificationBatch = async (intents) => {
    dispatchedIntents = intents;
    return { total: intents.length, sent: intents.length, suppressed: 0, failed: 0, errors: [] };
  };
  try {
    await run([observation('647-BX', predecessor.lat, predecessor.lng, '2026-10-22T11:54:00Z')], '2026-10-22T11:54:00Z', store, dispatchNotificationBatch);
    recentTruckHistory.clear();
    const result = await run([
      observation('647-BX', 25.076423, 121.649942, '2026-10-22T11:56:00Z'),
      observation('DIFFERENT-CAR', 25.076423, 121.649942, '2026-10-22T11:57:00Z'),
    ], '2026-10-22T11:57:00Z', store, dispatchNotificationBatch);
    assert.deepEqual(
      { matchedArrivals: result.matchedArrivals, intentCars: dispatchedIntents.map(({ carId }) => carId) },
      { matchedArrivals: 1, intentCars: ['647-BX'] },
      'the latest candidate decision must be isolated by vehicle identity'
    );
  } finally {
    recentTruckHistory.clear();
    mock.restoreAll();
  }
});

test('same-time duplicate observations retain a valid reported overspeed and cannot notify', async () => {
  installBoundaryMocks();
  recentTruckHistory.clear();
  const store = createSharedStore();
  let dispatchCalls = 0;
  const dispatchNotificationBatch = async (intents) => {
    dispatchCalls++;
    return { total: intents.length, sent: intents.length, suppressed: 0, failed: 0, errors: [] };
  };
  try {
    await run([observation('647-BX', predecessor.lat, predecessor.lng, '2026-10-22T11:54:00Z')], '2026-10-22T11:54:00Z', store, dispatchNotificationBatch);
    recentTruckHistory.clear();
    const result = await run([
      observation('647-BX', 25.076423, 121.649942, '2026-10-22T11:56:00Z', { speed: 3 }),
      observation('647-BX', 25.076423, 121.649942, '2026-10-22T11:56:00Z', { speed: 26 }),
    ], '2026-10-22T11:56:00Z', store, dispatchNotificationBatch);
    assert.deepEqual(
      { matchedArrivals: result.matchedArrivals, dispatchCalls },
      { matchedArrivals: 0, dispatchCalls: 0 },
      'deduplicating identical coordinates must not discard the valid reported speed that rejects the observation'
    );
  } finally {
    recentTruckHistory.clear();
    mock.restoreAll();
  }
});

test('a valid reported speed remains bound to its raw confirmed observation', async () => {
  installBoundaryMocks();
  recentTruckHistory.clear();
  const store = createSharedStore();
  let dispatchedIntents = [];
  const dispatchNotificationBatch = async (intents) => {
    dispatchedIntents = intents;
    return { total: intents.length, sent: intents.length, suppressed: 0, failed: 0, errors: [] };
  };
  try {
    await run([observation('647-BX', predecessor.lat, predecessor.lng, '2026-10-22T11:54:00Z')], '2026-10-22T11:54:00Z', store, dispatchNotificationBatch);
    recentTruckHistory.clear();
    const result = await run([
      observation('647-BX', 25.076423, 121.649942, '2026-10-22T11:56:00Z', { speed: 12 }),
    ], '2026-10-22T11:56:00Z', store, dispatchNotificationBatch);
    assert.deepEqual(
      { matchedArrivals: result.matchedArrivals, intentCount: dispatchedIntents.length, carId: dispatchedIntents[0]?.carId },
      { matchedArrivals: 1, intentCount: 1, carId: '647-BX' },
      'a valid reported speed below the cruise threshold must not break identity binding for a confirmed raw sample'
    );
  } finally {
    recentTruckHistory.clear();
    mock.restoreAll();
  }
});

test('protected-stop storage failure does not block an ordinary subscribed stop', async () => {
  installBoundaryMocks();
  recentTruckHistory.clear();
  const ordinaryStop = {
    id: 99, route_id: '221010', rank: 18, order_index: 18,
    name: '一般測試站點', lat: 25.076423, lng: 121.649942, schedule_time: '19:56:00',
  };
  const mixedContext = {
    ...context,
    stops: [targetStop, ordinaryStop],
    allRouteStops: [predecessor, targetStop, ordinaryStop],
    stopSubscribersMap: new Map([
      ['3', new Set(['XIZHI-TEST-GROUP'])],
      ['99', new Set(['ORDINARY-TEST-GROUP'])],
    ]),
    groupsMap: new Map([
      ['XIZHI-TEST-GROUP', { member_count: 1 }],
      ['ORDINARY-TEST-GROUP', { member_count: 1 }],
    ]),
  };
  const failingStore = { async read() { throw new Error('table missing'); }, async commit() { throw new Error('unreachable'); } };
  let dispatchedIntents = [];
  const dispatchNotificationBatch = async (intents) => {
    dispatchedIntents = intents;
    return { total: intents.length, sent: intents.length, suppressed: 0, failed: 0, errors: [] };
  };
  try {
    const result = await run([
      observation('647-BX', 25.076423, 121.649942, '2026-10-22T11:56:00Z'),
    ], '2026-10-22T11:56:00Z', failingStore, dispatchNotificationBatch, mixedContext);
    assert.deepEqual(
      { matchedArrivals: result.matchedArrivals, intentStops: dispatchedIntents.map(({ stopId }) => stopId) },
      { matchedArrivals: 1, intentStops: [99] },
      'missing shared protected state must fail closed only for Stop 3 while ordinary stop matching continues'
    );
  } finally {
    recentTruckHistory.clear();
    mock.restoreAll();
  }
});

test('fresh response-only coordinates cannot authorize the protected stop', async () => {
  installBoundaryMocks();
  recentTruckHistory.clear();
  let dispatchCalls = 0;
  const dispatchNotificationBatch = async (intents) => {
    dispatchCalls++;
    return { total: intents.length, sent: intents.length, suppressed: 0, failed: 0, errors: [] };
  };
  try {
    const result = await run([
      observation('647-BX', 25.076423, 121.649942, '2026-10-22T11:56:00Z', {
        source: 'ntpc-website', timestamp_kind: 'response',
      }),
    ], '2026-10-22T11:56:00Z', createSharedStore(), dispatchNotificationBatch);
    assert.deepEqual(
      { matchedArrivals: result.matchedArrivals, dispatchCalls },
      { matchedArrivals: 0, dispatchCalls: 0 },
      'a fresh website response timestamp cannot be treated as a per-vehicle GPS sample'
    );
  } finally {
    recentTruckHistory.clear();
    mock.restoreAll();
  }
});

test('missing predecessor topology keeps an otherwise nearby GPS sample pending', async () => {
  installBoundaryMocks();
  recentTruckHistory.clear();
  let dispatchCalls = 0;
  const dispatchNotificationBatch = async (intents) => {
    dispatchCalls++;
    return { total: intents.length, sent: intents.length, suppressed: 0, failed: 0, errors: [] };
  };
  try {
    const result = await run([
      observation('647-BX', 25.076423, 121.649942, '2026-10-22T11:56:00Z'),
    ], '2026-10-22T11:56:00Z', createSharedStore(), dispatchNotificationBatch, {
      ...context, allRouteStops: [targetStop],
    });
    assert.deepEqual(
      { matchedArrivals: result.matchedArrivals, dispatchCalls },
      { matchedArrivals: 0, dispatchCalls: 0 },
      'the protected stop must not fall back to legacy geometry when predecessor topology is missing'
    );
  } finally {
    recentTruckHistory.clear();
    mock.restoreAll();
  }
});

test('dirty legacy in-memory speed and direction do not override raw shared GPS confirmation', async () => {
  installBoundaryMocks();
  recentTruckHistory.clear();
  const store = createSharedStore();
  let dispatchCalls = 0;
  const dispatchNotificationBatch = async (intents) => {
    dispatchCalls++;
    return { total: intents.length, sent: intents.length, suppressed: 0, failed: 0, errors: [] };
  };
  try {
    await run([observation('647-BX', predecessor.lat, predecessor.lng, '2026-10-22T11:54:00Z')], '2026-10-22T11:54:00Z', store, dispatchNotificationBatch);
    recentTruckHistory.set('221010_647-BX', { lat: 25.09, lng: 121.64, time: Date.now() - 1000 });
    const truck = observation('647-BX', 25.076423, 121.649942, '2026-10-22T11:56:00Z');
    const result = await run([truck], '2026-10-22T11:56:00Z', store, dispatchNotificationBatch);
    assert.deepEqual(
      { matchedArrivals: result.matchedArrivals, dispatchCalls },
      { matchedArrivals: 1, dispatchCalls: 1 },
      'the legacy map’s derived overspeed and northbound direction cannot reject raw confirmed evidence'
    );
  } finally {
    recentTruckHistory.clear();
    mock.restoreAll();
  }
});
