const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { missingForPeriod, latestCrestsRow, upsertCrests, crestReport } = require('./guildDuelRows');
const { loadRows } = require('./guildDuelLow');

function makeDb() {
	const db = new Database(':memory:');
	db.exec(`
		CREATE TABLE warbands (id INTEGER PRIMARY KEY, name TEXT);
		CREATE TABLE members (id INTEGER PRIMARY KEY, ingame_name TEXT, active INTEGER DEFAULT 1,
			pending INTEGER DEFAULT 0, warband_id INTEGER);
		CREATE TABLE guild_duel_rankings (member_id INTEGER NOT NULL, period_start TEXT NOT NULL,
			rank INTEGER, crests INTEGER, scanned_at TEXT NOT NULL, damage INTEGER, damage_scanned_at TEXT,
			PRIMARY KEY (member_id, period_start));
		INSERT INTO members (id, ingame_name) VALUES (1, 'Aaa'), (2, 'Bbb'), (3, 'Ccc');
	`);
	return db;
}

const addRow = (db, id, period, { rank = null, crests = null, damage = null, at = '2026-10-19T12:00:00Z' } = {}) =>
	db.prepare('INSERT INTO guild_duel_rankings (member_id, period_start, rank, crests, scanned_at, damage) VALUES (?,?,?,?,?,?)')
		.run(id, period, rank, crests, at, damage);

test('missingForPeriod lists a member whose only row is damage-only and omits one with crests', () => {
	const db = makeDb();
	addRow(db, 1, '2026-10-19', { damage: 5e11 });
	addRow(db, 2, '2026-10-19', { rank: 4, crests: 4000 });
	assert.deepEqual(missingForPeriod(db, '2026-10-19').map(r => r.ingame_name), ['Aaa', 'Ccc']);
});

test('upsertCrests on a row that already has damage keeps the damage', () => {
	const db = makeDb();
	addRow(db, 1, '2026-10-19', { damage: 5e11 });
	upsertCrests(db, 1, '2026-10-19', 3, 4200, '2026-10-26T01:00:00Z');
	const row = db.prepare('SELECT * FROM guild_duel_rankings WHERE member_id = 1').get();
	assert.equal(row.damage, 5e11);
	assert.deepEqual([row.rank, row.crests, row.scanned_at], [3, 4200, '2026-10-26T01:00:00Z']);
});

test('upsertCrests inserts a fresh row when none exists', () => {
	const db = makeDb();
	upsertCrests(db, 2, '2026-10-12', 9, 3100, '2026-10-19T01:00:00Z');
	assert.equal(db.prepare('SELECT crests FROM guild_duel_rankings WHERE member_id = 2').get().crests, 3100);
});

test('latestCrestsRow returns the older crests row when a newer damage-only row exists', () => {
	const db = makeDb();
	addRow(db, 1, '2026-10-12', { rank: 2, crests: 4400, at: '2026-10-19T01:00:00Z' });
	addRow(db, 1, '2026-10-19', { damage: 5e11, at: '2026-10-25T20:00:00Z' });
	assert.deepEqual({ ...latestCrestsRow(db, 1) }, { rank: 2, crests: 4400 });
});

test('crestReport ignores a period that only has damage-only rows', () => {
	const db = makeDb();
	addRow(db, 1, '2026-10-12', { rank: 1, crests: 4400 });
	addRow(db, 1, '2026-10-19', { damage: 5e11 });
	const report = crestReport(db);
	assert.deepEqual(report.periods, ['2026-10-12']);
	assert.ok(report.rows.every(r => r.crests !== null));
});

test('crestReport lists a damage-only member as absent for a period that has crests', () => {
	const db = makeDb();
	addRow(db, 1, '2026-10-19', { rank: 1, crests: 4400 });
	addRow(db, 2, '2026-10-19', { damage: 3e11 });
	const absent = crestReport(db).absent.filter(a => a.period_start === '2026-10-19').map(a => a.ingame_name);
	assert.deepEqual(absent, ['Bbb', 'Ccc']);
});

test('guildDuelLow loadRows ignores damage-only rows', () => {
	const db = makeDb();
	db.exec(`
		CREATE TABLE snapshots (id INTEGER PRIMARY KEY, scraped_at TEXT);
		CREATE TABLE member_snapshots (snapshot_id INTEGER, member_id INTEGER, activeness INTEGER);
		CREATE TABLE member_afk (member_id INTEGER, set_at TEXT, return_date TEXT);
		CREATE TABLE member_afk_history (member_id INTEGER, started_at TEXT, ended_at TEXT);
	`);
	addRow(db, 1, '2026-10-19', { damage: 5e11 });
	addRow(db, 2, '2026-10-19', { rank: 4, crests: 4000 });
	assert.deepEqual(loadRows(db).crestRows.map(r => r.name), ['Bbb']);
});
