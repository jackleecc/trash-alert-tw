import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchActiveTrucks, NTPC_TRUCK_API_URL, KCG_TRUCK_API_URL } from '../lib/truckIntake.js';

const now = new Date('2026-10-12T10:00:00Z');
const websiteUrl = 'https://crd-rubbish.epd.ntpc.gov.tw/WebAPI/GetArrival';
const vehicle = (overrides = {}) => ({ LineID: '991001', CarNO: 'FIXTURE-CAR', LocationLat: '25.1', LocationLon: '121.6', BarCode: '991001', ...overrides });
const response = (data) => ({ ok: true, text: async () => JSON.stringify(data) });
const primaryTruck = (route_id, time) => ({ route_id, time, car_id: 'PRIMARY', lat: 25.1, lng: 121.6 });
async function run(primary = [], website = { TimeStamp: '20261012180000', Line: [vehicle()] }, options = {}) {
  const calls = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (url === NTPC_TRUCK_API_URL) {
      if (primary instanceof Error) throw primary;
      return response(primary);
    }
    if (url === websiteUrl) {
      if (website instanceof Error) throw website;
      if (typeof website?.text === 'function') return website;
      return response(website);
    }
    if (url === KCG_TRUCK_API_URL) return response([primaryTruck('KCG-ROUTE', '2026-10-12T10:00:00Z')]);
    throw new Error(`Unexpected HTTP boundary: ${url}`);
  };
  try {
    return { result: await fetchActiveTrucks({ targetCities: ['新北市'], now, requiredNtpcRouteIds: ['991001'], ntpcWebsiteBackupEnabled: true, ...options }), calls };
  } finally { globalThis.fetch = saved; }
}

test('unset environment enables backup for a missing required route by default', async () => {
  const saved = process.env.NTPC_WEBSITE_BACKUP_ENABLED;
  delete process.env.NTPC_WEBSITE_BACKUP_ENABLED;
  try {
    const { result } = await run([], undefined, { ntpcWebsiteBackupEnabled: undefined });
    assert.deepEqual(result.data, [{ route_id: '991001', car_id: 'FIXTURE-CAR', lat: 25.1, lng: 121.6, waste_type: 'garbage', source: 'ntpc-website', timestamp_kind: 'response', source_timestamp: '2026-10-12T10:00:00.000Z' }]);
  } finally {
    if (saved === undefined) delete process.env.NTPC_WEBSITE_BACKUP_ENABLED; else process.env.NTPC_WEBSITE_BACKUP_ENABLED = saved;
  }
});
test('missing required route is filled by on-duty website vehicle with response provenance', async () => {
  const { result, calls } = await run();
  assert.deepEqual(result.data, [{ route_id: '991001', car_id: 'FIXTURE-CAR', lat: 25.1, lng: 121.6, waste_type: 'garbage', source: 'ntpc-website', timestamp_kind: 'response', source_timestamp: '2026-10-12T10:00:00.000Z' }]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(String(calls[1].init.body), 'LineID=991001');
  assert.equal(result.sourceStats.length, 1);
  assert.equal(result.sourceStats[0].url, NTPC_TRUCK_API_URL);
});

test('website intake rejects non-service, malformed and unrelated vehicles while deduplicating valid ones', async () => {
  const { result } = await run([], { TimeStamp: '20261012180000', Line: [
    vehicle(), vehicle(), vehicle({ CarNO: 'SECOND', BarCode: '000005' }), vehicle({ CarNO: 'THIRD', BarCode: '000007' }),
    ...['000003', '000004', '000006', '000013', '000014', '000015', '', 'UNKNOWN'].map((BarCode) => vehicle({ BarCode })),
    vehicle({ CarNO: '' }), vehicle({ CarNO: 123 }), vehicle({ LocationLat: 0 }), vehicle({ LocationLon: '121.6oops' }), vehicle({ LineID: '991002' }),
  ] });
  assert.deepEqual(result.data.map((truck) => truck.car_id), ['FIXTURE-CAR', 'SECOND', 'THIRD']);
  assert.deepEqual(result.sourceStats[0].fallback.rejections, { not_in_service: 8, missing_vehicle: 2, invalid_position: 2, route_mismatch: 1 });
});

test('website response timestamp must be strictly valid and within freshness boundaries', async () => {
  for (const stamp of ['20261012175459', '20261012180101', '20260230180000', '20261312180000', '', null, '20261012180060']) {
    const { result } = await run([], { TimeStamp: stamp, Line: [vehicle()] });
    assert.equal(result.data.length, 0, `Reject timestamp ${stamp}`);
    assert.equal(result.sourceStats[0].fallback.count, 0);
  }
  for (const stamp of ['20261012175500', '20261012180100']) {
    assert.equal((await run([], { TimeStamp: stamp, Line: [vehicle()] })).result.data.length, 1);
  }
});

test('primary coverage keeps fresh samples and fills only the stale required route', async () => {
  const { result, calls } = await run([
    primaryTruck('991002', '2026/10/12 17:55:00'), primaryTruck('991002', '2026-10-12T10:01:00Z'),
    primaryTruck('991002', '2026-10-12T10:01:01Z'), primaryTruck('991001', '2026-10-12 17:54:59'),
  ], undefined, { requiredNtpcRouteIds: ['991001', ' 991002 ', '991002', '991001,991003', 'INVALID'] });
  assert.deepEqual(result.data.map((truck) => truck.route_id), ['991002', '991002', '991001']);
  assert.equal(String(calls[1].init.body), 'LineID=991001');
  assert.equal(result.data[0].time, '2026-10-12T09:55:00.000Z');
});

test('primary connection success remains logical success when backup fails without vehicles', async () => {
  const { result } = await run([], new Error('backup unavailable'));
  assert.equal(result.ok, true);
  assert.equal(result.sourceStats[0].ok, true);
  assert.equal(result.errors.length, 1);
});

test('disabled, legacy, override, unrelated and paused calls preserve primary without website requests', async () => {
  const stale = [primaryTruck('991001', '2026-10-12 10:00:00')];
  for (const options of [
    { ntpcWebsiteBackupEnabled: false }, { ntpcWebsiteBackupEnabled: 'true' },
    { requiredNtpcRouteIds: [] }, { requiredNtpcRouteIds: undefined },
    { requiredNtpcRouteIds: ['INVALID', '991001,991002'] }, { overrideUrl: NTPC_TRUCK_API_URL },
    { targetCities: ['高雄市'] }, { targetCities: ['新北市', '高雄市'], pausedCities: ['新北市'] },
  ]) {
    const { result, calls } = await run(stale, undefined, options);
    assert.equal(calls.filter(({ url }) => url === websiteUrl).length, 0);
    if (calls.some(({ url }) => url === NTPC_TRUCK_API_URL)) assert.deepEqual(result.data, [{ ...stale[0], waste_type: 'garbage' }]);
  }
});

test('environment defaults on, rejects malformed flags and preserves explicit boolean overrides', async () => {
  const saved = process.env.NTPC_WEBSITE_BACKUP_ENABLED;
  try {
    for (const [flag, enabled] of [[undefined, true], ['true', true], ['false', false], ['TRUE', false], ['1', false], ['true ', false], ['', false]]) {
      if (flag === undefined) delete process.env.NTPC_WEBSITE_BACKUP_ENABLED; else process.env.NTPC_WEBSITE_BACKUP_ENABLED = flag;
      const inherited = await run([], undefined, { ntpcWebsiteBackupEnabled: undefined });
      assert.deepEqual(inherited.result.data.map(({ car_id }) => car_id), enabled ? ['FIXTURE-CAR'] : [], `Flag ${JSON.stringify(flag)}`);
      assert.equal(inherited.calls.length, enabled ? 2 : 1);
      assert.equal((await run([], undefined, { ntpcWebsiteBackupEnabled: false })).result.data.length, 0, 'Explicit false disables every environment value');
      assert.equal((await run([], undefined, { ntpcWebsiteBackupEnabled: true })).result.data[0].car_id, 'FIXTURE-CAR', 'Explicit true enables every environment value');
    }
  } finally {
    if (saved === undefined) delete process.env.NTPC_WEBSITE_BACKUP_ENABLED; else process.env.NTPC_WEBSITE_BACKUP_ENABLED = saved;
  }
});
test('fresh primary prevents backup while invalid or missing required GPS times are replaced', async () => {
  for (const time of ['2026-10-12 17:55:00', '2026/10/12 18:01:00', '2026-10-12T10:00:00Z', '2026-10-12T12:00:00+02:00']) {
    const { result, calls } = await run([primaryTruck('991001', time)]);
    assert.equal(calls.length, 1, time);
    assert.equal(result.data[0].car_id, 'PRIMARY');
  }
  for (const time of [undefined, '', 'yesterday', '2026-02-30 18:00:00', '2026-10-12 24:00:00', '2026-10-12T10:01:01Z']) {
    const { result, calls } = await run([primaryTruck('991001', time)]);
    assert.equal(calls.length, 2, String(time));
    assert.equal(result.data[0].source, 'ntpc-website');
  }
});

test('Taiwan midnight uses the correct previous UTC date for GPS and website response freshness', async () => {
  const { result, calls } = await run([primaryTruck('991001', '2026/10/11 23:55:59')],
    { TimeStamp: '20261012000100', Line: [vehicle()] }, { now: new Date('2026-10-11T16:01:00Z') });
  assert.equal(calls.length, 2);
  assert.equal(result.data[0].source_timestamp, '2026-10-11T16:01:00.000Z');
});

test('primary failure can recover once from website and both failures retain diagnostic causes', async () => {
  const recovered = await run(new Error('primary offline'));
  assert.equal(recovered.calls.length, 3);
  assert.equal(recovered.result.sourceStats.length, 1);
  assert.equal(recovered.result.sourceStats[0].ok, true);
  assert.equal(recovered.result.sourceStats[0].primary.error, 'primary offline');
  for (const website of [new Error('website offline'), { TimeStamp: '20261012180000', Line: [] }]) {
    const { result } = await run(new Error('primary offline'), website);
    assert.equal(result.ok, false);
    assert.equal(result.sourceStats[0].ok, false);
    assert.equal(result.errors.length, 2);
  }
});

test('bad website HTTP, HTML, JSON and payloads preserve other cities and valid primary data', async () => {
  for (const website of [
    { ok: false, status: 503, text: async () => '' },
    { ok: true, text: async () => '<html>offline</html>' },
    { ok: true, text: async () => '{' }, null, [], { TimeStamp: '20261012180000', Line: {} },
  ]) {
    const { result } = await run([primaryTruck('991002', '2026-10-12T10:00:00Z')], website, { targetCities: ['新北市', '高雄市'] });
    assert.deepEqual(result.data.map(({ route_id }) => route_id), ['991002', 'KCG-ROUTE']);
    assert.equal(result.sourceStats[0].ok, true);
    assert.ok(result.sourceStats[0].fallback.error);
  }
});

test('Sunday empty vehicle response is rejected without treating Point arrivals or Diff as GPS evidence', async () => {
  const { result } = await run([], { TimeStamp: '20261011235500', LineCount: 1, Line: [vehicle({ CarNO: '', LocationLat: 0, LocationLon: 0, BarCode: '', Diff: 1, Point: [{ PointTime: '23:55', Arrival: '23:55' }] })] }, { now: new Date('2026-10-11T15:55:00Z') });
  assert.deepEqual(result.data, []);
  assert.equal(result.sourceStats[0].fallback.rejections.not_in_service, 1);
});

test('website uses one 5000ms abort timeout with no retries and always clears timers', async () => {
  const savedFetch = globalThis.fetch;
  const savedSetTimeout = globalThis.setTimeout;
  const savedClearTimeout = globalThis.clearTimeout;
  const active = new Set();
  const durations = [];
  let websiteCalls = 0;
  globalThis.setTimeout = (callback, duration, ...args) => {
    durations.push(duration);
    const timer = savedSetTimeout(callback, duration === 5000 ? 0 : duration, ...args);
    active.add(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => { active.delete(timer); savedClearTimeout(timer); };
  globalThis.fetch = async (url, init) => {
    if (url === NTPC_TRUCK_API_URL) return response([]);
    assert.equal(url, websiteUrl);
    websiteCalls++;
    assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded; charset=UTF-8');
    return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
  };
  try {
    const result = await fetchActiveTrucks({ targetCities: ['新北市'], now, requiredNtpcRouteIds: ['991001'], ntpcWebsiteBackupEnabled: true });
    assert.equal(websiteCalls, 1);
    assert.deepEqual(durations, [12000, 5000]);
    assert.equal(active.size, 0);
    assert.match(result.sourceStats[0].fallback.error, /5000ms/);
  } finally {
    globalThis.fetch = savedFetch;
    globalThis.setTimeout = savedSetTimeout;
    globalThis.clearTimeout = savedClearTimeout;
  }
});
