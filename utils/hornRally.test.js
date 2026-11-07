const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
	eventDates, participantsFor, nonParticipantsFor, memberHornStatus, hornRallyText, memberLine,
} = require('./hornRally');

function makeDb() {
	const db = new Database(':memory:');
	db.exec(`
		CREATE TABLE members (id INTEGER PRIMARY KEY, ingame_name TEXT, active INTEGER DEFAULT 1, pending INTEGER DEFAULT 0);
		CREATE TABLE member_afk (member_id INTEGER PRIMARY KEY);
		CREATE TABLE horn_rally_attendance (member_id INTEGER NOT NULL, event_date TEXT NOT NULL,
			scanned_at TEXT NOT NULL, PRIMARY KEY (member_id, event_date));
		INSERT INTO members (id, ingame_name, active, pending) VALUES
			(1, 'Aaa', 1, 0), (2, 'bbb', 1, 0), (3, 'Ccc', 1, 0), (4, 'Ddd', 0, 0), (5, 'Eee', 1, 1);
	`);
	return db;
}

const attend = (db, id, date) =>
	db.prepare('INSERT INTO horn_rally_attendance VALUES (?, ?, ?)').run(id, date, '2026-11-07T00:00:00Z');

test('eventDates lists each horn newest first with its head count', () => {
	const db = makeDb();
	attend(db, 1, '2026-10-30'); attend(db, 1, '2026-11-06'); attend(db, 2, '2026-11-06');
	assert.deepEqual(eventDates(db), [
		{ event_date: '2026-11-06', attended: 2 },
		{ event_date: '2026-10-30', attended: 1 },
	]);
});

test('participantsFor returns that date only, by name, case-insensitively', () => {
	const db = makeDb();
	attend(db, 2, '2026-11-06'); attend(db, 1, '2026-11-06'); attend(db, 3, '2026-10-30');
	assert.deepEqual(participantsFor(db, '2026-11-06').map(r => r.ingame_name), ['Aaa', 'bbb']);
});

test('nonParticipantsFor keeps only active, non-pending members who are not on that date and flags AFK', () => {
	const db = makeDb();
	attend(db, 1, '2026-11-06'); attend(db, 3, '2026-10-30');
	db.prepare('INSERT INTO member_afk VALUES (3)').run();
	const rows = nonParticipantsFor(db, '2026-11-06');
	assert.deepEqual(rows.map(r => [r.ingame_name, r.afk]), [['bbb', 0], ['Ccc', 1]]);
});

test('memberHornStatus is null before any horn is recorded', () => {
	assert.equal(memberHornStatus(makeDb(), 1), null);
	assert.equal(hornRallyText(null, false), '·');
});

test('a member on the latest horn shows Participated with that date', () => {
	const db = makeDb();
	attend(db, 1, '2026-10-30'); attend(db, 1, '2026-11-06'); attend(db, 2, '2026-11-06');
	const status = memberHornStatus(db, 1);
	assert.deepEqual(status, { latest: '2026-11-06', lastAttended: '2026-11-06', attendedLatest: true });
	assert.equal(hornRallyText(status, false), '2026-11-06 · Participated');
});

test('a member who missed the latest horn shows Missed plus the last one they attended', () => {
	const db = makeDb();
	attend(db, 1, '2026-11-06'); attend(db, 3, '2026-10-30');
	assert.equal(hornRallyText(memberHornStatus(db, 3), false), '2026-11-06 · Missed\nlast attended 2026-10-30');
	assert.equal(hornRallyText(memberHornStatus(db, 3), true), '2026-11-06 · Missed · AFK\nlast attended 2026-10-30');
});

test('a member with no attendance at all says never attended', () => {
	const db = makeDb();
	attend(db, 1, '2026-11-06');
	assert.equal(hornRallyText(memberHornStatus(db, 2), false), '2026-11-06 · Missed\nnever attended on record');
});

test('memberLine tags AFK members', () => {
	assert.equal(memberLine({ ingame_name: 'Aaa', afk: 0 }), '· Aaa');
	assert.equal(memberLine({ ingame_name: 'Aaa', afk: 1 }), '· Aaa · AFK');
});
