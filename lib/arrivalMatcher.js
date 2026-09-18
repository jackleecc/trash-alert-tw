/**
 * lib/arrivalMatcher.js
 * 垃圾車即將抵達比對與純幾何空間運算模組 (Arrival Matcher)
 */

import {
  calculateDistanceMeters,
  computeAdaptiveRadius,
  calculateSpeedKmh,
  deriveOfficialApproachBearing,
  isMovingTowardsApproach,
} from './geoUtils.js';

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
 * @param {number} [beforeMinutes=15] - 提前分鐘數
 * @param {number} [afterMinutes=40] - 延後分鐘數
 * @returns {boolean}
 */
export function isWithinScheduleWindow(
  scheduleTimeStr,
  twNow,
  beforeMinutes = 15,
  afterMinutes = 40
) {
  if (!scheduleTimeStr || typeof scheduleTimeStr !== 'string') {
    return true;
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
  if (diff > 720) diff -= 1440;
  if (diff < -720) diff += 1440;

  return diff >= -beforeMinutes && diff <= afterMinutes;
}

/**
 * 更新車輛遙測紀錄（計算速度、前次坐標、南下標記），並維護快取上限 (<= 500)
 * @param {Array<object>} truckData
 */
export function updateTruckTelemetry(truckData) {
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

  if (recentTruckHistory.size > 500) {
    const entries = [...recentTruckHistory.entries()]
      .map(([k, v]) => [k, v, typeof v.time === 'number' ? v.time : new Date(v.time).getTime()])
      .sort((a, b) => b[2] - a[2]);
    recentTruckHistory.clear();
    for (const [k, v] of entries.slice(0, 300)) {
      recentTruckHistory.set(k, v);
    }
  }
}

/**
 * 將官方即時車輛與已訂閱站點比對。支援傳入單一 SubscriptionContext 物件或傳統多參數。
 * @param {Array<object>} truckData
 * @param {Array<object> | object} stopsOrContext
 * @param {Map<string, Set<string>> | object} [stopSubscribersMap]
 * @param {Map<string, object>} [activeRoutesMap]
 * @param {Map<string, Set<string>>} [routeTrustedLinidsMap]
 * @param {object} [twNowInfo]
 * @param {Array<object>} [allRouteStops]
 * @returns {Array<object>}
 */
export function findNearbyTruckArrivals(
  truckData,
  stopsOrContext,
  stopSubscribersMap,
  activeRoutesMap,
  routeTrustedLinidsMap = new Map(),
  twNowInfo = null,
  allRouteStops = null
) {
  let stops = stopsOrContext;
  let subMap = stopSubscribersMap;
  let routesMap = activeRoutesMap;
  let trustedMap = routeTrustedLinidsMap;
  let nowInfo = twNowInfo;
  let candidateAllStops = allRouteStops;

  // 支援傳入單一 SubscriptionContext 物件 (消除 Data Clumps，同時維持 100% 向後相容)
  if (stopsOrContext && !Array.isArray(stopsOrContext) && typeof stopsOrContext === 'object') {
    stops = stopsOrContext.stops || [];
    subMap = stopsOrContext.stopSubscribersMap || new Map();
    routesMap = stopsOrContext.activeRoutesMap || new Map();
    candidateAllStops = stopsOrContext.allRouteStops || stops;
    if (stopSubscribersMap && typeof stopSubscribersMap === 'object' && !(stopSubscribersMap instanceof Map)) {
      trustedMap = stopSubscribersMap.routeTrustedLinidsMap || new Map();
      nowInfo = stopSubscribersMap.twNowInfo || null;
      if (stopSubscribersMap.allRouteStops) candidateAllStops = stopSubscribersMap.allRouteStops;
    }
  }

  const arrivals = [];

  for (const truck of truckData || []) {
    if (truck.waste_type === 'recycling') {
      continue;
    }

    for (const stop of stops || []) {
      const route = routesMap.get(String(stop.route_id));
      const subscribedGroups = subMap.get(String(stop.id));
      if (!route || !subscribedGroups || subscribedGroups.size === 0) continue;

      if (nowInfo && !isWithinScheduleWindow(stop.schedule_time, nowInfo)) {
        continue;
      }

      const candidateRouteStops = candidateAllStops || stops;
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
        if (typeof truck.speed === 'number' && truck.speed > 25) {
          console.log(
            `[Core] 🚧 車輛 ${truck.car_id || truck.route_id} 時速達 ${truck.speed} km/h (高於 25 km/h)，判定為巡航路過，略過通知。`
          );
          continue;
        }

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

        const trustedLinids = trustedMap ? trustedMap.get(String(route.id)) : undefined;
        const isTrusted =
          trustedLinids &&
          (trustedLinids.has(String(truck.route_id)) ||
            (truck.car_id && trustedLinids.has(String(truck.car_id))));
        const hasAnyTrusted = trustedLinids && trustedLinids.size > 0;
        const shouldNotify = !hasAnyTrusted || isTrusted;

        arrivals.push({ truck, stop, route, distance, subscribedGroups, shouldNotify });
      }
    }
  }

  return arrivals;
}

/**
 * 計算各已訂閱站點的最近車輛分析
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
