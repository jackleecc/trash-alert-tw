import { parseNtpcTime } from './ntpcWebsiteBackup.js';
import { supabaseCollectionApproachStore } from './collectionApproachStore.js';

const METERS_PER_DEGREE = 111_320;
const TARGET_RADIUS_METERS = 120;

function finiteCoordinate(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function sampleTime(sample) {
  if (sample.source !== 'ntpc-primary' || sample.timestampKind !== 'gps') return null;
  return parseNtpcTime(sample.sampledAt || '')?.getTime() ?? null;
}

function pointMeters(point, origin) {
  const middleLat = ((point.lat + origin.lat) / 2) * Math.PI / 180;
  return {
    east: (point.lng - origin.lng) * METERS_PER_DEGREE * Math.cos(middleLat),
    north: (point.lat - origin.lat) * METERS_PER_DEGREE,
  };
}

function distanceMeters(a, b) {
  const delta = pointMeters(a, b);
  return Math.hypot(delta.east, delta.north);
}

function bearingDegrees(a, b) {
  const delta = pointMeters(b, a);
  return (Math.atan2(delta.east, delta.north) * 180 / Math.PI + 360) % 360;
}

function bearingDifference(a, b) {
  const difference = Math.abs(a - b) % 360;
  return Math.min(difference, 360 - difference);
}

function taiwanDate(nowMs) {
  return new Date(nowMs + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function validDateKey(date, nowMs) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [year, month, day] = date.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day && date === taiwanDate(nowMs);
}

function blankState(sample, observedAtMs) {
  return {
    schemaVersion: 1,
    source: sample.source,
    timestampKind: sample.timestampKind,
    lastSample: null,
    anchor: null,
    direction: null,
    requiresPredecessorPass: false,
    expiresAt: new Date(observedAtMs + 900_000).toISOString(),
  };
}

function updateLastSample(state, sample, observedAtMs) {
  state.lastSample = { sampledAt: sample.sampledAt, lat: sample.lat, lng: sample.lng };
  state.expiresAt = new Date(observedAtMs + 900_000).toISOString();
  return state;
}

export function evaluateCollectionApproach({ sample, previousState, stop, predecessor, nowMs }) {
  const sampledAtMs = sampleTime(sample);
  const observedAtMs = Date.parse(sample.observedAt);
  const validClock = Number.isFinite(nowMs) && Number.isFinite(observedAtMs);
  const sourceChanged = Boolean(previousState) &&
    (previousState.source !== sample.source || previousState.timestampKind !== sample.timestampKind);
  const stateStillLive = validClock && previousState && !sourceChanged && Date.parse(previousState.expiresAt) > observedAtMs;
  const safeObservedAtMs = Number.isFinite(observedAtMs) ? observedAtMs : 0;
  const base = stateStillLive
    ? structuredClone(previousState)
    : blankState(sample, safeObservedAtMs);
  const makeResult = (status, reason, nextState = base, evidence = {}) => ({
    status,
    reason,
    nextState,
    evidence: {
      source: sample.source,
      timestampKind: sample.timestampKind,
      wasteType: sample.wasteType,
      sampledAt: sample.sampledAt,
      observedAt: sample.observedAt,
      lat: sample.lat,
      lng: sample.lng,
      rawSourceTimestamp: sample.rawSourceTimestamp ?? null,
      rawTime: sample.rawTime ?? null,
      ...evidence,
    },
  });

  if (!validClock) return makeResult('pending', 'invalid_sample_time', previousState || base);
  if (String(sample.routeId) !== '221010' || !String(sample.carId || '').trim()) {
    return makeResult('pending', 'invalid_identity');
  }
  if (!finiteCoordinate(sample.lat) || !finiteCoordinate(sample.lng) ||
      sample.lat < 21.5 || sample.lat > 26.5 || sample.lng < 119 || sample.lng > 122.5) {
    return makeResult('pending', 'invalid_position');
  }
  if (sample.batchConflict === true) {
    return makeResult('pending', 'batch_conflict', base, {
      batchConflict: true,
      conflictingObservations: Array.isArray(sample.conflictingObservations)
        ? sample.conflictingObservations
        : [],
    });
  }
  if (!Number.isFinite(observedAtMs) || !Number.isFinite(sampledAtMs)) {
    return makeResult('pending', 'untrusted_sample_time');
  }
  const ageMs = nowMs - sampledAtMs;
  if (ageMs < -30_000) return makeResult('pending', 'future_sample');
  if (ageMs > 180_000) return makeResult('pending', 'stale_sample');
  if (sample.wasteType === 'recycling') return makeResult('pending', 'non_collection_vehicle');
  if (!stop || String(stop.route_id) !== '221010' || String(stop.id) !== '3' ||
      String(stop.route_id) !== String(sample.routeId) || !predecessor ||
      String(predecessor.route_id) !== String(stop.route_id) ||
      !finiteCoordinate(predecessor.lat) || !finiteCoordinate(predecessor.lng)) {
    return makeResult('pending', 'missing_topology');
  }
  const previousSample = stateStillLive ? base.lastSample : null;
  const previousTimeMs = Date.parse(previousSample?.sampledAt || '');
  const elapsedMs = sampledAtMs - previousTimeMs;
  if (Number.isFinite(previousTimeMs)) {
    if (elapsedMs < 0) return makeResult('pending', 'out_of_order');
    if (elapsedMs < 2_000) return makeResult('pending', 'duplicate_sample');
  }
  if (Number.isFinite(sample.reportedSpeed) && sample.reportedSpeed > 25) {
    base.anchor = null;
    base.direction = null;
    updateLastSample(base, sample, observedAtMs);
    return makeResult('rejected', 'cruising_speed', base, { reportedSpeed: sample.reportedSpeed });
  }

  const axis = pointMeters(stop, predecessor);
  const axisLength = Math.hypot(axis.east, axis.north);
  if (!Number.isFinite(axisLength) || axisLength < 1) return makeResult('pending', 'missing_topology');
  const axisUnit = { east: axis.east / axisLength, north: axis.north / axisLength };
  const approachBearing = bearingDegrees(predecessor, stop);
  const currentFromPredecessor = pointMeters(sample, predecessor);
  const currentAlong = currentFromPredecessor.east * axisUnit.east + currentFromPredecessor.north * axisUnit.north;
  const currentLateral = Math.abs(currentFromPredecessor.east * axisUnit.north - currentFromPredecessor.north * axisUnit.east);
  const toPredecessor = distanceMeters(sample, predecessor);
  const inPredecessorAnchor = toPredecessor <= 100 && currentAlong <= 50 && currentLateral <= 60;

  let movedDistance = 0;
  let movementBearing = null;
  let derivedSpeed = null;
  let ambiguousMovement = false;
  if (Number.isFinite(previousTimeMs)) {
    if (elapsedMs > 180_000) {
      base.direction = null;
      if (base.anchor && sampledAtMs - Date.parse(base.anchor.sample.sampledAt) > 300_000) {
        base.anchor = null;
      }
      updateLastSample(base, sample, observedAtMs);
      if (!base.anchor && inPredecessorAnchor && !base.requiresPredecessorPass) {
        base.anchor = {
          sample: { sampledAt: sample.sampledAt, lat: sample.lat, lng: sample.lng },
          progress: currentAlong,
          distanceToTarget: distanceMeters(sample, stop),
        };
      }
      return makeResult('pending', 'direction_expired', base, { approachBearing, distanceToTarget: distanceMeters(sample, stop) });
    }
    movedDistance = distanceMeters(sample, previousSample);
    if (movedDistance >= 10) {
      movementBearing = bearingDegrees(previousSample, sample);
      derivedSpeed = movedDistance / (elapsedMs / 3_600_000) / 1_000;
      if (derivedSpeed > 25) {
        base.anchor = null;
        base.direction = null;
        updateLastSample(base, sample, observedAtMs);
        return makeResult('rejected', 'cruising_speed', base, { derivedSpeed });
      }
      const angle = bearingDifference(movementBearing, approachBearing);
      if (angle > 90) {
        base.anchor = null;
        base.direction = null;
        base.requiresPredecessorPass = true;
        updateLastSample(base, sample, observedAtMs);
        return makeResult('rejected', 'opposite_direction', base, { movementBearing, angle, derivedSpeed });
      }
      if (angle <= 60) {
        base.direction = { bearing: movementBearing, observedSampleAt: sample.sampledAt };
      } else {
        ambiguousMovement = true;
      }
    }
  }

  if (base.anchor && sampledAtMs - Date.parse(base.anchor.sample.sampledAt) > 300_000) {
    base.anchor = null;
  }
  const existingAnchor = base.anchor;
  const reliableApproachMovement = movedDistance >= 10 &&
    movementBearing !== null && bearingDifference(movementBearing, approachBearing) <= 60;
  if (!existingAnchor && inPredecessorAnchor &&
      (!base.requiresPredecessorPass || reliableApproachMovement)) {
    base.anchor = {
      sample: { sampledAt: sample.sampledAt, lat: sample.lat, lng: sample.lng },
      progress: currentAlong,
      distanceToTarget: distanceMeters(sample, stop),
    };
    base.requiresPredecessorPass = false;
  }
  updateLastSample(base, sample, observedAtMs);

  const anchor = base.anchor;
  const anchorTimeMs = Date.parse(anchor?.sample?.sampledAt || '');
  const anchorAgeMs = sampledAtMs - anchorTimeMs;
  const progress = anchor ? currentAlong - anchor.progress : 0;
  const distanceToTarget = distanceMeters(sample, stop);
  const targetProgress = anchor ? anchor.distanceToTarget - distanceToTarget : 0;
  const directionAgeMs = base.direction
    ? sampledAtMs - Date.parse(base.direction.observedSampleAt)
    : Infinity;
  const directionExpired = Boolean(base.direction) && directionAgeMs > 180_000;
  if (directionExpired) base.direction = null;
  const hasFreshDirection = Boolean(base.direction) && directionAgeMs >= 0 && directionAgeMs <= 180_000;

  if (anchor && anchorAgeMs >= 0 && anchorAgeMs <= 300_000 && hasFreshDirection && !ambiguousMovement &&
      currentLateral <= 60 && progress >= 20 && targetProgress >= 20 &&
      distanceToTarget <= TARGET_RADIUS_METERS) {
    return makeResult('confirmed', 'confirmed_approach', base, {
      approachBearing,
      movementBearing,
      derivedSpeed,
      progress,
      distanceToTarget,
    });
  }

  const reason = ambiguousMovement ? 'ambiguous_direction' : currentLateral > 60 ? 'outside_corridor' : !stateStillLive ? 'first_sample' :
    !anchor ? 'missing_predecessor' :
      anchorAgeMs > 300_000 ? 'predecessor_expired' :
        !hasFreshDirection ? (directionExpired ? 'direction_expired' : 'unknown_direction') :
          distanceToTarget > TARGET_RADIUS_METERS ? 'outside_target' : 'insufficient_progress';
  return makeResult('pending', reason, base, { approachBearing, movementBearing, derivedSpeed, progress, distanceToTarget });
}

export async function observeCollectionApproach({ sample, stop, predecessor, dateStr, store = supabaseCollectionApproachStore, nowMs }) {
  const observedAtMs = Date.parse(sample.observedAt);
  const effectiveNowMs = Number.isFinite(nowMs) ? nowMs : observedAtMs;
  if (!Number.isFinite(effectiveNowMs) || !Number.isFinite(observedAtMs)) {
    return {
      status: 'pending',
      reason: 'invalid_sample_time',
      evidence: { source: sample.source, timestampKind: sample.timestampKind, sampledAt: sample.sampledAt, observedAt: sample.observedAt },
    };
  }
  const date = validDateKey(dateStr, effectiveNowMs) ? dateStr : taiwanDate(effectiveNowMs);
  const key = {
    date,
    routeId: String(sample.routeId),
    stopId: String(stop?.id || '3'),
    carId: String(sample.carId || ''),
  };

  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const record = await store.read(key);
      if (record && (!Number.isSafeInteger(record.version) || record.version < 1 ||
          !record.state || typeof record.state !== 'object' || Array.isArray(record.state))) {
        throw new Error('collection approach store returned malformed state row');
      }
      const evaluated = evaluateCollectionApproach({
        sample,
        previousState: record?.state || null,
        stop,
        predecessor,
        nowMs: effectiveNowMs,
      });
      const expectedVersion = record?.version ?? 0;
      const nextVersion = expectedVersion + 1;
      const committed = await store.commit({
        key,
        expectedVersion,
        nextState: evaluated.nextState,
        event: {
          ...evaluated.evidence,
          details: {
            rawSourceTimestamp: sample.rawSourceTimestamp ?? null,
            rawTime: sample.rawTime ?? null,
            rawSampledAt: sample.sampledAt ?? null,
          },
          sampledAt: sample.source === 'ntpc-primary' && sample.timestampKind === 'gps' &&
            Number.isFinite(Date.parse(sample.sampledAt || '')) ? sample.sampledAt : null,
          rawSampledAt: sample.sampledAt ?? null,
          source: sample.source || 'unknown',
          timestampKind: sample.timestampKind || 'unknown',
          reportedSpeed: Number.isFinite(sample.reportedSpeed) && sample.reportedSpeed >= 0 ? sample.reportedSpeed : null,
          derivedSpeed: evaluated.evidence.derivedSpeed ?? null,
          previous: record?.state?.lastSample ?? null,
          predecessor: predecessor ? { id: predecessor.id, routeId: predecessor.route_id, lat: predecessor.lat, lng: predecessor.lng } : null,
          anchor: evaluated.nextState.anchor,
          direction: evaluated.nextState.direction,
          status: evaluated.status,
          reason: evaluated.reason,
          version: nextVersion,
        },
      });
      if (committed?.applied === false) continue;
      if (committed?.applied === true && Number.isSafeInteger(committed.version) &&
          committed.version === nextVersion) {
        return { status: evaluated.status, reason: evaluated.reason, evidence: evaluated.evidence };
      }
      throw new Error('collection approach store returned malformed commit result');
    }
    console.warn('[CollectionApproach] storage conflict retry limit reached', { key, status: 'pending', reason: 'storage_conflict' });
    return { status: 'pending', reason: 'storage_conflict', evidence: { source: sample.source, sampledAt: sample.sampledAt } };
  } catch (error) {
    console.error('[CollectionApproach] storage unavailable', {
      key,
      status: 'pending',
      reason: 'storage_unavailable',
      error: error?.message,
      source: sample.source,
      sampledAt: sample.sampledAt,
    });
    return { status: 'pending', reason: 'storage_unavailable', evidence: { source: sample.source, sampledAt: sample.sampledAt, error: error?.message } };
  }
}
