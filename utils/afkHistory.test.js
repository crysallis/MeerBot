const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { archiveEnded, archiveExpired } = require('./afkHistory');

function freshDb() {
	const db = new Database(':memory:');
	db.exec(`
		CREATE TABLE member_afk (id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER NOT NULL UNIQUE,
			reason TEXT, return_date TEXT, set_by TEXT NOT NULL, set_at TEXT NOT NULL);
		CREATE TABLE member_afk_history (id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER NOT NULL,
			started_at TEXT NOT NULL, ended_at TEXT NOT NULL, return_date TEXT, reason TEXT);
	`);
	return db;
}

test('archiveEnded copies the current AFK row with the given end time', () => {
	const db = freshDb();
	db.prepare("INSERT INTO member_afk (member_id, reason, return_date, set_by, set_at) VALUES (1, 'trip', '2026-11-01', 'u', '2026-10-20T10:00:00.000Z')").run();
	archiveEnded(db, 1, '2026-10-22T08:00:00.000Z');
	const rows = db.prepare('SELECT * FROM member_afk_history').all();
	assert.strictEqual(rows.length, 1);
	assert.strictEqual(rows[0].started_at, '2026-10-20T10:00:00.000Z');
	assert.strictEqual(rows[0].ended_at, '2026-10-22T08:00:00.000Z');
	assert.strictEqual(rows[0].reason, 'trip');
});

test('archiveEnded does nothing when the member was not AFK', () => {
	const db = freshDb();
	archiveEnded(db, 1, '2026-10-22T08:00:00.000Z');
	assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM member_afk_history').get().n, 0);
});

test('archiveExpired archives only past-due rows, ending at the end of the return day', () => {
	const db = freshDb();
	db.prepare("INSERT INTO member_afk (member_id, return_date, set_by, set_at) VALUES (1, '2026-10-10', 'u', '2026-10-01T00:00:00.000Z')").run();
	db.prepare("INSERT INTO member_afk (member_id, return_date, set_by, set_at) VALUES (2, '2026-11-10', 'u', '2026-10-01T00:00:00.000Z')").run();
	db.prepare("INSERT INTO member_afk (member_id, set_by, set_at) VALUES (3, 'u', '2026-10-01T00:00:00.000Z')").run();
	archiveExpired(db, '2026-10-24');
	const rows = db.prepare('SELECT member_id, ended_at FROM member_afk_history').all();
	assert.deepStrictEqual(rows, [{ member_id: 1, ended_at: '2026-10-10T23:59:59.999Z' }]);
});
