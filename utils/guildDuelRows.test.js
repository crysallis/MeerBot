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

test('upsertCrests with no rank inserts a row with an empty rank', () => {
	const db = makeDb();
	upsertCrests(db, 2, '2026-10-12', null, 3100, '2026-10-19T01:00:00Z');
	const row = db.prepare('SELECT rank, crests FROM guild_duel_rankings WHERE member_id = 2').get();
	assert.deepEqual({ ...row }, { rank: null, crests: 3100 });
});

test('upsertCrests with no rank keeps a rank that was already saved', () => {
	const db = makeDb();
	addRow(db, 1, '2026-10-19', { rank: 7, crests: 3900, damage: 5e11 });
	upsertCrests(db, 1, '2026-10-19', null, 4100, '2026-10-26T01:00:00Z');
	const row = db.prepare('SELECT rank, crests, damage FROM guild_duel_rankings WHERE member_id = 1').get();
	assert.deepEqual({ ...row }, { rank: 7, crests: 4100, damage: 5e11 });
});

test('upsertCrests with a rank still overwrites the old rank', () => {
	const db = makeDb();
	addRow(db, 1, '2026-10-19', { rank: 7, crests: 3900 });
	upsertCrests(db, 1, '2026-10-19', 2, 4100, '2026-10-26T01:00:00Z');
	assert.equal(db.prepare('SELECT rank FROM guild_duel_rankings WHERE member_id = 1').get().rank, 2);
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

test('guildDuelLow loadRows returns the weekly damage values next to the crest rows', () => {
	const db = makeDb();
	db.exec(`
		CREATE TABLE snapshots (id INTEGER PRIMARY KEY, scraped_at TEXT);
		CREATE TABLE member_snapshots (snapshot_id INTEGER, member_id INTEGER, activeness INTEGER);
		CREATE TABLE member_afk (member_id INTEGER, set_at TEXT, return_date TEXT);
		CREATE TABLE member_afk_history (member_id INTEGER, started_at TEXT, ended_at TEXT);
	`);
	addRow(db, 1, '2026-10-19', { rank: 3, crests: 4200, damage: 5e11 });
	addRow(db, 2, '2026-10-19', { crests: 4000 });
	addRow(db, 3, '2026-10-19', { damage: 3e11 });
	const rows = loadRows(db);
	assert.deepEqual(rows.damageRows.map(r => [r.name, r.week, r.damage]),
		[['Aaa', '2026-10-19', 5e11], ['Ccc', '2026-10-19', 3e11]]);
	assert.deepEqual(rows.crestRows.map(r => r.name), ['Aaa', 'Bbb']);
});

const { latestDuelWeek, weekHasDamageData, duelDamageText } = require('./guildDuelRows');

function addMembers(db, count) {
	for (let i = 4; i < 4 + count; i++) db.prepare("INSERT INTO members (id, ingame_name) VALUES (?, ?)").run(i, `M${i}`);
}

test('latestDuelWeek returns the most recent crests row with that same week\'s damage', () => {
	const db = makeDb();
	addRow(db, 1, '2026-10-12', { rank: 2, crests: 4400, at: '2026-10-19T01:00:00Z' });
	addRow(db, 1, '2026-10-19', { rank: 3, crests: 4200, damage: 5e11, at: '2026-10-26T01:00:00Z' });
	assert.deepEqual({ ...latestDuelWeek(db, 1) },
		{ period_start: '2026-10-19', rank: 3, crests: 4200, damage: 5e11 });
});

test('latestDuelWeek ignores a newer damage-only week and keeps the last week with crests', () => {
	const db = makeDb();
	addRow(db, 1, '2026-10-19', { crests: 4200, damage: 5e11, at: '2026-10-26T01:00:00Z' });
	addRow(db, 1, '2026-10-26', { damage: 4e11, at: '2026-11-01T20:00:00Z' });
	const row = latestDuelWeek(db, 1);
	assert.equal(row.period_start, '2026-10-19');
	assert.equal(row.damage, 5e11);
});

test('latestDuelWeek is undefined for a member with no crests row', () => {
	assert.equal(latestDuelWeek(makeDb(), 1), undefined);
});

test('weekHasDamageData needs ten members with damage that week', () => {
	const db = makeDb();
	addMembers(db, 12);
	for (let id = 4; id < 13; id++) addRow(db, id, '2026-10-19', { crests: 4000, damage: 1e11 });
	assert.equal(weekHasDamageData(db, '2026-10-19'), false);
	addRow(db, 13, '2026-10-19', { crests: 4000, damage: 1e11 });
	assert.equal(weekHasDamageData(db, '2026-10-19'), true);
	assert.equal(weekHasDamageData(db, '2026-10-12'), false);
});

test('duelDamageText shows the damage in the game\'s own style', () => {
	assert.equal(duelDamageText({ damage: 567e9 }, true), '567B');
	assert.equal(duelDamageText({ damage: 19.166e9 }, true), '19.2B');
	assert.equal(duelDamageText({ damage: 450e6 }, true), '450M');
});

test('duelDamageText says no damage when the week has damage data and this member has none', () => {
	assert.equal(duelDamageText({ damage: null }, true), 'No damage');
	assert.equal(duelDamageText({ damage: 0 }, true), 'No damage');
});

test('duelDamageText stays blank for a week that predates damage capture and for no row at all', () => {
	assert.equal(duelDamageText({ damage: null }, false), '·');
	assert.equal(duelDamageText(undefined, false), '·');
});

const { duelCrestsText } = require('./guildDuelRows');

test('duelDamageText shows AFK instead of "No damage" for a member who was out that week', () => {
	assert.equal(duelDamageText({ damage: null }, true, true), 'AFK');
	assert.equal(duelDamageText({ damage: 0 }, true, true), 'AFK');
});

test('duelDamageText keeps the damage and adds the AFK tag when an AFK member still attacked', () => {
	assert.equal(duelDamageText({ damage: 567e9 }, true, true), '567B · AFK');
});

test('duelDamageText says AFK even for a week before damage capture, since the member was out', () => {
	assert.equal(duelDamageText({ damage: null }, false, true), 'AFK');
});

test('duelCrestsText keeps today\'s crests format and adds the rank when there is one', () => {
	assert.equal(duelCrestsText({ crests: 4850, rank: null }), '4850');
	assert.equal(duelCrestsText({ crests: 4850, rank: 3 }), '4850 (#3)');
});

test('duelCrestsText tags a member who was AFK that week', () => {
	assert.equal(duelCrestsText({ crests: 100, rank: null }, true), '100 · AFK');
});

test('duelCrestsText with no crests row is blank, or AFK when the member is out right now', () => {
	assert.equal(duelCrestsText(undefined, false, false), '·');
	assert.equal(duelCrestsText(undefined, false, true), 'AFK');
});

const { damageReport } = require('./guildDuelRows');

function damageDb() {
	const db = makeDb();
	db.exec(`
		CREATE TABLE member_afk (member_id INTEGER, reason TEXT, return_date TEXT, set_at TEXT);
		CREATE TABLE member_afk_history (member_id INTEGER, started_at TEXT, ended_at TEXT, return_date TEXT, reason TEXT);
	`);
	addMembers(db, 14);
	return db;
}

test('damageReport lists only weeks with damage data, with their damage rows', () => {
	const db = damageDb();
	for (let id = 4; id < 14; id++) addRow(db, id, '2026-10-19', { crests: 4000, damage: (id - 3) * 1e10 });
	for (let id = 4; id < 7; id++) addRow(db, id, '2026-10-12', { crests: 4000, damage: 1e10 });
	const r = damageReport(db);
	assert.deepEqual(r.periods, ['2026-10-19']);
	assert.equal(r.rows.length, 10);
	assert.ok(r.rows.every(x => x.period_start === '2026-10-19' && x.damage > 0));
	assert.deepEqual({ ...r.rows.find(x => x.member_id === 5) }, { member_id: 5, period_start: '2026-10-19', damage: 2e10 });
});

test('damageReport says who was AFK in each damage week, by the recap rule', () => {
	const db = damageDb();
	for (let id = 4; id < 14; id++) addRow(db, id, '2026-10-19', { crests: 4000, damage: 1e10 });
	db.prepare("INSERT INTO member_afk VALUES (4, 'travel', NULL, '2026-10-20T10:00:00.000Z')").run();
	db.prepare("INSERT INTO member_afk VALUES (5, 'later', NULL, '2026-10-26T02:00:00.000Z')").run();
	db.prepare("INSERT INTO member_afk_history (member_id, started_at, ended_at) VALUES (6, '2026-10-01T00:00:00.000Z', '2026-10-21T23:59:59.999Z')").run();
	assert.deepEqual(damageReport(db).afk['2026-10-19'].sort((a, b) => a - b), [4, 6]);
});

test('damageReport on a database with no damage is empty', () => {
	assert.deepEqual(damageReport(damageDb()), { periods: [], rows: [], afk: {} });
});
