import fs from 'node:fs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The optional test runtime is installed separately; application dependencies
// and the production database are never used by this verifier.
if (!process.argv[2]) {
  throw new Error('Usage: node scripts/verifyCollectionApproachSql.mjs <path-to-pglite-dist/index.js>');
}
const { PGlite } = await import(pathToFileURL(resolve(process.argv[2])).href);

const db = new PGlite();
const migrationPath = new URL('../supabase/add_collection_approach_confirmation.sql', import.meta.url);
const sql = fs.existsSync(migrationPath) ? fs.readFileSync(migrationPath, 'utf8') : '';
const checks = [];
const key = {date: '2026-10-22', routeId: '221010', stopId: '3', carId: 'OFFLINE-CAR'};
const state = {schemaVersion: 1, source: 'ntpc-primary', timestampKind: 'gps', lastSample: {sampledAt: '2026-10-22T11:54:00.000Z', lat: 25.077625, lng: 121.649992}, anchor: null, direction: null, expiresAt: '2026-10-22T12:09:00.000Z'};
const event = {observedAt: '2026-10-22T11:54:00.000Z', sampledAt: '2026-10-22T11:54:00.000Z', source: 'ntpc-primary', timestampKind: 'gps', lat: 25.077625, lng: 121.649992, status: 'pending', reason: 'first_sample'};
const commit = async (version, nextState = state, nextEvent = event, nextKey = key) => (await db.query('SELECT public.commit_collection_approach($1::jsonb, $2::bigint, $3::jsonb, $4::jsonb) AS result', [JSON.stringify(nextKey), version, JSON.stringify(nextState), JSON.stringify(nextEvent)])).rows[0].result;
const count = async (table) => Number((await db.query(`SELECT count(*) AS count FROM public.${table}`)).rows[0].count);
try {
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE TABLE public.routes(id text PRIMARY KEY); CREATE TABLE public.stops(id integer PRIMARY KEY, route_id text); INSERT INTO public.routes VALUES (\'221010\'); INSERT INTO public.stops VALUES (3, \'221010\'), (25, \'221010\');');
  await db.exec(sql);
  await db.exec(sql);
  assert.notEqual((await db.query("SELECT to_regclass('public.collection_approach_state') AS table_name")).rows[0].table_name, null, 'shared predecessor evidence must have a durable state table');
  checks.push('migration executes twice');
  assert.equal((await commit(0)).applied, true);
  assert.equal(await count('collection_approach_state'), 1);
  assert.equal(await count('collection_approach_events'), 1);
  checks.push('first state and event commit together');
  assert.equal((await commit(0)).applied, false);
  assert.equal(await count('collection_approach_events'), 1);
  checks.push('competing expected version cannot advance or append event');
  await assert.rejects(commit(1, state, {...event, status: 'INVALID-STATUS'}));
  assert.equal(Number((await db.query('SELECT version FROM public.collection_approach_state')).rows[0].version), 1);
  assert.equal(await count('collection_approach_events'), 1);
  checks.push('event failure rolls back state and version');
  await commit(null).then(result => assert.equal(result?.applied, false), () => {});
  await commit(-1).then(result => assert.equal(result?.applied, false), () => {});
  await commit(1, state, event, {date: key.date}).then(result => assert.equal(result?.applied, false), () => {});
  await commit(1, state, event, {...key, carId: 'NO-PLACEHOLDER'}).then(result => assert.equal(result?.applied, false), () => {});
  await commit(1, state, {...event, source: null}).then(result => assert.equal(result?.applied, false), () => {});
  await commit(1, state, event, {...key, routeId: '221032'}).then(result => assert.equal(result?.applied, false), () => {});
  assert.equal(Number((await db.query('SELECT version FROM public.collection_approach_state')).rows[0].version), 1);
  assert.equal(await count('collection_approach_state'), 1, 'a losing CAS must not leave an empty placeholder row');
  assert.equal(await count('collection_approach_events'), 1);
  checks.push('null/negative version, invalid event, incomplete key, and losing absent key rejected without placeholder');
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`SET ROLE ${role}`);
    await assert.rejects(db.query('SELECT * FROM public.collection_approach_state'));
    await assert.rejects(db.query('SELECT * FROM public.collection_approach_events'));
    await assert.rejects(commit(1));
    await db.exec('RESET ROLE');
    checks.push(`${role} cannot read trajectory or execute RPC`);
  }
  await db.exec('SET ROLE service_role');
  await db.query('SELECT * FROM public.collection_approach_state');
  assert.equal((await commit(1, {...state, expiresAt: '2026-10-22T12:10:00.000Z'})).applied, true);
  await db.exec('RESET ROLE');
  checks.push('service_role can read and execute RPC');
  for (const table of ['collection_approach_state', 'collection_approach_events']) {
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE']) {
      assert.equal((await db.query('SELECT has_table_privilege($1, $2, $3) AS allowed', ['service_role', `public.${table}`, privilege])).rows[0].allowed, false);
    }
    assert.equal((await db.query('SELECT relrowsecurity FROM pg_class WHERE oid = $1::regclass', [`public.${table}`])).rows[0].relrowsecurity, true);
  }
  checks.push('service_role has read-only table grants and both tables enforce RLS');
  const functions = (await db.query("SELECT proconfig FROM pg_proc WHERE proname = 'commit_collection_approach'")).rows;
  assert.ok(functions.some(f => f.proconfig?.some(s => s.startsWith('search_path='))));
  checks.push('RPC fixes search_path');
  const competingKey = {...key, carId: 'OFFLINE-RACE'};
  const competing = await Promise.all([commit(0, state, event, competingKey), commit(0, state, event, competingKey)]);
  assert.equal(competing.filter(result => result.applied === true).length, 1);
  checks.push('competing submissions with one expected version have one winner');
  console.log(JSON.stringify({runtime: (await db.query('SELECT version()')).rows[0].version, passed: checks.length, checks}, null, 2));
} finally {
  await db.close();
}
