import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCollectionApproach, observeCollectionApproach } from '../lib/collectionApproach.js';
import { createSupabaseCollectionApproachStore } from '../lib/collectionApproachStore.js';

const stop = { id: 3, route_id: '221010', lat: 25.076252, lng: 121.649942 };
const predecessor = { id: 25, route_id: '221010', lat: 25.077625, lng: 121.649992 };
const nowMs = Date.parse('2026-10-22T11:56:00Z');

function sampleAt(instant, point = predecessor) {
  return {
    routeId: '221010', carId: 'STORE-TEST', lat: point.lat, lng: point.lng,
    sampledAt: instant, observedAt: instant, source: 'ntpc-primary', timestampKind: 'gps', reportedSpeed: null,
  };
}

function memoryStore() {
  const rows = new Map();
  const events = [];
  return {
    rows,
    events,
    async read(key) { return rows.get(JSON.stringify(key)) || null; },
    async commit({ key, expectedVersion, nextState, event }) {
      const encoded = JSON.stringify(key);
      const current = rows.get(encoded) || { version: 0, state: null };
      if (current.version !== expectedVersion) return { applied: false, version: current.version };
      const version = current.version + 1;
      rows.set(encoded, { version, state: nextState });
      events.push(event);
      return { applied: true, version };
    },
  };
}

test('observeCollectionApproach confirms at most once for concurrent copies of one GPS sample', async () => {
  const store = memoryStore();
  await observeCollectionApproach({ sample: sampleAt('2026-10-22T11:54:00Z'), stop, predecessor, dateStr: '2026-10-22', store, nowMs: Date.parse('2026-10-22T11:54:00Z') });
  const targetSample = sampleAt('2026-10-22T11:56:00Z', { lat: 25.076423, lng: 121.649942 });

  const results = await Promise.all([
    observeCollectionApproach({ sample: targetSample, stop, predecessor, dateStr: '2026-10-22', store, nowMs }),
    observeCollectionApproach({ sample: targetSample, stop, predecessor, dateStr: '2026-10-22', store, nowMs }),
  ]);

  assert.equal(results.filter((result) => result.status === 'confirmed').length, 1);
  const confirmedEvent = store.events.find((event) => event.status === 'confirmed');
  assert.equal(confirmedEvent.version, 2);
  assert.equal(confirmedEvent.reportedSpeed, null);
  assert.ok(confirmedEvent.derivedSpeed > 4 && confirmedEvent.derivedSpeed < 5);
  assert.equal(confirmedEvent.previous.sampledAt, '2026-10-22T11:54:00Z');
  assert.equal(confirmedEvent.predecessor.id, 25);
});

test('observeCollectionApproach keeps an invalid observation clock pending without throwing', async () => {
  const sample = sampleAt('2026-10-22T11:54:00Z');
  sample.observedAt = 'not-a-date';
  const result = await observeCollectionApproach({ sample, stop, predecessor, store: memoryStore(), nowMs });

  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'invalid_sample_time');
});

test('observeCollectionApproach fails closed on malformed Supabase CAS success data', async () => {
  const predecessorSample = sampleAt('2026-10-22T11:54:00Z');
  const prior = evaluateCollectionApproach({ sample: predecessorSample, previousState: null, stop, predecessor, nowMs: Date.parse(predecessorSample.observedAt) });
  for (const data of [
    { applied: 'false', version: '2' },
    { applied: true, version: '2' },
    { applied: true, version: 99 },
  ]) {
    let rpcCalls = 0;
    const client = {
      from() {
        const query = {
          eq() { return this; },
          async maybeSingle() { return { data: { version: 1, state: prior.nextState }, error: null }; },
        };
        return { select() { return query; } };
      },
      async rpc() { rpcCalls += 1; return { data, error: null }; },
    };
    const store = createSupabaseCollectionApproachStore(client);
    const result = await observeCollectionApproach({
      sample: sampleAt('2026-10-22T11:56:00Z', { lat: 25.076423, lng: 121.649942 }),
      stop, predecessor, dateStr: '2026-10-22', store, nowMs,
    });

    assert.equal(result.status, 'pending');
    assert.equal(result.reason, 'storage_unavailable');
    assert.equal(rpcCalls, 1);
  }
});

test('observeCollectionApproach retries a CAS conflict using the competing committed state', async () => {
  const firstSample = sampleAt('2026-10-22T11:54:00Z');
  const first = evaluateCollectionApproach({ sample: firstSample, previousState: null, stop, predecessor, nowMs: Date.parse(firstSample.observedAt) });
  const reverseSample = sampleAt('2026-10-22T11:55:00Z', { lat: 25.077805, lng: 121.649992 });
  const competing = evaluateCollectionApproach({ sample: reverseSample, previousState: first.nextState, stop, predecessor, nowMs: Date.parse(reverseSample.observedAt) });
  const key = { date: '2026-10-22', routeId: '221010', stopId: '3', carId: 'STORE-TEST' };
  let reads = 0;
  const events = [];
  const store = {
    async read() {
      reads += 1;
      return reads === 1 ? { version: 1, state: first.nextState } : { version: 2, state: competing.nextState };
    },
    async commit({ expectedVersion, event }) {
      if (expectedVersion === 1) return { applied: false, version: 2 };
      events.push(event);
      return { applied: true, version: 3 };
    },
  };
  const result = await observeCollectionApproach({
    sample: sampleAt('2026-10-22T11:56:00Z', { lat: 25.076423, lng: 121.649942 }),
    stop, predecessor, dateStr: key.date, store, nowMs,
  });

  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'missing_predecessor');
  assert.equal(reads, 2);
  assert.equal(events[0].status, 'pending');
});

test('observeCollectionApproach derives Taiwan date and isolates different vehicle keys', async () => {
  const store = memoryStore();
  const lateUtcMs = Date.parse('2026-10-22T23:30:00Z');
  const lateSample = sampleAt('2026-10-22T23:30:00Z');
  await observeCollectionApproach({ sample: lateSample, stop, predecessor, dateStr: '2026-10-22', store, nowMs: lateUtcMs });
  await observeCollectionApproach({ sample: { ...lateSample, carId: 'OTHER-CAR' }, stop, predecessor, dateStr: 'invalid', store, nowMs: lateUtcMs });
  const nextTaiwanDay = sampleAt('2026-10-23T16:01:00Z');
  await observeCollectionApproach({ sample: nextTaiwanDay, stop, predecessor, dateStr: '2026-10-23', store, nowMs: Date.parse(nextTaiwanDay.observedAt) });

  assert.equal(store.rows.size, 3);
  assert.ok([...store.rows.keys()].some((encoded) => JSON.parse(encoded).date === '2026-10-23'));
  assert.ok([...store.rows.keys()].some((encoded) => JSON.parse(encoded).date === '2026-10-24'));
  assert.ok([...store.rows.keys()].some((encoded) => JSON.parse(encoded).carId === 'OTHER-CAR'));
});

test('observeCollectionApproach returns pending and logs diagnostics for storage failures and exhausted conflicts', async (t) => {
  const errors = [];
  const warnings = [];
  t.mock.method(console, 'error', (...args) => errors.push(args));
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  const sample = sampleAt('2026-10-22T11:54:00Z');
  const readFailure = await observeCollectionApproach({ sample, stop, predecessor, store: { async read() { throw new Error('offline'); } } });
  const commitFailure = await observeCollectionApproach({ sample, stop, predecessor, store: { async read() { return null; }, async commit() { throw new Error('offline'); } } });
  let reads = 0;
  let commits = 0;
  const conflicted = await observeCollectionApproach({
    sample, stop, predecessor,
    store: {
      async read() { reads += 1; return null; },
      async commit() { commits += 1; return { applied: false, version: 1 }; },
    },
  });

  assert.equal(readFailure.reason, 'storage_unavailable');
  assert.equal(commitFailure.reason, 'storage_unavailable');
  assert.equal(conflicted.reason, 'storage_conflict');
  assert.equal(reads, 3);
  assert.equal(commits, 3);
  assert.equal(errors.length, 2);
  assert.equal(warnings.length, 1);
});

test('Supabase store schema errors fail closed as pending', async (t) => {
  t.mock.method(console, 'error', () => {});
  const client = {
    from() {
      const query = {
        eq() { return this; },
        async maybeSingle() { return { data: null, error: { message: 'relation does not exist' } }; },
      };
      return { select() { return query; } };
    },
    async rpc() { assert.fail('RPC must not run if state read failed'); },
  };
  const result = await observeCollectionApproach({
    sample: sampleAt('2026-10-22T11:54:00Z'), stop, predecessor,
    store: createSupabaseCollectionApproachStore(client), nowMs: Date.parse('2026-10-22T11:54:00Z'),
  });

  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'storage_unavailable');
});

test('Supabase store rejects malformed persisted state rows', async (t) => {
  t.mock.method(console, 'error', () => {});
  const client = {
    from() {
      const query = {
        eq() { return this; },
        async maybeSingle() { return { data: { version: 'NaN', state: [] }, error: null }; },
      };
      return { select() { return query; } };
    },
    async rpc() { assert.fail('RPC must not run for malformed state'); },
  };
  const result = await observeCollectionApproach({
    sample: sampleAt('2026-10-22T11:54:00Z'), stop, predecessor,
    store: createSupabaseCollectionApproachStore(client), nowMs: Date.parse('2026-10-22T11:54:00Z'),
  });

  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'storage_unavailable');
});

test('observeCollectionApproach preserves untrusted source evidence with a nullable GPS time', async () => {
  const store = memoryStore();
  const sample = sampleAt('not-a-gps-time');
  sample.source = 'ntpc-website';
  sample.timestampKind = 'response';
  sample.observedAt = '2026-10-22T11:54:00Z';
  const result = await observeCollectionApproach({ sample, stop, predecessor, dateStr: '2026-10-22', store, nowMs: Date.parse(sample.observedAt) });

  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'untrusted_sample_time');
  assert.equal(store.events[0].sampledAt, null);
  assert.equal(store.events[0].rawSampledAt, 'not-a-gps-time');
});
