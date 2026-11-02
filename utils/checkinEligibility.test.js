require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const db = require('./db');

function memDb() {
    const h = new Database(':memory:');
    h.exec(`
      CREATE TABLE members (id INTEGER PRIMARY KEY, ingame_name TEXT, discord_id TEXT, active INTEGER DEFAULT 1);
      CREATE TABLE snapshots (id INTEGER PRIMARY KEY, scraped_at TEXT NOT NULL);
      CREATE TABLE member_snapshots (member_id INTEGER, snapshot_id INTEGER, name TEXT, last_active TEXT, last_seen_approx TEXT);
      CREATE TABLE member_afk (member_id INTEGER);
      CREATE TABLE member_checkin_dms (id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER, sent_at TEXT NOT NULL);
      INSERT INTO members (id, ingame_name, discord_id, active) VALUES (1, 'Alpha', 'd1', 1), (2, 'Beta', 'd2', 1), (3, 'Gamma', 'd3', 0), (4, 'Delta', 'd4', 1);
      INSERT INTO snapshots (id, scraped_at) VALUES (1, '2026-10-25T12:00:00.000000');
    `);
    return h;
}

function setRow(h, memberId, lastActive, approx) {
    h.prepare('DELETE FROM member_snapshots WHERE member_id = ? AND snapshot_id = 1').run(memberId);
    h.prepare('INSERT INTO member_snapshots (member_id, snapshot_id, name, last_active, last_seen_approx) VALUES (?, 1, ?, ?, ?)')
        .run(memberId, `m${memberId}`, lastActive, approx);
}

const checkin = (h, memberId, sentAt) => h.prepare('INSERT INTO member_checkin_dms (member_id, sent_at) VALUES (?, ?)').run(memberId, sentAt);
const ids = (h, days = 4) => db.getMembersEligibleForCheckin(days, h).map(m => m.id).sort();

test('a member 4+ days offline who was never checked in on is eligible, with their days inactive', () => {
    const h = memDb();
    setRow(h, 1, '5d ago', '2026-10-20T12:00:00.000000');
    const [m] = db.getMembersEligibleForCheckin(4, h);
    assert.deepEqual([m.id, m.ingame_name, m.discord_id, m.days_inactive], [1, 'm1', 'd1', 5]);
});

test('members under the threshold, inactive members and AFK members are not eligible', () => {
    const h = memDb();
    setRow(h, 1, '3d ago', '2026-10-22T12:00:00.000000');
    setRow(h, 2, 'Online', '2026-10-25T12:00:00.000000');
    setRow(h, 3, '9d ago', '2026-10-16T12:00:00.000000');
    setRow(h, 4, '9d ago', '2026-10-16T12:00:00.000000');
    h.prepare('INSERT INTO member_afk (member_id) VALUES (4)').run();
    assert.deepEqual(ids(h), []);
});

test('a member already checked in on this absence is not eligible again', () => {
    const h = memDb();
    setRow(h, 1, '5d ago', '2026-10-20T12:00:00.000000');
    checkin(h, 1, '2026-10-24T12:00:00.000Z');
    assert.deepEqual(ids(h), []);
});

test('a member who played after their last check-in and is offline again is eligible, even though the weekly row never showed them online', () => {
    const h = memDb();
    checkin(h, 1, '2026-10-12T12:00:00.000Z');
    setRow(h, 1, '4d ago', '2026-10-21T12:00:00.000000');
    assert.deepEqual(ids(h), [1]);
});

test('a member with no readable last-seen time is not re-checked after an earlier check-in', () => {
    const h = memDb();
    checkin(h, 1, '2026-10-12T12:00:00.000Z');
    setRow(h, 1, '6d ago', null);
    assert.deepEqual(ids(h), []);
});

test('only the most recent check-in counts', () => {
    const h = memDb();
    checkin(h, 1, '2026-10-01T12:00:00.000Z');
    checkin(h, 1, '2026-10-23T12:00:00.000Z');
    setRow(h, 1, '5d ago', '2026-10-20T12:00:00.000000');
    assert.deepEqual(ids(h), []);
});
