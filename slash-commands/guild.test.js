require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../utils/db');
const { getSeasonSnapshotRange, getSeasonToNowRange } = require('./guild');

function makeSeason(name) {
    const r = db.prepare('INSERT INTO ally_seasons (name, active) VALUES (?, 0)').run(name);
    return r.lastInsertRowid;
}

function makeSnapshot(scrapedAt) {
    const r = db.prepare('INSERT INTO snapshots (scraped_at, member_count) VALUES (?, 0)').run(scrapedAt);
    return r.lastInsertRowid;
}

function tagMemberSnapshot(snapshotId, seasonId) {
    // member_id NULL is fine here -- these tests only exercise season_id resolution,
    // not member-level joins (Task 4's tests cover the member-level query).
    db.prepare(`INSERT INTO member_snapshots
        (snapshot_id, member_id, name, combat_power, combat_power_value, activeness, season_id)
        VALUES (?, NULL, 'test', '1K', 1000, 0, ?)`).run(snapshotId, seasonId);
}

test.after(() => {
    db.prepare("DELETE FROM member_snapshots WHERE name = 'test' AND snapshot_id IN (SELECT id FROM snapshots WHERE scraped_at LIKE '2026-01-%' OR scraped_at LIKE '2026-02-%')").run();
    db.prepare("DELETE FROM snapshots WHERE scraped_at LIKE '2026-01-%' OR scraped_at LIKE '2026-02-%'").run();
    db.prepare("DELETE FROM ally_seasons WHERE name LIKE '__test_%'").run();
});

test('getSeasonSnapshotRange returns first and last snapshot tagged with a season', () => {
    const seasonId = makeSeason('__test_season_range');
    const s1 = makeSnapshot('2026-01-01T00:00:00');
    const s2 = makeSnapshot('2026-01-08T00:00:00');
    const s3 = makeSnapshot('2026-01-15T00:00:00');
    tagMemberSnapshot(s1, seasonId);
    tagMemberSnapshot(s2, seasonId);
    tagMemberSnapshot(s3, seasonId);

    const range = getSeasonSnapshotRange(seasonId);
    assert.deepEqual(range, { startId: s1, endId: s3 });
});

test('getSeasonSnapshotRange returns null for a season with no tagged snapshots', () => {
    const seasonId = makeSeason('__test_season_empty');
    assert.equal(getSeasonSnapshotRange(seasonId), null);
});

test('getSeasonToNowRange uses the season start but the single most recent snapshot overall', () => {
    // This runs against the real, live guild.db (this repo's established test
    // convention -- see utils/db.test.js), which already has real snapshot rows.
    // getSeasonToNowRange's "end" is MAX(scraped_at) across ALL snapshots, so it
    // must be asserted against whatever the actual current latest snapshot is,
    // not a fixture row -- a fixture dated in the past would never win that MAX.
    const actualLatest = db.prepare('SELECT id FROM snapshots ORDER BY scraped_at DESC LIMIT 1').get();

    const seasonId = makeSeason('__test_season_plus');
    const s1 = makeSnapshot('2026-02-01T00:00:00');
    const s2 = makeSnapshot('2026-02-08T00:00:00');
    tagMemberSnapshot(s1, seasonId);
    tagMemberSnapshot(s2, seasonId);

    const range = getSeasonToNowRange(seasonId);
    assert.deepEqual(range, { startId: s1, endId: actualLatest.id });
});

test('getSeasonToNowRange returns null for a season with no tagged snapshots', () => {
    const seasonId = makeSeason('__test_season_plus_empty');
    assert.equal(getSeasonToNowRange(seasonId), null);
});
