import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { processTruckArrivals } from '../lib/coreProcessor.js';

test('processTruckArrivals - builds per-group messages and intents with weighted member counts', async () => {
  const truckData = [
    {
      car_id: 'KEK-3178',
      route_id: 'lagi2-006_2_21',
      lat: 24.908077,
      lng: 121.144473,
      speed: 10,
      direction: 240,
    },
  ];

  const mockContext = {
    ok: true,
    activeRoutesMap: new Map([
      [
        'lagi2-006_2_21',
        {
          id: 'lagi2-006_2_21',
          name: '楊梅區 垃圾清運路十七線',
          city: '桃園市',
        },
      ],
    ]),
    stops: [
      {
        id: 9,
        route_id: 'lagi2-006_2_21',
        name: '中山南路146號',
        lat: 24.908077,
        lng: 121.144473,
        schedule_time: '17:25:00',
      },
    ],
    allRouteStops: [],
    stopSubscribersMap: new Map([
      ['9', new Set(['G_TY_9', 'G_OTHER_3'])],
    ]),
    groupMemberCountMap: new Map([
      ['G_TY_9', 9],
      ['G_OTHER_3', 3],
    ]),
  };

  const taiwanNowInfo = {
    now: new Date('2026-10-06T09:25:00Z'),
    hour: 17,
    minute: 25,
    dateStr: '2026-10-06',
  };

  let dispatchedIntents = null;
  const mockDispatchBatch = async (intents) => {
    dispatchedIntents = intents;
    return {
      total: intents.length,
      sent: intents.length,
      suppressed: 0,
      failed: 0,
      errors: [],
    };
  };

  // Mock globalThis.fetch to avoid slow network timeouts in test
  mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({
      current: { precipitation_probability: 0, pm2_5: 10 },
      hourly: { precipitation_probability: [0, 0] },
    }),
  }));

  const result = await processTruckArrivals(
    truckData,
    taiwanNowInfo,
    [],
    mockContext,
    { dispatchNotificationBatch: mockDispatchBatch }
  );

  assert.equal(result.ok, true);
  assert.equal(result.matchedArrivals, 1);
  assert.ok(dispatchedIntents, 'dispatchNotificationBatch should be called');
  assert.equal(dispatchedIntents.length, 2);

  const tyIntent = dispatchedIntents.find((i) => i.groupId === 'G_TY_9');
  assert.equal(tyIntent.memberCount, 9);
  assert.match(tyIntent.messageText, /📊 本月推播額度：已用/);

  const otherIntent = dispatchedIntents.find((i) => i.groupId === 'G_OTHER_3');
  assert.equal(otherIntent.memberCount, 3);
  assert.match(otherIntent.messageText, /📊 本月推播額度：已用/);

  mock.restoreAll();
});
