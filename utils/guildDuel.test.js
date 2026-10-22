const { test } = require('node:test');
const assert = require('node:assert');
const { guildDuelPeriodKey } = require('./guildDuel');

test('period is one week behind the most recent Monday (UTC)', () => {
	assert.strictEqual(guildDuelPeriodKey(new Date('2026-10-21T12:00:00Z')), '2026-10-12');
	assert.strictEqual(guildDuelPeriodKey(new Date('2026-10-19T00:00:00Z')), '2026-10-12');
	assert.strictEqual(guildDuelPeriodKey(new Date('2026-10-18T23:59:59Z')), '2026-10-05');
	assert.strictEqual(guildDuelPeriodKey(new Date('2026-10-25T23:00:00Z')), '2026-10-12');
});
