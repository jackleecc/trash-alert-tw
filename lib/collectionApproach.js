import { parseNtpcTime } from './ntpcWebsiteBackup.js';
import { supabaseCollectionApproachStore } from './collectionApproachStore.js';

const METERS_PER_DEGREE = 111_320;
const TARGET_RADIUS_METERS = 120;
const PROTECTED_STOP_KEYS = new Set(['221010:3', 'lagi2-006_2_21:9']);
const PROTECTED_ROUTE_IDS = new Set(['221010', 'lagi2-006_2_21']);

function finiteCoordinate(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function sampleTime(sample) {
  if (
    (sample.source !== 'ntpc-primary' && sample.source !== 'taoyuan-primary') ||
    sample.timestampKind !== 'gps'
  ) return null;
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

function scheduleDiffMinutes(fromMinutes, toMinutes) {
  let dt = toMinutes - fromMinutes;
  if (dt < -720) dt += 1440;
  return dt;
}

function createApproachAnchor(sample, anchorCandidate, targetStop) {
  return {
    sample: { sampledAt: sample.sampledAt, lat: sample.lat, lng: sample.lng },
    segmentIndex: anchorCandidate.segmentIndex,
    progress: anchorCandidate.progress,
    distanceToTarget: distanceMeters(sample, targetStop),
  };
}

function parseScheduleMinutes(str) {
  if (typeof str !== 'string') return null;
  const match = str.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
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

export function isProtectedCollectionStop(stop) {
  if (!stop) return false;
  return PROTECTED_STOP_KEYS.has(`${String(stop.route_id ?? '')}:${String(stop.id ?? '')}`);
}

export function deriveApproachCorridor(targetStop, allRouteStops) {
  if (!targetStop || !Array.isArray(allRouteStops) || allRouteStops.length < 2) return null;

  const targetRouteId = String(targetStop.route_id ?? '');
  const sorted = allRouteStops
    .filter((s) => Boolean(s) && String(s.route_id) === targetRouteId && finiteCoordinate(s.lat) && finiteCoordinate(s.lng))
    .sort((a, b) => Number(a.rank ?? a.order_index ?? 0) - Number(b.rank ?? b.order_index ?? 0));

  let targetIndex = -1;
  // Match targetStop in sorted:
  // First prefer exact match of id AND name (or coords match)
  targetIndex = sorted.findIndex((s) =>
    String(s.id) === String(targetStop.id) &&
    (targetStop.name ? s.name === targetStop.name : true)
  );
  if (targetIndex === -1 && targetStop.name) {
    targetIndex = sorted.findIndex((s) => s.name === targetStop.name);
  }
  if (targetIndex === -1 && targetStop.id !== undefined) {
    targetIndex = sorted.findIndex((s) => String(s.id) === String(targetStop.id));
  }
  if (targetIndex === -1 && (targetStop.rank !== undefined || targetStop.order_index !== undefined)) {
    const targetRank = targetStop.rank ?? targetStop.order_index;
    targetIndex = sorted.findIndex((s) => (s.rank ?? s.order_index) === targetRank);
  }

  if (targetIndex <= 0) return null;

  const primaryBearing = bearingDegrees(sorted[targetIndex - 1], sorted[targetIndex]);
  const chain = [sorted[targetIndex]];

  for (let i = targetIndex - 1; i >= 0; i--) {
    const prev = sorted[i];
    const next = chain[0];

    const segDist = distanceMeters(prev, next);
    const totalDist = distanceMeters(prev, sorted[targetIndex]);
    if (segDist < 1 || segDist > 1500 || totalDist > 1500) {
      break;
    }

    const prevMins = parseScheduleMinutes(prev.schedule_time);
    const nextMins = parseScheduleMinutes(next.schedule_time);
    const targetMins = parseScheduleMinutes(targetStop.schedule_time ?? sorted[targetIndex].schedule_time);

    if (prevMins !== null && nextMins !== null) {
      const segDt = scheduleDiffMinutes(prevMins, nextMins);
      if (segDt < 0 || segDt > 15) break;
    }
    if (prevMins !== null && targetMins !== null) {
      const totalDt = scheduleDiffMinutes(prevMins, targetMins);
      if (totalDt < 0 || totalDt > 15) break;
    }

    const segBearing = bearingDegrees(prev, next);
    if (bearingDifference(segBearing, primaryBearing) > 65) {
      break;
    }
    if (chain.length >= 2) {
      const adjacentBearing = bearingDegrees(chain[0], chain[1]);
      if (bearingDifference(segBearing, adjacentBearing) > 75) {
        break;
      }
    }

    chain.unshift(prev);
  }

  return chain.length >= 2 ? chain : null;
}

function projectOnSegment(pt, seg) {
  const delta = pointMeters(pt, seg.from);
  const along = delta.east * seg.unit.east + delta.north * seg.unit.north;
  const lateral = Math.abs(delta.east * seg.unit.north - delta.north * seg.unit.east);
  return { along, lateral };
}

function findActiveSegment(sample, segments, baseAnchor) {
  const minK = baseAnchor?.segmentIndex ?? 0;
  if (baseAnchor && Number.isInteger(baseAnchor.segmentIndex) && baseAnchor.segmentIndex < segments.length) {
    const k = baseAnchor.segmentIndex;
    const proj = projectOnSegment(sample, segments[k]);
    if (proj.along >= 0 && proj.along <= segments[k].len + 20 && proj.lateral <= segments[k].segMaxLateral) {
      return { index: k, segment: segments[k], along: proj.along, lateral: proj.lateral };
    }
  }

  let best = null;
  for (let k = minK; k < segments.length; k++) {
    const seg = segments[k];
    const proj = projectOnSegment(sample, seg);
    if (proj.along >= -40 && proj.along <= seg.len + 40 && proj.lateral <= seg.segMaxLateral) {
      if (!best || proj.lateral < best.lateral) {
        best = { index: k, segment: seg, along: proj.along, lateral: proj.lateral };
      }
    }
  }
  if (best) return best;

  const fallbackIdx = (baseAnchor && Number.isInteger(baseAnchor.segmentIndex) && baseAnchor.segmentIndex < segments.length)
    ? baseAnchor.segmentIndex
    : segments.length - 1;
  const fallbackSeg = segments[fallbackIdx];
  const fallbackProj = projectOnSegment(sample, fallbackSeg);
  return { index: fallbackIdx, segment: fallbackSeg, along: fallbackProj.along, lateral: fallbackProj.lateral };
}

function findAnchorCandidate(sample, segments, stop) {
  let best = null;
  for (let k = 0; k < segments.length; k++) {
    const seg = segments[k];
    const toStop = distanceMeters(sample, seg.from);
    if (toStop <= 100) {
      const proj = projectOnSegment(sample, seg);
      const limit = seg.anchorAlongLimit;
      const validAlong = proj.along <= limit &&
        (seg.len <= 180 || distanceMeters(sample, stop) > TARGET_RADIUS_METERS || proj.along <= 50);
      if (validAlong && proj.lateral <= seg.segMaxLateral) {
        if (!best || toStop < best.distance) {
          best = { segmentIndex: k, progress: proj.along, distance: toStop };
        }
      }
    }
  }
  return best;
}

export function evaluateCollectionApproach({
  sample,
  previousState,
  stop,
  predecessor,
  corridorStops,
  allRouteStops,
  nowMs,
}) {
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
  if (!PROTECTED_ROUTE_IDS.has(String(sample.routeId)) || !String(sample.carId || '').trim()) {
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
  if (!stop || !isProtectedCollectionStop(stop) ||
      String(stop.route_id) !== String(sample.routeId) ||
      !finiteCoordinate(stop.lat) || !finiteCoordinate(stop.lng)) {
    return makeResult('pending', 'missing_topology');
  }

  let corridor = null;
  if (Array.isArray(corridorStops) && corridorStops.length >= 2 &&
      corridorStops.every((s) => String(s.route_id) === String(stop.route_id) && finiteCoordinate(s.lat) && finiteCoordinate(s.lng))) {
    corridor = corridorStops;
  } else if (Array.isArray(allRouteStops) && allRouteStops.length >= 2) {
    corridor = deriveApproachCorridor(stop, allRouteStops);
  }
  if (!corridor && predecessor && String(predecessor.route_id) === String(stop.route_id) &&
      finiteCoordinate(predecessor.lat) && finiteCoordinate(predecessor.lng)) {
    corridor = [predecessor, stop];
  }
  if (!corridor || corridor.length < 2) {
    return makeResult('pending', 'missing_topology');
  }

  const lastStop = corridor[corridor.length - 1];
  const targetDistanceToLast = distanceMeters(lastStop, stop);
  if (String(lastStop.id) !== String(stop.id) && targetDistanceToLast >= 1) {
    return makeResult('pending', 'missing_topology');
  }

  const segments = [];
  for (let k = 0; k < corridor.length - 1; k++) {
    const from = corridor[k];
    const to = corridor[k + 1];
    if (!finiteCoordinate(from.lat) || !finiteCoordinate(from.lng) ||
        !finiteCoordinate(to.lat) || !finiteCoordinate(to.lng)) {
      return makeResult('pending', 'missing_topology');
    }
    const axis = pointMeters(to, from);
    const segLen = Math.hypot(axis.east, axis.north);
    if (!Number.isFinite(segLen) || segLen < 1) {
      return makeResult('pending', 'missing_topology');
    }
    const unit = { east: axis.east / segLen, north: axis.north / segLen };
    const bearing = bearingDegrees(from, to);
    const segMaxLateral = segLen <= 250 ? 60 : Math.min(200, Math.round(segLen * 0.45));
    const anchorAlongLimit = (k === corridor.length - 2 || segLen <= 180)
      ? 50
      : Math.min(80, Math.round(segLen * 0.45));
    segments.push({
      from,
      to,
      len: segLen,
      unit,
      bearing,
      segMaxLateral,
      anchorAlongLimit,
    });
  }
  if (segments.length === 0) return makeResult('pending', 'missing_topology');

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

  const active = findActiveSegment(sample, segments, base.anchor);
  const activeIdx = active.index;
  const activeSeg = active.segment;
  const activeAlong = active.along;
  const activeLateral = active.lateral;
  const approachBearing = activeSeg.bearing;

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
      const anchorCandidate = findAnchorCandidate(sample, segments, stop);
      if (!base.anchor && anchorCandidate && !base.requiresPredecessorPass) {
        base.anchor = createApproachAnchor(sample, anchorCandidate, stop);
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
  const anchorCandidate = findAnchorCandidate(sample, segments, stop);
  if (!existingAnchor && anchorCandidate &&
      (!base.requiresPredecessorPass || reliableApproachMovement)) {
    base.anchor = createApproachAnchor(sample, anchorCandidate, stop);
    base.requiresPredecessorPass = false;
  }
  updateLastSample(base, sample, observedAtMs);

  const anchor = base.anchor;
  const anchorTimeMs = Date.parse(anchor?.sample?.sampledAt || '');
  const anchorAgeMs = sampledAtMs - anchorTimeMs;

  let progress = 0;
  if (anchor) {
    if (activeIdx === anchor.segmentIndex) {
      progress = activeAlong - anchor.progress;
    } else if (activeIdx > anchor.segmentIndex) {
      let accumulated = segments[anchor.segmentIndex].len - anchor.progress;
      for (let j = anchor.segmentIndex + 1; j < activeIdx; j++) {
        accumulated += segments[j].len;
      }
      accumulated += activeAlong;
      progress = accumulated;
    } else {
      progress = 0;
    }
  }

  const distanceToTarget = distanceMeters(sample, stop);
  const targetProgress = anchor ? anchor.distanceToTarget - distanceToTarget : 0;

  const directionAgeMs = base.direction
    ? sampledAtMs - Date.parse(base.direction.observedSampleAt)
    : Infinity;
  const directionExpired = Boolean(base.direction) && directionAgeMs > 180_000;
  if (directionExpired) base.direction = null;
  const hasFreshDirection = Boolean(base.direction) && directionAgeMs >= 0 && directionAgeMs <= 180_000;

  const lastSeg = segments[segments.length - 1];
  const lastProj = projectOnSegment(sample, lastSeg);
  const pastTarget = lastProj.along > lastSeg.len + 15 && distanceToTarget > TARGET_RADIUS_METERS;

  const inApproachZone = !pastTarget && (
    distanceToTarget <= TARGET_RADIUS_METERS ||
    (activeAlong >= 0 && activeAlong <= activeSeg.len + 15 && activeLateral <= activeSeg.segMaxLateral)
  );

  if (
    anchor &&
    anchorAgeMs >= 0 &&
    anchorAgeMs <= 300_000 &&
    hasFreshDirection &&
    !ambiguousMovement &&
    activeLateral <= activeSeg.segMaxLateral &&
    progress >= 20 &&
    targetProgress >= 20 &&
    inApproachZone
  ) {
    return makeResult('confirmed', 'confirmed_approach', base, {
      approachBearing,
      movementBearing,
      derivedSpeed,
      progress,
      distanceToTarget,
    });
  }

  let reason;
  if (ambiguousMovement) {
    reason = 'ambiguous_direction';
  } else if (activeLateral > activeSeg.segMaxLateral) {
    reason = 'outside_corridor';
  } else if (!stateStillLive) {
    reason = 'first_sample';
  } else if (!anchor) {
    reason = 'missing_predecessor';
  } else if (anchorAgeMs > 300_000) {
    reason = 'predecessor_expired';
  } else if (!hasFreshDirection) {
    reason = directionExpired ? 'direction_expired' : 'unknown_direction';
  } else if (pastTarget || (!inApproachZone && distanceToTarget > TARGET_RADIUS_METERS)) {
    reason = 'outside_target';
  } else {
    reason = 'insufficient_progress';
  }
  return makeResult('pending', reason, base, {
    approachBearing,
    movementBearing,
    derivedSpeed,
    progress,
    distanceToTarget,
  });
}

export async function observeCollectionApproach({
  sample,
  stop,
  predecessor,
  corridorStops,
  allRouteStops,
  dateStr,
  store = supabaseCollectionApproachStore,
  nowMs,
}) {
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
      const resolvedCorridor = Array.isArray(corridorStops) && corridorStops.length >= 2
        ? corridorStops
        : (Array.isArray(allRouteStops) && allRouteStops.length >= 2 ? deriveApproachCorridor(stop, allRouteStops) : null);
      const evaluated = evaluateCollectionApproach({
        sample,
        previousState: record?.state || null,
        stop,
        predecessor,
        corridorStops: resolvedCorridor,
        allRouteStops,
        nowMs: effectiveNowMs,
      });
      const expectedVersion = record?.version ?? 0;
      const nextVersion = expectedVersion + 1;
      const eventPredecessor = predecessor
        ? { id: predecessor.id, routeId: predecessor.route_id, lat: predecessor.lat, lng: predecessor.lng }
        : (Array.isArray(resolvedCorridor) && resolvedCorridor.length >= 2
          ? { id: resolvedCorridor[resolvedCorridor.length - 2].id, routeId: resolvedCorridor[resolvedCorridor.length - 2].route_id, lat: resolvedCorridor[resolvedCorridor.length - 2].lat, lng: resolvedCorridor[resolvedCorridor.length - 2].lng }
          : null);
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
          sampledAt: (sample.source === 'ntpc-primary' || sample.source === 'taoyuan-primary') && sample.timestampKind === 'gps' &&
            Number.isFinite(Date.parse(sample.sampledAt || '')) ? sample.sampledAt : null,
          rawSampledAt: sample.sampledAt ?? null,
          source: sample.source || 'unknown',
          timestampKind: sample.timestampKind || 'unknown',
          reportedSpeed: Number.isFinite(sample.reportedSpeed) && sample.reportedSpeed >= 0 ? sample.reportedSpeed : null,
          derivedSpeed: evaluated.evidence.derivedSpeed ?? null,
          previous: record?.state?.lastSample ?? null,
          predecessor: eventPredecessor,
          corridorStops: Array.isArray(resolvedCorridor) ? resolvedCorridor.map(s => ({ id: s.id, routeId: s.route_id, lat: s.lat, lng: s.lng })) : null,
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
