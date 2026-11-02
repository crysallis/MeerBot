require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const botConfig = require('../utils/botConfig');
const Database = require('better-sqlite3');
const { MODE_OUTPUT_RE, MODE_FLAGS, loadInactiveRows } = require('./scan');

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

function inactiveDb() {
	const h = new Database(':memory:');
	h.exec(`
		CREATE TABLE members (id INTEGER PRIMARY KEY, ingame_name TEXT, discord_id TEXT, active INTEGER DEFAULT 1);
		CREATE TABLE snapshots (id INTEGER PRIMARY KEY, scraped_at TEXT);
		CREATE TABLE member_snapshots (snapshot_id INTEGER, member_id INTEGER, name TEXT, last_active TEXT);
		CREATE TABLE member_afk (member_id INTEGER);
		INSERT INTO members (id, ingame_name, discord_id, active) VALUES
			(1, 'Alpha', '111', 1), (2, 'Beta', NULL, 1), (3, 'Gamma', '333', 1), (4, 'Delta', '444', 0),
			(5, 'Eps', '555', 1), (6, 'Zeta', '666', 1);
		INSERT INTO snapshots (id, scraped_at) VALUES (1, '2026-11-01T00:00:00.000Z'), (2, '2026-11-02T00:00:00.000Z');
		INSERT INTO member_snapshots (snapshot_id, member_id, name, last_active) VALUES
			(1, 6, 'Zeta', '9d ago'),
			(2, 1, 'Alpha', '3d ago'), (2, 2, 'Beta', '7d ago'), (2, 3, 'Gamma', '2d ago'),
			(2, 4, 'Delta', '5d ago'), (2, 5, 'Eps', '4d ago'), (2, 6, 'Zeta', 'Online');
		INSERT INTO member_afk (member_id) VALUES (5);
	`);
	return h;
}

test('loadInactiveRows lists active, non-AFK members at the threshold or beyond from the latest snapshot', () => {
	const rows = loadInactiveRows(inactiveDb(), 3);
	assert.deepEqual(rows.map(r => [r.member_id, r.name, r.days_inactive]).sort((a, b) => a[0] - b[0]), [[1, 'Alpha', 3], [2, 'Beta', 7]]);
});

test('loadInactiveRows keeps the Discord link (or its absence) and the last_active text', () => {
	const byId = Object.fromEntries(loadInactiveRows(inactiveDb(), 3).map(r => [r.member_id, r]));
	assert.equal(byId[1].discord_id, '111');
	assert.equal(byId[2].discord_id, null);
	assert.equal(byId[2].last_active, '7d ago');
});

test('loadInactiveRows uses the threshold it is given', () => {
	assert.deepEqual(loadInactiveRows(inactiveDb(), 2).map(r => r.member_id).sort(), [1, 2, 3]);
});

test('loadInactiveRows returns nothing when there is no snapshot', () => {
	const h = new Database(':memory:');
	h.exec('CREATE TABLE snapshots (id INTEGER PRIMARY KEY); CREATE TABLE members (id INTEGER); CREATE TABLE member_snapshots (snapshot_id INTEGER); CREATE TABLE member_afk (member_id INTEGER);');
	assert.deepEqual(loadInactiveRows(h, 3), []);
});
