require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert');
const botConfig = require('./botConfig');
const { THRESHOLDS, CONFIG_KEYS, thresholdsFromConfig } = require('./guildDuelLow');

test('every Guild Duel threshold is registered in the admin config under thresholds', () => {
	for (const key of Object.values(CONFIG_KEYS)) {
		assert.ok(botConfig.CONFIG_META[key], `${key} missing from CONFIG_META`);
		assert.strictEqual(botConfig.CONFIG_META[key].category, 'thresholds');
	}
});

test('admin config defaults match the module THRESHOLDS so they cannot drift', () => {
	const fromDefaults = thresholdsFromConfig(key => botConfig.CONFIG_META[key].default);
	assert.deepStrictEqual(fromDefaults, THRESHOLDS);
});
