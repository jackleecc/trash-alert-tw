/**
 * lib/coreProcessor.js
 * 垃圾車追蹤與到站推播核心運算引擎 (Core Processor)
 *
 * 核心流程：
 *   1. 驗證當月 LINE 額度狀態（195 則熔斷機制）。
 *   2. 根據當日星期，過濾有效營運的清運路線 (routes.active_days)。
 *   3. 載入對應站點 (stops) 與群組訂閱關聯 (subscriptions)。
 *   4. 透過 Geofencing 計算車輛與站點間距離 (預設 <= 250 公尺)。
 *   5. 執行 30 分鐘冷卻檢核 (notification_logs)，阻斷重複推播。
 *   6. 發送 LINE 推播訊息並寫入日誌與配額計數。
 */

import { supabase } from './supabaseClient.js';
import { calculateDistanceMeters } from './geoUtils.js';
import { getYearMonth, releaseQuotaReservation, reserveQuota } from './quotaService.js';
import { claimNotification, releaseNotificationClaim } from './cooldownService.js';
import { sendLinePushMessage } from './lineClient.js';

const GEOFENCE_RADIUS_METERS = 250; // 200~300 公尺觸發半徑

/**
 * 將 JavaScript 的 getUTCDay (0-6, 0=Sun) 轉換為 ISO 星期格式 (1=Mon, ..., 7=Sun)
 * @param {Date} date
 * @returns {number} 1~7
 */
export function getIsoDayOfWeek(date) {
  const day = date.getUTCDay();
  return day === 0 ? 7 : day;
}

/**
 * 格式化垃圾車即將抵達的 LINE 推播文字訊息
 * @param {object} params
 * @param {string} params.routeName
 * @param {string} params.stopName
 * @param {number} params.distance
 * @param {string} [params.carId]
 * @returns {string}
 */
export function formatArrivalMessage({ routeName, stopName, distance, carId }) {
  return [
    `🚛【垃圾車即將抵達提醒】`,
    `📍 站點：${stopName}`,
    `🛣️ 路線：${routeName}`,
    `📏 當前距離：約 ${Math.round(distance)} 公尺`,
    `⏰ 預估抵達：約 2～5 分鐘內`,
    `🏷️ 車號：${carId || '執勤車輛'}`,
    ``,
    `請準備好垃圾袋前往站點等候！`,
  ].join('\n');
}

/**
 * 將官方即時車輛與已訂閱站點比對。路線歸屬以站點的本地 route_id 為準，
 * 不要求官方 linid 預先存在於 routes 資料表。
 *
 * @param {Array<{ route_id: string, lat: number, lng: number, car_id?: string }>} truckData
 * @param {Array<{ id: number, route_id: string, name: string, lat: number, lng: number }>} stops
 * @param {Map<string, Set<string>>} stopSubscribersMap
 * @param {Map<string, { id: string, name: string }>} activeRoutesMap
 * @returns {Array<{ truck: object, stop: object, route: object, distance: number, subscribedGroups: Set<string> }>}
 */
export function findNearbyTruckArrivals(
  truckData,
  stops,
  stopSubscribersMap,
  activeRoutesMap
) {
  const arrivals = [];

  for (const truck of truckData) {
    for (const stop of stops || []) {
      const route = activeRoutesMap.get(String(stop.route_id));
      const subscribedGroups = stopSubscribersMap.get(String(stop.id));
      if (!route || !subscribedGroups || subscribedGroups.size === 0) continue;

      const distance = calculateDistanceMeters(
        truck.lat,
        truck.lng,
        stop.lat,
        stop.lng
      );

      if (distance <= GEOFENCE_RADIUS_METERS) {
        arrivals.push({ truck, stop, route, distance, subscribedGroups });
      }
    }
  }

  return arrivals;
}

/**
 * 執行即時車輛位置與訂閱站點的比對運算與推播處理
 *
 * @param {Array<{ route_id: string, lat: number, lng: number, car_id?: string, time?: string }>} truckData
 * @param {{ now: Date, hour: number, minute: number, dateStr: string }} taiwanNowInfo
 * @returns {Promise<{ ok: boolean, matchedArrivals: number, sentNotifications: number, reason?: string }>}
 */
export async function processTruckArrivals(truckData, taiwanNowInfo) {
  if (!truckData || truckData.length === 0) {
    return { ok: true, matchedArrivals: 0, sentNotifications: 0, reason: 'no-truck-data' };
  }

  const yearMonth = getYearMonth(taiwanNowInfo.now);

  // 1. 取得今日星期 (1~7)
  const todayIsoDay = getIsoDayOfWeek(taiwanNowInfo.now);

  // 2. 查詢所有啟用路線
  const { data: routes, error: routeErr } = await supabase
    .from('routes')
    .select('id, name, active_days')
    .eq('is_active', true);

  if (routeErr) {
    console.error(`[Core] 查詢 routes 失敗: ${routeErr.message}`);
    return { ok: false, matchedArrivals: 0, sentNotifications: 0, reason: 'db-route-error' };
  }

  if (!routes || routes.length === 0) {
    return { ok: true, matchedArrivals: 0, sentNotifications: 0, reason: 'no-active-routes' };
  }

  // 過濾今日有營運的路線
  const activeRoutesMap = new Map();
  for (const r of routes) {
    const days = Array.isArray(r.active_days) ? r.active_days : [];
    if (days.includes(todayIsoDay)) {
      activeRoutesMap.set(String(r.id), r);
    }
  }

  const activeRouteIds = Array.from(activeRoutesMap.keys());
  if (activeRouteIds.length === 0) {
    console.log(`[Core] 今日 (星期 ${todayIsoDay}) 無排定營運的清運路線。`);
    return { ok: true, matchedArrivals: 0, sentNotifications: 0, reason: 'no-routes-today' };
  }

  // 3. 僅查詢今日啟用路線的站點與訂閱關聯 (避免全表掃描)
  const { data: stops, error: stopErr } = await supabase
    .from('stops')
    .select('id, route_id, name, lat, lng, order_index')
    .in('route_id', activeRouteIds);

  if (stopErr) {
    console.error(`[Core] 查詢 stops 失敗: ${stopErr.message}`);
    return { ok: false, matchedArrivals: 0, sentNotifications: 0, reason: 'db-stop-error' };
  }

  const { data: groups, error: groupErr } = await supabase
    .from('line_groups')
    .select('group_id')
    .eq('is_active', true);

  if (groupErr) {
    console.error(`[Core] 查詢 line_groups 失敗: ${groupErr.message}`);
    return { ok: false, matchedArrivals: 0, sentNotifications: 0, reason: 'db-group-error' };
  }

  const activeGroupIds = (groups || []).map((group) => group.group_id);
  if (activeGroupIds.length === 0) {
    return { ok: true, matchedArrivals: 0, sentNotifications: 0, reason: 'no-active-groups' };
  }

  const { data: subscriptions, error: subErr } = await supabase
    .from('subscriptions')
    .select('group_id, stop_id')
    .in('group_id', activeGroupIds);

  if (subErr) {
    console.error(`[Core] 查詢 subscriptions 失敗: ${subErr.message}`);
    return { ok: false, matchedArrivals: 0, sentNotifications: 0, reason: 'db-sub-error' };
  }

  // 整理 stopId -> group_ids 的對應
  const stopSubscribersMap = new Map();
  for (const sub of subscriptions || []) {
    const stopIdStr = String(sub.stop_id);
    if (!stopSubscribersMap.has(stopIdStr)) {
      stopSubscribersMap.set(stopIdStr, new Set());
    }
    stopSubscribersMap.get(stopIdStr).add(sub.group_id);
  }

  // 4. 比對官方車輛與已訂閱站點；不預設官方 linid 等於本地 route_id。
  const nearbyArrivals = findNearbyTruckArrivals(
    truckData,
    stops,
    stopSubscribersMap,
    activeRoutesMap
  );
  const matchedArrivals = nearbyArrivals.length;
  const pendingNotifications = [];

  for (const { truck, stop, route, distance, subscribedGroups } of nearbyArrivals) {
    console.log(
      `[Core] 🎯 官方 linid ${truck.route_id} 的車輛 (${truck.car_id || '未知車號'}) 進入站點「${stop.name || stop.id}」半徑內 (距離: ${Math.round(distance)}m)`
    );

    const { error: observeErr } = await supabase.rpc('observe_route_linid', {
      p_route_id: String(route.id),
      p_linid: String(truck.route_id),
    });
    if (observeErr) {
      console.error(`[Core] 寫入 route_linids 失敗: ${observeErr.message}`);
    }

    const msgText = formatArrivalMessage({
      routeName: route.name || `路線 ${route.id}`,
      stopName: stop.name || `站點 ${stop.id}`,
      distance,
      carId: truck.car_id,
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
      reason: 'no-pending-notifications',
    };
  }

  // 5. 原子取得通知權，避免重疊 Cron 在冷卻檢核後重複發送。
  const claimedNotifications = await Promise.all(
    pendingNotifications.map(async (item) => {
      const notificationLogId = await claimNotification(
        item.groupId,
        item.routeId,
        item.stopId,
        item.carId
      );
      return notificationLogId === null ? null : { ...item, notificationLogId };
    })
  );

  const notificationsToSend = claimedNotifications.filter(Boolean);

  if (notificationsToSend.length === 0) {
    console.log('[Core] 所有觸發推播皆處於 30 分鐘冷卻期內，略過發送。');
    return {
      ok: true,
      matchedArrivals,
      sentNotifications: 0,
      reason: 'all-in-cooldown',
    };
  }

  // 6. 原子保留額度後發送；失敗時釋放額度與通知權。
  const sendResults = await Promise.allSettled(
    notificationsToSend.map(async (item) => {
      const quotaReservation = await reserveQuota(yearMonth);
      if (!quotaReservation.reserved) {
        await releaseNotificationClaim(item.notificationLogId);
        return false;
      }

      console.log(`[Core] 📤 發送到站通知至群組 ${item.groupId}...`);
      const sendRes = await sendLinePushMessage(item.groupId, item.msgText);
      if (sendRes.ok) {
        return true;
      }

      await Promise.all([
        releaseNotificationClaim(item.notificationLogId),
        releaseQuotaReservation(yearMonth),
      ]);
      return false;
    })
  );

  const sentNotifications = sendResults.filter(
    (r) => r.status === 'fulfilled' && r.value === true
  ).length;

  console.log(
    `[Core] 完成檢核：比對出 ${matchedArrivals} 次站點抵達，成功發送 ${sentNotifications} 則推播通知。`
  );

  return {
    ok: true,
    matchedArrivals,
    sentNotifications,
    reason: 'completed',
  };
}
