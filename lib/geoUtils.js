/**
 * lib/geoUtils.js
 * 地理距離計算與 Geofence 判定工具
 */

const EARTH_RADIUS_METERS = 6371000; // 地球平均半徑（公尺）

/**
 * 將角度轉為弧度
 * @param {number} deg
 * @returns {number}
 */
function deg2rad(deg) {
  return deg * (Math.PI / 180);
}

/**
 * 使用 Haversine 公式計算兩點經緯度間的大圓距離（公尺）
 *
 * @param {number} lat1 - 點 1 緯度
 * @param {number} lon1 - 點 1 經度
 * @param {number} lat2 - 點 2 緯度
 * @param {number} lon2 - 點 2 經度
 * @returns {number} 距離（公尺）
 */
export function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(deg2rad(lat1)) *
      Math.cos(deg2rad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

/**
 * 判定兩點距離是否在指定的半徑範圍內 (Geofence)
 *
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @param {number} [radiusMeters=250] - 預設 250 公尺
 * @returns {boolean}
 */
export function isWithinGeofence(lat1, lon1, lat2, lon2, radiusMeters = 250) {
  const distance = calculateDistanceMeters(lat1, lon1, lat2, lon2);
  return distance <= radiusMeters;
}

/**
 * 依據相鄰站距自動計算最適地理圍欄半徑 (Adaptive Geofence Radius)
 *
 * 設計原則：
 *   1. 若站點自身已有 radius_meters 屬性，優先使用該自訂值。
 *   2. 圍欄半徑絕不可覆蓋到相鄰站點 (No-Overlap 原則)。
 *   3. 針對相鄰站距 < 200m（高密度住宅區/狹小巷弄），收縮至 120m。
 *   4. 針對相鄰站距 200m ~ 400m（市區一般道路），設定為 150m。
 *   5. 針對相鄰站距 > 400m（郊區/山區長站距），設定為 250m。
 *
 * @param {object} stop - 當前站點 { id, lat, lng, radius_meters? }
 * @param {Array<object>} [allRouteStops=[]] - 同路線所有站點清單
 * @returns {number} 建議半徑 (公尺)
 */
export function computeAdaptiveRadius(stop, allRouteStops = []) {
  if (!stop) return 250;
  if (typeof stop.radius_meters === 'number' && stop.radius_meters > 0) {
    return stop.radius_meters;
  }

  const otherStops = (allRouteStops || []).filter(
    (s) => s && String(s.id) !== String(stop.id) && s.lat !== undefined && s.lng !== undefined
  );
  if (otherStops.length === 0) {
    return 150; // 預設市區標準半徑
  }

  let minDistance = Infinity;
  for (const other of otherStops) {
    const dist = calculateDistanceMeters(stop.lat, stop.lng, other.lat, other.lng);
    if (dist < minDistance) {
      minDistance = dist;
    }
  }

  if (minDistance < 200) {
    return 120; // 超高密度住宅區
  }
  if (minDistance < 400) {
    return 150; // 市區標準路段
  }
  return 250; // 郊區/山區長站距
}

/**
 * 計算兩次 GPS 座標與時間戳記間的移動時速 (km/h)
 *
 * @param {{ lat: number, lng: number, time?: string | number | Date }} p1 - 前次採樣
 * @param {{ lat: number, lng: number, time?: string | number | Date }} p2 - 本次採樣
 * @returns {number | null} 時速 (km/h)，若資料不足或時間差不合理回傳 null
 */
export function calculateSpeedKmh(p1, p2) {
  if (!p1 || !p2 || p1.lat === undefined || p1.lng === undefined || p2.lat === undefined || p2.lng === undefined) {
    return null;
  }

  const t1 = p1.time ? new Date(p1.time).getTime() : NaN;
  const t2 = p2.time ? new Date(p2.time).getTime() : NaN;

  if (isNaN(t1) || isNaN(t2)) {
    return null;
  }

  const dtSeconds = Math.abs(t2 - t1) / 1000;
  // 時間差過小 (< 2 秒) 或過大 (> 300 秒 / 5 分鐘)，估算失真，忽略
  if (dtSeconds < 2 || dtSeconds > 300) {
    return null;
  }

  const distMeters = calculateDistanceMeters(p1.lat, p1.lng, p2.lat, p2.lng);
  const speedMps = distMeters / dtSeconds;
  return Math.round(speedMps * 3.6 * 10) / 10;
}

/**
 * 計算兩點座標間的大地方位角 (True Bearing / Azimuth)，範圍 0° ~ 360°
 * 0° = 正北, 90° = 正東, 180° = 正南, 270° = 正西
 *
 * @param {number} lat1 - 起點緯度
 * @param {number} lon1 - 起點經度
 * @param {number} lat2 - 終點緯度
 * @param {number} lon2 - 終點經度
 * @returns {number} 方位角 (度, 0~360)
 */
export function calculateBearing(lat1, lon1, lat2, lon2) {
  const dLon = deg2rad(lon2 - lon1);
  const phi1 = deg2rad(lat1);
  const phi2 = deg2rad(lat2);

  const y = Math.sin(dLon) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);

  const theta = Math.atan2(y, x);
  return (theta * (180 / Math.PI) + 360) % 360;
}

/**
 * 計算兩個方位角之間的最小夾角差 (0° ~ 180°)
 *
 * @param {number} b1 - 方位角 1
 * @param {number} b2 - 方位角 2
 * @returns {number} 夾角 (度)
 */
export function getBearingDifference(b1, b2) {
  const diff = Math.abs(b1 - b2) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/**
 * 自動從路線清單推導站點的法定進場方位角 (Official Approach Bearing)
 * 完美處理 5 大邊際條件：
 *   - 邊際 3：首站無前站 -> 回傳 null (豁免方向檢核)
 *   - 邊際 4：中場休息/長站距 (距離 > 1500m 或時差 > 20分) -> 回傳 null (豁免)
 *   - 邊際 5：相鄰站距極短 (< 50m) -> 自動往前追溯取穩定基準向量
 *
 * @param {object} currentStop - 目標站點 { id, lat, lng, rank?, order_index?, schedule_time? }
 * @param {Array<object>} allRouteStops - 同路線所有站點
 * @returns {number | null} 進場方位角 (度)，若不適用回傳 null
 */
export function deriveOfficialApproachBearing(currentStop, allRouteStops = []) {
  if (!currentStop || !allRouteStops || allRouteStops.length < 2) return null;

  // 排序路線站點 (依 rank 或 order_index 排序)
  const sortedStops = [...allRouteStops].sort((a, b) => {
    const rA = parseInt(a.rank ?? a.order_index ?? 0, 10);
    const rB = parseInt(b.rank ?? b.order_index ?? 0, 10);
    return rA - rB;
  });

  const currentIndex = sortedStops.findIndex(
    (s) => String(s.id) === String(currentStop.id)
  );

  // 邊際條件 3：首站 (Index 0) 無前站，豁免方向性檢核
  if (currentIndex <= 0) return null;

  // 尋找有效的前置基準站點 (若前站距離 < 50m，邊際條件 5：往前追溯取長基線)
  let prevStop = sortedStops[currentIndex - 1];
  let distToPrev = calculateDistanceMeters(
    prevStop.lat,
    prevStop.lng,
    currentStop.lat,
    currentStop.lng
  );

  if (distToPrev < 50 && currentIndex >= 2) {
    const candidatePrev = sortedStops[currentIndex - 2];
    const candidateDist = calculateDistanceMeters(
      candidatePrev.lat,
      candidatePrev.lng,
      currentStop.lat,
      currentStop.lng
    );
    // 回溯長基線若在合理路段內 (<= 2000m)，採用長基線增強方向穩定度
    if (candidateDist <= 2000) {
      prevStop = candidatePrev;
      distToPrev = candidateDist;
    }
  }

  // 邊際條件 4：跨段長站距 (> 2500m) 或時差過大 (> 25分)，代表中場休息調度，豁免進場角
  if (distToPrev > 2500) return null;
  if (prevStop.schedule_time && currentStop.schedule_time) {
    const [h1, m1] = prevStop.schedule_time.split(':').map(Number);
    const [h2, m2] = currentStop.schedule_time.split(':').map(Number);
    if (!isNaN(h1) && !isNaN(h2)) {
      const dtMinutes = (h2 * 60 + m2) - (h1 * 60 + m1);
      if (dtMinutes > 25 || dtMinutes < 0) return null;
    }
  }

  return calculateBearing(prevStop.lat, prevStop.lng, currentStop.lat, currentStop.lng);
}

/**
 * 驗證車輛是否符合站點進場方向
 * 完美處理：
 *   - 邊際 1：靜止 / 停靠 GPS 漂移防護 (位移 < 10m 或時速 < 5 km/h 自動豁免)
 *   - 邊際 2：道路彎道容許與反向出庫過濾 (夾角 <= 90° 放行，> 90° 逆向阻斷)
 *
 * @param {object} truck - 車輛物件 { lat, lng, prev_lat, prev_lng, speed }
 * @param {number | null} officialBearing - 法定進場方位角 (度)
 * @param {number} [maxToleranceDegrees=90] - 最大容許夾角 (預設 90°，即非逆向皆放行)
 * @returns {boolean} true = 允許通過；false = 判定為逆向路過
 */
export function isMovingTowardsApproach(
  truck,
  officialBearing,
  maxToleranceDegrees = 90
) {
  if (officialBearing === null || officialBearing === undefined) {
    return true; // 站點無方向限制或屬於豁免站點，直接放行
  }
  if (!truck) return true;

  // 支援相容標記 is_southbound 快速過濾 (若規定正南 180° 但已知朝北行駛，直接判定逆向)
  if (officialBearing === 180 && truck.is_southbound === false) {
    return false;
  }
  if (officialBearing === 0 && truck.is_southbound === true) {
    return false;
  }

  if (truck.prev_lat === undefined || truck.prev_lng === undefined) {
    return true; // 無前次座標可比對方向，安全放行
  }


  // 邊際條件 1：車輛處於停靠或極低速作業中 (位移 < 10m 或時速 < 5 km/h)
  // GPS 靜止漂移時方位角會隨機震盪，此時車輛已在站點旁停滯，直接豁免放行
  const displacement = calculateDistanceMeters(
    truck.prev_lat,
    truck.prev_lng,
    truck.lat,
    truck.lng
  );
  if (displacement < 10 || (typeof truck.speed === 'number' && truck.speed < 5)) {
    return true;
  }

  // 計算車輛實際移動方位角
  const truckBearing = calculateBearing(
    truck.prev_lat,
    truck.prev_lng,
    truck.lat,
    truck.lng
  );

  // 邊際條件 2：計算兩者夾角，只要夾角 <= 90° (非反向逆行) 即視為同向收運進場
  const angleDiff = getBearingDifference(truckBearing, officialBearing);
  return angleDiff <= maxToleranceDegrees;
}


