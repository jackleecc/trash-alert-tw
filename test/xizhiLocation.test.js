import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateDistanceMeters, isWithinGeofence } from '../lib/geoUtils.js';
import { findNearbyTruckArrivals, formatArrivalMessage } from '../lib/coreProcessor.js';

test('Xizhi Xiwang Rd Sec 1 Lane 333 - Geofence distance calculation', () => {
  const xiwang333 = { lat: 25.076252, lng: 121.649942 };
  
  // 汐萬路一段343巷口 (上一站)
  const prevStop = { lat: 25.077625, lng: 121.649992 };
  const distToPrev = calculateDistanceMeters(
    xiwang333.lat,
    xiwang333.lng,
    prevStop.lat,
    prevStop.lng
  );
  
  // 兩站相距約 150 公尺
  assert.ok(distToPrev > 100 && distToPrev < 200);

  // 接近至 100m 時進入地理圍欄 (250m)
  const truckApproaching = { lat: 25.077000, lng: 121.649950 };
  assert.equal(
    isWithinGeofence(xiwang333.lat, xiwang333.lng, truckApproaching.lat, truckApproaching.lng, 250),
    true
  );

  // 遠離至 500m 外時不觸發
  const truckFarAway = { lat: 25.070000, lng: 121.650000 };
  assert.equal(
    isWithinGeofence(xiwang333.lat, xiwang333.lng, truckFarAway.lat, truckFarAway.lng, 250),
    false
  );
});

test('Xizhi Xiwang Rd Sec 1 Lane 333 - Core processor truck arrival matching with NTPC lineid', () => {
  const stop = {
    id: 201,
    route_id: '221010',
    name: '汐萬路一段333巷口',
    lat: 25.076252,
    lng: 121.649942,
  };

  // 模擬新北市環保局真實即時車輛格式
  const truckApproaching = {
    route_id: '221010',
    car_id: 'KEV-8732',
    lat: 25.076800,
    lng: 121.649940,
  };

  const stopSubscribersMap = new Map([['201', new Set(['C_XIZHI_GROUP'])]]);
  const activeRoutesMap = new Map([['221010', { id: '221010', name: '汐止區第1區路線(晚上)' }]]);

  const arrivals = findNearbyTruckArrivals(
    [truckApproaching],
    [stop],
    stopSubscribersMap,
    activeRoutesMap
  );

  assert.equal(arrivals.length, 1);
  assert.equal(arrivals[0].stop.name, '汐萬路一段333巷口');
  assert.equal(arrivals[0].route.name, '汐止區第1區路線(晚上)');
  assert.equal(arrivals[0].truck.car_id, 'KEV-8732');
  assert.equal(arrivals[0].shouldNotify, true);

  const msg = formatArrivalMessage({
    routeName: arrivals[0].route.name,
    stopName: arrivals[0].stop.name,
    distance: arrivals[0].distance,
    carId: arrivals[0].truck.car_id,
  });

  assert.ok(msg.includes('汐萬路一段333巷口'));
  assert.ok(msg.includes('汐止區第1區路線(晚上)'));
  assert.ok(msg.includes('KEV-8732'));
});
