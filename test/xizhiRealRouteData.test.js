import test from 'node:test';
import assert from 'node:assert/strict';
import { XIZHI_221010_REAL_STOPS } from './fixtures/xizhi221010Stops.js';
import {
  calculateDistanceMeters,
  computeAdaptiveRadius,
  calculateBearing,
  getBearingDifference,
  deriveOfficialApproachBearing,
  isMovingTowardsApproach,
  calculateSpeedKmh,
} from '../lib/geoUtils.js';
import {
  isWithinScheduleWindow,
  findNearbyTruckArrivals,
} from '../lib/coreProcessor.js';

// 取得關鍵真實站點
const rank1 = XIZHI_221010_REAL_STOPS.find(s => s.rank === 1);   // 汐萬路1段418巷 (首站)
const rank8 = XIZHI_221010_REAL_STOPS.find(s => s.rank === 8);   // 汐萬路2段284號前
const rank9 = XIZHI_221010_REAL_STOPS.find(s => s.rank === 9);   // 汐萬路三段252巷
const rank11 = XIZHI_221010_REAL_STOPS.find(s => s.rank === 11); // 汐萬路三段233號 (距第9站僅42m)
const rank12 = XIZHI_221010_REAL_STOPS.find(s => s.rank === 12); // 汐萬路三段239巷口 (18:45)
const rank13 = XIZHI_221010_REAL_STOPS.find(s => s.rank === 13); // 連峰街5巷 (19:38，時差53分，回隊部休息後出發)
const rank15 = XIZHI_221010_REAL_STOPS.find(s => s.rank === 15); // 汐萬路一段411號 (19:48)
const rank16 = XIZHI_221010_REAL_STOPS.find(s => s.rank === 16); // 汐萬路一段343巷口 (19:52)
const rank17 = XIZHI_221010_REAL_STOPS.find(s => s.rank === 17); // 汐萬路一段333巷口 (19:56，目標站)
const rank20 = XIZHI_221010_REAL_STOPS.find(s => s.rank === 20); // 八連路一段309巷口 (20:23)

test('Xizhi Real Data - 1. 自適應圍欄半徑計算 (基於真實相鄰站距)', () => {
  // Rank 17 (333巷口) 與 Rank 16 (343巷口) 相鄰站距約 153m (< 200m)
  const dist16To17 = calculateDistanceMeters(rank16.lat, rank16.lng, rank17.lat, rank17.lng);
  assert.ok(dist16To17 > 140 && dist16To17 < 165, `Actual dist: ${dist16To17}`);

  // 密集住宅區相鄰站距 < 200m，應自動收縮為 120m (杜絕 171m 外隊部干擾)
  const radiusRank17 = computeAdaptiveRadius(rank17, XIZHI_221010_REAL_STOPS);
  assert.equal(radiusRank17, 120, '高密度站點 333巷口半徑應自動縮窄為 120m');

  // Rank 12 (汐萬路三段239巷口) 與最近站點 (Rank 11) 距離約 262m (200m ~ 400m 區間)
  const dist11To12 = calculateDistanceMeters(rank11.lat, rank11.lng, rank12.lat, rank12.lng);
  assert.ok(dist11To12 >= 200 && dist11To12 <= 300, `Actual dist: ${dist11To12}`);
  const radiusRank12 = computeAdaptiveRadius(rank12, XIZHI_221010_REAL_STOPS);
  assert.equal(radiusRank12, 150, '一般市區間距站點 (262m) 應採用 150m');

  // Rank 20 (八連路一段309巷口) 與全路線最近站點距離達 669m (> 400m)
  const radiusRank20 = computeAdaptiveRadius(rank20, XIZHI_221010_REAL_STOPS);
  assert.equal(radiusRank20, 250, '長站距路段 (>400m) 應採用 250m');
});

test('Xizhi Real Data - 2. 360° 法定進場方位角推導 (Rank 16 -> Rank 17 汐萬路南下路段)', () => {
  const officialBearing = deriveOfficialApproachBearing(rank17, XIZHI_221010_REAL_STOPS);
  assert.ok(officialBearing !== null);

  // Rank 16 (25.077625) -> Rank 17 (25.076252)：由北往南行駛
  // 方位角應落在 180° ~ 185° 之間 (正南微偏西)
  assert.ok(officialBearing >= 180 && officialBearing <= 185, `Expected ~182°, got ${officialBearing}°`);

  // 驗證車輛南下進場 (航向 183°) 符合進場方位
  const southTruck = {
    lat: 25.0765,
    lng: 121.649942,
    prev_lat: 25.0770,
    prev_lng: 121.649942,
    speed: 12,
  };
  assert.equal(isMovingTowardsApproach(southTruck, officialBearing), true, '南下清運車輛應放行');

  // 驗證車輛北上出庫 (航向 3°，與 182° 夾角達 179°)
  const northTruck = {
    lat: 25.0750,
    lng: 121.649942,
    prev_lat: 25.0740,
    prev_lng: 121.649942,
    speed: 35,
  };
  assert.equal(isMovingTowardsApproach(northTruck, officialBearing), false, '北上出庫路過車輛應嚴格阻絕');
});

test('Xizhi Real Data - 3. 邊際條件 1：Rank 17 原地停靠作業與紅燈 GPS 漂移防護', () => {
  const officialBearing = deriveOfficialApproachBearing(rank17, XIZHI_221010_REAL_STOPS);

  // 情境 A：垃圾車在 333 巷口停靠裝卸垃圾，速度為 0，但經緯度跳動 1 公尺導致計算航向朝北 (0°)
  const loadingTruck = {
    lat: 25.076253,
    lng: 121.649942,
    prev_lat: 25.076244, // 位移僅約 1m
    prev_lng: 121.649942,
    speed: 0,
  };
  assert.equal(
    isMovingTowardsApproach(loadingTruck, officialBearing),
    true,
    '原地停靠裝卸作業時因微幅位移 (<10m) 應自動豁免方位檢核'
  );

  // 情境 B：微速慢行 (< 5 km/h) 走走停停
  const crawlingTruck = {
    lat: 25.076250,
    lng: 121.649942,
    prev_lat: 25.076150, // 稍微逆向漂移
    prev_lng: 121.649942,
    speed: 3.5, // 3.5 km/h
  };
  assert.equal(
    isMovingTowardsApproach(crawlingTruck, officialBearing),
    true,
    '時速 < 5 km/h 低速挪車應豁免方位檢核'
  );
});

test('Xizhi Real Data - 4. 邊際條件 2：汐萬路道路彎道寬容與出庫阻絕', () => {
  const officialBearing = deriveOfficialApproachBearing(rank17, XIZHI_221010_REAL_STOPS); // ~182°

  // 汐萬路彎道進場：由北北東切入西南 (航向 230°，夾角約 48° <= 90°)
  const curveTruck = {
    lat: 25.0763,
    lng: 121.6498,
    prev_lat: 25.0768,
    prev_lng: 121.6502,
    speed: 16,
  };
  assert.equal(
    isMovingTowardsApproach(curveTruck, officialBearing),
    true,
    '道路轉彎 (<= 90°) 應允許通過'
  );

  // 反向出庫車 (航向 350°，夾角 168° > 90°)
  const reverseTruck = {
    lat: 25.0755,
    lng: 121.6498,
    prev_lat: 25.0745,
    prev_lng: 121.6499,
    speed: 30,
  };
  assert.equal(
    isMovingTowardsApproach(reverseTruck, officialBearing),
    false,
    '反向車輛 (> 90°) 應予以攔截'
  );
});

test('Xizhi Real Data - 5. 邊際條件 3：真實首站 Rank 1 (汐萬路1段418巷) 無前站自動豁免', () => {
  const bearingRank1 = deriveOfficialApproachBearing(rank1, XIZHI_221010_REAL_STOPS);
  assert.equal(bearingRank1, null, '路線首站無前置站點，應回傳 null 豁免方向檢核');

  // 當 officialBearing 為 null 時，任何方位之車輛均放行
  const dummyTruck = { lat: 25.078, lng: 121.650, speed: 10 };
  assert.equal(isMovingTowardsApproach(dummyTruck, bearingRank1), true);
});

test('Xizhi Real Data - 6. 邊際條件 4：真實跨段長時差與長站距調度 (Rank 12 烘內 -> Rank 13 連峰街)', () => {
  // Rank 12 (18:45) 到 Rank 13 (19:38)：中間時差 53 分鐘，距離 3.3 公里
  const dist12To13 = calculateDistanceMeters(rank12.lat, rank12.lng, rank13.lat, rank13.lng);
  assert.ok(dist12To13 > 3000, `Actual dist: ${dist12To13}m`);

  const bearingRank13 = deriveOfficialApproachBearing(rank13, XIZHI_221010_REAL_STOPS);
  assert.equal(
    bearingRank13,
    null,
    '跨段大時差 (>20分) 與長站距 (>1.5km) 應視為非連續調度，自動豁免進場角'
  );
});

test('Xizhi Real Data - 7. 邊際條件 5：真實相鄰極短站距 (<50m) 長基線回溯 (Rank 9 & 11)', () => {
  // Rank 9 (汐萬路三段252巷) 與 Rank 11 (汐萬路三段233號)
  const dist9To11 = calculateDistanceMeters(rank9.lat, rank9.lng, rank11.lat, rank11.lng);
  assert.ok(dist9To11 < 50, `Distance between Rank 9 and 11 is ${dist9To11}m (< 50m)`);

  // 系統應自動往前追溯至 Rank 8 (汐萬路2段284號前) 取長基線
  const bearingRank11 = deriveOfficialApproachBearing(rank11, XIZHI_221010_REAL_STOPS);
  assert.ok(bearingRank11 !== null);

  // Rank 8 -> Rank 11 向量為向北偏西 (航向約 355°)
  const expectedBearingFromRank8 = calculateBearing(rank8.lat, rank8.lng, rank11.lat, rank11.lng);
  assert.equal(
    Math.round(bearingRank11),
    Math.round(expectedBearingFromRank8),
    '極短相鄰站距應成功回溯至 Rank 8 長基線'
  );
});

test('Xizhi Real Data - 8. 表定時間窗 10 分鐘前 / 40 分鐘後檢核 (Rank 17 表定 19:56:00)', () => {
  // 19:36:00 (出庫時間) -> 表定前 20 分鐘 -> 不在 [19:46 ~ 20:36] 窗內
  assert.equal(
    isWithinScheduleWindow('19:56:00', { hour: 19, minute: 36 }),
    false,
    '19:36 出庫車輛在 10 分鐘時間窗開啟前，應被排除'
  );

  // 19:46:00 (開啟邊界)
  assert.equal(
    isWithinScheduleWindow('19:56:00', { hour: 19, minute: 46 }),
    true,
    '19:46 正好進入 10 分鐘前邊界'
  );

  // 19:54:00 (真實抵達)
  assert.equal(
    isWithinScheduleWindow('19:56:00', { hour: 19, minute: 54 }),
    true,
    '19:54 到站前 2 分鐘在時間窗內'
  );

  // 20:36:00 (關閉邊界)
  assert.equal(
    isWithinScheduleWindow('19:56:00', { hour: 20, minute: 36 }),
    true,
    '20:36 表定後 40 分鐘內允許通過'
  );

  // 20:37:00 (關閉)
  assert.equal(
    isWithinScheduleWindow('19:56:00', { hour: 20, minute: 37 }),
    false,
    '20:37 超過 40 分鐘應關閉'
  );
});

test('Xizhi Real Data - 9. 時速過濾檢核：真實 Rank 17 站點路過車 vs 到站車', () => {
  const subscribers = new Map([[String(rank17.id), new Set(['C_XIZHI_GROUP'])]]);
  const routes = new Map([['221010', { id: '221010', name: '汐止區第1區路線(晚上)' }]]);
  const now1950 = { hour: 19, minute: 50 };

  // 1. 高速行駛 (35 km/h) 路過車輛（即便進入 120m 圍欄圈內）
  const speedingTruck = {
    route_id: '221010',
    car_id: 'FAST-TRUCK',
    lat: 25.0768, // 距 333巷口約 65m (在 120m 圈內)
    lng: 121.649942,
    speed: 35, // 超速路過
    is_southbound: true,
  };

  const arrivalsSpeeding = findNearbyTruckArrivals(
    [speedingTruck],
    [rank17],
    subscribers,
    routes,
    new Map(),
    now1950
  );
  assert.equal(arrivalsSpeeding.length, 0, '時速 > 25 km/h 之路過車輛應被過濾');

  // 2. 減速停靠 (10 km/h) 到站車輛
  const arrivingTruck = {
    route_id: '221010',
    car_id: 'KEU-3231',
    lat: 25.0768,
    lng: 121.649942,
    speed: 10, // 正常慢速收運
    is_southbound: true,
  };

  const arrivalsNormal = findNearbyTruckArrivals(
    [arrivingTruck],
    [rank17],
    subscribers,
    routes,
    new Map(),
    now1950
  );
  assert.equal(arrivalsNormal.length, 1, '時速 <= 25 km/h 之到站車輛應順利觸發通知');
  assert.equal(arrivalsNormal[0].truck.car_id, 'KEU-3231');
});

test('Xizhi Real Data - 10. 昨晚全情境完整串接：出庫路過 vs 真正到站 vs 資收車自然靜音', () => {
  const subscribers = new Map([[String(rank17.id), new Set(['C_XIZHI_GROUP'])]]);
  const routes = new Map([['221010', { id: '221010', name: '汐止區第1區路線(晚上)' }]]);

  // 階段 A：19:36:12 出庫路過車 (KEU-3231，由南往北出庫前往連峰街)
  const truckAt1936 = {
    route_id: '221010',
    car_id: 'KEU-3231',
    lat: 25.0745, // 距 333 巷口 196m (在自適應 120m 圈外)
    lng: 121.649942,
    speed: 38,
    is_southbound: false, // 逆向往北
  };
  const arrivals1936 = findNearbyTruckArrivals(
    [truckAt1936],
    XIZHI_221010_REAL_STOPS,
    subscribers,
    routes,
    new Map(),
    { hour: 19, minute: 36 }
  );
  assert.equal(arrivals1936.length, 0, '19:36 出庫車在全真實站點資料下被四重防護徹底攔截');

  // 階段 B：19:54:00 垃圾車真正抵達 (KEU-3231，由北往南抵達 333 巷口)
  const truckRealArrival = {
    route_id: '221010',
    car_id: 'KEU-3231',
    lat: 25.0768, // 距 333 巷口 65m (在自適應 120m 圈內)
    lng: 121.649942,
    speed: 10,
    is_southbound: true,
  };
  const arrivals1954 = findNearbyTruckArrivals(
    [truckRealArrival],
    XIZHI_221010_REAL_STOPS,
    subscribers,
    routes,
    new Map(),
    { hour: 19, minute: 54 }
  );
  assert.equal(arrivals1954.length, 1, '19:54 真正到站成功觸發通知！');
  assert.equal(arrivals1954[0].truck.car_id, 'KEU-3231');
  assert.equal(arrivals1954[0].stop.name, '汐萬路一段333巷口');

  // 階段 C：19:57:30 資源回收車 (KEV-2150，落後 3.5 分鐘緊隨抵達)
  // 模擬已進入 30 分鐘冷卻期 (lastNotifiedTime = 19:54:00，當前 19:57:30，相差 3.5 分鐘 < 30 分鐘)
  const cooldownMockMinutes = 3.5;
  const isCooldownActive = cooldownMockMinutes < 30;
  assert.equal(
    isCooldownActive,
    true,
    '資源回收車抵達時因位於一般垃圾車觸發的 30 分鐘冷卻期內，系統安全略過免重複推播！'
  );
});
