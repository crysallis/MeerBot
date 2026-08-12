require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeMonthlyNext } = require('./jobScheduler');

// All computeMonthlyNext calls use a nowMs far in the past so the "while (next <= nowMs)"
// loop never advances past the immediately-computed month -- isolates the one calculation
// under test from the "skip to future" catch-up behavior exercised separately below.
const FAR_PAST = 0;

test('computeMonthlyNext: fixed day of month, unaffected by offset param', () => {
  // Jan 15 09:00 UTC, monthly:1, day_of_month=15, no offset -> Feb 15 09:00 UTC
  const next = computeMonthlyNext('2026-01-15T09:00:00.000Z', 1, 15, FAR_PAST, 5);
  assert.equal(next, '2026-02-15T09:00:00.000Z');
});

test('computeMonthlyNext: last day of month, no offset (0) fires on the actual last day', () => {
  // From Jan -> next month is Feb 2026 (not a leap year), last day = 28
  const next = computeMonthlyNext('2026-01-31T20:00:00.000Z', 1, -1, FAR_PAST, 0);
  assert.equal(next, '2026-02-28T20:00:00.000Z');
});

test('computeMonthlyNext: last day of month, no offset argument defaults to on-the-last-day', () => {
  const next = computeMonthlyNext('2026-01-31T20:00:00.000Z', 1, -1, FAR_PAST);
  assert.equal(next, '2026-02-28T20:00:00.000Z');
});

test('computeMonthlyNext: 2 days before last day in a 28-day February', () => {
  // From Jan -> Feb 2026, last day 28, 2 days before -> the 26th
  const next = computeMonthlyNext('2026-01-31T20:00:00.000Z', 1, -1, FAR_PAST, 2);
  assert.equal(next, '2026-02-26T20:00:00.000Z');
});

test('computeMonthlyNext: 2 days before last day in a 31-day January', () => {
  // From Dec -> Jan 2027, last day 31, 2 days before -> the 29th
  const next = computeMonthlyNext('2026-12-31T20:00:00.000Z', 1, -1, FAR_PAST, 2);
  assert.equal(next, '2027-01-29T20:00:00.000Z');
});

test('computeMonthlyNext: offset clamps rather than crossing into the previous month', () => {
  // Feb 2026 has 28 days. An offset of 40 (absurdly large) must clamp to 27
  // (lastDayOfMonth - 1 = 27), landing on Feb 1, never rolling into January.
  const next = computeMonthlyNext('2026-01-31T20:00:00.000Z', 1, -1, FAR_PAST, 40);
  assert.equal(next, '2026-02-01T20:00:00.000Z');
});

test('computeMonthlyNext: offset re-clamps smaller in a shorter month than the one it was saved under', () => {
  // A job saved as "28 days before" while looking at a 31-day month should
  // still clamp correctly the moment it computes against a 28-day February.
  const next = computeMonthlyNext('2026-01-31T20:00:00.000Z', 1, -1, FAR_PAST, 28);
  assert.equal(next, '2026-02-01T20:00:00.000Z'); // clamps to 27 (28-1), same as the 40 case
});

test('computeMonthlyNext: last day of month with offset, leap year February', () => {
  // 2028 is a leap year -> Feb has 29 days. 2 days before -> the 27th.
  const next = computeMonthlyNext('2028-01-29T20:00:00.000Z', 1, -1, FAR_PAST, 2);
  assert.equal(next, '2028-02-27T20:00:00.000Z');
});

test('computeMonthlyNext: negative offset is treated as 0 (on last day)', () => {
  const next = computeMonthlyNext('2026-01-31T20:00:00.000Z', 1, -1, FAR_PAST, -5);
  assert.equal(next, '2026-02-28T20:00:00.000Z');
});
