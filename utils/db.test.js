require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('./db');

test('auto_delete_rules table exists with expected columns', () => {
    const cols = db.prepare("PRAGMA table_info(auto_delete_rules)").all().map(c => c.name);
    assert.deepEqual(cols.sort(), ['command', 'created_at', 'enabled', 'id', 'reaction_rule_id', 'scope', 'subcommand'].sort());
});

test('AUTO_DELETE_SECONDS config default is 30', () => {
    const botConfig = require('./botConfig');
    assert.equal(botConfig.get('AUTO_DELETE_SECONDS'), '30');
});

test('pearl_bazaar_prices table exists with expected columns', () => {
    const cols = db.prepare("PRAGMA table_info(pearl_bazaar_prices)").all().map(c => c.name);
    assert.deepEqual(cols.sort(), ['id', 'rank', 'ingame_id', 'price', 'selling_cap_remaining', 'scanned_at'].sort());
});

const MERGE_PERIOD = '2099-01-05';
const mergeFixtures = { ids: [], names: [] };

function makeMergeMember(label) {
    const name = `__gdd_merge_${label}_${process.pid}`;
    const id = Number(db.prepare(
        "INSERT INTO members (ingame_name, first_seen, pending, active) VALUES (?, '2026-01-01', 0, 1)"
    ).run(name).lastInsertRowid);
    mergeFixtures.ids.push(id);
    mergeFixtures.names.push(name.toLowerCase());
    return id;
}

function addDuelRow(memberId, fields) {
    db.prepare(`INSERT INTO guild_duel_rankings
        (member_id, period_start, rank, crests, scanned_at, damage, damage_scanned_at)
        VALUES (?, ?, ?, ?, '2026-10-19T00:00:00Z', ?, ?)`)
        .run(memberId, MERGE_PERIOD, fields.rank ?? null, fields.crests ?? null,
            fields.damage ?? null, fields.damage ? '2026-10-18T20:00:00Z' : null);
}

test.afterEach(() => {
    for (const id of mergeFixtures.ids) {
        db.prepare('DELETE FROM guild_duel_rankings WHERE member_id = ?').run(id);
        db.prepare('DELETE FROM member_name_history WHERE member_id = ?').run(id);
        db.prepare('DELETE FROM members WHERE id = ?').run(id);
    }
    for (const name of mergeFixtures.names) {
        db.prepare('DELETE FROM name_corrections WHERE ocr_name = ?').run(name);
    }
    mergeFixtures.ids.length = 0;
    mergeFixtures.names.length = 0;
});

test('mergeMembers keeps the dropped member\'s damage when the keeper only has crests for that week', () => {
    const keep = makeMergeMember('keep');
    const drop = makeMergeMember('drop');
    addDuelRow(keep, { rank: 3, crests: 4000 });
    addDuelRow(drop, { damage: 567000000000 });
    db.mergeMembers(keep, drop);
    const row = db.prepare('SELECT rank, crests, damage FROM guild_duel_rankings WHERE member_id = ? AND period_start = ?').get(keep, MERGE_PERIOD);
    assert.deepEqual({ ...row }, { rank: 3, crests: 4000, damage: 567000000000 });
});

test('mergeMembers keeps the dropped member\'s crests when the keeper only has damage for that week', () => {
    const keep = makeMergeMember('keep');
    const drop = makeMergeMember('drop');
    addDuelRow(keep, { damage: 567000000000 });
    addDuelRow(drop, { rank: 5, crests: 3500 });
    db.mergeMembers(keep, drop);
    const row = db.prepare('SELECT rank, crests, damage FROM guild_duel_rankings WHERE member_id = ? AND period_start = ?').get(keep, MERGE_PERIOD);
    assert.deepEqual({ ...row }, { rank: 5, crests: 3500, damage: 567000000000 });
});
