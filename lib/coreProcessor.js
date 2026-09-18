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
  providedContext = null
) {
  if (!truckData || truckData.length === 0) {
    return { ok: true, matchedArrivals: 0, sentNotifications: 0, closestTrucks: [], reason: 'no-truck-data' };
  }

  const context = providedContext || (await getActiveSubscriptionContext(taiwanNowInfo, suspendedCities));
  if (!context.ok) {
    return { ok: false, matchedArrivals: 0, sentNotifications: 0, closestTrucks: [], reason: context.reason };
  }

  const { activeRoutesMap, stops, stopSubscribersMap, allRouteStops } = context;
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

  // 3.8 更新車輛移動時速與方向特徵 (委派給 arrivalMatcher 的 updateTruckTelemetry)
  updateTruckTelemetry(truckData);

  // 4. 比對官方車輛與已訂閱站點
  const nearbyArrivals = findNearbyTruckArrivals(
    truckData,
    stops,
    stopSubscribersMap,
    activeRoutesMap,
    routeTrustedLinidsMap,
    taiwanNowInfo,
    allRouteStops
  );
  const matchedArrivals = nearbyArrivals.length;
  const pendingNotifications = [];

  const weatherCache = new Map();
  const currentMonth = getYearMonth(taiwanNowInfo?.now || new Date());
  let quotaInfo = null;
  try {
    quotaInfo = await getQuotaSnapshot(currentMonth);
  } catch (err) {
    console.warn(`[Core] 取得配額快照警告: ${err.message}`);
  }

  for (const { truck, stop, route, distance, subscribedGroups, shouldNotify } of nearbyArrivals) {
    console.log(
      `[Core] 🎯 官方 linid ${truck.route_id} 的車輛 (${truck.car_id || '未知車號'}) 進入站點「${stop.name || stop.id}」半徑內 (距離: ${Math.round(distance)}m)`
    );

    // 背景非同步記錄 route_linids，不阻塞到站推播主路徑
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

    const msgText = formatArrivalMessage({
      routeName: route.name || `路線 ${route.id}`,
      stopName: stop.name || `站點 ${stop.id}`,
      distance,
      carId: truck.car_id,
      weatherDesc,
      stopLat: stop.lat,
      stopLng: stop.lng,
      quotaInfo,
    });

    for (const groupId of subscribedGroups) {
      pendingNotifications.push({
        groupId,
        routeId: route.id,
        stopId: stop.id,
        carId: truck.car_id,
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
    carId: item.carId,
    messageText: item.msgText,
  }));

  const batchResult = await dispatchNotificationBatch(notificationIntents);

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
  const trucksRes = await fetchTrucksWithRetry(dateStr, undefined, subContext.activeCities);
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
