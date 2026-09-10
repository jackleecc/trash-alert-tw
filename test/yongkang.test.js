import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateDistanceMeters } from '../lib/geoUtils.js';
import { findNearbyTruckArrivals, resolveRouteCity, isWithinScheduleWindow } from '../lib/coreProcessor.js';

test('Tainan Yongkang Wenhua Rd 40 - Geofence distance calculation', () => {
  const stopLat = 23.016963;
  const stopLng = 120.261576;

  // 1. 車輛距離站點約 30 公尺 (文化路與永大路口附近)
  const truckNearLat = 23.0168;
  const truckNearLng = 120.2614;
  const distanceNear = calculateDistanceMeters(truckNearLat, truckNearLng, stopLat, stopLng);
  assert.ok(distanceNear <= 150, `距離 (${distanceNear}m) 應在 150m 圍欄內`);

  // 2. 車輛距離站點約 1.5 公里 (永康工業區/自強路)
  const truckFarLat = 23.030;
  const truckFarLng = 120.265;
  const distanceFar = calculateDistanceMeters(truckFarLat, truckFarLng, stopLat, stopLng);
  assert.ok(distanceFar > 500, `距離 (${distanceFar}m) 應大於 500m`);
});

test('Tainan Yongkang Wenhua Rd 40 - Schedule window validation', () => {
  const scheduleTime = '19:42:00';

  // 19:35 在時間窗內 (表定前 7 分鐘，容許前 10 分鐘)
  assert.equal(isWithinScheduleWindow(scheduleTime, { hour: 19, minute: 35 }), true);

  // 19:42 當班正點
  assert.equal(isWithinScheduleWindow(scheduleTime, { hour: 19, minute: 42 }), true);

  // 20:15 誤點清運在時間窗內 (表定後 33 分鐘，容許後 40 分鐘)
  assert.equal(isWithinScheduleWindow(scheduleTime, { hour: 20, minute: 15 }), true);

  // 18:00 提前出庫路過排除 (表定前 102 分鐘)
  assert.equal(isWithinScheduleWindow(scheduleTime, { hour: 18, minute: 0 }), false);

  // 21:00 執勤結束非當班車輛排除
  assert.equal(isWithinScheduleWindow(scheduleTime, { hour: 21, minute: 0 }), false);
});

test('Tainan Yongkang Wenhua Rd 40 - Core processor truck arrival matching', () => {
  const stops = [
    {
      id: 5,
      route_id: '70',
      name: '文化路128巷10號',
      lat: 23.016137,
      lng: 120.257498,
      order_index: 78,
      schedule_time: '19:37:00',
    },
    {
      id: 6,
      route_id: '70',
      name: '永康區文化路40號',
      lat: 23.016963,
      lng: 120.261576,
      order_index: 79,
      schedule_time: '19:42:00',
    },
    {
      id: 7,
      route_id: '70',
      name: '永忠路18號',
      lat: 23.01722,
      lng: 120.260959,
      order_index: 80,
      schedule_time: '19:44:00',
    },
  ];

  const activeRoutesMap = new Map([
    ['70', { id: '70', name: '永康區第70線 (永康里/文化路)', city: '台南市' }],
  ]);

  const targetGroupId = 'C6f0ecae71723b8aef86290448871e6fa';
  const otherGroupId = 'C_OTHER_GROUP';

  // 站點 6 (永康文化路40號) 只綁定 targetGroupId
  const stopSubscribersMap = new Map([
    ['6', new Set([targetGroupId])],
  ]);

  const twNowInfo = { hour: 19, minute: 40 };

  // 1. 車輛抵達文化路 40 號 (距離約 20m)
  const truckArrival = [
    {
      route_id: '70',
      car_id: 'KEF-1523',
      lat: 23.01698,
      lng: 120.26155,
      waste_type: 'garbage',
      speed: 12,
    },
  ];

  const arrivals = findNearbyTruckArrivals(
    truckArrival,
    stops,
    stopSubscribersMap,
    activeRoutesMap,
    new Map(),
    twNowInfo
  );

  assert.equal(arrivals.length, 1);
  assert.equal(arrivals[0].stop.name, '永康區文化路40號');
  assert.equal(arrivals[0].shouldNotify, true);
  assert.ok(arrivals[0].subscribedGroups.has(targetGroupId));
  assert.ok(!arrivals[0].subscribedGroups.has(otherGroupId)); // 絕對不通知其他群組

  // 2. 驗證 resolveRouteCity
  assert.equal(resolveRouteCity(activeRoutesMap.get('70')), '台南市');
});
