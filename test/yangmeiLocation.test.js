import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateDistanceMeters,
  computeAdaptiveRadius,
  deriveOfficialApproachBearing,
  isMovingTowardsApproach,
} from '../lib/geoUtils.js';
import {
  findNearbyTruckArrivals,
  isWithinScheduleWindow,
  resolveRouteCity,
} from '../lib/coreProcessor.js';
import { adaptTruckData } from '../lib/truckAdapter.js';

// 桃園市楊梅區中山南路及周邊真實站點資料
const yangmeiStops = [
  {
    id: 10,
    route_id: 'lagi2-006_2_21',
    name: '大平街246號(右邊)',
    lat: 24.910226,
    lng: 121.140549,
    order_index: 1,
    schedule_time: '17:20:00',
  },
  {
    id: 11,
    route_id: 'lagi2-006_2_21',
    name: '中山南路100號',
    lat: 24.907498,
    lng: 121.137464,
    order_index: 2,
    schedule_time: '17:24:00',
  },
  {
    id: 12,
    route_id: 'lagi2-006_2_21',
    name: '楊梅區中山南路146號',
    lat: 24.907648,
    lng: 121.136540,
    order_index: 3,
    schedule_time: '17:25:00',
  },
  {
    id: 13,
    route_id: 'lagi2-006_2_21',
    name: '中山南路336巷口',
    lat: 24.906638,
    lng: 121.134060,
    order_index: 4,
    schedule_time: '17:27:00',
  },
  {
    id: 14,
    route_id: 'lagi2-006_2_21',
    name: '中山南路522巷',
    lat: 24.905206,
    lng: 121.129214,
    order_index: 5,
    schedule_time: '17:34:00',
  },
];

const activeRoutesMap = new Map([
  [
    'lagi2-006_2_21',
    {
      id: 'lagi2-006_2_21',
      name: '楊梅區 垃圾清運路十七線',
      city: '桃園市',
      active_days: [1, 2, 4, 5, 6],
    },
  ],
]);

const targetGroupId = 'Cbc0aef28eb6226fafe1ea7e5a6e4487e';
const stopSubscribersMap = new Map([
  ['12', new Set([targetGroupId])],
]);

test('Taoyuan Yangmei - 1. Adaptive Geofence dynamically sizes around 146号', () => {
  const stop146 = yangmeiStops[2]; // 中山南路146號
  const radius = computeAdaptiveRadius(stop146, yangmeiStops);

  // 中山南路100號距離146號約 95m，自適應圍欄收縮至 120m ~ 150m，防止跨路干擾
  assert.ok(radius >= 120 && radius <= 200, `圍欄半徑 (${radius}m) 應在合理自適應範圍 [120m, 200m]`);

  // 車輛在門牌 146 號門前 (距離約 11m 處) 應在圍欄內
  const distAtDoor = calculateDistanceMeters(24.907648, 121.13654, 24.90755, 121.13651);
  assert.ok(distAtDoor <= radius, `門前距離 (${distAtDoor.toFixed(1)}m) 應在圍欄內`);

  // 車輛在楊梅火車站前 (約 1.2km 處) 應在圍欄外
  const distFar = calculateDistanceMeters(24.907648, 121.13654, 24.9142, 121.146);
  assert.ok(distFar > radius, `遠距 (${distFar.toFixed(1)}m) 應超出圍欄`);
});

test('Taoyuan Yangmei - 2. Schedule window validation matches estimated arrival time (17:25:00)', () => {
  const schedTime = '17:25:00';

  // 17:25 (表定準時到站) -> 允許
  assert.equal(isWithinScheduleWindow(schedTime, { hour: 17, minute: 25 }), true, '準時 17:25 應在時間窗內');

  // 17:18 (提早 7 分鐘，容許前 10 分鐘) -> 允許
  assert.equal(isWithinScheduleWindow(schedTime, { hour: 17, minute: 18 }), true, '提早 7 分鐘應在時間窗內');

  // 17:55 (誤點 30 分鐘，容許後 40 分鐘) -> 允許
  assert.equal(isWithinScheduleWindow(schedTime, { hour: 17, minute: 55 }), true, '誤點 30 分鐘應在時間窗內');

  // 15:30 (出勤前提早路過) -> 攔截排除
  assert.equal(isWithinScheduleWindow(schedTime, { hour: 15, minute: 30 }), false, '提早路過應被攔截');

  // 21:00 (收班夜間路過) -> 攔截排除
  assert.equal(isWithinScheduleWindow(schedTime, { hour: 21, minute: 0 }), false, '收班路過應被攔截');
});

test('Taoyuan Yangmei - 3. 360-degree approach bearing verifies southwest collection path', () => {
  const stop146 = yangmeiStops[2];
  const officialBearing = deriveOfficialApproachBearing(stop146, yangmeiStops);

  // 中山南路由東南東往西北西行駛 (方位角約 280°)
  assert.ok(officialBearing >= 260 && officialBearing <= 300, `進場方位角 (${Math.round(officialBearing)}°) 應為西向/西北西向`);

  // 同向行駛（由 100 號往 146 號方向行駛）：允許放行
  const forwardTruck = {
    car_id: 'KEK-3178',
    route_id: 'lagi2-006_2_21',
    prev_lat: 24.907498,
    prev_lng: 121.137464,
    lat: 24.907648,
    lng: 121.136540,
    speed: 15,
  };
  assert.equal(isMovingTowardsApproach(forwardTruck, officialBearing), true, '同向收運作業車輛應放行');

  // 逆向行駛（由 146 號逆向往 100 號反向行駛）：阻斷排除
  const reverseTruck = {
    car_id: 'KEK-3178',
    route_id: 'lagi2-006_2_21',
    prev_lat: 24.907648,
    prev_lng: 121.136540,
    lat: 24.907498,
    lng: 121.137464,
    speed: 20,
  };
  assert.equal(isMovingTowardsApproach(reverseTruck, officialBearing), false, '逆向行駛路過車輛應被阻斷');

  // 停靠作業中（speed = 0，靜止漂移豁免）：允許放行
  const stoppedTruck = {
    car_id: 'KEK-3178',
    route_id: 'lagi2-006_2_21',
    lat: 24.90755,
    lng: 121.13651,
    speed: 0,
  };
  assert.equal(isMovingTowardsApproach(stoppedTruck, officialBearing), true, '停靠靜止垃圾車應豁免方位角檢驗');
});

test('Taoyuan Yangmei - 4. Drive-by speed filter correctly admits work speeds and blocks cruising', () => {
  const stop146 = yangmeiStops[2];

  // 慢速收運作業 (時速 12 km/h) -> 放行通知
  const slowTruck = [
    {
      route_id: 'lagi2-006_2_21',
      car_id: 'KEK-3178',
      lat: stop146.lat,
      lng: stop146.lng,
      waste_type: 'garbage',
      speed: 12,
    },
  ];
  const slowArrivals = findNearbyTruckArrivals(
    slowTruck,
    yangmeiStops,
    stopSubscribersMap,
    activeRoutesMap,
    new Map(),
    { hour: 17, minute: 25 }
  );
  assert.equal(slowArrivals.length, 1, '慢速清運 (12 km/h) 應放行推播');

  // 快速巡航通過 (時速 45 km/h) -> 阻斷
  const fastTruck = [
    {
      route_id: 'lagi2-006_2_21',
      car_id: 'KEK-3178',
      lat: stop146.lat,
      lng: stop146.lng,
      waste_type: 'garbage',
      speed: 45,
    },
  ];
  const fastArrivals = findNearbyTruckArrivals(
    fastTruck,
    yangmeiStops,
    stopSubscribersMap,
    activeRoutesMap,
    new Map(),
    { hour: 17, minute: 25 }
  );
  assert.equal(fastArrivals.length, 0, '快速巡航 (45 km/h) 應被阻斷排除');
});

test('Taoyuan Yangmei - 5. Waste type filter admits garbage trucks and silences recycling trucks', () => {
  const stop146 = yangmeiStops[2];

  // 一般垃圾車 (KEK-3178) -> 發送通知
  const garbageArrivals = findNearbyTruckArrivals(
    [
      {
        route_id: 'lagi2-006_2_21',
        car_id: 'KEK-3178',
        lat: stop146.lat,
        lng: stop146.lng,
        waste_type: 'garbage',
        speed: 10,
      },
    ],
    yangmeiStops,
    stopSubscribersMap,
    activeRoutesMap,
    new Map(),
    { hour: 17, minute: 25 }
  );
  assert.equal(garbageArrivals.length, 1, '一般垃圾車應發送到站提醒');
  assert.equal(garbageArrivals[0].truck.car_id, 'KEK-3178');

  // 資源回收車 (KEU-1590) -> 靜音排除
  const recycleArrivals = findNearbyTruckArrivals(
    [
      {
        route_id: 'lagi2-006_2_21',
        car_id: 'KEU-1590',
        lat: stop146.lat,
        lng: stop146.lng,
        waste_type: 'recycling',
        speed: 10,
      },
    ],
    yangmeiStops,
    stopSubscribersMap,
    activeRoutesMap,
    new Map(),
    { hour: 17, minute: 25 }
  );
  assert.equal(recycleArrivals.length, 0, '資源回收車應自然靜音不推播');
});

test('Taoyuan Yangmei - 6. resolveRouteCity resolves 桃園市 for Yangmei', () => {
  assert.equal(resolveRouteCity({ city: '桃園市' }), '桃園市');
  assert.equal(resolveRouteCity({ name: '楊梅區 垃圾清運路十七線' }), '桃園市');
  assert.equal(resolveRouteCity({ description: '桃園市楊梅區中山南路' }), '桃園市');
});

test('Taoyuan Yangmei - 7. adaptTruckData correctly parses Taoyuan API schema and speed', () => {
  const rawApiOutput = {
    result: [
      {
        gid: 'lagi2-006',
        lng: 121.1096028,
        lat: 24.9455483,
        speed: 15,
        car_type: '垃圾車',
        car_id: 'KEK-3178',
        clean_status: '行駛中',
        route_id: 'lagi2-006_2_21',
        gpstime: {
          year: 126,
          month: 8,
          date: 14,
          hours: 20,
          minutes: 56,
          seconds: 27,
        },
      },
    ],
  };

  const adapted = adaptTruckData(rawApiOutput);
  assert.equal(adapted.length, 1);
  assert.equal(adapted[0].route_id, 'lagi2-006_2_21');
  assert.equal(adapted[0].car_id, 'KEK-3178');
  assert.equal(adapted[0].waste_type, 'garbage');
  assert.equal(adapted[0].speed, 15);
  assert.equal(adapted[0].time, '2026-09-14 20:56:27');
});
