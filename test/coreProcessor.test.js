import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findNearbyTruckArrivals,
  getIsoDayOfWeek,
  formatArrivalMessage,
  isWithinScheduleWindow,
} from '../lib/coreProcessor.js';

test('getIsoDayOfWeek - converts UTC day properly', () => {
  // 2026-09-02 is Wednesday (3)
  const wednesday = new Date('2026-09-02T00:00:00Z');
  assert.equal(getIsoDayOfWeek(wednesday), 3);

  // 2026-09-06 is Sunday (7 in ISO format)
  const sunday = new Date('2026-09-06T00:00:00Z');
  assert.equal(getIsoDayOfWeek(sunday), 7);
});

test('isWithinScheduleWindow - handles window logic correctly', () => {
  // 表定 19:30:00，預設前 10 分鐘 (19:20) 到 後 40 分鐘 (20:10)
  const sched = '19:30:00';

  // 1. 提早 10 分鐘 (19:20) -> true
  assert.equal(isWithinScheduleWindow(sched, { hour: 19, minute: 20 }), true);

  // 2. 延後 25 分鐘 (19:55) -> true
  assert.equal(isWithinScheduleWindow(sched, { hour: 19, minute: 55 }), true);

  // 3. 提早 15 分鐘 (19:15) -> false (超過 10 分鐘提前門檻，防止出庫路過)
  assert.equal(isWithinScheduleWindow(sched, { hour: 19, minute: 15 }), false);

  // 4. 延後 45 分鐘 (20:15) -> false (超過 40 分鐘)
  assert.equal(isWithinScheduleWindow(sched, { hour: 20, minute: 15 }), false);

  // 5. 無設定表定時間 -> true (向後相容)
  assert.equal(isWithinScheduleWindow(null, { hour: 17, minute: 0 }), true);
  assert.equal(isWithinScheduleWindow('', { hour: 17, minute: 0 }), true);
});


test('formatArrivalMessage - contains expected structured fields and maps link', () => {
  const msg = formatArrivalMessage({
    routeName: '新興區清運A線',
    stopName: '中正三路口',
    distance: 185.4,
    carId: 'KCG-1234',
    stopLat: 22.6273,
    stopLng: 120.3014,
  });

  assert.ok(msg.includes('【垃圾車即將抵達提醒】'));
  assert.ok(msg.includes('站點：中正三路口'));
  assert.ok(msg.includes('路線：新興區清運A線'));
  assert.ok(msg.includes('約 185 公尺'));
  assert.ok(msg.includes('KCG-1234'));
  assert.ok(msg.includes('https://www.google.com/maps/search/?api=1&query=22.6273,120.3014'));
});

test('findNearbyTruckArrivals - matches an official linid without requiring it to equal route ID', () => {
  const arrivals = findNearbyTruckArrivals(
    [{ route_id: '1066015646', car_id: 'KEW-0079', lat: 22.858, lng: 120.259 }],
    [{ id: 1, route_id: 'LZ01', name: '中興路75號', lat: 22.858, lng: 120.259 }],
    new Map([['1', new Set(['C_GROUP'])]]),
    new Map([['LZ01', { id: 'LZ01', name: '路竹區清運路線' }]])
  );

  assert.equal(arrivals.length, 1);
  assert.equal(arrivals[0].route.id, 'LZ01');
  assert.equal(arrivals[0].truck.route_id, '1066015646');
});

test('findNearbyTruckArrivals - ignores recycling trucks and respects schedule window', () => {
  const stops = [
    { id: 1, route_id: 'R1', name: '早班站點', lat: 25.0, lng: 121.5, schedule_time: '17:30:00' },
    { id: 2, route_id: 'R1', name: '晚班站點', lat: 25.0, lng: 121.5, schedule_time: '20:30:00' },
  ];
  const subscribers = new Map([
    ['1', new Set(['G1'])],
    ['2', new Set(['G2'])],
  ]);
  const routes = new Map([['R1', { id: 'R1', name: '路線1' }]]);

  // 情境 A：當前時間為 17:35（早班在窗內，晚班不在）
  const twNowInfo = { hour: 17, minute: 35 };

  // 1. 一般垃圾車 -> 應只匹配站點 1
  const garbageArrivals = findNearbyTruckArrivals(
    [{ route_id: 'R1', car_id: 'TRUCK-1', lat: 25.0, lng: 121.5, waste_type: 'garbage' }],
    stops,
    subscribers,
    routes,
    new Map(),
    twNowInfo
  );
  assert.equal(garbageArrivals.length, 1);
  assert.equal(garbageArrivals[0].stop.id, 1);

  // 2. 資源回收車 -> 應被完全過濾忽略
  const recyclingArrivals = findNearbyTruckArrivals(
    [{ route_id: 'R1', car_id: 'TRUCK-RECYCLE', lat: 25.0, lng: 121.5, waste_type: 'recycling' }],
    stops,
    subscribers,
    routes,
    new Map(),
    twNowInfo
  );
  assert.equal(recyclingArrivals.length, 0);
});

test('findNearbyTruckArrivals - filters out cruising drive-by trucks by speed threshold', () => {
  const stops = [
    { id: 1, route_id: 'R1', name: '測試站', lat: 25.0, lng: 121.5, radius_meters: 150 },
  ];
  const subscribers = new Map([['1', new Set(['G1'])]]);
  const routes = new Map([['R1', { id: 'R1', name: '路線1' }]]);

  // 1. 車輛時速 40 km/h (巡航路過) -> 應被時速過濾阻擋
  const fastArrivals = findNearbyTruckArrivals(
    [{ route_id: 'R1', car_id: 'CRUISING-CAR', lat: 25.0005, lng: 121.5, speed: 40 }],
    stops,
    subscribers,
    routes
  );
  assert.equal(fastArrivals.length, 0);

  // 2. 車輛時速 12 km/h (低速收運中) -> 應正常通過
  const slowArrivals = findNearbyTruckArrivals(
    [{ route_id: 'R1', car_id: 'SLOW-COLLECTING-CAR', lat: 25.0005, lng: 121.5, speed: 12 }],
    stops,
    subscribers,
    routes
  );
  assert.equal(slowArrivals.length, 1);
});

test('findNearbyTruckArrivals - filters out trucks moving in opposite direction', () => {
  const stops = [
    { id: 1, route_id: 'R1', name: '由北往南收運站', lat: 25.076, lng: 121.650, approach_direction: 'southbound' },
  ];
  const subscribers = new Map([['1', new Set(['G1'])]]);
  const routes = new Map([['R1', { id: 'R1', name: '路線1' }]]);

  // 1. 朝北行駛 (出庫車，is_southbound: false) -> 應被排除
  const northboundArrivals = findNearbyTruckArrivals(
    [{ route_id: 'R1', car_id: 'DEPOT-EXIT-TRUCK', lat: 25.0765, lng: 121.650, is_southbound: false }],
    stops,
    subscribers,
    routes
  );
  assert.equal(northboundArrivals.length, 0);

  // 2. 朝南行駛 (收運正線，is_southbound: true) -> 應放行
  const southboundArrivals = findNearbyTruckArrivals(
    [{ route_id: 'R1', car_id: 'SERVICE-TRUCK', lat: 25.0765, lng: 121.650, is_southbound: true }],
    stops,
    subscribers,
    routes
  );
  assert.equal(southboundArrivals.length, 1);
});

test('findNearbyTruckArrivals - respects adaptive radius for dense stops', () => {
  // 模擬汐萬路一段333巷口 (id: 17) 與相鄰 343巷口 (id: 16, 距 153m)
  const stops = [
    { id: 16, route_id: '221010', name: '343巷口', lat: 25.077625, lng: 121.649992 },
    { id: 17, route_id: '221010', name: '333巷口', lat: 25.076252, lng: 121.649942 },
  ];
  const subscribers = new Map([['17', new Set(['G1'])]]);
  const routes = new Map([['221010', { id: '221010', name: '第1區路線' }]]);

  // 車輛距離 333 巷口 196 公尺 (如 19:36 出庫位置)：
  // 在舊的 250m 半徑下會觸發；但在新的自適應 120m 半徑下，應精準被阻絕！
  const truckAt196m = {
    route_id: '221010',
    car_id: 'KEU-3231',
    lat: 25.0745, // 距 333 巷口約 196m
    lng: 121.649942,
  };

  const arrivalsAt196m = findNearbyTruckArrivals(
    [truckAt196m],
    stops,
    subscribers,
    routes
  );
  assert.equal(arrivalsAt196m.length, 0, '196m 處應被自適應 120m 圍欄阻斷');

  // 車輛到達 80 公尺處 (如 19:56 真到站)：應放行
  const truckAt80m = {
    route_id: '221010',
    car_id: 'KEU-3231',
    lat: 25.07555,
    lng: 121.649942,
  };
  const arrivalsAt80m = findNearbyTruckArrivals(
    [truckAt80m],
    stops,
    subscribers,
    routes
  );
  assert.equal(arrivalsAt80m.length, 1, '80m 處應順利觸發到站通知');
});

