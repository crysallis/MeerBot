const test = require('node:test');
const assert = require('node:assert/strict');
const { pickPollEmoji, nextOccurrenceUtc, EMOJI_POOL } = require('./glorycta');

test('EMOJI_POOL has no flag emoji (regional indicator pairs)', () => {
  // Flags are built from two regional-indicator code points (U+1F1E6-U+1F1FF).
  // None of the pool entries should be exactly two such code points.
  const isFlag = s => /^[\u{1F1E6}-\u{1F1FF}]{2}$/u.test(s);
  assert.equal(EMOJI_POOL.some(isFlag), false);
});

test('EMOJI_POOL has no skin-tone modifier suffix', () => {
  const hasSkinTone = s => /[\u{1F3FB}-\u{1F3FF}]/u.test(s);
  assert.equal(EMOJI_POOL.some(hasSkinTone), false);
});

test('EMOJI_POOL has at least 20 distinct entries', () => {
  assert.ok(EMOJI_POOL.length >= 20);
  assert.equal(new Set(EMOJI_POOL).size, EMOJI_POOL.length);
});

test('pickPollEmoji returns two distinct emoji from the pool', () => {
  const [a, b] = pickPollEmoji();
  assert.notEqual(a, b);
  assert.ok(EMOJI_POOL.includes(a));
  assert.ok(EMOJI_POOL.includes(b));
});

test('pickPollEmoji varies across calls (not hardcoded)', () => {
  const seen = new Set();
  for (let i = 0; i < 30; i++) {
    const [a, b] = pickPollEmoji();
    seen.add(a);
    seen.add(b);
  }
  // With 30 draws from a pool of 20+, expect more than 2 distinct emoji to
  // have appeared -- guards against an accidental hardcoded fixed pair.
  assert.ok(seen.size > 2);
});

test('nextOccurrenceUtc: time later today rolls to today', () => {
  const from = new Date('2026-08-12T10:00:00Z');
  const result = nextOccurrenceUtc('14:00', from);
  assert.equal(result.toISOString(), '2026-08-12T14:00:00.000Z');
});

test('nextOccurrenceUtc: time already passed today rolls to tomorrow', () => {
  const from = new Date('2026-08-12T10:00:00Z');
  const result = nextOccurrenceUtc('06:00', from);
  assert.equal(result.toISOString(), '2026-08-13T06:00:00.000Z');
});

test('nextOccurrenceUtc: exact current time counts as passed, rolls to tomorrow', () => {
  const from = new Date('2026-08-12T10:00:00.000Z');
  const result = nextOccurrenceUtc('10:00', from);
  assert.equal(result.toISOString(), '2026-08-13T10:00:00.000Z');
});

test('nextOccurrenceUtc: two options can land on different calendar dates independently', () => {
  const from = new Date('2026-08-12T15:00:00Z');
  const early = nextOccurrenceUtc('06:00', from); // already passed -> tomorrow
  const late  = nextOccurrenceUtc('20:00', from); // still ahead -> today
  assert.equal(early.toISOString(), '2026-08-13T06:00:00.000Z');
  assert.equal(late.toISOString(), '2026-08-12T20:00:00.000Z');
});
