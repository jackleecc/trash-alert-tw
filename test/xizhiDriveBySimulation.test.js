import test from 'node:test';
import assert from 'node:assert/strict';
import { findNearbyTruckArrivals } from '../lib/coreProcessor.js';

test('Xizhi 333 Lane - Complete Tonight Scenario Simulation (Road-Pass vs Real Arrival vs Recycling Follower)', () => {
  // 汐萬路一段333巷口與相鄰站點
  const stops = [
    { id: 16, route_id: '221010', name: '汐萬路一段343巷口', lat: 25.077625, lng: 121.649992, schedule_time: '19:52:00' },
    { id: 17, route_id: '221010', name: '汐萬路一段333巷口', lat: 25.076252, lng: 121.649942, schedule_time: '19:56:00', approach_direction: 'southbound' },
  ];
  const subscribers = new Map([['17', new Set(['TEST_LINE_GROUP'])]]);
  const routes = new Map([['221010', { id: '221010', name: '汐止區第1區路線(晚上)' }]]);

  // --------------------------------------------------------------------------------
  // 情境 1：19:36:12 出庫路過車（KEU-3231 剛從隊部出庫前往連峰街）
  // 狀態：距離 196m、時速 38 km/h、由南往北行駛 (is_southbound: false)
  // --------------------------------------------------------------------------------
  const time1936 = { hour: 19, minute: 36 };
  const truckAt1936 = {
    route_id: '221010',
    car_id: 'KEU-3231',
    lat: 25.0745, // 距 333 巷口約 196m (在舊 250m 圈內，但在新 120m 圈外)
    lng: 121.649942,
    speed: 38, // 市區正常行車時速
    is_southbound: false, // 由南往北出庫
  };

  const arrivals1936 = findNearbyTruckArrivals(
    [truckAt1936],
    stops,
    subscribers,
    routes,
    new Map(),
    time1936
  );

  assert.equal(
    arrivals1936.length,
    0,
    '❌ 19:36 出庫路過車應被全面攔截（時間窗未開放、半徑收縮至120m、時速>25km/h、方向朝北）'
  );

  // --------------------------------------------------------------------------------
  // 情境 2：19:54:00 垃圾車真正抵達（完成連峰街收運，由北往南抵達 333 巷口）
  // 狀態：距離 85m、時速 10 km/h (收運走走停停)、由北往南行駛 (is_southbound: true)
  // --------------------------------------------------------------------------------
  const time1954 = { hour: 19, minute: 54 };
  const truckRealArrival = {
    route_id: '221010',
    car_id: 'KEU-3231',
    lat: 25.0755, // 距 333 巷口約 85m (在自適應 120m 圈內)
    lng: 121.649942,
    speed: 10, // 減速停靠收運中
    is_southbound: true, // 由北往南收運
  };

  const arrivals1954 = findNearbyTruckArrivals(
    [truckRealArrival],
    stops,
    subscribers,
    routes,
    new Map(),
    time1954
  );

  assert.equal(
    arrivals1954.length,
    1,
    '✅ 19:54 真正到站應順利觸發通知！'
  );
  assert.equal(arrivals1954[0].truck.car_id, 'KEU-3231');
  assert.equal(arrivals1954[0].stop.id, 17);
});
