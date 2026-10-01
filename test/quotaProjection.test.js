import test from 'node:test';
import assert from 'node:assert/strict';
import { formatArrivalMessage } from '../lib/arrivalMatcher.js';

test('quotaProjection - formatArrivalMessage projects current notification into used count (0 -> 1 / 199)', () => {
  const msg = formatArrivalMessage({
    routeName: '楊梅區 垃圾清運路十七線',
    stopName: '楊梅區中山南路146號',
    distance: 45,
    carId: 'KEK-3178',
    weatherDesc: '☀️ 降雨機率：0%（天氣良好，免帶雨具）',
    stopLat: 24.908077,
    stopLng: 121.144473,
    quotaInfo: {
      usedCount: 0,
      maxQuota: 200,
      remaining: 200,
    },
  });

  // 当月第 1 则通知（快照中 usedCount 為 0），送出時應計入本次，顯示 已用 1 / 剩餘 199
  assert.match(
    msg,
    /📊 本月推播額度：已用 1 \/ 剩餘 199/,
    'First notification of the month must project to used 1 / remaining 199'
  );
});

test('quotaProjection - formatArrivalMessage respects isProjected flag if already incremented', () => {
  const msg = formatArrivalMessage({
    routeName: '路十七線',
    stopName: '中山南路146號',
    distance: 45,
    carId: 'KEK-3178',
    quotaInfo: {
      usedCount: 1,
      maxQuota: 200,
      remaining: 199,
      isProjected: true,
    },
  });

  assert.match(
    msg,
    /📊 本月推播額度：已用 1 \/ 剩餘 199/,
    'Already projected quota should preserve used 1 / remaining 199'
  );
});
