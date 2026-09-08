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
  // 表定 19:30:00，預設前 20 分鐘 (19:10) 到 後 40 分鐘 (20:10)
  const sched = '19:30:00';

  // 1. 提早 10 分鐘 (19:20) -> true
  assert.equal(isWithinScheduleWindow(sched, { hour: 19, minute: 20 }), true);

  // 2. 延後 25 分鐘 (19:55) -> true
  assert.equal(isWithinScheduleWindow(sched, { hour: 19, minute: 55 }), true);

  // 3. 提早 25 分鐘 (19:05) -> false (超過 20 分鐘)
  assert.equal(isWithinScheduleWindow(sched, { hour: 19, minute: 5 }), false);

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
