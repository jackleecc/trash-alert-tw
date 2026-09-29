import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { supabase } from '../lib/supabaseClient.js';
import { getActiveSubscriptionContext } from '../lib/subscriptionContext.js';

test('getActiveSubscriptionContext - test notifications (TEST-BOT, MOCK) do NOT trigger deep sleep', async () => {
  mock.method(supabase, 'from', (table) => {
    if (table === 'routes') {
      return {
        select: () => ({
          eq: async () => ({
            data: [{ id: 'lagi2-006_2_21', name: '楊梅清運路十七線', active_days: [2], city: '桃園市', is_active: true }],
            error: null,
          }),
        }),
      };
    }
    if (table === 'stops') {
      return {
        select: () => ({
          in: async () => ({
            data: [{ id: 9, route_id: 'lagi2-006_2_21', name: '楊梅區中山南路146號', lat: 24.9, lng: 121.1, schedule_time: '17:15:00' }],
            error: null,
          }),
        }),
      };
    }
    if (table === 'line_groups') {
      return {
        select: () => ({
          eq: async () => ({
            data: [{ group_id: 'Cbc0aef28eb6226fafe1ea7e5a6e4487e', is_active: true }],
            error: null,
          }),
        }),
      };
    }
    if (table === 'subscriptions') {
      return {
        select: () => ({
          in: async () => ({
            data: [{ group_id: 'Cbc0aef28eb6226fafe1ea7e5a6e4487e', stop_id: 9 }],
            error: null,
          }),
        }),
      };
    }
    if (table === 'notification_logs') {
      const gteHandler = async () => ({
        // 今日有 TEST-BOT 與 MOCK 測試推播日誌
        data: [
          { stop_id: 9, group_id: 'Cbc0aef28eb6226fafe1ea7e5a6e4487e', route_id: 'lagi2-006_2_21', car_id: 'TEST-BOT' },
          { stop_id: 9, group_id: 'Cbc0aef28eb6226fafe1ea7e5a6e4487e', route_id: 'lagi2-006_2_21', car_id: 'MOCK-TRUCK' },
        ],
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
    const ctx = await getActiveSubscriptionContext({
      now: new Date('2026-09-29T09:15:00Z'), // 17:15 TW (in schedule window)
      hour: 17,
      minute: 15,
      dateStr: '2026-09-29',
    });

    assert.equal(ctx.ok, true);
    assert.equal(ctx.hasActiveSubscriptions, true, 'Stop must remain active despite TEST-BOT/MOCK notifications');
    assert.equal(ctx.sleepingStops.length, 0, 'sleepingStops must NOT include stops with only test notifications');
    assert.deepEqual(ctx.activeCities, ['桃園市'], '桃園市 must remain active');
  } finally {
    mock.restoreAll();
  }
});

test('getActiveSubscriptionContext - test route_id (containing TEST) does NOT trigger deep sleep', async () => {
  mock.method(supabase, 'from', (table) => {
    if (table === 'routes') {
      return {
        select: () => ({
          eq: async () => ({
            data: [{ id: 'TEST-ROUTE-1', name: '測試路線', active_days: [2], city: '桃園市', is_active: true }],
            error: null,
          }),
        }),
      };
    }
    if (table === 'stops') {
      return {
        select: () => ({
          in: async () => ({
            data: [{ id: 99, route_id: 'TEST-ROUTE-1', name: '測試站點', lat: 24.9, lng: 121.1, schedule_time: '17:15:00' }],
            error: null,
          }),
        }),
      };
    }
    if (table === 'line_groups') {
      return {
        select: () => ({
          eq: async () => ({
            data: [{ group_id: 'Cbc0aef28eb6226fafe1ea7e5a6e4487e', is_active: true }],
            error: null,
          }),
        }),
      };
    }
    if (table === 'subscriptions') {
      return {
        select: () => ({
          in: async () => ({
            data: [{ group_id: 'Cbc0aef28eb6226fafe1ea7e5a6e4487e', stop_id: 99 }],
            error: null,
          }),
        }),
      };
    }
    if (table === 'notification_logs') {
      const gteHandler = async () => ({
        // 含有 TEST 路由的推播日誌
        data: [
          { stop_id: 99, group_id: 'Cbc0aef28eb6226fafe1ea7e5a6e4487e', route_id: 'TEST-ROUTE-1', car_id: 'NORMAL-CAR' },
        ],
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
    const ctx = await getActiveSubscriptionContext({
      now: new Date('2026-09-29T09:15:00Z'),
      hour: 17,
      minute: 15,
      dateStr: '2026-09-29',
    });

    assert.equal(ctx.ok, true);
    assert.equal(ctx.hasActiveSubscriptions, true, 'Stop must remain active despite test route_id notification');
    assert.equal(ctx.sleepingStops.length, 0);
  } finally {
    mock.restoreAll();
  }
});

test('getActiveSubscriptionContext - real truck notifications DO trigger deep sleep', async () => {
  mock.method(supabase, 'from', (table) => {
    if (table === 'routes') {
      return {
        select: () => ({
          eq: async () => ({
            data: [{ id: 'lagi2-006_2_21', name: '楊梅清運路十七線', active_days: [2], city: '桃園市', is_active: true }],
            error: null,
          }),
        }),
      };
    }
    if (table === 'stops') {
      return {
        select: () => ({
          in: async () => ({
            data: [{ id: 9, route_id: 'lagi2-006_2_21', name: '楊梅區中山南路146號', lat: 24.9, lng: 121.1, schedule_time: '17:15:00' }],
            error: null,
          }),
        }),
      };
    }
    if (table === 'line_groups') {
      return {
        select: () => ({
          eq: async () => ({
            data: [{ group_id: 'Cbc0aef28eb6226fafe1ea7e5a6e4487e', is_active: true }],
            error: null,
          }),
        }),
      };
    }
    if (table === 'subscriptions') {
      return {
        select: () => ({
          in: async () => ({
            data: [{ group_id: 'Cbc0aef28eb6226fafe1ea7e5a6e4487e', stop_id: 9 }],
            error: null,
          }),
        }),
      };
    }
    if (table === 'notification_logs') {
      const gteHandler = async () => ({
        // 今日已有真實執勤車輛 KEK-3178 推播日誌
        data: [
          { stop_id: 9, group_id: 'Cbc0aef28eb6226fafe1ea7e5a6e4487e', route_id: 'lagi2-006_2_21', car_id: 'KEK-3178' },
        ],
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
    const ctx = await getActiveSubscriptionContext({
      now: new Date('2026-09-29T09:15:00Z'), // 17:15 TW
      hour: 17,
      minute: 15,
      dateStr: '2026-09-29',
    });

    assert.equal(ctx.ok, true);
    assert.equal(ctx.hasActiveSubscriptions, false, 'Stop must sleep after real truck notification');
    assert.equal(ctx.sleepingStops.length, 1);
    assert.equal(ctx.sleepingStops[0].name, '楊梅區中山南路146號');
  } finally {
    mock.restoreAll();
  }
});
