import test from 'node:test';
import assert from 'node:assert/strict';
import { toTaiwanTime, isWithinServiceWindow } from '../lib/timeUtils.js';

test('toTaiwanTime - converts UTC date to UTC+8 date properly', () => {
  const utcDate = new Date('2026-09-02T09:00:00Z'); // 09:00 UTC = 17:00 TW
  const twDate = toTaiwanTime(utcDate);
  assert.equal(twDate.getUTCHours(), 17);
});

test('isWithinServiceWindow - returns boolean without crashing', () => {
  const result = isWithinServiceWindow();
  assert.equal(typeof result, 'boolean');
});
