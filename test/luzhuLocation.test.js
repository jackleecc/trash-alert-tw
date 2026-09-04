import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateDistanceMeters, isWithinGeofence } from '../lib/geoUtils.js';
import { findNearbyTruckArrivals, formatArrivalMessage } from '../lib/coreProcessor.js';

test('Luzhu Minyou Rd 55 - Geofence distance calculation', () => {
  const minyou55 = { lat: 22.822194, lng: 120.270422 };
  
  // 北嶺古安宮 (民有路121號)
  const guangong = { lat: 22.821559, lng: 120.272604 };
  const distToGuangong = calculateDistanceMeters(
    minyou55.lat,
    minyou55.lng,
    guangong.lat,
    guangong.lng
  );
  
  // 距離應在 220 ~ 260 公尺之間
  assert.ok(distToGuangong > 200 && distToGuangong < 300);

  // 接近至 150m 時進入地理圍欄
  const truckApproaching = { lat: 22.822100, lng: 120.271500 };
  assert.equal(
    isWithinGeofence(minyou55.lat, minyou55.lng, truckApproaching.lat, truckApproaching.lng, 250),
    true
  );

  // 遠離至 500m 外時不觸發
  const truckFarAway = { lat: 22.822194, lng: 120.276000 };
  assert.equal(
    isWithinGeofence(minyou55.lat, minyou55.lng, truckFarAway.lat, truckFarAway.lng, 250),
    false
  );
});

test('Luzhu Minyou Rd 55 - Core processor truck arrival matching', () => {
  const stop = {
    id: 101,
    route_id: 'LZ01',
    name: '路竹區民有路55號',
    lat: 22.822194,
    lng: 120.270422,
  };

  const truckApproaching = {
    route_id: '1066015646',
    car_id: 'KEW-0079',
    lat: 22.822100,
    lng: 120.271500,
  };

  const stopSubscribersMap = new Map([['101', new Set(['C_LUZHU_GROUP'])]]);
  const activeRoutesMap = new Map([['LZ01', { id: 'LZ01', name: '路竹區北嶺線' }]]);

  const arrivals = findNearbyTruckArrivals(
    [truckApproaching],
    [stop],
    stopSubscribersMap,
    activeRoutesMap
  );

  assert.equal(arrivals.length, 1);
  assert.equal(arrivals[0].stop.name, '路竹區民有路55號');
  assert.equal(arrivals[0].route.name, '路竹區北嶺線');
  assert.equal(arrivals[0].truck.car_id, 'KEW-0079');

  const msg = formatArrivalMessage({
    routeName: arrivals[0].route.name,
    stopName: arrivals[0].stop.name,
    distance: arrivals[0].distance,
    carId: arrivals[0].truck.car_id,
  });

  assert.ok(msg.includes('路竹區民有路55號'));
  assert.ok(msg.includes('路竹區北嶺線'));
  assert.ok(msg.includes('KEW-0079'));
});
