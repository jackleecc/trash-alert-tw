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
