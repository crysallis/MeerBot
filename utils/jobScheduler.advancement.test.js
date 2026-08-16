require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const { nextFire, nextDailyAt, nextWeeklyAt } = require('./jobScheduler');

test('nextFire: daily:1 advances by exactly one day', () => {
  // Use a future fire_at to test pure advancement without triggering fast-forward logic.
  // The function should add exactly one day to the fire_at time.
  const now = Date.now();
  const futureTime = new Date(now + 25 * 60 * 60 * 1000); // 25 hours in the future
  const fireAt = futureTime.toISOString();
  const job = { fire_at: fireAt, recurrence: 'daily:1' };
  const result = new Date(nextFire(job));
  const expected = new Date(new Date(fireAt).getTime() + 24 * 60 * 60 * 1000);
  assert.equal(result.getTime(), expected.getTime());
});

test('nextFire: weekly:2 advances by 14 days', () => {
  // Use a future fire_at to test pure advancement without triggering fast-forward logic.
  const now = Date.now();
  const futureTime = new Date(now + 25 * 60 * 60 * 1000); // 25 hours in the future
  const fireAt = futureTime.toISOString();
  const job = { fire_at: fireAt, recurrence: 'weekly:2' };
  const result = new Date(nextFire(job));
  const expected = new Date(new Date(fireAt).getTime() + 14 * 24 * 60 * 60 * 1000);
  assert.equal(result.getTime(), expected.getTime());
});

test('nextFire: fast-forwards past multiple missed intervals', () => {
  // fire_at is 10 days in the past relative to "now" at test-run time --
  // daily:1 must skip forward to the next occurrence strictly after now,
  // not just add one day to the stale fire_at.
  const baseNow = Date.now();
  const staleFireAt = new Date(baseNow - 10 * 24 * 60 * 60 * 1000).toISOString();
  const job = { fire_at: staleFireAt, recurrence: 'daily:1' };
  const result = new Date(nextFire(job));
  assert.ok(result.getTime() > baseNow, 'next fire time must be in the future');
  assert.ok(result.getTime() - baseNow <= 24 * 60 * 60 * 1000, 'next fire time must be within one day from now');
});

test('nextFire: defaults to daily:1 when recurrence is missing', () => {
  // Use a future fire_at to test pure advancement without triggering fast-forward logic.
  const now = Date.now();
  const futureTime = new Date(now + 25 * 60 * 60 * 1000);
  const fireAt = futureTime.toISOString();
  const job = { fire_at: fireAt };
  const result = new Date(nextFire(job));
  const expected = new Date(new Date(fireAt).getTime() + 24 * 60 * 60 * 1000);
  assert.equal(result.getTime(), expected.getTime());
});

test('nextDailyAt: returns tomorrow if the target time today has already passed', () => {
  const now = new Date();
  const pastHour = (now.getUTCHours() - 1 + 24) % 24;
  const result = new Date(nextDailyAt(pastHour, 0));
  assert.ok(result.getTime() > now.getTime(), 'must be in the future');
});

test('nextWeeklyAt: returns a date on the requested day of week', () => {
  const result = new Date(nextWeeklyAt(3, 9, 0)); // Wednesday
  assert.equal(result.getUTCDay(), 3);
});
