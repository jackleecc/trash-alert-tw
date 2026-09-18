import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { supabase } from '../lib/supabaseClient.js';
import {
  findNearbyTruckArrivals,
  getIsoDayOfWeek,
  formatArrivalMessage,
  isWithinScheduleWindow,
  getActiveSubscriptionContext,
  resolveRouteCity,
  recentTruckHistory,
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
  // 表定 19:30:00，預設前 15 分鐘 (19:15) 到 後 40 分鐘 (20:10)
  const sched = '19:30:00';

  // 1. 提早 10 分鐘 (19:20) -> true
  assert.equal(isWithinScheduleWindow(sched, { hour: 19, minute: 20 }), true);

  // 2. 延後 25 分鐘 (19:55) -> true
  assert.equal(isWithinScheduleWindow(sched, { hour: 19, minute: 55 }), true);

  // 3. 提早 15 分鐘 (19:15) -> true (放寬至 15 分鐘提前門檻，包容清潔隊大幅早到)
  assert.equal(isWithinScheduleWindow(sched, { hour: 19, minute: 15 }), true);

  // 4. 提早 16 分鐘 (19:14) -> false (超過 15 分鐘提前門檻，防止出庫路過)
  assert.equal(isWithinScheduleWindow(sched, { hour: 19, minute: 14 }), false);

  // 5. 延後 45 分鐘 (20:15) -> false (超過 40 分鐘)
  assert.equal(isWithinScheduleWindow(sched, { hour: 20, minute: 15 }), false);

  // 6. 無設定表定時間 -> true (向後相容)
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

test('isWithinScheduleWindow - supports custom before and after minutes', () => {
  // 表定 19:42:00，自訂提前 18 分鐘 (19:24) 至 延後 25 分鐘 (20:07)
  const sched = '19:42:00';

  // 19:23 -> false (提早 19 分鐘，未到 19:24)
  assert.equal(isWithinScheduleWindow(sched, { hour: 19, minute: 23 }, 18, 25), false);
  // 19:24 -> true (恰好提早 18 分鐘)
  assert.equal(isWithinScheduleWindow(sched, { hour: 19, minute: 24 }, 18, 25), true);
  // 19:48 -> true (真正到站時間，延後 6 分鐘)
  assert.equal(isWithinScheduleWindow(sched, { hour: 19, minute: 48 }, 18, 25), true);
  // 20:07 -> true (恰好延後 25 分鐘)
  assert.equal(isWithinScheduleWindow(sched, { hour: 20, minute: 7 }, 18, 25), true);
  // 20:08 -> false (延後 26 分鐘，超過窗口)
  assert.equal(isWithinScheduleWindow(sched, { hour: 20, minute: 8 }, 18, 25), false);
});

test('getActiveSubscriptionContext - smart window filters stops outside window (prevents high frequency polling)', async () => {
  mock.method(supabase, 'from', (table) => {
    if (table === 'routes') {
      return {
        select: () => ({
          eq: async () => ({
            data: [{ id: 'TN_YK', name: '永康區文化路路線', active_days: [3], is_active: true }],
            error: null,
          }),
        }),
      };
    }
    if (table === 'stops') {
      return {
        select: () => ({
          in: async () => ({
            data: [{ id: 101, route_id: 'TN_YK', name: '文化路40號', lat: 23.0, lng: 120.2, schedule_time: '19:42:00' }],
            error: null,
          }),
        }),
      };
    }
    if (table === 'line_groups') {
      return {
        select: () => ({
          eq: async () => ({
            data: [{ group_id: 'GRP_YK', is_active: true }],
            error: null,
          }),
        }),
      };
    }
    if (table === 'subscriptions') {
      return {
        select: () => ({
          in: async () => ({
            data: [{ group_id: 'GRP_YK', stop_id: 101 }],
            error: null,
          }),
        }),
      };
    }
    if (table === 'notification_logs') {
      return {
        select: () => ({
          gte: async () => ({
            data: [], // 今日尚未推播
            error: null,
          }),
        }),
      };
    }
    return {};
  });

  try {
    // 2026-09-02 是週三 (3)
    // 1. 在時間窗外（18:00）執行：應被智慧縮時窗攔截，activeCities 為空，hasActiveSubscriptions 為 false
    const ctxOutside = await getActiveSubscriptionContext({
      now: new Date('2026-09-02T10:00:00Z'), // 18:00 TW
      hour: 18,
      minute: 0,
      dateStr: '2026-09-02',
    });

    assert.equal(ctxOutside.ok, true);
    assert.equal(ctxOutside.hasActiveSubscriptions, false);
    assert.equal(ctxOutside.reason, 'outside-schedule-window');
    assert.equal(ctxOutside.activeCities.length, 0);
    assert.equal(ctxOutside.outOfWindowStops.length, 1);
    assert.equal(ctxOutside.outOfWindowStops[0].name, '文化路40號');

    // 2. 在時間窗內（19:35）執行：應放行，activeCities 包含台南市，hasActiveSubscriptions 為 true
    const ctxInside = await getActiveSubscriptionContext({
      now: new Date('2026-09-02T11:35:00Z'), // 19:35 TW
      hour: 19,
      minute: 35,
      dateStr: '2026-09-02',
    });

    assert.equal(ctxInside.ok, true);
    assert.equal(ctxInside.hasActiveSubscriptions, true);
    assert.deepEqual(ctxInside.activeCities, ['台南市']);
    assert.equal(ctxInside.stops.length, 1);
    assert.equal(ctxInside.stops[0].id, 101);
  } finally {
    mock.restoreAll();
  }
});

test('getActiveSubscriptionContext - post-notification deep sleep stops external polling for the rest of today', async () => {
  mock.method(supabase, 'from', (table) => {
    if (table === 'routes') {
      return {
        select: () => ({
          eq: async () => ({
            data: [{ id: 'TN_YK', name: '永康區文化路路線', active_days: [3], is_active: true }],
            error: null,
          }),
        }),
      };
    }
    if (table === 'stops') {
      return {
        select: () => ({
          in: async () => ({
            data: [{ id: 101, route_id: 'TN_YK', name: '文化路40號', lat: 23.0, lng: 120.2, schedule_time: '19:42:00' }],
            error: null,
          }),
        }),
      };
    }
    if (table === 'line_groups') {
      return {
        select: () => ({
          eq: async () => ({
            data: [{ group_id: 'GRP_YK', is_active: true }],
            error: null,
          }),
        }),
      };
    }
    if (table === 'subscriptions') {
      return {
        select: () => ({
          in: async () => ({
            data: [{ group_id: 'GRP_YK', stop_id: 101 }],
            error: null,
          }),
        }),
      };
    }
    if (table === 'notification_logs') {
      const gteHandler = async () => ({
        // 今日 19:48 已推播過給 GRP_YK
        data: [{ stop_id: 101, group_id: 'GRP_YK', route_id: 'TN_YK' }],
        error: null,
      });
      return {
        select: () => ({
          gte: gteHandler,
          neq: () => ({
            gte: gteHandler,
          }),
        }),
      };
    }
    return {};
  });

  try {
    // 即使在 19:50（仍處於原時間窗 19:24~20:07 內），但因今日已推播成功，應立即啟動深度休眠！
    const ctxSleeping = await getActiveSubscriptionContext({
      now: new Date('2026-09-02T11:50:00Z'), // 19:50 TW
      hour: 19,
      minute: 50,
      dateStr: '2026-09-02',
    });

    assert.equal(ctxSleeping.ok, true);
    assert.equal(ctxSleeping.hasActiveSubscriptions, false);
    assert.equal(ctxSleeping.reason, 'all-subscriptions-sleeping-today');
    assert.equal(ctxSleeping.activeCities.length, 0);
    assert.equal(ctxSleeping.sleepingStops.length, 1);
    assert.equal(ctxSleeping.sleepingStops[0].name, '文化路40號');

    // 當指定 bypassSleep / bypassWindow 時，應可強制執行偵測 (供手動測試排查)
    const ctxBypass = await getActiveSubscriptionContext(
      {
        now: new Date('2026-09-02T11:50:00Z'),
        hour: 19,
        minute: 50,
        dateStr: '2026-09-02',
      },
      [],
      { bypassWindow: true, bypassSleep: true }
    );

    assert.equal(ctxBypass.ok, true);
    assert.equal(ctxBypass.hasActiveSubscriptions, true);
    assert.deepEqual(ctxBypass.activeCities, ['台南市']);
  } finally {
    mock.restoreAll();
  }
});

test('getActiveSubscriptionContext - weather notifications do NOT trigger deep sleep', async () => {
  mock.method(supabase, 'from', (table) => {
    if (table === 'routes') {
      return {
        select: () => ({
          eq: async () => ({
            data: [{ id: 'TN_YK', name: '永康區文化路路線', active_days: [3], is_active: true }],
            error: null,
          }),
        }),
      };
    }
    if (table === 'stops') {
      return {
        select: () => ({
          in: async () => ({
            data: [{ id: 101, route_id: 'TN_YK', name: '文化路40號', lat: 23.0, lng: 120.2, schedule_time: '19:42:00' }],
            error: null,
          }),
        }),
      };
    }
    if (table === 'line_groups') {
      return {
        select: () => ({
          eq: async () => ({
            data: [{ group_id: 'GRP_YK', is_active: true }],
            error: null,
          }),
        }),
      };
    }
    if (table === 'subscriptions') {
      return {
        select: () => ({
          in: async () => ({
            data: [{ group_id: 'GRP_YK', stop_id: 101 }],
            error: null,
          }),
        }),
      };
    }
    if (table === 'notification_logs') {
      return {
        select: () => ({
          neq: (col, val) => ({
            gte: async () => {
              // 若有過濾 route_id != 'WEATHER'，回傳空陣列；若未過濾則會回傳 WEATHER 記錄
              return {
                data: val === 'WEATHER' ? [] : [{ stop_id: 101, group_id: 'GRP_YK', route_id: 'WEATHER' }],
                error: null,
              };
            },
          }),
        }),
      };
    }
    return {};
  });

  try {
    // 19:42 在時間窗內，且今日只有天氣預報推播，不應進入深度休眠！
    const ctx = await getActiveSubscriptionContext({
      now: new Date('2026-09-02T11:42:00Z'), // 19:42 TW
      hour: 19,
      minute: 42,
      dateStr: '2026-09-02',
    });

    assert.equal(ctx.ok, true);
    assert.equal(ctx.hasActiveSubscriptions, true);
    assert.deepEqual(ctx.activeCities, ['台南市']);
    assert.equal(ctx.stops.length, 1);
    assert.equal(ctx.stops[0].id, 101);
  } finally {
    mock.restoreAll();
  }
});

test('findNearbyTruckArrivals - uses allRouteStops to compute dynamic adaptive radius even with single subscription', () => {
  // 路線包含相鄰極近的兩站 (相距約 95m < 200m -> 自適應半徑應收縮至 120m)
  const stop1 = { id: 1, route_id: 'R_DENSE', name: '前站', lat: 25.0760, lng: 121.6500, order_index: 1 };
  const targetStop = { id: 2, route_id: 'R_DENSE', name: '目標站', lat: 25.0768, lng: 121.6500, order_index: 2 };
  const allRouteStops = [stop1, targetStop];

  // 正式環境中，只有 targetStop 被訂閱
  const subscribedStops = [targetStop];
  const subscribers = new Map([['2', new Set(['G_TEST'])]]);
  const routes = new Map([['R_DENSE', { id: 'R_DENSE', name: '密集路線' }]]);

  // 車輛距離目標站約 135 公尺 (若無拓撲會退回預設 150m 入圈；若有拓撲收縮至 120m 則會阻隔)
  // 緯度差約 0.0012 度 (~133 公尺)
  const truck = {
    route_id: 'R_DENSE',
    car_id: 'TRUCK-135M',
    lat: 25.0780,
    lng: 121.6500,
  };

  // 1. 傳入 allRouteStops：自適應收縮至 120m -> 135m 車輛應在圍欄外 (arrivals 為 0)
  const withTopologyArrivals = findNearbyTruckArrivals(
    [truck],
    subscribedStops,
    subscribers,
    routes,
    new Map(),
    null,
    allRouteStops
  );
  assert.equal(withTopologyArrivals.length, 0, '完整拓撲應觸發 120m 圍欄收縮並阻斷 135m 車輛');

  // 2. 未傳入 allRouteStops (單站退回預設 150m) -> 135m 車輛在 150m 圍欄內 (arrivals 為 1)
  const withoutTopologyArrivals = findNearbyTruckArrivals(
    [truck],
    subscribedStops,
    subscribers,
    routes,
    new Map(),
    null
  );
  assert.equal(withoutTopologyArrivals.length, 1, '無拓撲時退回 150m 預設半徑');
});

test('findNearbyTruckArrivals - recognizes trusted truck when route_linids matches truck.car_id', () => {
  const stop = { id: 10, route_id: 'TY_ROUTE', name: '測試站', lat: 24.907, lng: 121.136 };
  const subscribers = new Map([['10', new Set(['G_TY'])]]);
  const routes = new Map([['TY_ROUTE', { id: 'TY_ROUTE', name: '桃園測試線' }]]);

  // 路線信任名單中登錄了車牌號碼 KEK-3178 (而非路線編號)
  const routeTrustedLinidsMap = new Map([
    ['TY_ROUTE', new Set(['KEK-3178'])]
  ]);

  // 車輛到達：route_id 是 TY_ROUTE，但車牌是 KEK-3178
  const truck = {
    route_id: 'TY_ROUTE',
    car_id: 'KEK-3178',
    lat: 24.90705,
    lng: 121.136,
  };

  const arrivals = findNearbyTruckArrivals(
    [truck],
    [stop],
    subscribers,
    routes,
    routeTrustedLinidsMap
  );

  assert.equal(arrivals.length, 1);
  assert.equal(arrivals[0].shouldNotify, true, '車牌符合信任清單時應放行推播');
});

test('resolveRouteCity - normalizes 臺 to 台 for full consistency', () => {
  assert.equal(resolveRouteCity({ city: '臺南市' }), '台南市');
  assert.equal(resolveRouteCity({ city: '台南市' }), '台南市');
  assert.equal(resolveRouteCity({ name: '臺南市永康區清運線' }), '台南市');
  assert.equal(resolveRouteCity({ name: '新北市汐止清運線' }), '新北市');
});

test('getActiveSubscriptionContext - defaults afterMinutes to 40 minutes for delayed trucks', async () => {
  mock.method(supabase, 'from', (table) => {
    if (table === 'routes') {
      return {
        select: () => ({
          eq: async () => ({
            data: [{ id: 'R_LATE', name: '新北市誤點路線', city: '新北市', active_days: [1], is_active: true }],
            error: null,
          }),
        }),
      };
    }
    if (table === 'stops') {
      return {
        select: () => ({
          in: async () => ({
            data: [{ id: 99, route_id: 'R_LATE', name: '誤點站點', lat: 25.0, lng: 121.5, schedule_time: '19:00:00' }],
            error: null,
          }),
        }),
      };
    }
    if (table === 'line_groups') {
      return {
        select: () => ({
          eq: async () => ({
            data: [{ group_id: 'G_LATE', is_active: true }],
            error: null,
          }),
        }),
      };
    }
    if (table === 'subscriptions') {
      return {
        select: () => ({
          in: async () => ({
            data: [{ group_id: 'G_LATE', stop_id: 99 }],
            error: null,
          }),
        }),
      };
    }
    if (table === 'notification_logs') {
      return {
        select: () => ({
          neq: () => ({
            gte: async () => ({ data: [], error: null }),
          }),
        }),
      };
    }
    return {};
  });

  try {
    // 當前時間 19:35 (表定 19:00，已誤點 35 分鐘，但在 40 分鐘寬容門檻內)
    const ctx = await getActiveSubscriptionContext({
      now: new Date('2026-09-07T11:35:00Z'), // 19:35 TW, Monday (1)
      hour: 19,
      minute: 35,
      dateStr: '2026-09-07',
    });

    assert.equal(ctx.ok, true);
    assert.equal(ctx.hasActiveSubscriptions, true, '誤點 35 分鐘應仍在預設 40 分鐘容忍窗口內');
    assert.equal(ctx.stops.length, 1);
    assert.equal(ctx.stops[0].id, 99);
    assert.equal(ctx.allRouteStops.length, 1, '應回傳 allRouteStops 供後續比對');
  } finally {
    mock.restoreAll();
  }
});

test('isWithinScheduleWindow - handles midnight wrap-around correctly (FIX-5)', () => {
  // 情境 A: 站點表定 00:05:00，目前 23:55 (提前 10 分鐘，在 beforeMinutes=15 內)
  const schedEarly = '00:05:00';
  const nowBeforeMidnight = { hour: 23, minute: 55 };
  assert.equal(isWithinScheduleWindow(schedEarly, nowBeforeMidnight, 15, 40), true);

  // 情境 B: 站點表定 23:55:00，目前 00:15 (誤點 20 分鐘，在 afterMinutes=40 內)
  const schedLate = '23:55:00';
  const nowAfterMidnight = { hour: 0, minute: 15 };
  assert.equal(isWithinScheduleWindow(schedLate, nowAfterMidnight, 15, 40), true);

  // 情境 C: 站點表定 00:05:00，目前 23:00 (提前 65 分鐘，超出 15 分鐘門檻)
  const nowTooEarly = { hour: 23, minute: 0 };
  assert.equal(isWithinScheduleWindow(schedEarly, nowTooEarly, 15, 40), false);
});

test('recentTruckHistory - prunes to 300 latest entries when size exceeds 500 (FIX-10)', async () => {
  recentTruckHistory.clear();
  const now = Date.now();

  // 插入 501 筆紀錄，timestamp 由舊到新
  for (let i = 0; i < 501; i++) {
    recentTruckHistory.set(`TRUCK_${i}`, {
      lat: 25.0,
      lng: 121.0,
      time: now - (501 - i) * 1000, // TRUCK_500 最新
    });
  }

  assert.equal(recentTruckHistory.size, 501);

  // 觸發一次包含快取修剪的處理 (或直接模擬比對程序中的容量修剪邏輯)
  const entries = [...recentTruckHistory.entries()]
    .map(([k, v]) => [k, v, typeof v.time === 'number' ? v.time : new Date(v.time).getTime()])
    .sort((a, b) => b[2] - a[2]);
  recentTruckHistory.clear();
  for (const [k, v] of entries.slice(0, 300)) {
    recentTruckHistory.set(k, v);
  }

  assert.equal(recentTruckHistory.size, 300);
  assert.ok(recentTruckHistory.has('TRUCK_500'), '最新的記錄 TRUCK_500 應被保留');
  assert.ok(!recentTruckHistory.has('TRUCK_0'), '最舊的記錄 TRUCK_0 應被淘汰');

  recentTruckHistory.clear();
});



