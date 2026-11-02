require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const realDb = require('./db');
const W = require('./warnings');

const NOW = new Date('2026-11-02T12:00:00.000Z');
const LATER = new Date('2026-11-05T12:00:00.000Z');

function memDb() {
    const h = new Database(':memory:');
    h.exec(`
      CREATE TABLE members (id INTEGER PRIMARY KEY, ingame_name TEXT);
      CREATE TABLE snapshots (id INTEGER PRIMARY KEY, scraped_at TEXT);
      CREATE TABLE member_snapshots (snapshot_id INTEGER, member_id INTEGER, last_active TEXT);
      CREATE TABLE member_warnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER NOT NULL REFERENCES members(id),
        reason TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
        ended_at TEXT, ended_by TEXT
      );
      CREATE TABLE warning_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, warning_id INTEGER NOT NULL, member_id INTEGER NOT NULL,
        action TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL, detail TEXT
      );
      INSERT INTO members (id, ingame_name) VALUES (1, 'Alpha'), (2, 'Beta');
    `);
    return h;
}

function logRows(h, warningId) {
    return h.prepare('SELECT * FROM warning_log WHERE warning_id = ? ORDER BY id').all(warningId);
}

test('the in-memory schema matches the real warning tables', () => {
    const h = memDb();
    for (const table of ['member_warnings', 'warning_log']) {
        const cols = (db) => db.prepare(`PRAGMA table_info(${table})`).all().map(c => `${c.name}:${c.type}:${c.notnull}`);
        assert.deepEqual(cols(h), cols(realDb), table);
    }
});

test('defaultExpiry adds three calendar months', () => {
    assert.equal(W.defaultExpiry(NOW), '2027-02-02T12:00:00.000Z');
});

test('parseExpiryDate takes a real future date as the end of that UTC day', () => {
    assert.equal(W.parseExpiryDate('2026-12-31', NOW), '2026-12-31T23:59:59.999Z');
    assert.equal(W.parseExpiryDate('2026-11-02', NOW), '2026-11-02T23:59:59.999Z');
});

test('parseExpiryDate rejects malformed, impossible and past dates', () => {
    for (const bad of ['2026-02-30', 'soon', '', '12/31/2026', '2026-1-5', '2026-11-01', null, undefined]) {
        assert.equal(W.parseExpiryDate(bad, NOW), null, String(bad));
    }
});

test('warningStatus is active, expired, or ended with ended winning', () => {
    const w = { expires_at: '2026-12-01T00:00:00.000Z', ended_at: null };
    assert.equal(W.warningStatus(w, NOW), 'active');
    assert.equal(W.warningStatus({ ...w, expires_at: '2026-10-01T00:00:00.000Z' }, NOW), 'expired');
    assert.equal(W.warningStatus({ ...w, ended_at: '2026-11-01T00:00:00.000Z' }, NOW), 'ended');
    assert.equal(W.warningStatus({ expires_at: '2026-10-01T00:00:00.000Z', ended_at: '2026-10-02T00:00:00.000Z' }, NOW), 'ended');
});

test('addWarning writes the row with the default expiry and an add log row', () => {
    const h = memDb();
    const id = W.addWarning(h, { memberId: 1, reason: 'No attacks', createdBy: '111', now: NOW });
    const row = h.prepare('SELECT * FROM member_warnings WHERE id = ?').get(id);
    assert.equal(row.reason, 'No attacks');
    assert.equal(row.created_by, '111');
    assert.equal(row.created_at, NOW.toISOString());
    assert.equal(row.expires_at, '2027-02-02T12:00:00.000Z');
    assert.equal(row.ended_at, null);
    const log = logRows(h, id);
    assert.equal(log.length, 1);
    assert.deepEqual([log[0].action, log[0].actor, log[0].member_id], ['add', '111', 1]);
});

test('editWarning amends only given fields, never created_by or created_at, and logs old and new', () => {
    const h = memDb();
    const id = W.addWarning(h, { memberId: 1, reason: 'Old', createdBy: '111', now: NOW });
    assert.equal(W.editWarning(h, id, { reason: 'New' }, '222', LATER), true);
    const row = h.prepare('SELECT * FROM member_warnings WHERE id = ?').get(id);
    assert.equal(row.reason, 'New');
    assert.equal(row.expires_at, '2027-02-02T12:00:00.000Z');
    assert.equal(row.created_by, '111');
    assert.equal(row.created_at, NOW.toISOString());
    const edit = logRows(h, id).find(r => r.action === 'edit');
    assert.equal(edit.actor, '222');
    assert.deepEqual(JSON.parse(edit.detail), { reason: { from: 'Old', to: 'New' } });
});

test('editWarning changes the expiry and returns false when nothing changes or the id is missing', () => {
    const h = memDb();
    const id = W.addWarning(h, { memberId: 1, reason: 'Same', createdBy: '111', now: NOW });
    assert.equal(W.editWarning(h, id, { reason: 'Same' }, '222', LATER), false);
    assert.equal(W.editWarning(h, 999, { reason: 'x' }, '222', LATER), false);
    assert.equal(W.editWarning(h, id, { expiresAt: '2026-12-31T23:59:59.999Z' }, '222', LATER), true);
    const edit = logRows(h, id).find(r => r.action === 'edit');
    assert.deepEqual(JSON.parse(edit.detail), { expires_at: { from: '2027-02-02T12:00:00.000Z', to: '2026-12-31T23:59:59.999Z' } });
});

test('expireWarning keeps the row, sets ended_at and ended_by, and logs the note', () => {
    const h = memDb();
    const id = W.addWarning(h, { memberId: 1, reason: 'R', createdBy: '111', now: NOW });
    assert.equal(W.expireWarning(h, id, '222', 'resolved in chat', LATER), true);
    const row = h.prepare('SELECT * FROM member_warnings WHERE id = ?').get(id);
    assert.equal(row.ended_at, LATER.toISOString());
    assert.equal(row.ended_by, '222');
    const log = logRows(h, id).find(r => r.action === 'expire');
    assert.equal(log.detail, 'resolved in chat');
});

test('expireWarning refuses an already ended warning and a missing id', () => {
    const h = memDb();
    const id = W.addWarning(h, { memberId: 1, reason: 'R', createdBy: '111', now: NOW });
    W.expireWarning(h, id, '222', null, LATER);
    assert.equal(W.expireWarning(h, id, '333', null, LATER), false);
    assert.equal(W.expireWarning(h, 999, '333', null, LATER), false);
});

test('strikeWarning deletes the row and leaves one strike log row with no detail', () => {
    const h = memDb();
    const id = W.addWarning(h, { memberId: 1, reason: 'R', createdBy: '111', now: NOW });
    assert.deepEqual(W.strikeWarning(h, id, '222', LATER), { memberId: 1 });
    assert.equal(h.prepare('SELECT COUNT(*) AS n FROM member_warnings WHERE id = ?').get(id).n, 0);
    const strike = logRows(h, id).filter(r => r.action === 'strike');
    assert.equal(strike.length, 1);
    assert.equal(strike[0].detail, null);
    assert.equal(strike[0].actor, '222');
    assert.equal(W.strikeWarning(h, id, '222', LATER), null);
});

test('strikeWarning blanks detail on earlier edit and expire log rows for that warning', () => {
    const h = memDb();
    const id = W.addWarning(h, { memberId: 1, reason: 'secret old reason', createdBy: '111', now: NOW });
    W.editWarning(h, id, { reason: 'secret new reason' }, '222', NOW);
    W.expireWarning(h, id, '222', 'secret note', NOW);
    W.strikeWarning(h, id, '333', LATER);
    const rows = logRows(h, id);
    assert.ok(rows.length >= 4);
    for (const r of rows) assert.equal(r.detail, null, r.action);
    assert.ok(!JSON.stringify(h.prepare('SELECT * FROM warning_log').all()).includes('secret'));
});

test('strikeWarning leaves other warnings\' log rows alone', () => {
    const h = memDb();
    const a = W.addWarning(h, { memberId: 1, reason: 'A', createdBy: '1', now: NOW });
    const b = W.addWarning(h, { memberId: 1, reason: 'B', createdBy: '1', now: NOW });
    W.expireWarning(h, b, '2', 'keep me', NOW);
    W.strikeWarning(h, a, '3', LATER);
    assert.equal(logRows(h, b).find(r => r.action === 'expire').detail, 'keep me');
});

test('listWarnings shows expired and ended warnings with status, newest first, with edit lines', () => {
    const h = memDb();
    const old = W.addWarning(h, { memberId: 1, reason: 'Old', createdBy: '1', now: new Date('2026-06-01T00:00:00.000Z') });
    const ended = W.addWarning(h, { memberId: 1, reason: 'Ended', createdBy: '1', now: new Date('2026-10-01T00:00:00.000Z') });
    W.expireWarning(h, ended, '2', null, NOW);
    const live = W.addWarning(h, { memberId: 1, reason: 'Live', createdBy: '1', now: NOW });
    W.editWarning(h, live, { reason: 'Live2' }, '3', NOW);
    W.addWarning(h, { memberId: 2, reason: 'Other member', createdBy: '1', now: NOW });
    const list = W.listWarnings(h, 1, NOW);
    assert.deepEqual(list.map(w => [w.id, w.status]), [[live, 'active'], [ended, 'ended'], [old, 'expired']]);
    assert.equal(list[0].edits.length, 1);
    assert.equal(list[0].edits[0].actor, '3');
    assert.deepEqual(list[1].edits, []);
});

test('countActive ignores expired and ended warnings', () => {
    const h = memDb();
    W.addWarning(h, { memberId: 1, reason: 'Expired', createdBy: '1', now: new Date('2026-01-01T00:00:00.000Z') });
    const ended = W.addWarning(h, { memberId: 1, reason: 'Ended', createdBy: '1', now: NOW });
    W.expireWarning(h, ended, '2', null, NOW);
    W.addWarning(h, { memberId: 1, reason: 'A', createdBy: '1', now: NOW });
    W.addWarning(h, { memberId: 1, reason: 'B', createdBy: '1', now: NOW });
    assert.equal(W.countActive(h, 1, NOW), 2);
    assert.equal(W.countActive(h, 2, NOW), 0);
});

test('pickerWarnings: expire lists only active, strike lists all, edit caps at 25 with active first', () => {
    const h = memDb();
    const expired = W.addWarning(h, { memberId: 1, reason: 'Expired', createdBy: '1', now: new Date('2026-01-01T00:00:00.000Z') });
    const live = W.addWarning(h, { memberId: 1, reason: 'Live', createdBy: '1', now: NOW });
    assert.deepEqual(W.pickerWarnings(h, 1, 'expire', NOW).map(w => w.id), [live]);
    assert.deepEqual(W.pickerWarnings(h, 1, 'strike', NOW).map(w => w.id).sort(), [expired, live].sort());
    for (let i = 0; i < 30; i++) {
        W.addWarning(h, { memberId: 2, reason: `E${i}`, createdBy: '1', now: new Date('2026-01-01T00:00:00.000Z') });
    }
    const liveBeta = W.addWarning(h, { memberId: 2, reason: 'Live', createdBy: '1', now: new Date('2026-10-30T00:00:00.000Z') });
    const edit = W.pickerWarnings(h, 2, 'edit', NOW);
    assert.equal(edit.length, 25);
    assert.equal(edit[0].id, liveBeta);
});

test('recordOfflineWarnings creates one warning per member and a second call creates none', () => {
    const h = memDb();
    const rows = [{ member_id: 1, days_inactive: 3 }, { member_id: 2, days_inactive: 5 }];
    assert.equal(W.recordOfflineWarnings(h, rows, { thresholdDays: 3, now: NOW }), 2);
    assert.equal(W.recordOfflineWarnings(h, rows, { thresholdDays: 3, now: NOW }), 0);
    const w = h.prepare('SELECT * FROM member_warnings WHERE member_id = 1').get();
    assert.equal(w.reason, 'Offline 3+ days');
    assert.equal(w.created_by, 'bot');
    assert.equal(w.expires_at, '2027-02-02T12:00:00.000Z');
});

test('the auto_add log row detail records the days inactive', () => {
    const h = memDb();
    W.recordOfflineWarnings(h, [{ member_id: 2, days_inactive: 5 }], { thresholdDays: 3, now: NOW });
    const log = h.prepare("SELECT * FROM warning_log WHERE action = 'auto_add'").get();
    assert.equal(log.actor, 'bot');
    assert.deepEqual(JSON.parse(log.detail), { days_inactive: 5 });
});

test('a struck automatic warning is not re-created while the member stays offline', () => {
    const h = memDb();
    const rows = [{ member_id: 1, days_inactive: 3 }];
    W.recordOfflineWarnings(h, rows, { thresholdDays: 3, now: NOW });
    const id = h.prepare('SELECT id FROM member_warnings WHERE member_id = 1').get().id;
    W.strikeWarning(h, id, '222', NOW);
    assert.equal(W.recordOfflineWarnings(h, rows, { thresholdDays: 3, now: LATER }), 0);
    assert.equal(h.prepare('SELECT COUNT(*) AS n FROM member_warnings').get().n, 0);
});

test('a member seen active in a later snapshot gets a new automatic warning when offline again', () => {
    const h = memDb();
    const rows = [{ member_id: 1, days_inactive: 3 }];
    W.recordOfflineWarnings(h, rows, { thresholdDays: 3, now: NOW });
    h.prepare("INSERT INTO snapshots (id, scraped_at) VALUES (1, '2026-11-03T08:00:00.000Z')").run();
    h.prepare("INSERT INTO member_snapshots (snapshot_id, member_id, last_active) VALUES (1, 1, 'Online')").run();
    assert.equal(W.needsAutoWarning(h, 1), true);
    assert.equal(W.recordOfflineWarnings(h, rows, { thresholdDays: 3, now: LATER }), 1);
    assert.equal(h.prepare('SELECT COUNT(*) AS n FROM member_warnings WHERE member_id = 1').get().n, 2);
});

test('a later snapshot that still shows the member offline does not count as a return', () => {
    const h = memDb();
    W.recordOfflineWarnings(h, [{ member_id: 1, days_inactive: 3 }], { thresholdDays: 3, now: NOW });
    h.prepare("INSERT INTO snapshots (id, scraped_at) VALUES (1, '2026-11-03T08:00:00.000Z')").run();
    h.prepare("INSERT INTO member_snapshots (snapshot_id, member_id, last_active) VALUES (1, 1, '4d ago')").run();
    assert.equal(W.needsAutoWarning(h, 1), false);
});
