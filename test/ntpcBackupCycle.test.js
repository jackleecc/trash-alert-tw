import test from 'node:test';
import assert from 'node:assert/strict';
import { executeTruckTrackingCycle } from '../lib/coreProcessor.js';
import { supabase } from '../lib/supabaseClient.js';
import { NTPC_TRUCK_API_URL, KCG_TRUCK_API_URL } from '../lib/truckIntake.js';

test('cycle queries only active subscribed NTPC stops and passes the real Taiwan instant through facade', async () => {
  const savedFetch = globalThis.fetch;
  const savedFrom = supabase.from;
  const savedFlag = process.env.NTPC_WEBSITE_BACKUP_ENABLED;
  const savedToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  process.env.NTPC_WEBSITE_BACKUP_ENABLED = 'true';
  process.env.LINE_CHANNEL_ACCESS_TOKEN = 'OFFLINE-FIXTURE';
  const tables = {
    routes: [
      { id: '991001', city: '新北市', active_days: [1] },
      { id: '991002', city: '新北市', active_days: [1] },
      { id: '991003', city: '新北市', active_days: [1] },
      { id: '991004', city: '新北市', active_days: [1] },
      { id: 'KCG', city: '高雄市', active_days: [1] },
    ],
    stops: [
      { id: 1, route_id: '991001', lat: 25, lng: 121.5, schedule_time: '18:00:00' },
      { id: 2, route_id: '991002', lat: 25, lng: 121.5, schedule_time: '10:00:00' },
      { id: 3, route_id: '991003', lat: 25, lng: 121.5, schedule_time: '18:00:00' },
      { id: 4, route_id: '991004', lat: 25, lng: 121.5, schedule_time: '18:00:00' },
      { id: 5, route_id: 'KCG', lat: 22.6, lng: 120.3, schedule_time: '18:00:00' },
    ],
    line_groups: [{ group_id: 'FIXTURE-GROUP', member_count: 1 }],
    subscriptions: [1, 2, 3, 5].map((stop_id) => ({ stop_id, group_id: 'FIXTURE-GROUP' })),
    notification_logs: [{ stop_id: 3, group_id: 'FIXTURE-GROUP', car_id: 'PRODUCTION-CAR' }],
    daily_status: { api_fail_count: 2, last_api_error: '[CITY_FAILS:{"新北市":2}]', paused_cities: [] },
    route_linids: [],
    system_quota: { month: '2026-10', used_count: 0, is_melted: false },
  };
  const writes = [];
  supabase.from = (table) => {
    assert.ok(table in tables, `Unexpected DB table ${table}`);
    let data = tables[table];
    const query = new Proxy({}, { get(_, method) {
      if (method === 'then') return (resolve, reject) => Promise.resolve({ data, error: null }).then(resolve, reject);
      return (...args) => {
        if (['update', 'upsert', 'insert'].includes(method)) { writes.push({ table, value: args[0] }); data = null; }
        return query;
      };
    } });
    return query;
  };
  const websiteCalls = [];
  const lineCalls = [];
  globalThis.fetch = async (url, init) => {
    if (url === 'https://api.line.me/v2/bot/message/quota/consumption') {
      lineCalls.push(url);
      return { ok: true, json: async () => ({ totalUsage: 0 }) };
    }
    if (url === NTPC_TRUCK_API_URL || url === KCG_TRUCK_API_URL) return { ok: true, text: async () => '[]' };
    if (url === 'https://crd-rubbish.epd.ntpc.gov.tw/WebAPI/GetArrival') {
      websiteCalls.push(init);
      return { ok: true, text: async () => JSON.stringify({ TimeStamp: '20261012180000', Line: [{ LineID: '991001', CarNO: 'FIXTURE-CAR', LocationLat: 25.2, LocationLon: 121.7, BarCode: '991001' }] }) };
    }
    throw new Error(`Undeclared HTTP boundary: ${url}`);
  };
  try {
    const result = await executeTruckTrackingCycle({ taiwanNowInfo: { now: new Date('2026-10-12T18:00:00Z'), dateStr: '2026-10-12', hour: 18, minute: 0 } });
    assert.equal(result.recordsCount, 1, 'Website timestamp must use 10:00Z, not shifted 18:00Z');
    assert.equal(websiteCalls.length, 1);
    assert.equal(String(websiteCalls[0].body), 'LineID=991001');
    assert.equal(result.sentNotifications, 0);
    assert.equal(result.matchedArrivals, 0);
    assert.equal(lineCalls.length, 1, 'Quota is mocked locally');
    assert.ok(writes.some(({ table, value }) => table === 'daily_status' && value.last_api_error === null), 'Canonical NTPC success clears prior failure');
  } finally {
    globalThis.fetch = savedFetch;
    supabase.from = savedFrom;
    for (const [key, value] of [['NTPC_WEBSITE_BACKUP_ENABLED', savedFlag], ['LINE_CHANNEL_ACCESS_TOKEN', savedToken]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('cycle with missing raw date uses current UTC instant rather than inventing a Taiwan date near midnight', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-12T16:01:00Z') });
  const savedFrom = supabase.from;
  const savedFetch = globalThis.fetch;
  const savedFlag = process.env.NTPC_WEBSITE_BACKUP_ENABLED;
  const savedToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  process.env.NTPC_WEBSITE_BACKUP_ENABLED = 'true';
  delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const tables = {
    routes: [{ id: '991001', city: '新北市', active_days: [2] }],
    stops: [{ id: 1, route_id: '991001', lat: 25, lng: 121.5, schedule_time: '00:01:00' }],
    line_groups: [{ group_id: 'FIXTURE-GROUP', member_count: 1 }],
    subscriptions: [{ stop_id: 1, group_id: 'FIXTURE-GROUP' }],
    notification_logs: [], daily_status: null, route_linids: [],
  };
  supabase.from = (table) => {
    assert.ok(table in tables, `Unexpected DB boundary ${table}`);
    const query = new Proxy({}, { get(_, method) {
      if (method === 'then') return (resolve, reject) => Promise.resolve({ data: tables[table], error: null }).then(resolve, reject);
      return () => query;
    } });
    return query;
  };
  globalThis.fetch = async (url) => {
    if (url === NTPC_TRUCK_API_URL) return { ok: true, text: async () => '[]' };
    assert.equal(url, 'https://crd-rubbish.epd.ntpc.gov.tw/WebAPI/GetArrival');
    return { ok: true, text: async () => JSON.stringify({ TimeStamp: '20261013000100', Line: [{ LineID: '991001', CarNO: 'FIXTURE-CAR', LocationLat: 25.2, LocationLon: 121.7, BarCode: '991001' }] }) };
  };
  try {
    const result = await executeTruckTrackingCycle({ taiwanNowInfo: { now: new Date('2026-10-13T00:01:00Z'), hour: 0, minute: 1 } });
    assert.equal(result.recordsCount, 1, 'Missing raw date must accept response fresh at actual current 16:01Z');
    assert.equal(result.sentNotifications, 0);
    assert.equal(result.sourceStats[0].fallback.responseTimestamp, '2026-10-12T16:01:00.000Z');
  } finally {
    supabase.from = savedFrom;
    globalThis.fetch = savedFetch;
    for (const [key, value] of [['NTPC_WEBSITE_BACKUP_ENABLED', savedFlag], ['LINE_CHANNEL_ACCESS_TOKEN', savedToken]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
