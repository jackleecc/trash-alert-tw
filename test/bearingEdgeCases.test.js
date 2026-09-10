import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateBearing,
  getBearingDifference,
  deriveOfficialApproachBearing,
  isMovingTowardsApproach,
} from '../lib/geoUtils.js';

test('calculateBearing - accurately calculates 360-degree azimuth', () => {
  // 正北 (0°)
  assert.equal(Math.round(calculateBearing(25.0, 121.5, 25.01, 121.5)), 0);
  // 正東 (90°)
  assert.equal(Math.round(calculateBearing(25.0, 121.5, 25.0, 121.51)), 90);
  // 正南 (180°)
  assert.equal(Math.round(calculateBearing(25.01, 121.5, 25.0, 121.5)), 180);
  // 正西 (270°)
  assert.equal(Math.round(calculateBearing(25.0, 121.51, 25.0, 121.5)), 270);
});

test('getBearingDifference - computes minimal angular difference (0~180)', () => {
  // 同向
  assert.equal(getBearingDifference(180, 180), 0);
  // 正南與南南西 (180° vs 202.5°) -> 22.5°
  assert.equal(getBearingDifference(180, 202.5), 22.5);
  // 正北與正南 (0° vs 180°) -> 180°
  assert.equal(getBearingDifference(0, 180), 180);
  // 跨零度 (10° vs 350°) -> 20°
  assert.equal(getBearingDifference(10, 350), 20);
});

test('Edge Case 1: 靜止 / 停靠 GPS 漂移防護 (位移 < 10m 或時速 < 5 km/h 自動豁免)', () => {
  const officialBearing = 180; // 法定進場為正南

  // 1. 車輛停靠在路口作業，時速為 0，因衛星座標微幅 Jitter 導致方向飄向正北 (0°，看似完全逆向)
  const stationaryJitterTruck = {
    lat: 25.076255,
    lng: 121.649942,
    prev_lat: 25.076250, // 位移僅約 0.5m
    prev_lng: 121.649942,
    speed: 0,
  };

  // 應被邊際條件 1 自動豁免放行，不因靜止漂移而誤擋！
  assert.equal(
    isMovingTowardsApproach(stationaryJitterTruck, officialBearing),
    true,
    '靜止停靠中的車輛應自動豁免方位檢測'
  );

  // 2. 移動中的車輛（位移 50m，時速 15 km/h，方向確實朝北 0°，與法定 180° 逆向）
  const actualReverseTruck = {
    lat: 25.0767,
    lng: 121.649942,
    prev_lat: 25.0762,
    prev_lng: 121.649942,
    speed: 15,
  };
  assert.equal(
    isMovingTowardsApproach(actualReverseTruck, officialBearing),
    false,
    '實際移動中且方向逆向（夾角 180°）的車輛應被阻斷'
  );
});

test('Edge Case 2: 道路彎道容許（扇形夾角 <= 90° 放行，> 90° 阻絕）', () => {
  const officialBearing = 180; // 法定正南進場

  // 1. 道路轉彎，車輛以南南西 220° (夾角 40° <= 90°) 行駛進場 -> 應放行
  const curvedRoadTruck = {
    lat: 25.075,
    lng: 121.648,
    prev_lat: 25.076,
    prev_lng: 121.649,
    speed: 15,
  };
  assert.equal(isMovingTowardsApproach(curvedRoadTruck, officialBearing), true);

  // 2. 完全逆向出庫車 (朝北 0° 行駛，夾角 180° > 90°) -> 應阻絕
  const outboundTruck = {
    lat: 25.076,
    lng: 121.649,
    prev_lat: 25.075,
    prev_lng: 121.649,
    speed: 35,
  };
  assert.equal(isMovingTowardsApproach(outboundTruck, officialBearing), false);
});

test('Edge Case 3: 路線首站 (Rank 1) 無前站，自動豁免方向檢核', () => {
  const stops = [
    { id: 1, rank: '1', lat: 25.078, lng: 121.649 },
    { id: 2, rank: '2', lat: 25.082, lng: 121.649 },
  ];

  // 首站無法推導前置進場角 -> 應回傳 null
  const bearing = deriveOfficialApproachBearing(stops[0], stops);
  assert.equal(bearing, null);

  // officialBearing 為 null 時，isMovingTowardsApproach 應一律放行
  assert.equal(isMovingTowardsApproach({ lat: 25.0, lng: 121.0 }, bearing), true);
});

test('Edge Case 4: 跨段大時差/長站距調度 (中場回隊部)，自動豁免虛擬直線', () => {
  // 模擬汐止路線 221010：第 12 站 (烘內) 18:45 到 第 13 站 (連峰街) 19:38 (距離 3.3km，時差 53分)
  const stops = [
    { id: 12, rank: '12', lat: 25.1067, lng: 121.6423, schedule_time: '18:45:00' },
    { id: 13, rank: '13', lat: 25.0768, lng: 121.6465, schedule_time: '19:38:00' },
  ];

  const bearing = deriveOfficialApproachBearing(stops[1], stops);
  assert.equal(bearing, null, '相鄰站距 > 1500m 或時差 > 20分應自動豁免方向性檢核');
});

test('Edge Case 5: 相鄰站距極短 (< 50m) 自動往前追溯前兩站取長基線', () => {
  // 模擬第 8 站、第 9 站、第 11 站 (第 9 與 11 站距離僅 42m)
  const stops = [
    { id: 8, rank: '8', lat: 25.1010, lng: 121.6445 }, // 穩定前前站 (距第 11 站約 425m)
    { id: 9, rank: '9', lat: 25.1045, lng: 121.6439 }, // 距第 11 站僅 42m
    { id: 11, rank: '11', lat: 25.1048, lng: 121.6438 }, // 目標站
  ];

  const bearing = deriveOfficialApproachBearing(stops[2], stops);
  assert.ok(bearing !== null, '應成功回傳回溯長基線進場角');
  // 驗證計算出的航向是基於第 8 站往第 11 站的穩定長基線 (朝北偏西約 350°)
  assert.ok(bearing > 340 || bearing < 20, `Expected ~350°, got ${bearing}`);
});
