const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
    weekStartOf, formatWeekRange, formatBossWindow, afkMemberIdsForWeek, evaluateRecap,
    classifyWeek, listRecapWeeks, buildRecapEmbed, recapMessage, isMemberAfkForWeek,
} = require('./guildDuelRecap');

function memDb() {
    const h = new Database(':memory:');
    h.exec(`
      CREATE TABLE guild_duel_rankings (member_id INTEGER, period_start TEXT, rank INTEGER, crests INTEGER, damage INTEGER);
      CREATE TABLE member_afk (member_id INTEGER, reason TEXT, return_date TEXT, set_at TEXT);
      CREATE TABLE member_afk_history (member_id INTEGER, started_at TEXT, ended_at TEXT, return_date TEXT, reason TEXT);
    `);
    return h;
}

function addWeek(h, period, { damage = 12, crests = 12 } = {}) {
    for (let i = 1; i <= Math.max(damage, crests); i++) {
        h.prepare('INSERT INTO guild_duel_rankings (member_id, period_start, crests, damage) VALUES (?, ?, ?, ?)')
            .run(i, period, i <= crests ? 1000 : null, i <= damage ? 50e9 : null);
    }
}

const MONDAY_NOW = new Date('2026-10-26T03:00:00Z');

test('weekStartOf maps any day to that duel week\'s Monday (UTC)', () => {
    assert.equal(weekStartOf('2026-10-19'), '2026-10-19');
    assert.equal(weekStartOf('2026-10-22'), '2026-10-19');
    assert.equal(weekStartOf('2026-10-25'), '2026-10-19');
    assert.equal(weekStartOf('2026-10-26'), '2026-10-26');
});

test('weekStartOf rejects anything that is not a real YYYY-MM-DD date', () => {
    for (const bad of ['bad', '', '2026-13-45', '10/22/2026', '2026-2-3', null, undefined]) {
        assert.equal(weekStartOf(bad), null, String(bad));
    }
});

test('week and boss-window labels are plain UTC dates', () => {
    assert.equal(formatWeekRange('2026-10-19'), 'Mon Oct 19 to Sun Oct 25, 2026 (UTC)');
    assert.equal(formatBossWindow('2026-10-19'), 'Sat Oct 24 to Sun Oct 25');
});

test('AFK: a current record that started in or before the week excludes the member', () => {
    const h = memDb();
    h.prepare("INSERT INTO member_afk VALUES (1, 'x', NULL, '2026-10-20T10:00:00.000Z')").run();
    h.prepare("INSERT INTO member_afk VALUES (2, 'x', '2026-12-01', '2026-05-30T23:31:00.000Z')").run();
    assert.deepEqual([...afkMemberIdsForWeek(h, '2026-10-19')].sort(), [1, 2]);
});

test('AFK: someone who went AFK after the week ended is not excluded', () => {
    const h = memDb();
    h.prepare("INSERT INTO member_afk VALUES (1, 'travel', NULL, '2026-10-26T01:24:00.000Z')").run();
    assert.deepEqual([...afkMemberIdsForWeek(h, '2026-10-19')], []);
});

test('AFK: a stale current record whose return date was before the week does not exclude', () => {
    const h = memDb();
    h.prepare("INSERT INTO member_afk VALUES (1, 'x', '2026-06-01', '2026-05-30T23:31:00.000Z')").run();
    assert.deepEqual([...afkMemberIdsForWeek(h, '2026-10-19')], []);
});

test('AFK: history rows that overlap the week exclude, others do not', () => {
    const h = memDb();
    const add = (id, s, e) => h.prepare('INSERT INTO member_afk_history (member_id, started_at, ended_at) VALUES (?, ?, ?)').run(id, s, e);
    add(1, '2026-10-10T00:00:00.000Z', '2026-10-21T23:59:59.999Z');
    add(2, '2026-10-01T00:00:00.000Z', '2026-10-18T23:59:59.999Z');
    add(3, '2026-10-26T00:00:00.000Z', '2026-10-30T23:59:59.999Z');
    add(4, '2026-10-05T00:00:00.000Z', '2026-10-19T00:00:00.000Z');
    add(5, '2026-10-22T00:00:00.000Z', '2026-10-23T23:59:59.999Z');
    assert.deepEqual([...afkMemberIdsForWeek(h, '2026-10-19')].sort(), [1, 4, 5]);
});

const rows = [
    ...[1, 2, 3, 4, 5].map(id => ({ member_id: id, crests: 1000, damage: 50e9 })),
    { member_id: 6, crests: 600, damage: null },
    { member_id: 7, crests: 1000, damage: 5e9 },
    { member_id: 8, crests: 800, damage: null },
];

test('evaluateRecap counts the guild total, the average hit and both unspent groups', () => {
    const r = evaluateRecap(rows, new Set([8]));
    assert.equal(r.dealers, 6);
    assert.equal(r.totalDamage, 255e9);
    assert.equal(r.totalHits, 30);
    assert.equal(r.avgPerHit, 8.5e9);
    assert.equal(r.meanPerHit, 8.5e9);
    assert.deepEqual(r.zero, { count: 1, hits: 3, damage: 25.5e9 });
    assert.equal(r.low.count, 1);
    assert.ok(Math.abs(r.low.hits - 4.4118) < 0.001);
    assert.ok(Math.abs(r.low.damage - 37.5e9) < 1e6);
    assert.ok(Math.abs(r.combined.hits - 7.4118) < 0.001);
    assert.ok(Math.abs(r.combined.damage - 63e9) < 1e6);
    assert.ok(Math.abs(r.combined.pct - 24.71) < 0.01);
    assert.equal(r.afkExcluded, 1);
});

test('evaluateRecap returns null when nobody dealt damage', () => {
    assert.equal(evaluateRecap([{ member_id: 1, crests: 500, damage: null }], new Set()), null);
});

test('evaluateRecap gives back numbers only, no member ids or names', () => {
    const text = JSON.stringify(evaluateRecap(rows, new Set()));
    assert.ok(!text.includes('member_id'));
});

test('classifyWeek: a finished week with damage and crests is ok', () => {
    const h = memDb();
    addWeek(h, '2026-10-19');
    assert.equal(classifyWeek(h, '2026-10-19', MONDAY_NOW).kind, 'ok');
});

test('classifyWeek: a week before our first data says so and names the first week', () => {
    const h = memDb();
    addWeek(h, '2026-10-19');
    const c = classifyWeek(h, '2026-10-12', MONDAY_NOW);
    assert.equal(c.kind, 'before-data');
    assert.equal(c.firstWeek, '2026-10-19');
});

test('classifyWeek: the current week and a future week are not recapped', () => {
    const h = memDb();
    addWeek(h, '2026-10-19');
    assert.equal(classifyWeek(h, '2026-10-26', MONDAY_NOW).kind, 'current');
    assert.equal(classifyWeek(h, '2026-11-09', MONDAY_NOW).kind, 'future');
});

test('classifyWeek: damage but no crests yet means the Monday scan has not run', () => {
    const h = memDb();
    addWeek(h, '2026-10-19', { damage: 12, crests: 3 });
    assert.equal(classifyWeek(h, '2026-10-19', MONDAY_NOW).kind, 'crests-pending');
});

test('classifyWeek: a gap week after our first data has no data', () => {
    const h = memDb();
    addWeek(h, '2026-10-05');
    addWeek(h, '2026-10-19');
    assert.equal(classifyWeek(h, '2026-10-12', MONDAY_NOW).kind, 'no-data');
});

test('classifyWeek: too few damage rows does not count as data', () => {
    const h = memDb();
    addWeek(h, '2026-10-19', { damage: 4, crests: 4 });
    assert.equal(classifyWeek(h, '2026-10-19', MONDAY_NOW).kind, 'before-data');
});

test('listRecapWeeks offers finished weeks with data, newest first, with plain labels', () => {
    const h = memDb();
    addWeek(h, '2026-10-12');
    addWeek(h, '2026-10-19');
    addWeek(h, '2026-10-26');
    assert.deepEqual(listRecapWeeks(h, MONDAY_NOW), [
        { weekStart: '2026-10-19', label: 'Oct 19 to Oct 25, 2026' },
        { weekStart: '2026-10-12', label: 'Oct 12 to Oct 18, 2026' },
    ]);
});

test('the embed has the date range, the totals and the groups, and no names', () => {
    const embed = buildRecapEmbed(evaluateRecap(rows, new Set([8])), '2026-10-19').toJSON();
    assert.equal(embed.title, 'Guild Duel recap');
    assert.ok(embed.description.includes('Mon Oct 19 to Sun Oct 25, 2026 (UTC)'));
    assert.ok(embed.description.includes('Sat Oct 24 to Sun Oct 25'));
    const byName = Object.fromEntries(embed.fields.map(f => [f.name, f.value]));
    assert.ok(byName['Guild total'].includes('255B'));
    assert.ok(byName['Guild total'].includes('8.5B per hit'));
    assert.ok(byName['Earned crests, never attacked'].includes('1 member'));
    assert.ok(byName['Used only a small part of their crests'].includes('1 member'));
    assert.ok(byName['Left on the table'].includes('24.7%'));
    assert.ok(embed.footer.text.includes('AFK'));
});

test('a group with nobody in it reads as none', () => {
    const only = [1, 2, 3].map(id => ({ member_id: id, crests: 1000, damage: 50e9 }));
    const embed = buildRecapEmbed(evaluateRecap(only, new Set()), '2026-10-19').toJSON();
    const byName = Object.fromEntries(embed.fields.map(f => [f.name, f.value]));
    assert.equal(byName['Earned crests, never attacked'], 'None');
    assert.equal(byName['Used only a small part of their crests'], 'None');
});

test('the replies for weeks we cannot recap say why, in one plain sentence', () => {
    assert.ok(recapMessage({ kind: 'before-data', firstWeek: '2026-10-19' }).includes("weren't capturing"));
    assert.ok(recapMessage({ kind: 'before-data', firstWeek: '2026-10-19' }).includes('Oct 19'));
    assert.ok(recapMessage({ kind: 'current' }).includes('check again next week'));
    assert.ok(recapMessage({ kind: 'future' }).includes("hasn't happened"));
    assert.ok(recapMessage({ kind: 'crests-pending' }).includes('Monday'));
    assert.ok(recapMessage({ kind: 'invalid' }).includes('YYYY-MM-DD'));
    assert.ok(recapMessage({ kind: 'no-data' }).includes("don't have"));
});

test('the floor is the shared setting: a lower floor stops counting a member as using little of their crests', () => {
    const strict = evaluateRecap(rows, new Set([8]), 0.5);
    const loose = evaluateRecap(rows, new Set([8]), 0.05);
    assert.equal(strict.low.count, 1);
    assert.equal(loose.low.count, 0);
});

test('the floor defaults to half the mean hit', () => {
    assert.deepEqual(evaluateRecap(rows, new Set([8])).low, evaluateRecap(rows, new Set([8]), 0.5).low);
});

test('crests worth less than one hit do not count as earning and never attacking', () => {
    const withTiny = [...rows, { member_id: 9, crests: 150, damage: null }];
    assert.equal(evaluateRecap(withTiny, new Set([8])).zero.count, 1);
});

test('the footer names the mean hit it estimates with', () => {
    const embed = buildRecapEmbed(evaluateRecap(rows, new Set([8])), '2026-10-19').toJSON();
    assert.ok(embed.footer.text.includes('guild mean hit (8.50B)'));
});

test('AFK: the check can be narrowed to one member and uses the same rule', () => {
    const h = memDb();
    h.prepare("INSERT INTO member_afk VALUES (1, 'x', NULL, '2026-10-20T10:00:00.000Z')").run();
    h.prepare("INSERT INTO member_afk VALUES (2, 'x', NULL, '2026-10-26T01:24:00.000Z')").run();
    h.prepare("INSERT INTO member_afk_history (member_id, started_at, ended_at) VALUES (3, '2026-10-10T00:00:00.000Z', '2026-10-21T23:59:59.999Z')").run();
    assert.equal(isMemberAfkForWeek(h, 1, '2026-10-19'), true);
    assert.equal(isMemberAfkForWeek(h, 2, '2026-10-19'), false);
    assert.equal(isMemberAfkForWeek(h, 3, '2026-10-19'), true);
    assert.equal(isMemberAfkForWeek(h, 4, '2026-10-19'), false);
});
