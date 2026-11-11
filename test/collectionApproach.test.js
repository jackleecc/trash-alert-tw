import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCollectionApproach } from '../lib/collectionApproach.js';
import { XIZHI_221010_REAL_STOPS } from './fixtures/xizhi221010Stops.js';

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

const YM_STOPS = [
  { id: 101, route_id: 'lagi2-006_2_21', order_index: 1, name: '大平街246號(右邊)', lat: 24.910226, lng: 121.140549, schedule_time: '17:10:00' },
  { id: 8, route_id: 'lagi2-006_2_21', order_index: 2, name: '中山南路100號', lat: 24.907498, lng: 121.137464, schedule_time: '17:14:00' },
  { id: 9, route_id: 'lagi2-006_2_21', order_index: 3, name: '楊梅區中山南路146號', lat: 24.907648, lng: 121.136540, schedule_time: '17:15:00' },
];

function ymSample(seconds, point, overrides = {}) {
  const instant = new Date(Date.parse('2026-11-10T09:10:00Z') + seconds * 1_000).toISOString();
  return {
    routeId: 'lagi2-006_2_21',
    carId: 'KEK-3178',
    lat: point.lat,
    lng: point.lng,
    sampledAt: instant,
    observedAt: instant,
    source: 'taoyuan-primary',
    timestampKind: 'gps',
    reportedSpeed: null,
    ...overrides,
  };
}

test('evaluateCollectionApproach confirms early along Xizhi upstream corridor', () => {
  const targetStop = {
    ...XIZHI_221010_REAL_STOPS.find((s) => s.rank === 17),
    id: 3,
  };

  const sample1 = {
    routeId: '221010',
    carId: '647-BX',
    lat: 25.0809083333333,
    lng: 121.649451666667,
    sampledAt: '2026-11-09T11:48:11Z',
    observedAt: '2026-11-09T11:48:11Z',
    source: 'ntpc-primary',
    timestampKind: 'gps',
    reportedSpeed: null,
  };

  const sample2 = {
    routeId: '221010',
    carId: '647-BX',
    lat: 25.0806683333333,
    lng: 121.649411666667,
    sampledAt: '2026-11-09T11:49:09Z',
    observedAt: '2026-11-09T11:49:09Z',
    source: 'ntpc-primary',
    timestampKind: 'gps',
    reportedSpeed: null,
  };

  const first = evaluateCollectionApproach({
    sample: sample1,
    previousState: null,
    stop: targetStop,
    allRouteStops: XIZHI_221010_REAL_STOPS,
    nowMs: Date.parse(sample1.observedAt),
  });
  assert.equal(first.status, 'pending');

  const second = evaluateCollectionApproach({
    sample: sample2,
    previousState: first.nextState,
    stop: targetStop,
    allRouteStops: XIZHI_221010_REAL_STOPS,
    nowMs: Date.parse(sample2.observedAt),
  });
  assert.equal(second.status, 'confirmed');
  assert.equal(second.reason, 'confirmed_approach');
});

test('evaluateCollectionApproach excludes Rank 13 and rejects northbound pass on Xizhi corridor', () => {
  const targetStop = {
    ...XIZHI_221010_REAL_STOPS.find((s) => s.rank === 17),
    id: 3,
  };

  const points = [
    { sampledAt: '2026-11-09T11:42:11Z', lat: 25.076235, lng: 121.646435 },
    { sampledAt: '2026-11-09T11:43:10Z', lat: 25.075935, lng: 121.649328333333 },
    { sampledAt: '2026-11-09T11:44:11Z', lat: 25.07511, lng: 121.650428333333 },
    { sampledAt: '2026-11-09T11:46:11Z', lat: 25.07622, lng: 121.649901666667 },
  ];

  let state = null;
  const results = [];
  for (const pt of points) {
    const sample = {
      routeId: '221010',
      carId: '647-BX',
      lat: pt.lat,
      lng: pt.lng,
      sampledAt: pt.sampledAt,
      observedAt: pt.sampledAt,
      source: 'ntpc-primary',
      timestampKind: 'gps',
      reportedSpeed: null,
    };
    const res = evaluateCollectionApproach({
      sample,
      previousState: state,
      stop: targetStop,
      allRouteStops: XIZHI_221010_REAL_STOPS,
      nowMs: Date.parse(pt.sampledAt),
    });
    results.push(res);
    state = res.nextState;
  }

  for (const res of results) {
    assert.notEqual(res.status, 'confirmed');
  }

  const lastResult = results[3];
  assert.equal(lastResult.status, 'rejected');
  assert.equal(lastResult.reason, 'opposite_direction');
});

test('evaluateCollectionApproach handles cruising then drift then southbound confirmation on Xizhi corridor', () => {
  const targetStop = {
    ...XIZHI_221010_REAL_STOPS.find((s) => s.rank === 17),
    id: 3,
  };

  const seq = [
    { sampledAt: '2026-11-06T11:45:21Z', lat: 25.077018, lng: 121.650247 },
    { sampledAt: '2026-11-06T11:46:10Z', lat: 25.078520, lng: 121.649708 }, // cruising
    { sampledAt: '2026-11-06T11:47:09Z', lat: 25.081467, lng: 121.649558 }, // cruising
    { sampledAt: '2026-11-06T11:48:12Z', lat: 25.081533, lng: 121.649522 }, // 8m drift north
    { sampledAt: '2026-11-06T11:49:09Z', lat: 25.080643, lng: 121.649395 }, // ~100m south near 37巷口
    { sampledAt: '2026-11-06T11:50:24Z', lat: 25.079537, lng: 121.649142 }, // ~126m south
  ];

  let state = null;
  const results = [];
  for (const pt of seq) {
    const sample = {
      routeId: '221010',
      carId: '647-BX',
      lat: pt.lat,
      lng: pt.lng,
      sampledAt: pt.sampledAt,
      observedAt: pt.sampledAt,
      source: 'ntpc-primary',
      timestampKind: 'gps',
      reportedSpeed: null,
    };
    const res = evaluateCollectionApproach({
      sample,
      previousState: state,
      stop: targetStop,
      allRouteStops: XIZHI_221010_REAL_STOPS,
      nowMs: Date.parse(pt.sampledAt),
    });
    results.push(res);
    state = res.nextState;
  }

  // 11:48:12Z is pending (drift does not clear reverse lock)
  assert.equal(results[3].status, 'pending');

  // 11:50:24Z is confirmed
  assert.equal(results[5].status, 'confirmed');
  assert.equal(results[5].reason, 'confirmed_approach');

  // 11:49:09Z sets anchor at 37巷口 and is pending
  assert.equal(results[4].status, 'pending');
  assert.ok(results[4].nextState.anchor);
});

test('evaluateCollectionApproach confirms Yangmei Stop 9 corridor at curve point (24.90951, 121.13932)', () => {
  const targetStop = YM_STOPS[2];
  const firstSample = ymSample(0, YM_STOPS[0]);
  const first = evaluateCollectionApproach({
    sample: firstSample,
    previousState: null,
    stop: targetStop,
    allRouteStops: YM_STOPS,
    nowMs: Date.parse(firstSample.observedAt),
  });
  assert.equal(first.status, 'pending');

  const secondSample = ymSample(60, { lat: 24.90951, lng: 121.13932 });
  const second = evaluateCollectionApproach({
    sample: secondSample,
    previousState: first.nextState,
    stop: targetStop,
    allRouteStops: YM_STOPS,
    nowMs: Date.parse(secondSample.observedAt),
  });
  assert.equal(second.status, 'confirmed');
  assert.equal(second.reason, 'confirmed_approach');
  assert.equal(first.reason, 'first_sample');
});

test('evaluateCollectionApproach confirms Yangmei Stop 9 corridor across L-bend curve (24.90717, 121.13955)', () => {
  const targetStop = YM_STOPS[2];
  const firstSample = ymSample(0, YM_STOPS[0]);
  const first = evaluateCollectionApproach({
    sample: firstSample,
    previousState: null,
    stop: targetStop,
    allRouteStops: YM_STOPS,
    nowMs: Date.parse(firstSample.observedAt),
  });
  assert.equal(first.status, 'pending');

  const secondSample = ymSample(60, { lat: 24.90717, lng: 121.13955 });
  const second = evaluateCollectionApproach({
    sample: secondSample,
    previousState: first.nextState,
    stop: targetStop,
    allRouteStops: YM_STOPS,
    nowMs: Date.parse(secondSample.observedAt),
  });
  assert.equal(second.status, 'confirmed');
  assert.equal(second.reason, 'confirmed_approach');
});

test('evaluateCollectionApproach rejects opposite NE movement from Yangmei first stop', () => {
  const targetStop = YM_STOPS[2];
  const firstSample = ymSample(0, YM_STOPS[0]);
  const first = evaluateCollectionApproach({
    sample: firstSample,
    previousState: null,
    stop: targetStop,
    allRouteStops: YM_STOPS,
    nowMs: Date.parse(firstSample.observedAt),
  });
  assert.equal(first.status, 'pending');

  const secondSample = ymSample(60, { lat: 24.9106, lng: 121.1410 });
  const second = evaluateCollectionApproach({
    sample: secondSample,
    previousState: first.nextState,
    stop: targetStop,
    allRouteStops: YM_STOPS,
    nowMs: Date.parse(secondSample.observedAt),
  });
  assert.equal(second.status, 'rejected');
  assert.equal(second.reason, 'opposite_direction');
});

test('evaluateCollectionApproach anchors on eastbound depot entry into Yangmei first stop and confirms on Da-Ping St approach', () => {
  const targetStop = YM_STOPS[2];

  const sample1 = ymSample(0, { lat: 24.910220, lng: 121.138500 });
  const step1 = evaluateCollectionApproach({
    sample: sample1,
    previousState: null,
    stop: targetStop,
    allRouteStops: YM_STOPS,
    nowMs: Date.parse(sample1.observedAt),
  });

  const sample2 = ymSample(60, YM_STOPS[0]);
  const step2 = evaluateCollectionApproach({
    sample: sample2,
    previousState: step1.nextState,
    stop: targetStop,
    allRouteStops: YM_STOPS,
    nowMs: Date.parse(sample2.observedAt),
  });

  assert.equal(step2.status, 'pending');
  assert.equal(step2.nextState.requiresPredecessorPass, false);
  assert.equal(Boolean(step2.nextState.anchor), true);

  const sample3 = ymSample(120, { lat: 24.909510, lng: 121.139320 });
  const step3 = evaluateCollectionApproach({
    sample: sample3,
    previousState: step2.nextState,
    stop: targetStop,
    allRouteStops: YM_STOPS,
    nowMs: Date.parse(sample3.observedAt),
  });

  assert.equal(step3.status, 'confirmed');
  assert.equal(step3.reason, 'confirmed_approach');
});

test('evaluateCollectionApproach anchors mid-segment on Da-Ping St and confirms across 145-degree SSE L-bend leg', () => {
  const targetStop = YM_STOPS[2];

  const sample1 = ymSample(0, { lat: 24.909510, lng: 121.139320 });
  const step1 = evaluateCollectionApproach({
    sample: sample1,
    previousState: null,
    stop: targetStop,
    allRouteStops: YM_STOPS,
    nowMs: Date.parse(sample1.observedAt),
  });

  assert.equal(step1.status, 'pending');
  assert.equal(Boolean(step1.nextState.anchor), true);

  const sample2 = ymSample(60, { lat: 24.909030, lng: 121.139690 });
  const step2 = evaluateCollectionApproach({
    sample: sample2,
    previousState: step1.nextState,
    stop: targetStop,
    allRouteStops: YM_STOPS,
    nowMs: Date.parse(sample2.observedAt),
  });

  assert.equal(step2.status, 'confirmed');
  assert.equal(step2.reason, 'confirmed_approach');
});

test('evaluateCollectionApproach stays pending outside_target when past target stop outside 120m', () => {
  const targetStop = {
    ...XIZHI_221010_REAL_STOPS.find((s) => s.rank === 17),
    id: 3,
  };
  const predecessor = XIZHI_221010_REAL_STOPS.find((s) => s.rank === 16);

  const seedSample = {
    routeId: '221010',
    carId: '647-BX',
    lat: predecessor.lat,
    lng: predecessor.lng,
    sampledAt: '2026-11-09T11:52:00Z',
    observedAt: '2026-11-09T11:52:00Z',
    source: 'ntpc-primary',
    timestampKind: 'gps',
    reportedSpeed: null,
  };

  const first = evaluateCollectionApproach({
    sample: seedSample,
    previousState: null,
    stop: targetStop,
    allRouteStops: XIZHI_221010_REAL_STOPS,
    nowMs: Date.parse(seedSample.observedAt),
  });

  const pastSample = {
    routeId: '221010',
    carId: '647-BX',
    lat: 25.07505,
    lng: 121.649942,
    sampledAt: '2026-11-09T11:54:00Z',
    observedAt: '2026-11-09T11:54:00Z',
    source: 'ntpc-primary',
    timestampKind: 'gps',
    reportedSpeed: null,
  };

  const second = evaluateCollectionApproach({
    sample: pastSample,
    previousState: first.nextState,
    stop: targetStop,
    allRouteStops: XIZHI_221010_REAL_STOPS,
    nowMs: Date.parse(pastSample.observedAt),
  });

  assert.equal(second.status, 'pending');
  assert.equal(second.reason, 'outside_target');
});

