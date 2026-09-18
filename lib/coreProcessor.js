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
import {
  calculateDistanceMeters,
  computeAdaptiveRadius,
  calculateSpeedKmh,
  deriveOfficialApproachBearing,
  isMovingTowardsApproach,
  resolveRouteCity,
} from './geoUtils.js';
import { getYearMonth, releaseQuotaReservation, reserveQuota } from './quotaService.js';

import { claimNotification, releaseNotificationClaim } from './cooldownService.js';
import { sendLinePushMessage } from './lineClient.js';
import { checkUpcomingRain } from './weatherApi.js';

const GEOFENCE_RADIUS_METERS = 250; // 預設最大上限

// 車輛前次位置與時間戳記快取 (供計算移動時速與行車方向)
export const recentTruckHistory = new Map();

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
export function formatArrivalMessage({
  routeName,
  stopName,
  distance,
  carId,
  weatherDesc,
  stopLat,
  stopLng,
}) {
  const lines = [
    `🚛【垃圾車即將抵達提醒】`,
    `📍 站點：${stopName}`,
    `🛣️ 路線：${routeName}`,
    `📏 當前距離：約 ${Math.round(distance)} 公尺`,
    `⏰ 預估抵達：約 2～5 分鐘內`,
    `🏷️ 車號：${carId || '執勤車輛'}`,
  ];

  if (stopLat !== undefined && stopLng !== undefined) {
    lines.push(`🗺️ 站點地圖：https://www.google.com/maps/search/?api=1&query=${stopLat},${stopLng}`);
  }

  lines.push(``);

  if (weatherDesc) {
    lines.push(`💡【環境提醒】`);
    lines.push(weatherDesc);
    lines.push(``);
  }

  lines.push(`請準備好垃圾袋前往站點等候！`);
  return lines.join('\n');
}

/**
 * 判斷當前台灣時間是否在站點的表定清運時間窗內。
 * @param {string | null | undefined} scheduleTimeStr - 表定時間字串，例如 '19:56:00' 或 '19:56'
 * @param {{ hour: number, minute: number } | Date | null | undefined} twNow - 台灣時間
 * @param {number} [beforeMinutes=15] - 提前分鐘數（預設 15 分鐘，防出庫路過誤觸並包容清潔隊大幅早到）
 * @param {number} [afterMinutes=40] - 延後分鐘數（預設 40 分鐘，容納天候路況誤點）
 * @returns {boolean} 若未設定表定時間則預設為 true（向後相容）
 */
export function isWithinScheduleWindow(
  scheduleTimeStr,
  twNow,
  beforeMinutes = 15,
  afterMinutes = 40
) {
  if (!scheduleTimeStr || typeof scheduleTimeStr !== 'string') {
    return true; // 未填寫表定時間者，不予限制
  }
  if (!twNow) {
    return true;
  }

  let currentHour = 0;
  let currentMinute = 0;
  if (twNow instanceof Date) {
    currentHour = twNow.getUTCHours();
    currentMinute = twNow.getUTCMinutes();
  } else if (typeof twNow === 'object' && twNow.hour !== undefined && twNow.minute !== undefined) {
    currentHour = Number(twNow.hour);
    currentMinute = Number(twNow.minute);
  } else {
    return true;
  }

  const parts = scheduleTimeStr.trim().split(':');
  if (parts.length < 2) return true;

  const schedHour = parseInt(parts[0], 10);
  const schedMinute = parseInt(parts[1], 10);
  if (isNaN(schedHour) || isNaN(schedMinute)) return true;

  const schedTotalMinutes = schedHour * 60 + schedMinute;
  const currentTotalMinutes = currentHour * 60 + currentMinute;

  let diff = currentTotalMinutes - schedTotalMinutes;
  // 跨午夜邊界修正（例如 23:55 與 00:05）：若差值超過半天 (720 分鐘)，取最短環形距離
  if (diff > 720) diff -= 1440;
  if (diff < -720) diff += 1440;

  return diff >= -beforeMinutes && diff <= afterMinutes;
}

/**
 * 將官方即時車輛與已訂閱站點比對。路線歸屬以站點的本地 route_id 為準，
 * 不要求官方 linid 預先存在於 routes 資料表。
 *
 * 具備四大防誤判核心特徵：
 *   1. 自適應圍欄半徑 (Adaptive Geofencing)：密集巷弄自動收縮至 120m。
 *   2. 表定時間窗限制 (Schedule Window)：表定前 10 分鐘至後 40 分鐘。
 *   3. 時速過濾 (Speed Threshold)：時速 > 25 km/h 判定為巡航路過排除。
 *   4. 進場方向走廊 (Approach Direction)：支援驗證車輛南下/北上收運正線。
 *
 * @param {Array<{ route_id: string, lat: number, lng: number, car_id?: string, waste_type?: string, speed?: number, is_southbound?: boolean }>} truckData
 * @param {Array<{ id: number, route_id: string, name: string, lat: number, lng: number, schedule_time?: string, radius_meters?: number, approach_direction?: string }>} stops
 * @param {Map<string, Set<string>>} stopSubscribersMap
 * @param {Map<string, { id: string, name: string }>} activeRoutesMap
 * @param {Map<string, Set<string>>} [routeTrustedLinidsMap]
 * @param {object} [twNowInfo] - 台灣時間物件
 * @returns {Array<{ truck: object, stop: object, route: object, distance: number, subscribedGroups: Set<string>, shouldNotify: boolean }>}
 */
export function findNearbyTruckArrivals(
  truckData,
  stops,
  stopSubscribersMap,
  activeRoutesMap,
  routeTrustedLinidsMap = new Map(),
  twNowInfo = null,
  allRouteStops = null
) {
  const arrivals = [];

  for (const truck of truckData || []) {
    // 排除非目標車輛：若明確標註為回收車/資收車/廚餘車，則略過
    if (truck.waste_type === 'recycling') {
      continue;
    }

    for (const stop of stops || []) {
      const route = activeRoutesMap.get(String(stop.route_id));
      const subscribedGroups = stopSubscribersMap.get(String(stop.id));
      if (!route || !subscribedGroups || subscribedGroups.size === 0) continue;

      // 1. 班表時間窗過濾：若該站點有表定時間，且當前時間不在清運時間窗內，則略過
      if (twNowInfo && !isWithinScheduleWindow(stop.schedule_time, twNowInfo)) {
        continue;
      }

      // 2. 自適應地理圍欄半徑：若站點有自訂 radius_meters 優先使用，否則依同路線站距動態自適應計算
      // 優先使用完整路線站點池 (allRouteStops)，確保單一站點訂閱時仍可保有相鄰站距拓撲
      const candidateRouteStops = allRouteStops || stops;
      const routeStops = (candidateRouteStops || []).filter(
        (s) => String(s.route_id) === String(stop.route_id)
      );
      const effectiveRadius =
        stop.radius_meters || computeAdaptiveRadius(stop, routeStops);

      const distance = calculateDistanceMeters(
        truck.lat,
        truck.lng,
        stop.lat,
        stop.lng
      );

      if (distance <= effectiveRadius) {
        // 3. 時速過濾判定：若已測得即時時速，且時速大於收運閥值 (25 km/h)，判定為巡航路過，略過通知
        if (typeof truck.speed === 'number' && truck.speed > 25) {
          console.log(
            `[Core] 🚧 車輛 ${truck.car_id || truck.route_id} 時速達 ${truck.speed} km/h (高於 25 km/h)，判定為巡航路過，略過通知。`
          );
          continue;
        }

        // 4. 360° 全自動路線進場方位角檢驗 (全解 5 大邊際條件：靜止漂移豁免、彎道寬容、首站豁免、長時差調度豁免、短站距基線)
        const officialBearing =
          typeof stop.approach_bearing === 'number'
            ? stop.approach_bearing
            : (stop.approach_direction === 'southbound'
                ? 180
                : stop.approach_direction === 'northbound'
                  ? 0
                  : stop.approach_direction === 'eastbound'
                    ? 90
                    : stop.approach_direction === 'westbound'
                      ? 270
                      : deriveOfficialApproachBearing(stop, routeStops));

        if (!isMovingTowardsApproach(truck, officialBearing)) {
          console.log(
            `[Core] 🚧 車輛 ${truck.car_id || truck.route_id} 行駛方向與進場方位角 (${Math.round(officialBearing)}°) 逆向相反，判定為出庫/調度車，略過通知。`
          );
          continue;
        }

        const trustedLinids = routeTrustedLinidsMap.get(String(route.id));
        // 支援路線代碼 (route_id) 或執勤車牌 (car_id) 雙向比對，相容管理員手動維護車牌記錄
        const isTrusted =
          trustedLinids &&
          (trustedLinids.has(String(truck.route_id)) ||
            (truck.car_id && trustedLinids.has(String(truck.car_id))));
        const hasAnyTrusted = trustedLinids && trustedLinids.size > 0;

        // 若該路線已有信任清單，且本車不在清單內，則不發送通知 (但仍回傳供背景觀測)
        const shouldNotify = !hasAnyTrusted || isTrusted;

        arrivals.push({ truck, stop, route, distance, subscribedGroups, shouldNotify });
      }
    }
  }

  return arrivals;
}

/**
 * 解析路線所屬縣市。重新導出自 geoUtils.js，維持向後相容。
 */
export { resolveRouteCity } from './geoUtils.js';

/**
 * 計算各已訂閱站點的最近車輛分析 (供 Debug Log 與排查使用)
 * @param {Array<object>} truckData
 * @param {Array<object>} stops
 * @param {Map<string, Set<string>>} stopSubscribersMap
 * @param {Map<string, object>} activeRoutesMap
 * @returns {Array<object>}
 */
export function computeClosestTrucks(truckData, stops, stopSubscribersMap, activeRoutesMap) {
  const closestList = [];

  for (const stop of stops || []) {
    const subscribedGroups = stopSubscribersMap.get(String(stop.id));
    if (!subscribedGroups || subscribedGroups.size === 0) continue;

    const route = activeRoutesMap.get(String(stop.route_id));
    const sameRouteTrucks = (truckData || []).filter(
      (t) => String(t.route_id) === String(stop.route_id)
    );
    const candidateTrucks = sameRouteTrucks.length > 0 ? sameRouteTrucks : (truckData || []);

    let closest = null;
    let minDistance = Infinity;

    for (const truck of candidateTrucks) {
      const dist = calculateDistanceMeters(truck.lat, truck.lng, stop.lat, stop.lng);
      if (dist < minDistance) {
        minDistance = dist;
        closest = {
          carId: truck.car_id || 'unknown',
          routeId: truck.route_id,
          distanceMeters: Math.round(dist),
          lat: truck.lat,
          lng: truck.lng,
          isTargetRoute: String(truck.route_id) === String(stop.route_id),
        };
      }
    }

    closestList.push({
      stopId: stop.id,
      stopName: stop.name,
      routeId: stop.route_id,
      routeName: route?.name || `路線 ${stop.route_id}`,
      targetRouteTrucksCount: sameRouteTrucks.length,
      closestTruck: closest,
    });
  }

  return closestList;
}

/**
 * 查詢今日啟用的路線、站點、群組訂閱與有活躍訂閱的縣市清單 (Smart Context)
 *
 * @param {{ now: Date, hour: number, minute: number, dateStr: string }} taiwanNowInfo
 * @param {string[]} [suspendedCities]
 * @returns {Promise<{
 *   ok: boolean,
 *   todayIsoDay: number,
 *   activeRoutesMap: Map<string, object>,
 *   stops: Array<object>,
 *   stopSubscribersMap: Map<string, Set<string>>,
 *   activeCities: string[],
 *   hasActiveSubscriptions: boolean,
 *   reason?: string,
 *   error?: string
 * }>}
 */
export async function getActiveSubscriptionContext(
  taiwanNowInfo,
  suspendedCities = [],
  options = {}
) {
  const todayIsoDay = getIsoDayOfWeek(taiwanNowInfo.now);

  // 1. 查詢所有啟用路線
  const { data: routes, error: routeErr } = await supabase
    .from('routes')
    .select('*')
    .eq('is_active', true);

  if (routeErr) {
    console.error(`[Core] 查詢 routes 失敗: ${routeErr.message}`);
    return { ok: false, error: routeErr.message, reason: 'db-route-error', hasActiveSubscriptions: false };
  }

  if (!routes || routes.length === 0) {
    return { ok: true, todayIsoDay, activeRoutesMap: new Map(), stops: [], stopSubscribersMap: new Map(), activeCities: [], hasActiveSubscriptions: false, reason: 'no-active-routes' };
  }

  // 過濾今日有營運的路線，並排除停班停課縣市的路線
  const activeRoutesMap = new Map();
  for (const r of routes) {
    const days = Array.isArray(r.active_days) ? r.active_days : [];
    if (!days.includes(todayIsoDay)) continue;

    const city = resolveRouteCity(r);
    if (city && suspendedCities.includes(city)) {
      console.log(`[Core] 路線 [${r.id}] ${r.name} 因 ${city} 天災停收，今日略過。`);
      continue;
    }

    activeRoutesMap.set(String(r.id), r);
  }

  const activeRouteIds = Array.from(activeRoutesMap.keys());
  if (activeRouteIds.length === 0) {
    return { ok: true, todayIsoDay, activeRoutesMap, stops: [], stopSubscribersMap: new Map(), activeCities: [], hasActiveSubscriptions: false, reason: 'no-routes-today' };
  }

  // 2. 僅查詢今日啟用路線的站點
  const { data: stops, error: stopErr } = await supabase
    .from('stops')
    .select('id, route_id, name, lat, lng, order_index, schedule_time')
    .in('route_id', activeRouteIds);

  if (stopErr) {
    console.error(`[Core] 查詢 stops 失敗: ${stopErr.message}`);
    return { ok: false, error: stopErr.message, reason: 'db-stop-error', hasActiveSubscriptions: false };
  }

  // 3. 查詢啟用群組
  const { data: groups, error: groupErr } = await supabase
    .from('line_groups')
    .select('group_id')
    .eq('is_active', true);

  if (groupErr) {
    console.error(`[Core] 查詢 line_groups 失敗: ${groupErr.message}`);
    return { ok: false, error: groupErr.message, reason: 'db-group-error', hasActiveSubscriptions: false };
  }

  const activeGroupIds = (groups || []).map((group) => group.group_id);
  if (activeGroupIds.length === 0) {
    return { ok: true, todayIsoDay, activeRoutesMap, stops: [], stopSubscribersMap: new Map(), activeCities: [], hasActiveSubscriptions: false, reason: 'no-active-groups' };
  }

  // 4. 查詢活躍訂閱
  const { data: subscriptions, error: subErr } = await supabase
    .from('subscriptions')
    .select('group_id, stop_id')
    .in('group_id', activeGroupIds);

  if (subErr) {
    console.error(`[Core] 查詢 subscriptions 失敗: ${subErr.message}`);
    return { ok: false, error: subErr.message, reason: 'db-sub-error', hasActiveSubscriptions: false };
  }

  // 5. 查詢今日 (台灣時間 00:00:00+08:00 起) 已成功推播之記錄，落實當日推播後深度休眠
  const notifiedGroupStopSet = new Set();
  const dateStr = taiwanNowInfo.dateStr || new Date().toISOString().slice(0, 10);
  const todayStartIso = `${dateStr}T00:00:00+08:00`;

  if (!options.bypassSleep) {
    try {
      const { data: todayLogs, error: logErr } = await supabase
        .from('notification_logs')
        .select('stop_id, group_id, route_id')
        .neq('route_id', 'WEATHER')
        .gte('sent_at', todayStartIso);

      if (logErr) {
        console.warn(`[Core] 查詢 notification_logs 警告: ${logErr.message}`);
      } else if (todayLogs) {
        for (const log of todayLogs) {
          if (log.route_id === 'WEATHER') continue;
          if (log.stop_id && log.group_id) {
            notifiedGroupStopSet.add(`${log.stop_id}:${log.group_id}`);
          }
        }
      }
    } catch (e) {
      console.warn(`[Core] 查詢 notification_logs 例外: ${e.message}`);
    }
  }

  // 整理 stopId -> 尚未通知的 group_ids 的對應
  const stopSubscribersMap = new Map();
  const subscribedStopIds = new Set();

  for (const sub of subscriptions || []) {
    const stopIdStr = String(sub.stop_id);
    subscribedStopIds.add(stopIdStr);
    const subKey = `${sub.stop_id}:${sub.group_id}`;

    // 若該群組在該站點今日已成功推播，進入深度休眠 (排除本次訂閱等待)
    if (notifiedGroupStopSet.has(subKey)) {
      continue;
    }

    if (!stopSubscribersMap.has(stopIdStr)) {
      stopSubscribersMap.set(stopIdStr, new Set());
    }
    stopSubscribersMap.get(stopIdStr).add(sub.group_id);
  }

  // 6. 檢核站點之智慧縮時窗口 (Smart Time Window) 與深度休眠過濾
  const activeStops = [];
  const sleepingStops = [];
  const outOfWindowStops = [];
  const activeCitiesSet = new Set();

  for (const stop of stops || []) {
    const stopIdStr = String(stop.id);
    // 只關注有被群組訂閱的站點
    if (!subscribedStopIds.has(stopIdStr)) {
      continue;
    }

    const remainingSubs = stopSubscribersMap.get(stopIdStr);
    // 若本站已被訂閱，但 remainingSubs 為空，代表今日已全部推播完成 -> 深度休眠
    if (!remainingSubs || remainingSubs.size === 0) {
      sleepingStops.push({
        id: stop.id,
        name: stop.name,
        routeId: stop.route_id,
        scheduleTime: stop.schedule_time,
      });
      continue;
    }

    // 智慧縮時窗口判定：預設表定前 18 分鐘至後 40 分鐘（與 isWithinScheduleWindow 保持一致，包容路況誤點）
    const beforeMins = options.beforeMinutes ?? 18;
    const afterMins = options.afterMinutes ?? 40;
    const inWindow = options.bypassWindow
      ? true
      : isWithinScheduleWindow(stop.schedule_time, taiwanNowInfo, beforeMins, afterMins);

    if (!inWindow) {
      outOfWindowStops.push({
        id: stop.id,
        name: stop.name,
        routeId: stop.route_id,
        scheduleTime: stop.schedule_time,
      });
      continue;
    }

    // 站點既在時間窗內，且今日尚未完成推播 -> 列入即時活躍清單
    activeStops.push(stop);

    const route = activeRoutesMap.get(String(stop.route_id));
    const city = route ? resolveRouteCity(route) : null;
    if (city) {
      if (
        (city === '台南市' || city === '臺南市') &&
        (process.env.SKIP_TAINAN_POLLING === 'true' || process.env.TAINAN_RELAY_MODE === 'phone')
      ) {
        console.log(`[Core] 📱 臺南市已配置為手機通知中繼模式 (SKIP_TAINAN_POLLING)，雲端排程略過主動輪詢天眼系統，以防連線逾時觸發熔斷。`);
      } else {
        activeCitiesSet.add(city);
      }
    }
  }

  const activeCities = Array.from(activeCitiesSet);
  const hasActiveSubscriptions = activeCities.length > 0;

  let reason = undefined;
  if (!hasActiveSubscriptions) {
    if (sleepingStops.length > 0 && outOfWindowStops.length === 0) {
      reason = 'all-subscriptions-sleeping-today';
      console.log(`[Core] 💤 今日所有訂閱站點皆已推播完成，啟動深度休眠 (${sleepingStops.map(s => s.name).join('、')})。`);
    } else if (outOfWindowStops.length > 0 && sleepingStops.length === 0) {
      reason = 'outside-schedule-window';
      console.log(`[Core] ⏳ 目前時間不在任何訂閱站點的智慧縮時窗內 (${outOfWindowStops.map(s => `${s.name}@${s.scheduleTime || '未定'}`).join('、')})，安全略過。`);
    } else if (sleepingStops.length > 0 && outOfWindowStops.length > 0) {
      reason = 'sleeping-or-outside-schedule-window';
      console.log(`[Core] 💤 站點休眠中或尚未進入清運縮時窗，安全略過。`);
    } else {
      reason = 'no-active-subscriptions';
    }
  }

  return {
    ok: true,
    todayIsoDay,
    activeRoutesMap,
    stops: activeStops,
    allRouteStops: stops || [],
    stopSubscribersMap,
    activeCities,
    hasActiveSubscriptions,
    sleepingStops,
    outOfWindowStops,
    reason,
  };
}

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

  const yearMonth = getYearMonth(taiwanNowInfo.now);

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

  // 3.8 更新車輛移動時速與方向特徵 (供 findNearbyTruckArrivals 進行巡航路過過濾)
  for (const truck of truckData || []) {
    const carKey = truck.car_id ? `${truck.route_id}_${truck.car_id}` : truck.route_id;
    const prevRecord = recentTruckHistory.get(carKey);
    if (prevRecord) {
      if (truck.speed === undefined) {
        truck.speed = calculateSpeedKmh(prevRecord, {
          lat: truck.lat,
          lng: truck.lng,
          time: truck.time || Date.now(),
        });
      }
      truck.prev_lat = prevRecord.lat;
      truck.prev_lng = prevRecord.lng;
      if (typeof truck.prev_lat === 'number') {
        truck.is_southbound = truck.lat < truck.prev_lat;
      }
    }
    recentTruckHistory.set(carKey, {
      lat: truck.lat,
      lng: truck.lng,
      time: truck.time || Date.now(),
    });
  }

  // 防止快取無上限增長 (FIX-10)
  if (recentTruckHistory.size > 500) {
    const entries = [...recentTruckHistory.entries()]
      .map(([k, v]) => [k, v, typeof v.time === 'number' ? v.time : new Date(v.time).getTime()])
      .sort((a, b) => b[2] - a[2]);
    recentTruckHistory.clear();
    for (const [k, v] of entries.slice(0, 300)) {
      recentTruckHistory.set(k, v);
    }
  }

  // 4. 比對官方車輛與已訂閱站點，並利用信任名單、完整路線拓撲與班表時間窗過濾路過車輛。
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

  for (const { truck, stop, route, distance, subscribedGroups, shouldNotify } of nearbyArrivals) {
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

    if (!shouldNotify) {
      console.log(`[Core] 🚧 車輛 ${truck.route_id} 非路線 ${route.id} 的信任常客，忽略發送以防干擾。`);
      continue;
    }

    let weatherDesc = '';
    if (!weatherCache.has(stop.id)) {
      const wRes = await checkUpcomingRain(stop.lat, stop.lng);
      weatherCache.set(stop.id, wRes.shouldNotify ? wRes.desc : '');
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
      closestTrucks,
      reason: 'all-in-cooldown',
    };
  }

  const lineErrors = [];

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

      lineErrors.push({
        groupId: item.groupId,
        status: sendRes.status,
        error: sendRes.error,
      });

      console.error(
        `[Core] ❌ 群組 ${item.groupId} 發送失敗 (HTTP ${sendRes.status}): ${sendRes.error}`
      );

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

  const failedNotifications = lineErrors.length;

  // 若有發送失敗，更新至 daily_status 的 last_api_error 以便除錯
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
