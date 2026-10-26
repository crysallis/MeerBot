import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDamage, indexDamage, damageFor, damageSeries } from './guildDuelDamage.mjs';

const report = {
    periods: ['2026-10-12', '2026-10-19'],
    rows: [
        { member_id: 1, period_start: '2026-10-12', damage: 100e9 },
        { member_id: 1, period_start: '2026-10-19', damage: 200e9 },
        { member_id: 2, period_start: '2026-10-19', damage: 50e9 },
        { member_id: 4, period_start: '2026-10-19', damage: 19.166e9 },
    ],
    afk: { '2026-10-12': [], '2026-10-19': [3] },
};
const idx = indexDamage(report);

const member = (id, name, periods) => ({ id, name, crestsByPeriod: Object.fromEntries(periods.map(p => [p, 4000])) });
const both = ['2026-10-12', '2026-10-19'];

test('formatDamage uses the game\'s own style', () => {
    assert.equal(formatDamage(567e9), '567B');
    assert.equal(formatDamage(19.166e9), '19.2B');
    assert.equal(formatDamage(450e6), '450M');
    assert.equal(formatDamage(1.04e12), '1,040B');
});

test('a member who attacked shows their damage for the period', () => {
    const c = damageFor(idx, member(1, 'A', both), '2026-10-19');
    assert.deepEqual([c.kind, c.text, c.total], ['amount', '200B', 200e9]);
});

test('a member with crests and no damage in a week that has damage data reads No damage', () => {
    const c = damageFor(idx, member(5, 'E', both), '2026-10-19');
    assert.deepEqual([c.kind, c.text], ['none', 'No damage']);
});

test('an AFK member with no damage reads AFK, not No damage', () => {
    const c = damageFor(idx, member(3, 'C', both), '2026-10-19');
    assert.deepEqual([c.kind, c.text], ['afk', 'AFK']);
});

test('an AFK member who still attacked keeps the number and gains the AFK tag', () => {
    const afkIdx = indexDamage({ ...report, afk: { '2026-10-19': [2] } });
    const c = damageFor(afkIdx, member(2, 'B', both), '2026-10-19');
    assert.deepEqual([c.kind, c.text], ['amount', '50B · AFK']);
});

test('a period with no damage data stays blank instead of accusing anyone', () => {
    const c = damageFor(idx, member(5, 'E', ['2026-10-05']), '2026-10-05');
    assert.deepEqual([c.kind, c.text], ['blank', '·']);
});

test('all time adds the weeks up', () => {
    const c = damageFor(idx, member(1, 'A', both), 'all');
    assert.deepEqual([c.kind, c.text, c.total], ['amount', '300B', 300e9]);
});

test('all time reads No damage when a non-AFK member never attacked in any week with damage data', () => {
    const c = damageFor(idx, member(5, 'E', both), 'all');
    assert.deepEqual([c.kind, c.text], ['none', 'No damage']);
});

test('all time reads AFK when every week with damage data was an AFK week and nothing was dealt', () => {
    const allAfk = indexDamage({ ...report, afk: { '2026-10-12': [5], '2026-10-19': [5] } });
    const c = damageFor(allAfk, member(5, 'E', both), 'all');
    assert.deepEqual([c.kind, c.text], ['afk', 'AFK']);
});

test('all time is blank for a member with no crests in any week that has damage data', () => {
    const c = damageFor(idx, member(6, 'F', ['2026-10-05']), 'all');
    assert.deepEqual([c.kind, c.text], ['blank', '·']);
});

test('the chart rows are sorted by damage and leave out members with none', () => {
    const members = [member(5, 'E', both), member(2, 'B', both), member(1, 'A', both), member(4, 'D', both)];
    const s = damageSeries(idx, members, '2026-10-19');
    assert.equal(s.hasData, true);
    assert.deepEqual(s.rows.map(r => [r.name, r.damage]), [['A', 200e9], ['B', 50e9], ['D', 19.166e9]]);
});

test('the chart rows for all time are each member\'s total', () => {
    const s = damageSeries(idx, [member(1, 'A', both), member(2, 'B', both)], 'all');
    assert.deepEqual(s.rows.map(r => [r.name, r.damage]), [['A', 300e9], ['B', 50e9]]);
});

test('a period without damage data has no chart', () => {
    const s = damageSeries(idx, [member(1, 'A', both)], '2026-10-05');
    assert.deepEqual(s, { hasData: false, rows: [] });
});

test('with no damage report at all everything stays blank and the chart is empty', () => {
    const none = indexDamage(undefined);
    assert.equal(damageFor(none, member(1, 'A', both), '2026-10-19').kind, 'blank');
    assert.equal(damageSeries(none, [member(1, 'A', both)], 'all').hasData, false);
});
