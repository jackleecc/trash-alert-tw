import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findNearbyTruckArrivals,
  getIsoDayOfWeek,
  formatArrivalMessage,
} from '../lib/coreProcessor.js';

test('getIsoDayOfWeek - converts UTC day properly', () => {
  // 2026-09-02 is Wednesday (3)
  const wednesday = new Date('2026-09-02T00:00:00Z');
  assert.equal(getIsoDayOfWeek(wednesday), 3);

  // 2026-09-06 is Sunday (7 in ISO format)
  const sunday = new Date('2026-09-06T00:00:00Z');
  assert.equal(getIsoDayOfWeek(sunday), 7);
});

test('formatArrivalMessage - contains expected structured fields', () => {
  const msg = formatArrivalMessage({
    routeName: '新興區清運A線',
    stopName: '中正三路口',
    distance: 185.4,
    carId: 'KCG-1234',
  });

  assert.ok(msg.includes('【垃圾車即將抵達提醒】'));
  assert.ok(msg.includes('站點：中正三路口'));
  assert.ok(msg.includes('路線：新興區清運A線'));
  assert.ok(msg.includes('約 185 公尺'));
  assert.ok(msg.includes('KCG-1234'));
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
