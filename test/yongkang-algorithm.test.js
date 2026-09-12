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

// 台南永康區文化路及周邊真實站點清單
const yongkangStops = [
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
    lat: 23.017220,
    lng: 120.260959,
    order_index: 80,
    schedule_time: '19:44:00',
  },
];

const activeRoutesMap = new Map([
  [
    '70',
    {
      id: '70',
      name: '永康區第70線 (永康里/文化路)',
      city: '台南市',
    },
  ],
]);

const targetGroupId = 'C6f0ecae71723b8aef86290448871e6fa';
const stopSubscribersMap = new Map([
  ['6', new Set([targetGroupId])],
]);

test('Tainan Yongkang - 1. Adaptive Geofence dynamically shrinks for dense stops', () => {
  const stop40 = yongkangStops[1]; // 文化路40號
  const radius = computeAdaptiveRadius(stop40, yongkangStops);

  // 永忠路18號距離文化路40號僅約 69m (< 200m)，圍欄半徑應自動收縮至 120m，避免串線誤判
  assert.equal(radius, 120, '高密度站點圍欄半徑應收縮至 120m');

  // 車輛在文化路36號 (約 5m 處) 應在圍欄內
  const distAt36 = calculateDistanceMeters(23.016963, 120.261576, 23.01695, 120.26155);
  assert.ok(distAt36 <= radius, `抵達 36 號距離 (${distAt36.toFixed(1)}m) 應在 120m 圍欄內`);

  // 車輛在永大二路 (約 250m 處) 應在圍欄外
  const distFar = calculateDistanceMeters(23.016963, 120.261576, 23.018686, 120.260782);
  assert.ok(distFar > radius, `遠端距離 (${distFar.toFixed(1)}m) 應大於 120m 圍欄`);
});

test('Tainan Yongkang - 2. Schedule window validation matches actual arrival time (19:48:31)', () => {
  const schedTime = '19:42:00';

  // 19:48 (實際當日天眼系統記錄到站時間 19:48:31) -> 允許
  assert.equal(isWithinScheduleWindow(schedTime, { hour: 19, minute: 48 }), true, '實際到站 19:48 應在時間窗內');

  // 19:35 (表定前 7 分鐘，容許前 10 分鐘) -> 允許
  assert.equal(isWithinScheduleWindow(schedTime, { hour: 19, minute: 35 }), true, '提早 7 分鐘應在時間窗內');

  // 20:15 (表定後 33 分鐘，容許後 40 分鐘) -> 允許
  assert.equal(isWithinScheduleWindow(schedTime, { hour: 20, minute: 15 }), true, '誤點 33 分鐘應在時間窗內');

  // 17:30 (出勤前提早路過) -> 攔截排除
  assert.equal(isWithinScheduleWindow(schedTime, { hour: 17, minute: 30 }), false, '提早出勤路過應被攔截');

  // 21:30 (夜間收運返隊路過) -> 攔截排除
  assert.equal(isWithinScheduleWindow(schedTime, { hour: 21, minute: 30 }), false, '收班路過應被攔截');
});

test('Tainan Yongkang - 3. 360-degree approach bearing verifies eastward collection path', () => {
  const stop40 = yongkangStops[1];
  const officialBearing = deriveOfficialApproachBearing(stop40, yongkangStops);

  // 由前一站 (文化路128巷10號) 往 文化路40號 為由西向東，航向約 77.6°
  assert.ok(officialBearing !== null, '應成功推導官方進場方位角');
  assert.ok(Math.abs(officialBearing - 77.6) < 1.0, `進場角 (${officialBearing?.toFixed(1)}°) 應約為 77.6°`);

  // 正向清運車輛 (由西向東進場)
  const forwardTruck = {
    lat: 23.01696,
    lng: 120.26150,
    prev_lat: 23.01690,
    prev_lng: 23.01690 ? 120.26120 : 0,
    speed: 12,
  };
  assert.equal(isMovingTowardsApproach(forwardTruck, officialBearing), true, '同向進場車輛應放行');

  // 逆向返程路過車輛 (由東向西行駛)
  const reverseTruck = {
    lat: 23.01696,
    lng: 120.26150,
    prev_lat: 23.01700,
    prev_lng: 120.26180,
    speed: 35,
  };
  assert.equal(isMovingTowardsApproach(reverseTruck, officialBearing), false, '反向路過車輛應被阻斷');

  // 停靠靜止微幅漂移豁免 (時速 2 km/h < 5 km/h)
  const stoppedTruck = {
    lat: 23.01696,
    lng: 120.26157,
    prev_lat: 23.01696,
    prev_lng: 120.26156,
    speed: 2,
  };
  assert.equal(isMovingTowardsApproach(stoppedTruck, officialBearing), true, '停靠作業靜止車輛應豁免方向檢驗');
});

test('Tainan Yongkang - 4. Drive-by speed threshold filters high-speed cruising', () => {
  const timeNow = { hour: 19, minute: 45 };

  // 低速清運車 (時速 12 km/h)
  const workingTruck = [
    {
      route_id: '70',
      car_id: '218-UW',
      lat: 23.01696,
      lng: 120.26156,
      speed: 12,
      waste_type: 'garbage',
    },
  ];
  const arrivalsWorking = findNearbyTruckArrivals(
    workingTruck,
    yongkangStops,
    stopSubscribersMap,
    activeRoutesMap,
    new Map(),
    timeNow
  );
  assert.equal(arrivalsWorking.length, 1, '低速清運車應順利判為到站');

  // 快速路過巡航車 (時速 40 km/h)
  const cruisingTruck = [
    {
      route_id: '70',
      car_id: '218-UW',
      lat: 23.01696,
      lng: 120.26156,
      speed: 40,
      waste_type: 'garbage',
    },
  ];
  const arrivalsCruising = findNearbyTruckArrivals(
    cruisingTruck,
    yongkangStops,
    stopSubscribersMap,
    activeRoutesMap,
    new Map(),
    timeNow
  );
  assert.equal(arrivalsCruising.length, 0, '時速 40km/h 巡航車應被時速門檻過濾');
});

test('Tainan Yongkang - 5. Recycling truck (cartype R) is excluded from garbage alerts', () => {
  const timeNow = { hour: 19, minute: 45 };

  const recyclingTruck = [
    {
      route_id: '70',
      car_id: '219-UW',
      lat: 23.01696,
      lng: 120.26156,
      speed: 10,
      waste_type: 'recycling', // 由 cartype: 'R' 轉化而來
    },
  ];

  const arrivals = findNearbyTruckArrivals(
    recyclingTruck,
    yongkangStops,
    stopSubscribersMap,
    activeRoutesMap,
    new Map(),
    timeNow
  );
  assert.equal(arrivals.length, 0, '資源回收車不應觸發一般垃圾車推播');
});

test('Tainan Yongkang - 6. End-to-end simulation using real clean.tnepb.gov.tw payload', () => {
  // 模擬 clean.tnepb.gov.tw 於 19:48 到達文化路時回傳的即時 ASMX 結構
  const rawCleanTnepbPayload = {
    d: JSON.stringify({
      DATA: [
        {
          car_licence: '218-UW',
          caption: '文化路36號',
          dt: '2026-09-12 19:48:31',
          wgs_x: '120.261576',
          wgs_y: '23.016963',
          cartype: 'N',
          car_id: '976475257',
          linename: '70',
        },
      ],
    }),
  };

  // 1. 透過 truckAdapter 正規化
  const adapted = adaptTruckData(rawCleanTnepbPayload);
  assert.equal(adapted.length, 1);
  assert.equal(adapted[0].car_id, '218-UW');
  assert.equal(adapted[0].waste_type, 'garbage');

  // 2. 模擬 19:48 演算法判定
  const arrivals = findNearbyTruckArrivals(
    adapted,
    yongkangStops,
    stopSubscribersMap,
    activeRoutesMap,
    new Map(),
    { hour: 19, minute: 48 }
  );

  assert.equal(arrivals.length, 1, '新網站即時資料應順利通過演算法並觸發通知');
  assert.equal(arrivals[0].stop.name, '永康區文化路40號');
  assert.equal(arrivals[0].truck.car_id, '218-UW');
  assert.equal(arrivals[0].shouldNotify, true);
  assert.ok(arrivals[0].subscribedGroups.has(targetGroupId));
});

test('Tainan Yongkang - 7. City resolution correctly identifies Tainan routes', () => {
  assert.equal(resolveRouteCity({ city: '台南市' }), '台南市');
  assert.equal(resolveRouteCity({ name: '永康區第70線' }), '台南市');
  assert.equal(resolveRouteCity({ description: '台南市永康區文化路' }), '台南市');
});
