require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const db = require('./db');

const OLD_TABLE = `
  CREATE TABLE members (id INTEGER PRIMARY KEY);
  CREATE TABLE snapshots (id INTEGER PRIMARY KEY, scraped_at TEXT NOT NULL);
  CREATE TABLE member_snapshots (member_id INTEGER, snapshot_id INTEGER, last_active TEXT);
  CREATE TABLE member_checkin_dms (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id             INTEGER NOT NULL REFERENCES members(id),
    discord_id            TEXT NOT NULL,
    dm_message_id         TEXT,
    sent_at               TEXT NOT NULL,
    days_inactive_at_send INTEGER NOT NULL,
    status                TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'responded_text', 'responded_reaction', 'dm_failed')),
    response_text         TEXT,
    response_emoji        TEXT,
    responded_at          TEXT
  );
  CREATE INDEX idx_checkin_message ON member_checkin_dms(dm_message_id);
  CREATE INDEX idx_checkin_member_status ON member_checkin_dms(member_id, status);
`;

function oldShapeDb() {
    const h = new Database(':memory:');
    h.exec(OLD_TABLE);
    return h;
}

function addCheckin(h, { id, memberId, discordId = `d${memberId}`, messageId = `m${id}`, sentAt, status = 'pending', respondedAt = null }) {
    h.prepare('INSERT OR IGNORE INTO members (id) VALUES (?)').run(memberId);
    h.prepare(`INSERT INTO member_checkin_dms
        (id, member_id, discord_id, dm_message_id, sent_at, days_inactive_at_send, status, responded_at)
        VALUES (?, ?, ?, ?, ?, 4, ?, ?)`).run(id, memberId, discordId, messageId, sentAt, status, respondedAt);
}

function addSnapshot(h, id, scrapedAt, activeByMember) {
    h.prepare('INSERT INTO snapshots (id, scraped_at) VALUES (?, ?)').run(id, scrapedAt);
    for (const [memberId, lastActive] of Object.entries(activeByMember)) {
        h.prepare('INSERT INTO member_snapshots (member_id, snapshot_id, last_active) VALUES (?, ?, ?)')
            .run(Number(memberId), id, lastActive);
    }
}

function migrated() {
    const h = oldShapeDb();
    db.migrateCheckinReturned(h);
    return h;
}

test('migration rebuilds the table, keeps every row, and allows the returned status', () => {
    const h = oldShapeDb();
    addCheckin(h, { id: 1, memberId: 1, sentAt: '2026-10-01T10:00:00.000Z', status: 'pending' });
    addCheckin(h, { id: 2, memberId: 2, sentAt: '2026-10-02T10:00:00.000Z', status: 'responded_text', respondedAt: '2026-10-02T11:00:00.000Z' });
    addCheckin(h, { id: 7, memberId: 3, sentAt: '2026-10-03T10:00:00.000Z', status: 'dm_failed' });

    assert.equal(db.migrateCheckinReturned(h), true);

    const rows = h.prepare('SELECT id, member_id, status, responded_at FROM member_checkin_dms ORDER BY id').all();
    assert.deepEqual(rows, [
        { id: 1, member_id: 1, status: 'pending', responded_at: null },
        { id: 2, member_id: 2, status: 'responded_text', responded_at: '2026-10-02T11:00:00.000Z' },
        { id: 7, member_id: 3, status: 'dm_failed', responded_at: null },
    ]);
    const cols = h.prepare('PRAGMA table_info(member_checkin_dms)').all().map(c => c.name);
    assert.ok(cols.includes('returned_at'));
    h.prepare("UPDATE member_checkin_dms SET status = 'returned' WHERE id = 1").run();
    assert.equal(h.prepare('SELECT status FROM member_checkin_dms WHERE id = 1').get().status, 'returned');
    assert.throws(() => h.prepare("UPDATE member_checkin_dms SET status = 'nonsense' WHERE id = 1").run());
});

test('migration keeps the indexes and continues the id sequence', () => {
    const h = oldShapeDb();
    addCheckin(h, { id: 7, memberId: 1, sentAt: '2026-10-01T10:00:00.000Z' });
    db.migrateCheckinReturned(h);
    const indexes = h.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'member_checkin_dms'")
        .all().map(i => i.name);
    assert.ok(indexes.includes('idx_checkin_message'));
    assert.ok(indexes.includes('idx_checkin_member_status'));
    h.prepare('INSERT INTO members (id) VALUES (9)').run();
    const next = h.prepare(`INSERT INTO member_checkin_dms (member_id, discord_id, sent_at, days_inactive_at_send)
        VALUES (9, 'd9', '2026-10-05T10:00:00.000Z', 4)`).run();
    assert.equal(Number(next.lastInsertRowid), 8);
});

test('migration is a no-op the second time', () => {
    const h = oldShapeDb();
    assert.equal(db.migrateCheckinReturned(h), true);
    assert.equal(db.migrateCheckinReturned(h), false);
});

test('the live table already allows the returned status after startup', () => {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'member_checkin_dms'").get().sql;
    assert.ok(sql.includes("'returned'"));
});

test('markReturnedCheckins tags a pending check-in once a later snapshot shows the member active', () => {
    const h = migrated();
    addCheckin(h, { id: 1, memberId: 1, sentAt: '2026-10-20T10:00:00.000Z' });
    addSnapshot(h, 1, '2026-10-19T12:00:00.000000', { 1: '5d ago' });
    addSnapshot(h, 2, '2026-10-21T12:00:00.000000', { 1: '6d ago' });
    addSnapshot(h, 3, '2026-10-22T12:00:00.000000', { 1: 'Online' });
    addSnapshot(h, 4, '2026-10-23T12:00:00.000000', { 1: '2h ago' });

    assert.equal(db.markReturnedCheckins(h), 1);

    const row = h.prepare('SELECT status, returned_at, responded_at FROM member_checkin_dms WHERE id = 1').get();
    assert.equal(row.status, 'returned');
    assert.equal(row.returned_at, '2026-10-22T12:00:00.000000');
    assert.equal(row.responded_at, null);
});

test('markReturnedCheckins leaves everything else alone', () => {
    const h = migrated();
    addCheckin(h, { id: 1, memberId: 1, sentAt: '2026-10-20T10:00:00.000Z' });
    addCheckin(h, { id: 2, memberId: 2, sentAt: '2026-10-20T10:00:00.000Z' });
    addCheckin(h, { id: 3, memberId: 3, sentAt: '2026-10-20T10:00:00.000Z', status: 'responded_text', respondedAt: '2026-10-20T11:00:00.000Z' });
    addCheckin(h, { id: 4, memberId: 4, sentAt: '2026-10-20T10:00:00.000Z', status: 'dm_failed' });
    addCheckin(h, { id: 5, memberId: 5, sentAt: '2026-10-20T10:00:00.000Z' });
    addSnapshot(h, 1, '2026-10-19T12:00:00.000000', { 5: 'Online' });
    addSnapshot(h, 2, '2026-10-22T12:00:00.000000', { 1: '2d ago', 2: null, 3: 'Online', 4: 'Online', 5: '9d ago' });

    assert.equal(db.markReturnedCheckins(h), 0);

    const statuses = h.prepare('SELECT id, status FROM member_checkin_dms ORDER BY id').all().map(r => r.status);
    assert.deepEqual(statuses, ['pending', 'pending', 'responded_text', 'dm_failed', 'pending']);
});

test('markReturnedCheckins is idempotent', () => {
    const h = migrated();
    addCheckin(h, { id: 1, memberId: 1, sentAt: '2026-10-20T10:00:00.000Z' });
    addSnapshot(h, 1, '2026-10-22T12:00:00.000000', { 1: 'Online' });
    assert.equal(db.markReturnedCheckins(h), 1);
    assert.equal(db.markReturnedCheckins(h), 0);
});

test('a reaction on the check-in DM still counts after the member returned', () => {
    const h = migrated();
    addCheckin(h, { id: 1, memberId: 1, messageId: 'dm-1', sentAt: '2026-10-20T10:00:00.000Z' });
    addCheckin(h, { id: 2, memberId: 2, messageId: 'dm-2', sentAt: '2026-10-20T10:00:00.000Z', status: 'responded_reaction', respondedAt: '2026-10-20T11:00:00.000Z' });
    h.prepare("UPDATE member_checkin_dms SET status = 'returned' WHERE id = 1").run();

    assert.equal(db.getOpenCheckinByMessageId('dm-1', h).id, 1);
    assert.equal(db.getOpenCheckinByMessageId('dm-2', h), undefined);
});

test('a plain DM after the member returned is not swallowed as a check-in reply', () => {
    const h = migrated();
    addCheckin(h, { id: 1, memberId: 1, discordId: 'user-1', sentAt: '2026-10-20T10:00:00.000Z' });
    assert.equal(db.getPendingCheckinByDiscordId('user-1', h).id, 1);
    h.prepare("UPDATE member_checkin_dms SET status = 'returned' WHERE id = 1").run();
    assert.equal(db.getPendingCheckinByDiscordId('user-1', h), undefined);
});
