import test from 'node:test';
import assert from 'node:assert/strict';
import { findNearbyTruckArrivals } from '../lib/arrivalMatcher.js';
import { XIZHI_221010_REAL_STOPS } from './fixtures/xizhi221010Stops.js';

test('xizhiRoadPassGuard - rejects 130-UY (route 221032) at 111m when full route topology derives southbound approach bearing', () => {
  // 汐萬路一段333巷口 (Rank 17 in real stops)
  const stop333 = {
    id: 3,
    rank: 17,
    order_index: 17,
    route_id: '221010',
    name: '汐萬路一段333巷口',
    schedule_time: '19:56:00',
    lat: 25.076252,
    lng: 121.649942,
  };

  const routesMap = new Map([
    ['221010', { id: '221010', name: '汐止區第1區路線(晚上)', city: '新北市' }],
  ]);

  const stopSubscribersMap = new Map([
    ['3', new Set(['C8b514cecb1141d158bb44a19f33eb291'])],
  ]);

  // 乾淨的信任名單：僅信任官方 221010，絕不信任外來路線 221032
  const routeTrustedLinidsMap = new Map([
    ['221010', new Set(['221010'])],
  ]);

  // 19:42:11 的路過車輛 130-UY (官方 linid 為 221032，朝北出庫逆向行駛)
  const driveByTruck = {
    car_id: '130-UY',
    route_id: '221032', // 非 221010
    lat: 25.07725,
    lng: 121.64994,
    prev_lat: 25.07600, // 由南往北行駛 (northbound)
    prev_lng: 121.64994,
    speed: 18,
    waste_type: 'garbage',
  };

  // 19:56:00 的真實執勤清運車輛 647-BX (官方 linid 為 221010，朝南順向收運)
  const realCollectionTruck = {
    car_id: '647-BX',
    route_id: '221010',
    lat: 25.07680,
    lng: 121.64995,
    prev_lat: 25.07760, // 由北往南行駛 (southbound ~180°)
    prev_lng: 121.64998,
    speed: 12,
    waste_type: 'garbage',
  };

  const twNowInfo = { hour: 19, minute: 42, now: new Date('2026-10-01T11:42:11Z') };

  // 傳入完整的路線拓撲 XIZHI_221010_REAL_STOPS
  const arrivalsAt1942 = findNearbyTruckArrivals(
    [driveByTruck],
    [stop333],
    stopSubscribersMap,
    routesMap,
    routeTrustedLinidsMap,
    twNowInfo,
    XIZHI_221010_REAL_STOPS
  );

  // 130-UY 必須被攔截 (逆向且非信任 linid)
  assert.equal(arrivalsAt1942.length, 0, '130-UY driving northbound on route 221032 must be rejected');

  // 真實車輛 647-BX 於 19:56 順向南下進場時必須成功匹配
  const twNowAt1956 = { hour: 19, minute: 56, now: new Date('2026-10-01T11:56:00Z') };
  const arrivalsAt1956 = findNearbyTruckArrivals(
    [realCollectionTruck],
    [stop333],
    stopSubscribersMap,
    routesMap,
    routeTrustedLinidsMap,
    twNowAt1956,
    XIZHI_221010_REAL_STOPS
  );

  assert.equal(arrivalsAt1956.length, 1, 'Real truck 647-BX must be matched');
  assert.equal(arrivalsAt1956[0].truck.car_id, '647-BX');
  assert.equal(arrivalsAt1956[0].shouldNotify, true);
});
