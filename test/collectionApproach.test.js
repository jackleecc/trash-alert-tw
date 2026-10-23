import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCollectionApproach } from '../lib/collectionApproach.js';

const STOP = { id: 3, route_id: '221010', lat: 25.076252, lng: 121.649942 };
const PREDECESSOR = { id: 25, route_id: '221010', lat: 25.077625, lng: 121.649992 };
const BASE_MS = Date.parse('2026-10-22T11:54:00Z');
const METERS_PER_DEGREE = 111_320;

function atMeters(origin, east, north) {
  const latitude = origin.lat + north / METERS_PER_DEGREE;
  const longitude = origin.lng + east / (METERS_PER_DEGREE * Math.cos(origin.lat * Math.PI / 180));
  return { lat: latitude, lng: longitude };
}

function atApproachOffset(along, lateral) {
  const middleLat = ((STOP.lat + PREDECESSOR.lat) / 2) * Math.PI / 180;
  const east = (STOP.lng - PREDECESSOR.lng) * METERS_PER_DEGREE * Math.cos(middleLat);
  const north = (STOP.lat - PREDECESSOR.lat) * METERS_PER_DEGREE;
  const length = Math.hypot(east, north);
  const unit = { east: east / length, north: north / length };
  const pointEast = unit.east * along - unit.north * lateral;
  const pointNorth = unit.north * along + unit.east * lateral;
  return atMeters(PREDECESSOR, pointEast, pointNorth);
}

function sampleAt(seconds, point = PREDECESSOR, overrides = {}) {
  const instant = new Date(BASE_MS + seconds * 1_000).toISOString();
  return {
    routeId: '221010',
    carId: '647-BX',
    lat: point.lat,
    lng: point.lng,
    sampledAt: instant,
    observedAt: instant,
    source: 'ntpc-primary',
    timestampKind: 'gps',
    reportedSpeed: null,
    ...overrides,
  };
}

function evaluate(sample, previousState = null, nowMs = Date.parse(sample.observedAt), stop = STOP, predecessor = PREDECESSOR) {
  return evaluateCollectionApproach({ sample, previousState, stop, predecessor, nowMs });
}

function seedAtPredecessor() {
  return evaluate(sampleAt(0)).nextState;
}

test('evaluateCollectionApproach rejects a slow northbound sample and clears approach evidence', () => {
  const result = evaluate(sampleAt(60, atMeters(PREDECESSOR, 0, 20), { reportedSpeed: 3 }), seedAtPredecessor());

  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'opposite_direction');
  assert.equal(result.nextState.anchor, null);
  assert.equal(result.nextState.direction, null);
});

test('evaluateCollectionApproach does not restore direction from drift after an opposite movement', () => {
  const reversed = evaluate(sampleAt(60, atMeters(PREDECESSOR, 0, 20)), seedAtPredecessor());
  const drift = evaluate(sampleAt(90, atMeters(PREDECESSOR, 1, 20)), reversed.nextState);

  assert.equal(drift.status, 'pending');
  assert.equal(drift.nextState.anchor, null);
  assert.equal(drift.nextState.direction, null);
});

test('evaluateCollectionApproach confirms reliable slow southbound movement without reported speed', () => {
  const first = evaluate(sampleAt(0));
  const second = evaluate(sampleAt(120, { lat: 25.076423, lng: 121.649942 }), first.nextState);

  assert.equal(second.status, 'confirmed');
  assert.equal(second.reason, 'confirmed_approach');
  assert.ok(second.evidence.derivedSpeed > 4 && second.evidence.derivedSpeed < 5);
});

test('evaluateCollectionApproach keeps a drift direction for exactly 180 seconds but expires it afterward', () => {
  const first = evaluate(sampleAt(0));
  const directed = evaluate(sampleAt(20, atMeters(PREDECESSOR, 0, -20)), first.nextState);
  const atBoundary = evaluate(sampleAt(200, atMeters(PREDECESSOR, 0, -20)), directed.nextState);
  const expired = evaluate(sampleAt(202, atMeters(PREDECESSOR, 0, -20)), atBoundary.nextState);

  assert.equal(atBoundary.nextState.direction.observedSampleAt, directed.nextState.direction.observedSampleAt);
  assert.equal(expired.status, 'pending');
  assert.equal(expired.reason, 'direction_expired');
  assert.equal(expired.nextState.direction, null);
});

test('evaluateCollectionApproach records a new anchor when a vehicle returns after the predecessor anchor expires', () => {
  const first = evaluate(sampleAt(0));
  const returned = evaluate(sampleAt(301), first.nextState);

  assert.equal(returned.status, 'pending');
  assert.equal(returned.nextState.anchor.sample.sampledAt, sampleAt(301).sampledAt);
  assert.equal(returned.nextState.direction, null);
});

test('evaluateCollectionApproach treats state at 900 seconds as a new first observation', () => {
  const first = evaluate(sampleAt(0));
  const expired = evaluate(sampleAt(900), first.nextState);

  assert.equal(expired.status, 'pending');
  assert.equal(expired.reason, 'first_sample');
  assert.equal(expired.nextState.anchor.sample.sampledAt, sampleAt(900).sampledAt);
  assert.equal(expired.nextState.lastSample.sampledAt, sampleAt(900).sampledAt);
});

test('evaluateCollectionApproach rebuilds its last sample without direction after a gap over 180 seconds', () => {
  const first = evaluate(sampleAt(0));
  const afterGap = evaluate(sampleAt(181, atMeters(PREDECESSOR, 0, -20)), first.nextState);

  assert.equal(afterGap.status, 'pending');
  assert.equal(afterGap.nextState.direction, null);
  assert.equal(afterGap.nextState.lastSample.sampledAt, sampleAt(181).sampledAt);
});

test('evaluateCollectionApproach accepts GPS samples at the 180 second and 30 second freshness boundaries', () => {
  const observedAt = new Date(BASE_MS).toISOString();
  const oldest = sampleAt(-180, PREDECESSOR, { observedAt });
  const future = sampleAt(30, PREDECESSOR, { observedAt });

  assert.equal(evaluate(oldest, null, BASE_MS).reason, 'first_sample');
  assert.equal(evaluate(future, null, BASE_MS).reason, 'first_sample');
});

test('evaluateCollectionApproach rejects a GPS sample more than 30 seconds in the future', () => {
  const future = sampleAt(31, PREDECESSOR, { observedAt: new Date(BASE_MS).toISOString() });

  assert.equal(evaluate(future, null, BASE_MS).status, 'pending');
  assert.equal(evaluate(future, null, BASE_MS).reason, 'future_sample');
});

test('evaluateCollectionApproach keeps samples without trusted primary GPS time pending', () => {
  const cases = [
    sampleAt(0, PREDECESSOR, { sampledAt: null }),
    sampleAt(0, PREDECESSOR, { sampledAt: 'invalid-time' }),
    sampleAt(0, PREDECESSOR, { source: 'unknown-source' }),
    sampleAt(0, PREDECESSOR, { source: 'ntpc-website', timestampKind: 'response' }),
  ];

  for (const sample of cases) {
    const result = evaluate(sample);
    assert.equal(result.status, 'pending');
    assert.equal(result.reason, 'untrusted_sample_time');
    assert.equal(result.nextState.anchor, null);
    assert.equal(result.nextState.direction, null);
  }
});

test('evaluateCollectionApproach rejects a predecessor from a different route', () => {
  const wrongRoutePredecessor = { ...PREDECESSOR, route_id: '221032' };
  const result = evaluate(sampleAt(0), null, BASE_MS, STOP, wrongRoutePredecessor);

  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'missing_topology');
  assert.equal(result.nextState.anchor, null);
});

test('evaluateCollectionApproach clears GPS evidence when switching to a response-timestamp source', () => {
  const first = evaluate(sampleAt(0));
  const directed = evaluate(sampleAt(60, atMeters(PREDECESSOR, 0, -20)), first.nextState);
  const switched = evaluate(sampleAt(90, PREDECESSOR, {
    source: 'ntpc-website',
    timestampKind: 'response',
  }), directed.nextState);

  assert.equal(switched.status, 'pending');
  assert.equal(switched.reason, 'untrusted_sample_time');
  assert.equal(switched.nextState.source, 'ntpc-website');
  assert.equal(switched.nextState.timestampKind, 'response');
  assert.equal(switched.nextState.lastSample, null);
  assert.equal(switched.nextState.anchor, null);
  assert.equal(switched.nextState.direction, null);

  const switchedBack = evaluate(sampleAt(120, { lat: 25.076423, lng: 121.649942 }), switched.nextState);
  assert.equal(switchedBack.status, 'pending');
  assert.equal(switchedBack.reason, 'first_sample');
  assert.equal(switchedBack.nextState.anchor, null);
  assert.equal(switchedBack.nextState.direction, null);
});

test('evaluateCollectionApproach treats a repeated GPS timestamp as duplicate without replacing state', () => {
  const first = evaluate(sampleAt(0));
  const directed = evaluate(sampleAt(20, atMeters(PREDECESSOR, 0, -20)), first.nextState);
  const duplicate = evaluate(sampleAt(20, atMeters(PREDECESSOR, 0, -35)), directed.nextState);

  assert.equal(duplicate.status, 'pending');
  assert.equal(duplicate.reason, 'duplicate_sample');
  assert.deepEqual(duplicate.nextState, directed.nextState);
});

test('evaluateCollectionApproach leaves an ambiguous 60 to 90 degree movement pending', () => {
  const first = evaluate(sampleAt(0));
  const directed = evaluate(sampleAt(30, atMeters(PREDECESSOR, 0, -20)), first.nextState);
  const ambiguous = evaluate(sampleAt(60, atMeters(PREDECESSOR, 20, -26)), directed.nextState);

  assert.equal(ambiguous.status, 'pending');
  assert.equal(ambiguous.reason, 'ambiguous_direction');
});

test('evaluateCollectionApproach accepts a reliable approach on the 60 meter corridor boundary', () => {
  const first = evaluate(sampleAt(0));
  const boundary = evaluate(sampleAt(60, atApproachOffset(80, 59.999)), first.nextState);

  assert.equal(boundary.status, 'confirmed');
});

test('evaluateCollectionApproach rejects a reliable path beyond the 60 meter corridor', () => {
  const first = evaluate(sampleAt(0));
  const outside = evaluate(sampleAt(60, atApproachOffset(80, 60.1)), first.nextState);

  assert.equal(outside.status, 'pending');
  assert.equal(outside.reason, 'outside_corridor');
});

test('evaluateCollectionApproach rejects reported and GPS-derived cruising speeds', () => {
  const reported = evaluate(sampleAt(0, PREDECESSOR, { reportedSpeed: 26 }));
  const first = evaluate(sampleAt(0));
  const derived = evaluate(sampleAt(10, atMeters(PREDECESSOR, 0, -100)), first.nextState);

  assert.equal(reported.status, 'rejected');
  assert.equal(reported.reason, 'cruising_speed');
  assert.equal(derived.status, 'rejected');
  assert.equal(derived.reason, 'cruising_speed');
});

test('evaluateCollectionApproach leaves state unchanged for older GPS samples', () => {
  const first = evaluate(sampleAt(0));
  const directed = evaluate(sampleAt(20, atMeters(PREDECESSOR, 0, -20)), first.nextState);
  const older = evaluate(sampleAt(10, atMeters(PREDECESSOR, 0, -35)), directed.nextState);

  assert.equal(older.status, 'pending');
  assert.equal(older.reason, 'out_of_order');
  assert.deepEqual(older.nextState, directed.nextState);
});

test('evaluateCollectionApproach ignores duplicate and older samples before checking reported speed', () => {
  const first = evaluate(sampleAt(0));
  const directed = evaluate(sampleAt(20, atMeters(PREDECESSOR, 0, -20)), first.nextState);
  const duplicate = evaluate(sampleAt(20, atMeters(PREDECESSOR, 0, -35), { reportedSpeed: 26 }), directed.nextState);
  const older = evaluate(sampleAt(10, atMeters(PREDECESSOR, 0, -35), { reportedSpeed: 26 }), directed.nextState);

  assert.equal(duplicate.reason, 'duplicate_sample');
  assert.deepEqual(duplicate.nextState, directed.nextState);
  assert.equal(older.reason, 'out_of_order');
  assert.deepEqual(older.nextState, directed.nextState);
});

test('evaluateCollectionApproach does not extend direction TTL for sub-10-meter drift', () => {
  const first = evaluate(sampleAt(0));
  const directed = evaluate(sampleAt(20, atMeters(PREDECESSOR, 0, -20)), first.nextState);
  const drift = evaluate(sampleAt(100, atMeters(PREDECESSOR, 1, -20)), directed.nextState);
  const expired = evaluate(sampleAt(201, atMeters(PREDECESSOR, 1, -20)), drift.nextState);

  assert.equal(drift.nextState.direction.observedSampleAt, directed.nextState.direction.observedSampleAt);
  assert.equal(expired.reason, 'direction_expired');
});

test('evaluateCollectionApproach leaves invalid clock and invalid sample identity pending', () => {
  const invalidClock = evaluate(sampleAt(0), null, Number.NaN);
  const invalidId = evaluate(sampleAt(0, PREDECESSOR, { carId: '' }));
  const invalidPosition = evaluate(sampleAt(0, PREDECESSOR, { lat: Number.NaN }));

  assert.equal(invalidClock.status, 'pending');
  assert.equal(invalidClock.reason, 'invalid_sample_time');
  assert.equal(invalidId.reason, 'invalid_identity');
  assert.equal(invalidPosition.reason, 'invalid_position');
});

test('evaluateCollectionApproach handles an invalid observedAt timestamp without throwing', () => {
  const invalidObservedAt = sampleAt(0, PREDECESSOR, { observedAt: 'not-a-date' });
  assert.doesNotThrow(() => evaluate(invalidObservedAt));
  assert.equal(evaluate(invalidObservedAt).status, 'pending');
});

test('evaluateCollectionApproach does not seed state from an invalid or stale first sample', () => {
  const invalidPosition = evaluate(sampleAt(0, PREDECESSOR, { lng: Number.NaN }));
  const stale = evaluate(sampleAt(-181, PREDECESSOR, { observedAt: new Date(BASE_MS).toISOString() }), null, BASE_MS);

  assert.equal(invalidPosition.status, 'pending');
  assert.equal(invalidPosition.nextState.lastSample, null);
  assert.equal(stale.status, 'pending');
  assert.equal(stale.nextState.lastSample, null);
});

test('evaluateCollectionApproach accepts the two second and 180 second movement interval boundaries', () => {
  const first = evaluate(sampleAt(0));
  const atTwoSeconds = evaluate(sampleAt(2, atMeters(PREDECESSOR, 0, -10)), first.nextState);
  const at180Seconds = evaluate(sampleAt(180, atMeters(PREDECESSOR, 0, -20)), first.nextState);

  assert.equal(atTwoSeconds.nextState.direction.observedSampleAt, sampleAt(2).sampledAt);
  assert.equal(at180Seconds.nextState.direction.observedSampleAt, sampleAt(180).sampledAt);
});

test('evaluateCollectionApproach retains a predecessor anchor through exactly 300 seconds', () => {
  const first = evaluate(sampleAt(0));
  const atBoundary = evaluate(sampleAt(300), first.nextState);

  assert.equal(atBoundary.status, 'pending');
  assert.equal(atBoundary.nextState.anchor.sample.sampledAt, sampleAt(0).sampledAt);
});

test('evaluateCollectionApproach leaves the caller state untouched when the clock is invalid', () => {
  const first = evaluate(sampleAt(0));
  const original = structuredClone(first.nextState);
  const invalidClock = evaluate(sampleAt(20), first.nextState, Number.NaN);

  assert.equal(invalidClock.status, 'pending');
  assert.deepEqual(first.nextState, original);
});

test('evaluateCollectionApproach rejects a target stop outside the protected topology', () => {
  const wrongStop = { ...STOP, id: 4 };
  const result = evaluate(sampleAt(0), null, BASE_MS, wrongStop);

  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'missing_topology');
});
