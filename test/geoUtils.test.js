import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateDistanceMeters, isWithinGeofence } from '../lib/geoUtils.js';

test('calculateDistanceMeters - calculates zero distance for identical coordinates', () => {
  const dist = calculateDistanceMeters(22.6273, 120.3014, 22.6273, 120.3014);
  assert.equal(Math.round(dist), 0);
});

test('calculateDistanceMeters - accurate distance for known points (~100m)', () => {
  // 經度偏移約 0.001 度在台灣緯度大約為 102 公尺
  const lat1 = 22.6273;
  const lon1 = 120.3014;
  const lat2 = 22.6273;
  const lon2 = 120.3024;

  const dist = calculateDistanceMeters(lat1, lon1, lat2, lon2);
  assert.ok(dist > 90 && dist < 120, `Expected ~102m, got ${dist}m`);
});

test('isWithinGeofence - correctly identifies within and outside radius', () => {
  const lat1 = 22.6273;
  const lon1 = 120.3014;

  // ~102m away: should be within 250m geofence
  assert.equal(isWithinGeofence(lat1, lon1, 22.6273, 120.3024, 250), true);

  // ~1000m away: should be outside 250m geofence
  assert.equal(isWithinGeofence(lat1, lon1, 22.6273, 120.3114, 250), false);
});
