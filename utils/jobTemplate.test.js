const test = require('node:test');
const assert = require('node:assert/strict');
const { renderTemplate, shouldFireToday, computeLateness, buildMentions } = require('./jobTemplate');

test('renderTemplate substitutes known keys', () => {
  assert.equal(renderTemplate('Hello {{name}}!', { name: 'RiffRaff' }), 'Hello RiffRaff!');
});

test('renderTemplate leaves unknown keys literal', () => {
  assert.equal(renderTemplate('Hello {{typo}}!', { name: 'RiffRaff' }), 'Hello {{typo}}!');
});

test('renderTemplate is a no-op with no tokens', () => {
  assert.equal(renderTemplate('plain text', {}), 'plain text');
});

test('renderTemplate substitutes multiple occurrences of the same key', () => {
  assert.equal(renderTemplate('{{n}} and {{n}} again', { n: 5 }), '5 and 5 again');
});

test('shouldFireToday: null daysOfWeek means every day', () => {
  const wednesday = new Date('2026-07-15T00:00:00Z'); // 2026-07-15 is a Wednesday
  assert.equal(shouldFireToday(null, wednesday), true);
});

test('shouldFireToday: empty string means every day', () => {
  const saturday = new Date('2026-07-18T00:00:00Z'); // 2026-07-18 is a Saturday
  assert.equal(shouldFireToday('', saturday), true);
});

test('shouldFireToday: weekday filter skips Saturday', () => {
  const saturday = new Date('2026-07-18T00:00:00Z');
  assert.equal(shouldFireToday('1,2,3,4,5', saturday), false);
});

test('shouldFireToday: weekday filter fires on Wednesday', () => {
  const wednesday = new Date('2026-07-15T00:00:00Z');
  assert.equal(shouldFireToday('1,2,3,4,5', wednesday), true);
});

test('shouldFireToday: weekend filter fires on Sunday', () => {
  const sunday = new Date('2026-07-19T00:00:00Z');
  assert.equal(shouldFireToday('6,7', sunday), true);
});

test('computeLateness: on-time run', () => {
  const fireAt = '2026-07-12T00:00:00.000Z';
  const now    = new Date('2026-07-12T00:05:00.000Z'); // 5 min late
  const result = computeLateness(fireAt, now, 30);
  assert.equal(result.lateMinutes, 5);
  assert.equal(result.isLate, false);
  assert.equal(result.tooLateToSend, false);
});

test('computeLateness: past warning threshold but sendable', () => {
  const fireAt = '2026-07-12T00:00:00.000Z';
  const now    = new Date('2026-07-12T00:45:00.000Z'); // 45 min late
  const result = computeLateness(fireAt, now, 30);
  assert.equal(result.lateMinutes, 45);
  assert.equal(result.isLate, true);
  assert.equal(result.tooLateToSend, false);
});

test('computeLateness: past max-late threshold, do not send', () => {
  const fireAt = '2026-07-12T00:00:00.000Z';
  const now    = new Date('2026-07-12T03:00:00.000Z'); // 180 min late
  const result = computeLateness(fireAt, now, 30);
  assert.equal(result.lateMinutes, 180);
  assert.equal(result.isLate, true);
  assert.equal(result.tooLateToSend, true);
});

test('buildMentions: empty array pings nobody', () => {
  const result = buildMentions([]);
  assert.equal(result.content, '');
  assert.deepEqual(result.allowedMentions, { parse: [] });
});

test('buildMentions: everyone', () => {
  const result = buildMentions([{ type: 'everyone' }]);
  assert.match(result.content, /@everyone/);
  assert.deepEqual(result.allowedMentions, { parse: ['everyone'] });
});

test('buildMentions: here uses the everyone parse flag (Discord has no separate here flag)', () => {
  const result = buildMentions([{ type: 'here' }]);
  assert.match(result.content, /@here/);
  assert.deepEqual(result.allowedMentions, { parse: ['everyone'] });
});

test('buildMentions: a single role does not set the everyone parse flag', () => {
  const result = buildMentions([{ type: 'role', id: '999' }]);
  assert.match(result.content, /<@&999>/);
  assert.deepEqual(result.allowedMentions, { parse: [], roles: ['999'] });
});

test('buildMentions: role + everyone together set both without conflict', () => {
  const result = buildMentions([{ type: 'role', id: '999' }, { type: 'everyone' }]);
  assert.match(result.content, /<@&999>/);
  assert.match(result.content, /@everyone/);
  assert.deepEqual(result.allowedMentions, { parse: ['everyone'], roles: ['999'] });
});

test('buildMentions: multiple roles are all included', () => {
  const result = buildMentions([{ type: 'role', id: '1' }, { type: 'role', id: '2' }]);
  assert.deepEqual(result.allowedMentions.roles, ['1', '2']);
});
