import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findNearbyTruckArrivals,
  computeClosestTrucks,
  formatArrivalMessage,
  isWithinScheduleWindow,
  getIsoDayOfWeek,
  updateTruckTelemetry,
  recentTruckHistory,
} from '../lib/arrivalMatcher.js';

test('Case 1: isWithinScheduleWindow handles standard window, early/late bounds, and cross-midnight ring logic', () => {
  const sched = '19:30:00';

  // Standard window within bounds: 10 mins early (19:20), 25 mins late (19:55)
  assert.equal(isWithinScheduleWindow(sched, { hour: 19, minute: 20 }), true);
  assert.equal(isWithinScheduleWindow(sched, { hour: 19, minute: 55 }), true);

  // Exact early bound (15 mins early -> 19:15)
  assert.equal(isWithinScheduleWindow(sched, { hour: 19, minute: 15 }), true);
  // Outside early bound (16 mins early -> 19:14)
  assert.equal(isWithinScheduleWindow(sched, { hour: 19, minute: 14 }), false);

  // Exact late bound (40 mins late -> 20:10)
  assert.equal(isWithinScheduleWindow(sched, { hour: 20, minute: 10 }), true);
  // Outside late bound (41 mins late -> 20:11)
  assert.equal(isWithinScheduleWindow(sched, { hour: 20, minute: 11 }), false);

  // Fallback for null / empty
  assert.equal(isWithinScheduleWindow(null, { hour: 17, minute: 0 }), true);
  assert.equal(isWithinScheduleWindow('', { hour: 17, minute: 0 }), true);

  // Cross-midnight ring logic:
  // 表定 23:55:00
  // 次日 00:05:00 (延後 10 分鐘) -> true
  assert.equal(isWithinScheduleWindow('23:55:00', { hour: 0, minute: 5 }), true);
  // 次日 00:40:00 (延後 45 分鐘，超過 40 分鐘) -> false
  assert.equal(isWithinScheduleWindow('23:55:00', { hour: 0, minute: 40 }), false);

  // 表定 00:10:00
  // 前日 23:58:00 (提早 12 分鐘) -> true
  assert.equal(isWithinScheduleWindow('00:10:00', { hour: 23, minute: 58 }), true);
  // 前日 23:50:00 (提早 20 分鐘，超過 15 分鐘) -> false
  assert.equal(isWithinScheduleWindow('00:10:00', { hour: 23, minute: 50 }), false);
});

test('Case 2: updateTruckTelemetry updates vehicle speed, previous coordinates, is_southbound flag, and enforces the max cache capacity (<= 500 entries)', () => {
  recentTruckHistory.clear();

  // 1. 首次上報：寫入快取，但尚無前次座標
  const truck1 = { route_id: 'R1', car_id: 'TRUCK-01', lat: 25.0100, lng: 121.5000, time: 1000000 };
  updateTruckTelemetry([truck1]);
  assert.equal(recentTruckHistory.has('R1_TRUCK-01'), true);

  // 2. 第二次上報：向南行駛 (lat 變小)，更新 speed, prev_lat, prev_lng, is_southbound = true
  const truck2 = { route_id: 'R1', car_id: 'TRUCK-01', lat: 25.0050, lng: 121.5000, time: 1060000 };
  updateTruckTelemetry([truck2]);
  assert.equal(truck2.prev_lat, 25.0100);
  assert.equal(truck2.prev_lng, 121.5000);
  assert.equal(truck2.is_southbound, true);
  assert.ok(typeof truck2.speed === 'number' && truck2.speed > 0);

  // 3. 第三次上報：向北行駛 (lat 變大)，更新 is_southbound = false
  const truck3 = { route_id: 'R1', car_id: 'TRUCK-01', lat: 25.0080, lng: 121.5000, time: 1120000 };
  updateTruckTelemetry([truck3]);
  assert.equal(truck3.prev_lat, 25.0050);
  assert.equal(truck3.is_southbound, false);

  // 4. 大量灌入超過 500 筆車輛，驗證快取容量上限限制 (<= 500 entries)
  const bulkTrucks = [];
  for (let i = 0; i < 550; i++) {
    bulkTrucks.push({
      route_id: 'RB',
      car_id: `CAR-${i}`,
      lat: 25.0,
      lng: 121.5,
      time: 2000000 + i,
    });
  }
  updateTruckTelemetry(bulkTrucks);
  assert.ok(recentTruckHistory.size <= 500, `Cache size ${recentTruckHistory.size} should be <= 500`);
});

test('Case 3: findNearbyTruckArrivals filters out cruising trucks (speed > 25 km/h) and opposite bearing vehicles (isMovingTowardsApproach)', () => {
  const stops = [
    { id: 1, route_id: 'R1', name: '測試站點', lat: 25.0000, lng: 121.5000, radius_meters: 200, approach_direction: 'southbound' },
  ];
  const subscribers = new Map([['1', new Set(['GROUP_1'])]]);
  const routes = new Map([['R1', { id: 'R1', name: '路線1' }]]);

  // A. 時速過濾：時速 > 25 km/h 判定為巡航路過排除
  const fastCruisingTruck = {
    route_id: 'R1',
    car_id: 'FAST-01',
    lat: 25.0003,
    lng: 121.5000,
    speed: 35,
    is_southbound: true,
  };
  const fastArrivals = findNearbyTruckArrivals([fastCruisingTruck], stops, subscribers, routes);
  assert.equal(fastArrivals.length, 0, '高速巡航車輛應被排除');

  const slowCollectingTruck = {
    route_id: 'R1',
    car_id: 'SLOW-01',
    lat: 25.0003,
    lng: 121.5000,
    speed: 12,
    is_southbound: true,
  };
  const slowArrivals = findNearbyTruckArrivals([slowCollectingTruck], stops, subscribers, routes);
  assert.equal(slowArrivals.length, 1, '低速收運車輛應放行');

  // B. 方位角檢驗：approach_direction 為 southbound，朝北行駛 (is_southbound: false) 應被排除
  const northboundTruck = {
    route_id: 'R1',
    car_id: 'OPPOSITE-01',
    lat: 25.0003,
    lng: 121.5000,
    speed: 10,
    is_southbound: false,
  };
  const oppositeArrivals = findNearbyTruckArrivals([northboundTruck], stops, subscribers, routes);
  assert.equal(oppositeArrivals.length, 0, '逆向行駛車輛應被排除');
});

test('Case 4: findNearbyTruckArrivals matches arrivals, applies adaptive geofence radius (computeAdaptiveRadius), and checks trusted linid whitelist', () => {
  // 密集相鄰站點 (距離約 153 公尺)
  const stops = [
    { id: 16, route_id: 'R10', name: '343巷口', lat: 25.077625, lng: 121.649992 },
    { id: 17, route_id: 'R10', name: '333巷口', lat: 25.076252, lng: 121.649942 },
  ];
  const subscribers = new Map([['17', new Set(['G1'])]]);
  const routes = new Map([['R10', { id: 'R10', name: '第1區路線' }]]);

  // 1. 自適應半徑測試：車輛距離 333 巷口約 196m，自適應半徑收縮至 120m 時應阻斷
  const truckAt196m = {
    route_id: 'R10',
    car_id: 'KEU-3231',
    lat: 25.0745,
    lng: 121.649942,
  };
  const arrivalsAt196m = findNearbyTruckArrivals([truckAt196m], stops, subscribers, routes);
  assert.equal(arrivalsAt196m.length, 0, '196m 處應被自適應 120m 圍欄阻斷');

  // 2. 到站放行測試：車輛距離 333 巷口約 80m，應成功匹配
  const truckAt80m = {
    route_id: 'R10',
    car_id: 'KEU-3231',
    lat: 25.07555,
    lng: 121.649942,
  };
  const arrivalsAt80m = findNearbyTruckArrivals([truckAt80m], stops, subscribers, routes);
  assert.equal(arrivalsAt80m.length, 1, '80m 處應成功匹配到站');
  assert.equal(arrivalsAt80m[0].stop.id, 17);
  assert.equal(arrivalsAt80m[0].route.id, 'R10');

  // 3. 信任白名單測試：若路線有信任清單，不在名單內則 shouldNotify 為 false
  const routeTrustedLinidsMap = new Map([['R10', new Set(['TRUSTED-ROUTE-A'])]]);
  const untrustedTruck = {
    route_id: 'UNTRUSTED-ROUTE',
    car_id: 'OTHER-CAR',
    lat: 25.07555,
    lng: 121.649942,
  };
  const untrustedStops = [
    { id: 17, route_id: 'R10', name: '333巷口', lat: 25.076252, lng: 121.649942 },
  ];
  const untrustedArrivals = findNearbyTruckArrivals(
    [untrustedTruck],
    untrustedStops,
    subscribers,
    routes,
    routeTrustedLinidsMap,
    null,
    stops
  );
  assert.equal(untrustedArrivals.length, 1);
  assert.equal(untrustedArrivals[0].shouldNotify, false, '不在信任清單中的車輛 shouldNotify 應為 false');

  const trustedTruck = {
    route_id: 'TRUSTED-ROUTE-A',
    car_id: 'OTHER-CAR',
    lat: 25.07555,
    lng: 121.649942,
  };
  const trustedArrivals = findNearbyTruckArrivals(
    [trustedTruck],
    untrustedStops,
    subscribers,
    routes,
    routeTrustedLinidsMap,
    null,
    stops
  );
  assert.equal(trustedArrivals.length, 1);
  assert.equal(trustedArrivals[0].shouldNotify, true, '在信任清單中的車輛 shouldNotify 應為 true');
});

test('Case 5: computeClosestTrucks returns nearest vehicle per subscribed stop with distance and target route flags', () => {
  const stops = [
    { id: 101, route_id: 'R20', name: '民生站', lat: 25.0500, lng: 121.5500 },
    { id: 102, route_id: 'R20', name: '無訂閱站', lat: 25.0600, lng: 121.5500 },
  ];
  const subscribers = new Map([['101', new Set(['GROUP_SUB'])]]);
  const routes = new Map([['R20', { id: 'R20', name: '民生幹線' }]]);

  const trucks = [
    { route_id: 'R20', car_id: 'TRUCK-FAR', lat: 25.0550, lng: 121.5500 },
    { route_id: 'R20', car_id: 'TRUCK-NEAR', lat: 25.0510, lng: 121.5500 },
    { route_id: 'R99', car_id: 'TRUCK-OTHER', lat: 25.0502, lng: 121.5500 },
  ];

  const closest = computeClosestTrucks(trucks, stops, subscribers, routes);

  // 僅已訂閱站點納入計算
  assert.equal(closest.length, 1);
  assert.equal(closest[0].stopId, 101);
  assert.equal(closest[0].stopName, '民生站');
  assert.equal(closest[0].routeId, 'R20');
  assert.equal(closest[0].routeName, '民生幹線');
  assert.equal(closest[0].targetRouteTrucksCount, 2);

  // 優先選擇同路線最近車輛 TRUCK-NEAR
  assert.ok(closest[0].closestTruck);
  assert.equal(closest[0].closestTruck.carId, 'TRUCK-NEAR');
  assert.equal(closest[0].closestTruck.isTargetRoute, true);
  assert.ok(closest[0].closestTruck.distanceMeters > 0);

  // 若無同路線車輛，則退回候選車輛並標記 isTargetRoute: false
  const fallbackClosest = computeClosestTrucks(
    [{ route_id: 'R99', car_id: 'TRUCK-OTHER', lat: 25.0502, lng: 121.5500 }],
    [stops[0]],
    subscribers,
    routes
  );
  assert.equal(fallbackClosest[0].targetRouteTrucksCount, 0);
  assert.equal(fallbackClosest[0].closestTruck.carId, 'TRUCK-OTHER');
  assert.equal(fallbackClosest[0].closestTruck.isTargetRoute, false);
});
