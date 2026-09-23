require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../utils/db');
const { getMemberSeasonGrowth } = require('./guild');

// Track every fixture row's exact id as it's created, so cleanup deletes by id
// (never by a date-range or name pattern -- a broad LIKE match on scraped_at
// once collided with real historical snapshot rows and tripped a foreign key
// error, since real member_snapshots rows still referenced them).
const createdSeasonIds = [];
const createdSnapshotIds = [];
const createdMemberIds = [];

function makeSeason(name) {
    const r = db.prepare('INSERT INTO ally_seasons (name, active) VALUES (?, 0)').run(name);
    createdSeasonIds.push(r.lastInsertRowid);
    return r.lastInsertRowid;
}

function makeSnapshot(scrapedAt) {
    const r = db.prepare('INSERT INTO snapshots (scraped_at, member_count) VALUES (?, 0)').run(scrapedAt);
    createdSnapshotIds.push(r.lastInsertRowid);
    return r.lastInsertRowid;
}

function makeMember(name) {
    const r = db.prepare("INSERT INTO members (ingame_name, first_seen, active) VALUES (?, datetime('now'), 1)").run(name);
    createdMemberIds.push(r.lastInsertRowid);
    return r.lastInsertRowid;
}

function tagMemberSnapshot(snapshotId, memberId, seasonId, power) {
    db.prepare(`INSERT INTO member_snapshots
        (snapshot_id, member_id, name, combat_power, combat_power_value, activeness, season_id)
        VALUES (?, ?, 'test', '1K', ?, 0, ?)`).run(snapshotId, memberId, power, seasonId);
}

test.after(() => {
    if (createdSnapshotIds.length) {
        const placeholders = createdSnapshotIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM member_snapshots WHERE snapshot_id IN (${placeholders})`).run(...createdSnapshotIds);
        db.prepare(`DELETE FROM snapshots WHERE id IN (${placeholders})`).run(...createdSnapshotIds);
    }
    if (createdMemberIds.length) {
        const placeholders = createdMemberIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM members WHERE id IN (${placeholders})`).run(...createdMemberIds);
    }
    if (createdSeasonIds.length) {
        const placeholders = createdSeasonIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM ally_seasons WHERE id IN (${placeholders})`).run(...createdSeasonIds);
    }
});

test('getMemberSeasonGrowth: member with multiple snapshots in the season shows first->last growth', () => {
    const seasonId = makeSeason('__test_season_multi');
    const memberId = makeMember('__test_member_multi');
    const s1 = makeSnapshot('2026-03-01T00:00:00');
    const s2 = makeSnapshot('2026-03-08T00:00:00');
    const s3 = makeSnapshot('2026-03-15T00:00:00');
    tagMemberSnapshot(s1, memberId, seasonId, 1_000_000);
    tagMemberSnapshot(s2, memberId, seasonId, 1_500_000);
    tagMemberSnapshot(s3, memberId, seasonId, 2_000_000);

    const rows = getMemberSeasonGrowth(seasonId, false);
    const row = rows.find(r => r.member_id === memberId);
    assert.ok(row, 'member should appear in results');
    assert.equal(row.start_power, 1_000_000);
    assert.equal(row.end_power, 2_000_000);
});

test('getMemberSeasonGrowth: member with only one snapshot shows start === end (zero growth, not excluded)', () => {
    const seasonId = makeSeason('__test_season_single');
    const memberId = makeMember('__test_member_single');
    const s1 = makeSnapshot('2026-03-20T00:00:00');
    tagMemberSnapshot(s1, memberId, seasonId, 3_000_000);

    const rows = getMemberSeasonGrowth(seasonId, false);
    const row = rows.find(r => r.member_id === memberId);
    assert.ok(row, 'member with a single snapshot should still appear');
    assert.equal(row.start_power, 3_000_000);
    assert.equal(row.end_power, 3_000_000);
});

test('getMemberSeasonGrowth: member with no snapshots in the season is excluded entirely', () => {
    const seasonId = makeSeason('__test_season_absent');
    const otherSeasonId = makeSeason('__test_season_absent_other');
    const memberId = makeMember('__test_member_absent');
    const s1 = makeSnapshot('2026-03-25T00:00:00');
    tagMemberSnapshot(s1, memberId, otherSeasonId, 5_000_000);

    const rows = getMemberSeasonGrowth(seasonId, false);
    assert.equal(rows.find(r => r.member_id === memberId), undefined);
});

test('getMemberSeasonGrowth toNow=true: end is the member\'s most recent snapshot overall, any season', () => {
    const seasonId = makeSeason('__test_season_plus');
    const laterSeasonId = makeSeason('__test_season_plus_later');
    const memberId = makeMember('__test_member_plus');
    const s1 = makeSnapshot('2026-04-01T00:00:00');
    const s2 = makeSnapshot('2026-04-08T00:00:00'); // tagged with a DIFFERENT (later) season
    tagMemberSnapshot(s1, memberId, seasonId, 4_000_000);
    tagMemberSnapshot(s2, memberId, laterSeasonId, 6_000_000);

    const seasonScoped = getMemberSeasonGrowth(seasonId, false).find(r => r.member_id === memberId);
    assert.equal(seasonScoped.start_power, 4_000_000);
    assert.equal(seasonScoped.end_power, 4_000_000); // only one row tagged with seasonId itself

    const toNow = getMemberSeasonGrowth(seasonId, true).find(r => r.member_id === memberId);
    assert.equal(toNow.start_power, 4_000_000); // start still scoped to seasonId
    assert.equal(toNow.end_power, 6_000_000); // end reaches past the season into the most recent snapshot overall
});
