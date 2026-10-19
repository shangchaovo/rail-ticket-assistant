import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, beijingDate } from '../cloud/public/ui-dates.ts';

test('public date shortcuts follow Beijing midnight, regardless of browser time zone', () => {
  assert.equal(beijingDate(Date.parse('2026-10-19T15:59:59Z')), '2026-10-19');
  assert.equal(beijingDate(Date.parse('2026-10-19T16:00:00Z')), '2026-10-20');
  assert.equal(beijingDate(Date.parse('2026-12-31T16:00:00Z')), '2027-01-01');
});

test('shortcut offsets preserve real calendar dates through month, year and leap boundaries', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-12-31', 2), '2027-01-02');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2026-10-19', 0), '2026-10-19');
  assert.equal(addDays('2026-10-19', 14), '2026-11-02');
  for (const [date, offset] of [['', 1], ['2026-02-30', 1], ['2026-10-19', 0.5], ['9999-12-31', 1], ['2026-10-19', Number.MAX_SAFE_INTEGER]] as const) {
    assert.equal(addDays(date, offset), '');
  }
});
