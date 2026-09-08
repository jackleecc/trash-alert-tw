import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptTruckData, normalizeTruckRecord } from '../lib/truckAdapter.js';

test('normalizeTruckRecord - valid standard object', () => {
  const raw = {
    route_id: 'R101',
    lat: 22.6273,
    lng: 120.3014,
    car_id: 'TRUCK-01',
    time: '2026-09-02 17:15:00',
  };
  const result = normalizeTruckRecord(raw);
  assert.deepEqual(result, {
    route_id: 'R101',
    lat: 22.6273,
    lng: 120.3014,
    waste_type: 'garbage',
    car_id: 'TRUCK-01',
    time: '2026-09-02 17:15:00',
  });
});

test('normalizeTruckRecord - field variations mapping (RouteId, Latitude, Longitude, CarNo)', () => {
  const raw = {
    RouteId: 'R202',
    Latitude: '22.6500',
    Longitude: '120.3200',
    CarNo: 'KCG-8888',
    GpsTime: '17:30',
  };
  const result = normalizeTruckRecord(raw);
  assert.deepEqual(result, {
    route_id: 'R202',
    lat: 22.65,
    lng: 120.32,
    waste_type: 'garbage',
    car_id: 'KCG-8888',
    time: '17:30',
  });
});

test('normalizeTruckRecord - maps official KCG API fields', () => {
  const result = normalizeTruckRecord({
    linid: '1066015646',
    car: 'KEW-0079',
    time: '2026-09-02T13:14:45',
    x: '120.25215',
    y: '22.87174',
  });

  assert.deepEqual(result, {
    route_id: '1066015646',
    lat: 22.87174,
    lng: 120.25215,
    waste_type: 'garbage',
    car_id: 'KEW-0079',
    time: '2026-09-02T13:14:45',
  });
});

test('normalizeTruckRecord - maps Taoyuan API fields (RouteNo / VehicleNo / px / py)', () => {
  const result = normalizeTruckRecord({
    RouteNo: 'TY-010',
    VehicleNo: '888-TY',
    UpdateTime: '2026-09-08 17:45:00',
    px: '121.3009',
    py: '24.9936',
  });

  assert.deepEqual(result, {
    route_id: 'TY-010',
    lat: 24.9936,
    lng: 121.3009,
    waste_type: 'garbage',
    car_id: '888-TY',
    time: '2026-09-08 17:45:00',
  });
});

test('normalizeTruckRecord - detects recycling / food waste type', () => {
  const recyclingRaw = {
    route_id: 'R999',
    lat: 25.033,
    lng: 121.565,
    car_type: '資源回收車',
  };
  const foodWasteRaw = {
    route_id: 'R998',
    lat: 25.033,
    lng: 121.565,
    type: '廚餘回收',
  };

  assert.equal(normalizeTruckRecord(recyclingRaw).waste_type, 'recycling');
  assert.equal(normalizeTruckRecord(foodWasteRaw).waste_type, 'recycling');
});

test('normalizeTruckRecord - skips out-of-bounds coordinates', () => {
  // Invalid lat (< 21.5 or > 26.5)
  assert.equal(
    normalizeTruckRecord({ route_id: 'R1', lat: 10.0, lng: 120.3 }),
    null
  );
  // Invalid lng (< 119.0 or > 122.5)
  assert.equal(
    normalizeTruckRecord({ route_id: 'R1', lat: 22.6, lng: 150.0 }),
    null
  );
});

test('normalizeTruckRecord - skips missing required fields', () => {
  // Missing route_id
  assert.equal(normalizeTruckRecord({ lat: 22.6, lng: 120.3 }), null);
  // Missing lat
  assert.equal(normalizeTruckRecord({ route_id: 'R1', lng: 120.3 }), null);
  // Missing lng
  assert.equal(normalizeTruckRecord({ route_id: 'R1', lat: 22.6 }), null);
  // Non-numeric coords
  assert.equal(
    normalizeTruckRecord({ route_id: 'R1', lat: 'invalid', lng: 120.3 }),
    null
  );
});

test('adaptTruckData - handles wrapped structures (data, records, items, GeoJSON)', () => {
  const rawWrapped = {
    data: [
      { LineNo: 'L1', y: 22.6, x: 120.3 },
      { LineNo: '', y: 22.6, x: 120.3 }, // skipped (empty route_id)
      { LineNo: 'L2', y: 99.9, x: 120.3 }, // skipped (invalid lat)
      { LineNo: 'L3', y: 22.7, x: 120.4, PlateNo: 'ABC-123' },
    ],
  };

  const results = adaptTruckData(rawWrapped);
  assert.equal(results.length, 2);
  assert.equal(results[0].route_id, 'L1');
  assert.equal(results[1].route_id, 'L3');
  assert.equal(results[1].car_id, 'ABC-123');
});
