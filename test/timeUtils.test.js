import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { toTaiwanTime, isWithinServiceWindow } from '../lib/timeUtils.js';

test('toTaiwanTime - converts UTC date to UTC+8 date properly', () => {
  const utcDate = new Date('2026-09-02T09:00:00Z'); // 09:00 UTC = 17:00 TW
  const twDate = toTaiwanTime(utcDate);
  assert.equal(twDate.getUTCHours(), 17);
});

test('isWithinServiceWindow - boundary conditions', () => {
  const OriginalDate = Date;
  
  const mockTime = (isoString) => {
    global.Date = class extends OriginalDate {
      constructor(...args) {
        if (args.length === 0) return new OriginalDate(isoString);
        return new OriginalDate(...args);
      }
      static now() {
        return new OriginalDate(isoString).getTime();
      }
    };
  };

  try {
    // 16:59 TW (08:59 UTC) -> false
    mockTime('2026-09-02T08:59:00Z');
    assert.equal(isWithinServiceWindow(), false);

    // 17:00 TW (09:00 UTC) -> true
    mockTime('2026-09-02T09:00:00Z');
    assert.equal(isWithinServiceWindow(), true);

    // 20:59 TW (12:59 UTC) -> true
    mockTime('2026-09-02T12:59:00Z');
    assert.equal(isWithinServiceWindow(), true);

    // 21:00 TW (13:00 UTC) -> true
    mockTime('2026-09-02T13:00:00Z');
    assert.equal(isWithinServiceWindow(), true);

    // 21:59 TW (13:59 UTC) -> true
    mockTime('2026-09-02T13:59:00Z');
    assert.equal(isWithinServiceWindow(), true);

    // 22:00 TW (14:00 UTC) -> false
    mockTime('2026-09-02T14:00:00Z');
    assert.equal(isWithinServiceWindow(), false);
  } finally {
    global.Date = OriginalDate;
  }
});
