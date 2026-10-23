/**
 * lib/coreProcessor.js
 * 垃圾車追蹤與到站推播核心運算引擎 (Core Processor)
 */

import { supabase } from './supabaseClient.js';
import { dispatchNotificationBatch } from './notificationDispatcher.js';
import { checkUpcomingRain, formatArrivalWeatherSummary } from './weatherApi.js';
import { syncLineConsumption, getQuotaSnapshot, getYearMonth } from './quotaService.js';
import { fetchTrucksWithRetry } from './truckApi.js';
import { getActiveSubscriptionContext } from './subscriptionContext.js';
import { resolveRouteCity } from './geoUtils.js';
import { parseNtpcTime } from './ntpcWebsiteBackup.js';
import { resolveChannelForIntent } from './channelService.js';
import { observeCollectionApproach } from './collectionApproach.js';
import {
  findNearbyTruckArrivals,
  computeClosestTrucks,
  formatArrivalMessage,
  isWithinScheduleWindow,
  getIsoDayOfWeek,
  updateTruckTelemetry,
  recentTruckHistory,
} from './arrivalMatcher.js';

export {
  findNearbyTruckArrivals,
  computeClosestTrucks,
  formatArrivalMessage,
  isWithinScheduleWindow,
  getIsoDayOfWeek,
  updateTruckTelemetry,
  recentTruckHistory,
} from './arrivalMatcher.js';

export { getActiveSubscriptionContext } from './subscriptionContext.js';
export { resolveRouteCity } from './geoUtils.js';

/**
 * 執行即時車輛位置與訂閱站點的比對運算與推播處理
 *
 * @param {Array<{ route_id: string, lat: number, lng: number, car_id?: string, time?: string }>} truckData
 * @param {{ now: Date, hour: number, minute: number, dateStr: string }} taiwanNowInfo
 * @param {string[]} [suspendedCities]
 * @param {object} [providedContext] - 可選的訂閱上下文 (傳入可免除重複 DB 查詢)
 * @returns {Promise<{ ok: boolean, matchedArrivals: number, sentNotifications: number, closestTrucks: Array<object>, reason?: string }>}
 */
export async function processTruckArrivals(
  truckData,
  taiwanNowInfo,
  suspendedCities = [],
  providedContext = null,
  options = {}
) {
  if (!truckData || truckData.length === 0) {
    return { ok: true, matchedArrivals: 0, sentNotifications: 0, closestTrucks: [], reason: 'no-truck-data' };
  }

  const context = providedContext || (await getActiveSubscriptionContext(taiwanNowInfo, suspendedCities));
  if (!context.ok) {
    return { ok: false, matchedArrivals: 0, sentNotifications: 0, closestTrucks: [], reason: context.reason };
  }

  const { activeRoutesMap, stops, stopSubscribersMap, allRouteStops } = context;
  const rawTruckData = truckData.map((truck) => ({ ...truck }));
  const activeRouteIds = Array.from(activeRoutesMap.keys());
  if (activeRouteIds.length === 0) {
    return { ok: true, matchedArrivals: 0, sentNotifications: 0, closestTrucks: [], reason: context.reason || 'no-routes-today' };
  }

  // 計算已訂閱站點的最近車輛分析 (供 Debug Log 存查與排查)
  const closestTrucks = computeClosestTrucks(
    truckData,
    stops,
    stopSubscribersMap,
    activeRoutesMap
  );

  // 3.5 查詢各路線歷史上被觀測過的信任 linid (observed_count >= 3)
  const { data: trustedLinidsData, error: trustedErr } = await supabase
    .from('route_linids')
    .select('route_id, linid')
    .in('route_id', activeRouteIds)
    .gte('observed_count', 3);

  if (trustedErr) {
    console.error(`[Core] 查詢 route_linids 失敗: ${trustedErr.message}`);
  }

  const routeTrustedLinidsMap = new Map();
  for (const record of trustedLinidsData || []) {
    const rId = String(record.route_id);
    if (!routeTrustedLinidsMap.has(rId)) {
      routeTrustedLinidsMap.set(rId, new Set());
    }
    routeTrustedLinidsMap.get(rId).add(String(record.linid));
  }

  const protectedStops = stops.filter((stop) =>
    String(stop.route_id) === '221010' && String(stop.id) === '3'
  );
  const otherStops = stops.filter((stop) =>
    String(stop.route_id) !== '221010' || String(stop.id) !== '3'
  );
  const observationNow = options.observationNow instanceof Date
    ? options.observationNow
    : new Date();
  const approachResults = new Map();
  const latestProtectedSamples = new Map();

  function approachIdentity(truck) {
    return JSON.stringify([truck.route_id, truck.car_id, truck.source, truck.timestamp_kind,
      truck.source_timestamp || truck.time || '', truck.lat, truck.lng,
      truck.waste_type,
      Number.isFinite(truck.speed) && truck.speed >= 0 ? truck.speed : null]);
  }
  const protectedGeometryIdentities = new WeakMap();

  function findPredecessor(stop) {
    const routeStops = (allRouteStops || [])
      .filter((candidate) => String(candidate.route_id) === String(stop.route_id))
      .sort((a, b) => Number(a.rank ?? a.order_index) - Number(b.rank ?? b.order_index));
    const index = routeStops.findIndex((candidate) => String(candidate.id) === String(stop.id));
    return index > 0 ? routeStops[index - 1] : null;
  }

  if (protectedStops.length > 0) {
    const protectedSamples = rawTruckData
      .filter((truck) => String(truck.route_id) === '221010')
      .sort((a, b) => {
        const timeA = parseNtpcTime(a.source_timestamp || a.time)?.getTime() ?? Number.MAX_SAFE_INTEGER;
        const timeB = parseNtpcTime(b.source_timestamp || b.time)?.getTime() ?? Number.MAX_SAFE_INTEGER;
        return timeA - timeB;
      });
    const samplesByVehicle = new Map();
    for (const truck of protectedSamples) {
      const key = JSON.stringify([truck.route_id, truck.car_id]);
      if (!samplesByVehicle.has(key)) samplesByVehicle.set(key, []);
      samplesByVehicle.get(key).push(truck);
    }
    const conflictingSamples = new Map();
    for (const samples of samplesByVehicle.values()) {
      const uniqueSamples = [...new Map(samples.map((truck) => [approachIdentity(truck), truck])).values()];
      for (let leftIndex = 0; leftIndex < uniqueSamples.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < uniqueSamples.length; rightIndex += 1) {
          const left = uniqueSamples[leftIndex];
          const right = uniqueSamples[rightIndex];
          const samePosition = left.lat === right.lat && left.lng === right.lng;
          const differentSource = left.source !== right.source || left.timestamp_kind !== right.timestamp_kind;
          const sameGpsTimestamp = left.source === 'ntpc-primary' && right.source === 'ntpc-primary' &&
            left.timestamp_kind === 'gps' && right.timestamp_kind === 'gps' &&
            (left.source_timestamp || left.time) === (right.source_timestamp || right.time);
          const differentWasteType = left.waste_type !== right.waste_type;
          if ((samePosition && !differentWasteType) || (!differentSource && !sameGpsTimestamp && !differentWasteType)) continue;
          const evidence = [left, right].map((item) => ({
            source: item.source || 'unknown',
            timestampKind: item.timestamp_kind || 'unknown',
            sampledAt: item.source === 'ntpc-primary' && item.timestamp_kind === 'gps'
              ? parseNtpcTime(item.source_timestamp || item.time)?.toISOString() || null
              : null,
            rawSourceTimestamp: item.source_timestamp ?? null,
            rawTime: item.time ?? null,
            lat: item.lat,
            lng: item.lng,
          }));
          conflictingSamples.set(approachIdentity(left), evidence);
          conflictingSamples.set(approachIdentity(right), evidence);
        }
      }
    }
    const processedSamples = new Set();

    for (const truck of protectedSamples) {
      const identity = approachIdentity(truck);
      if (processedSamples.has(identity)) continue;
      processedSamples.add(identity);
      const source = typeof truck.source === 'string' ? truck.source : 'unknown';
      const timestampKind = typeof truck.timestamp_kind === 'string' ? truck.timestamp_kind : 'unknown';
      const trustedTimestamp = source === 'ntpc-primary' && timestampKind === 'gps'
        ? parseNtpcTime(truck.source_timestamp || truck.time)
        : null;
      const sample = {
        routeId: String(truck.route_id),
        carId: truck.car_id,
        lat: truck.lat,
        lng: truck.lng,
        sampledAt: trustedTimestamp?.toISOString() || null,
        observedAt: observationNow.toISOString(),
        source,
        timestampKind,
        rawSourceTimestamp: truck.source_timestamp ?? null,
        rawTime: truck.time ?? null,
        wasteType: truck.waste_type,
        reportedSpeed: Number.isFinite(truck.speed) ? truck.speed : null,
        ...(conflictingSamples.has(identity) ? {
          batchConflict: true,
          conflictingObservations: conflictingSamples.get(identity),
        } : {}),
      };

      for (const stop of protectedStops) {
        const vehicleStopKey = JSON.stringify([truck.route_id, truck.car_id, stop.id]);
        const identity = approachIdentity(truck);
        latestProtectedSamples.set(vehicleStopKey, identity);
        const decision = await observeCollectionApproach({
          sample,
          stop,
          predecessor: findPredecessor(stop),
          dateStr: taiwanNowInfo?.dateStr,
          store: options.collectionApproachStore,
          nowMs: observationNow.getTime(),
        });
        approachResults.set(JSON.stringify([identity, stop.id]), decision.status);
      }
    }
  }

  // 3.8 更新車輛移動時速與方向特徵 (委派給 arrivalMatcher 的 updateTruckTelemetry)
  updateTruckTelemetry(truckData);

  // 4. Keep ordinary stops on the legacy telemetry path. Protected-stop geometry
  // uses the untouched sample so legacy motion fields cannot authorize arrival.
  const ordinaryArrivals = findNearbyTruckArrivals(
    truckData,
    otherStops,
    stopSubscribersMap,
    activeRoutesMap,
    routeTrustedLinidsMap,
    taiwanNowInfo,
    allRouteStops
  );
  const protectedGeometrySamples = [...new Map(rawTruckData.map((truck) => [approachIdentity(truck), truck])).values()]
    .map((rawTruck) => {
      const { speed, prev_lat, prev_lng, is_southbound, ...geometryTruck } = rawTruck;
      protectedGeometryIdentities.set(geometryTruck, approachIdentity(rawTruck));
      return geometryTruck;
    });
  const protectedGeometryArrivals = protectedStops.length > 0
    ? findNearbyTruckArrivals(
        protectedGeometrySamples,
        protectedStops,
        stopSubscribersMap,
        activeRoutesMap,
        routeTrustedLinidsMap,
        taiwanNowInfo,
        allRouteStops
      ).filter(({ truck, stop }) => {
        const identity = protectedGeometryIdentities.get(truck);
        const vehicleStopKey = JSON.stringify([truck.route_id, truck.car_id, stop.id]);
        return latestProtectedSamples.get(vehicleStopKey) === identity &&
          approachResults.get(JSON.stringify([identity, stop.id])) === 'confirmed';
      })
    : [];
  const notifiableArrivals = [...ordinaryArrivals, ...protectedGeometryArrivals];
  const matchedArrivals = notifiableArrivals.length;
  const pendingNotifications = [];

  const weatherCache = new Map();
  const currentMonth = getYearMonth(taiwanNowInfo?.now || new Date());
  const quotaCache = new Map();
  const groupsMap = context.groupsMap || new Map();

  async function getQuotaForChannel(chId) {
    if (quotaCache.has(chId)) return quotaCache.get(chId);
    try {
      const snap = await getQuotaSnapshot(currentMonth, chId);
      quotaCache.set(chId, snap);
      return snap;
    } catch (err) {
      console.warn(`[Core] 取得頻道 ${chId} 配額快照警告: ${err.message}`);
      return null;
    }
  }

  for (const { truck, stop, route, distance, subscribedGroups, shouldNotify } of notifiableArrivals) {
    console.log(
      `[Core] 🎯 官方 linid ${truck.route_id} 的車輛 (${truck.car_id || '未知車號'}) 進入站點「${stop.name || stop.id}」半徑內 (距離: ${Math.round(distance)}m)`
    );

    // 背景非同步記錄 route_linids，不阻塞到站推播主路徑
    const isStrictLinidCity = route.city === '新北市';
    if (!isStrictLinidCity || String(truck.route_id) === String(route.id)) {
      supabase
        .rpc('observe_route_linid', {
          p_route_id: String(route.id),
          p_linid: String(truck.route_id),
        })
        .then(({ error: observeErr }) => {
          if (observeErr) {
            console.error(`[Core] 寫入 route_linids 失敗: ${observeErr.message}`);
          }
        })
        .catch((err) => {
          console.error(`[Core] 呼叫 observe_route_linid 例外: ${err.message}`);
        });
    }

    if (!shouldNotify) {
      console.log(`[Core] 🚧 車輛 ${truck.route_id} 非路線 ${route.id} 的信任常客，忽略發送以防干擾。`);
      continue;
    }

    let weatherDesc = '';
    if (!weatherCache.has(stop.id)) {
      const wRes = await checkUpcomingRain(stop.lat, stop.lng);
      weatherCache.set(stop.id, formatArrivalWeatherSummary(wRes));
    }
    weatherDesc = weatherCache.get(stop.id);

    for (const groupId of subscribedGroups) {
      const groupRecord = groupsMap.get(groupId);
      const memberCount = groupRecord?.member_count || context.groupMemberCountMap?.get(groupId) || 1;
      const targetChannel = resolveChannelForIntent({
        groupId,
        channelId: groupRecord?.channel_id,
        city: route.city,
        routeId: route.id,
        stopName: stop.name,
      });
      const channelQuotaInfo = await getQuotaForChannel(targetChannel);
      const groupQuota = channelQuotaInfo
        ? {
            ...channelQuotaInfo,
            memberCount,
          }
        : null;

      const msgText = formatArrivalMessage({
        routeName: route.name || `路線 ${route.id}`,
        stopName: stop.name || `站點 ${stop.id}`,
        distance,
        carId: truck.car_id,
        weatherDesc,
        stopLat: stop.lat,
        stopLng: stop.lng,
        quotaInfo: groupQuota,
      });

      pendingNotifications.push({
        groupId,
        routeId: route.id,
        stopId: stop.id,
        city: route.city,
        stopName: stop.name,
        carId: truck.car_id,
        memberCount,
        msgText,
      });
    }
  }

  if (pendingNotifications.length === 0) {
    return {
      ok: true,
      matchedArrivals,
      sentNotifications: 0,
      closestTrucks,
      reason: 'no-pending-notifications',
    };
  }

  // 5. 原子調度與批次發送通知
  const notificationIntents = pendingNotifications.map((item) => ({
    groupId: item.groupId,
    routeId: item.routeId,
    stopId: item.stopId,
    city: item.city,
    stopName: item.stopName,
    carId: item.carId,
    memberCount: item.memberCount,
    messageText: item.msgText,
    memberCount: item.memberCount,
  }));

  const dispatchBatch = options.dispatchNotificationBatch || dispatchNotificationBatch;
  const batchResult = await dispatchBatch(notificationIntents);

  if (batchResult.total > 0 && batchResult.suppressed === batchResult.total) {
    console.log('[Core] 所有觸發推播皆處於 30 分鐘冷卻期內，略過發送。');
    return {
      ok: true,
      matchedArrivals,
      sentNotifications: 0,
      closestTrucks,
      reason: 'all-in-cooldown',
    };
  }

  const sentNotifications = batchResult.sent;
  const failedNotifications = batchResult.failed;
  const lineErrors = batchResult.errors;

  if (failedNotifications > 0 && taiwanNowInfo?.dateStr) {
    const errorMsg = `LINE推播失敗 (${failedNotifications}件): ${lineErrors.map((e) => `[${e.groupId}] HTTP ${e.status}: ${e.error || '未知'}`).join('; ')}`;
    await supabase
      .from('daily_status')
      .update({
        last_api_error: errorMsg,
        updated_at: new Date().toISOString(),
      })
      .eq('date', taiwanNowInfo.dateStr);
  }

  console.log(
    `[Core] 完成檢核：比對出 ${matchedArrivals} 次站點抵達，成功發送 ${sentNotifications} 則推播通知，失敗 ${failedNotifications} 則。`
  );

  return {
    ok: true,
    matchedArrivals,
    sentNotifications,
    failedNotifications,
    lineErrors,
    closestTrucks,
    reason: 'completed',
  };
}

/**
 * 執行端到端垃圾車追蹤與推播排程循環
 * @param {object} params
 * @param {{ now: Date, hour: number, minute: number, dateStr: string }} params.taiwanNowInfo
 * @param {string[]} [params.suspendedCities]
 * @param {boolean} [params.forceRun]
 * @returns {Promise<object>}
 */
export async function executeTruckTrackingCycle({ taiwanNowInfo, suspendedCities = [], forceRun = false }) {
  // 背景非同步同步 LINE 官方用量（非阻塞，不影響追蹤主流程）
  const currentMonth = getYearMonth(taiwanNowInfo?.now || new Date());
  syncLineConsumption(currentMonth).catch((err) => {
    console.warn(`[Quota] 背景同步 LINE 官方額度失敗: ${err.message}`);
  });

  const subContext = await getActiveSubscriptionContext(taiwanNowInfo, suspendedCities, {
    bypassWindow: forceRun,
    bypassSleep: forceRun,
  });
  if (!subContext.ok) {
    return {
      ok: false,
      skipped: true,
      reason: subContext.reason || 'db-context-error',
      error: subContext.error,
    };
  }

  if (!subContext.hasActiveSubscriptions) {
    return {
      ok: true,
      skipped: true,
      reason: subContext.reason || 'no-active-subscriptions',
      sleepingStops: subContext.sleepingStops || [],
      outOfWindowStops: subContext.outOfWindowStops || [],
    };
  }

  const dateStr = taiwanNowInfo.dateStr || new Date().toISOString().slice(0, 10);
  const requiredNtpcRouteIds = [...new Set(subContext.stops
    .filter((stop) => resolveRouteCity(subContext.activeRoutesMap.get(String(stop.route_id))) === '新北市')
    .map((stop) => String(stop.route_id)))];
  const { hour, minute } = taiwanNowInfo;
  const validClock = Number.isInteger(hour) && hour >= 0 && hour <= 23 && Number.isInteger(minute) && minute >= 0 && minute <= 59;
  const rawDateStr = taiwanNowInfo.dateStr;
  const intakeNow = validClock && typeof rawDateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawDateStr)
    ? parseNtpcTime(`${rawDateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`)
    : null;
  const trucksRes = await fetchTrucksWithRetry(dateStr, undefined, subContext.activeCities, {
    requiredNtpcRouteIds,
    now: intakeNow || new Date(),
  });
  if (!trucksRes.ok) {
    return {
      ok: false,
      skipped: true,
      reason: trucksRes.paused ? 'api-retry-paused' : 'api-fetch-failed',
      retryCount: trucksRes.retryCount,
      error: trucksRes.error,
      sourceStats: trucksRes.sourceStats || [],
    };
  }

  const processResult = await processTruckArrivals(trucksRes.data, taiwanNowInfo, suspendedCities, subContext);
  return {
    ok: processResult.ok,
    skipped: false,
    recordsCount: trucksRes.data.length,
    targetCities: subContext.activeCities,
    sourceStats: trucksRes.sourceStats || [],
    partialErrors: trucksRes.errors || [],
    matchedArrivals: processResult.matchedArrivals,
    sentNotifications: processResult.sentNotifications,
    failedNotifications: processResult.failedNotifications || 0,
    lineErrors: processResult.lineErrors || [],
    closestTrucks: processResult.closestTrucks || [],
    reason: processResult.reason || 'processed-successfully',
  };
}
