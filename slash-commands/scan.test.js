require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const botConfig = require('../utils/botConfig');
const { MODE_OUTPUT_RE, MODE_FLAGS } = require('./scan');

test('MODE_OUTPUT_RE matches every mode result line, including the damage scan', () => {
	assert.ok(MODE_OUTPUT_RE.test('GUILD_DUEL_DAMAGE: saved 40 entries for period 2026-10-19.'));
	assert.ok(MODE_OUTPUT_RE.test('GUILD_DUEL: saved 5 entries for period 2026-10-12.'));
	assert.ok(MODE_OUTPUT_RE.test('MODE_FAILED: guild_duel_damage - boom'));
});

test('MODE_OUTPUT_RE ignores progress chatter', () => {
	assert.ok(!MODE_OUTPUT_RE.test('Mode scan: guild_duel_damage'));
	assert.ok(!MODE_OUTPUT_RE.test('  Guild Duel Damage: skipped unmatched \'x\''));
});

test('the damage scan has an admin toggle that maps to its CLI flag, off by default', () => {
	assert.equal(MODE_FLAGS.SCAN_GUILD_DUEL_DAMAGE, '--guild-duel-damage');
	assert.equal(botConfig.CONFIG_META.SCAN_GUILD_DUEL_DAMAGE.category, 'scan_modes');
	assert.equal(botConfig.CONFIG_META.SCAN_GUILD_DUEL_DAMAGE.default, 'false');
});

test('every scan flag key is registered in the admin config', () => {
	for (const key of Object.keys(MODE_FLAGS)) {
		assert.ok(botConfig.CONFIG_META[key], `${key} missing from CONFIG_META`);
	}
});
