import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateDistanceMeters,
  isWithinGeofence,
  computeAdaptiveRadius,
  calculateSpeedKmh,
  isMovingTowardsApproach,
} from '../lib/geoUtils.js';


test('calculateDistanceMeters - calculates zero distance for identical coordinates', () => {
  const dist = calculateDistanceMeters(22.6273, 120.3014, 22.6273, 120.3014);
  assert.equal(Math.round(dist), 0);
});

test('calculateDistanceMeters - accurate distance for known points (~100m)', () => {
  // 經度偏移約 0.001 度在台灣緯度大約為 102 公尺
  const lat1 = 22.6273;
  const lon1 = 120.3014;
  const lat2 = 22.6273;
  const lon2 = 120.3024;

  const dist = calculateDistanceMeters(lat1, lon1, lat2, lon2);
  assert.ok(dist > 90 && dist < 120, `Expected ~102m, got ${dist}m`);
});

test('isWithinGeofence - correctly identifies within and outside radius', () => {
  const lat1 = 22.6273;
  const lon1 = 120.3014;

  // ~102m away: should be within 250m geofence
  assert.equal(isWithinGeofence(lat1, lon1, 22.6273, 120.3024, 250), true);

  // ~1000m away: should be outside 250m geofence
  assert.equal(isWithinGeofence(lat1, lon1, 22.6273, 120.3114, 250), false);
});

test('computeAdaptiveRadius - respects explicit radius_meters on stop', () => {
  const stop = { id: 1, lat: 25.076, lng: 121.650, radius_meters: 100 };
  assert.equal(computeAdaptiveRadius(stop, []), 100);
});

test('computeAdaptiveRadius - adjusts radius based on neighboring stops distance', () => {
  const targetStop = { id: 17, lat: 25.076252, lng: 121.649942 }; // 汐萬路一段333巷口
  const closeNeighbor = { id: 16, lat: 25.077625, lng: 121.649992 }; // ~153m away (343巷口)
  const farNeighbor = { id: 14, lat: 25.081235, lng: 121.649562 }; // ~555m away

  // 1. 鄰站 < 200m -> 超密集住宅區應自適應收縮至 120m
  const denseRadius = computeAdaptiveRadius(targetStop, [targetStop, closeNeighbor]);
  assert.equal(denseRadius, 120);

  // 2. 只有遠站 (> 400m) -> 郊區/山區應設為 250m
  const ruralRadius = computeAdaptiveRadius(targetStop, [targetStop, farNeighbor]);
  assert.equal(ruralRadius, 250);

  // 3. 無其他相鄰站點 -> 預設市區標準 150m
  const defaultRadius = computeAdaptiveRadius(targetStop, [targetStop]);
  assert.equal(defaultRadius, 150);
});

test('calculateSpeedKmh - calculates speed from GPS displacement and time delta', () => {
  const now = Date.now();
  // 經度差 0.001 度大約 102 公尺，10 秒內行駛 -> ~36.7 km/h
  const p1 = { lat: 25.0, lng: 121.5, time: new Date(now - 10000).toISOString() };
  const p2 = { lat: 25.0, lng: 121.501, time: new Date(now).toISOString() };

  const speed = calculateSpeedKmh(p1, p2);
  assert.ok(speed !== null);
  assert.ok(speed > 30 && speed < 45, `Expected ~36.7 km/h, got ${speed}`);

  // 時間差不合理（如同一秒）回傳 null
  assert.equal(calculateSpeedKmh(p1, { ...p2, time: p1.time }), null);
});

test('isMovingTowardsApproach - stationary truck loading trash with GPS north drift passes southbound stop', () => {
  // 垃圾車在南下站點 (180°) 停靠作業，車速為 0，GPS 漂移朝北約 1.1 公尺 (lat > prev_lat => is_southbound: false)
  const truckAtStop = {
    lat: 25.076260,
    lng: 121.649942,
    prev_lat: 25.076250, // 緯度增加 0.000010 度 (~1.1 公尺)
    prev_lng: 121.649942,
    speed: 0,
    is_southbound: false, // 遭判定為朝北，但處於停靠作業狀態
  };

  const officialBearing = 180; // 南下法定進場角
  const passed = isMovingTowardsApproach(truckAtStop, officialBearing);
  assert.equal(passed, true, '正在站點停靠作業之車輛，即使 GPS 逆向微幅漂移亦必須優先獲得豁免');
});

test('isMovingTowardsApproach - low-speed creeping truck (<5 km/h) is exempt from bearing filter', () => {
  const creepingTruck = {
    lat: 25.076280,
    lng: 121.649942,
    prev_lat: 25.076250,
    prev_lng: 121.649942,
    speed: 3.2, // 3.2 km/h 低速挪車
    is_southbound: false,
  };

  const officialBearing = 180;
  const passed = isMovingTowardsApproach(creepingTruck, officialBearing);
  assert.equal(passed, true, '低速挪車作業時速 < 5 km/h 應獲得方位豁免');
});

