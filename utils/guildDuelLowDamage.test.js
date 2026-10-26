const { test } = require('node:test');
const assert = require('node:assert');
const { evaluate, thresholdsFromConfig, THRESHOLDS, CONFIG_KEYS } = require('./guildDuelLow');

const DAY = 24 * 60 * 60 * 1000;
const WEEK = '2026-10-19';
const sundayNoon = monday => new Date(Date.parse(`${monday}T12:00:00Z`) + 6 * DAY).toISOString();

// 12 ordinary dealers (4000 crests = 20 hits, 110B damage = 5.5B per hit) so the week has damage data,
// plus whatever extra members the test adds. Flagged-by-activeness members get one low activeness row.
function world(extra, { fillers = 12, weeks = [WEEK], afkSpans = [] } = {}) {
	const crestRows = [];
	const damageRows = [];
	const actRows = [];
	const activeIds = new Set();
	let id = 0;
	const add = (name, { crests = 4000, damage = 0, lowAct = false, active = true, week } = {}) => {
		id += 1;
		for (const wk of week ? [week] : weeks) {
			if (crests != null) crestRows.push({ memberId: id, name, week: wk, crests });
			if (damage > 0) damageRows.push({ memberId: id, name, week: wk, damage });
			if (lowAct) actRows.push({ memberId: id, name, scrapedAt: sundayNoon(wk), activeness: 100 });
		}
		if (active) activeIds.add(id);
		return id;
	};
	for (let i = 0; i < fillers; i++) add(`Filler${i}`, { damage: 110e9 });
	const ids = {};
	for (const [name, opts] of Object.entries(extra)) ids[name] = add(name, opts);
	return { input: { crestRows, damageRows, actRows, activeIds, afkSpans }, ids };
}

const byName = result => Object.fromEntries(result.flagged.map(p => [p.name, p]));

test('a member who earned crests but never attacked is called out on their own', () => {
	const { input } = world({ Skipper: { crests: 3175 } });
	const r = evaluate(input);
	assert.deepStrictEqual(r.zeroAttackers.map(z => z.name), ['Skipper']);
	const z = r.zeroAttackers[0];
	assert.strictEqual(z.zeroWeeks, 1);
	assert.strictEqual(z.damageWeeks, 1);
	assert.strictEqual(z.crests, 3175);
	assert.strictEqual(r.flagged.length, 0);
});

test('members who attacked are not on the zero-attack list', () => {
	const { input } = world({ Hitter: { damage: 100e9 } });
	assert.deepStrictEqual(evaluate(input).zeroAttackers, []);
});

test('fewer crests than one hit does not count as never attacking', () => {
	const { input } = world({ Tiny: { crests: 150 } });
	assert.deepStrictEqual(evaluate(input).zeroAttackers, []);
});

test('a week with no damage data accuses nobody', () => {
	const { input } = world({ Skipper: { crests: 3175 } }, { fillers: 4 });
	const r = evaluate(input);
	assert.deepStrictEqual(r.zeroAttackers, []);
	assert.deepStrictEqual(r.damageWeeks, []);
});

test('an AFK week is skipped for the zero-attack list', () => {
	const { input, ids } = world({ Away: { crests: 3000 } });
	input.afkSpans = [{ memberId: ids.Away, startedAt: '2026-10-10T00:00:00.000Z', endedAt: null }];
	assert.deepStrictEqual(evaluate(input).zeroAttackers, []);
});

test('inactive members are not on the zero-attack list', () => {
	const { input } = world({ Gone: { crests: 3000, active: false } });
	assert.deepStrictEqual(evaluate(input).zeroAttackers, []);
});

test('zero-attack weeks are counted against the weeks that had damage data', () => {
	const weeks = ['2026-10-12', '2026-10-19'];
	const { input } = world({ Sometimes: { crests: 3000 } }, { weeks });
	input.damageRows.push({ memberId: input.crestRows.find(r => r.name === 'Sometimes').memberId, name: 'Sometimes', week: '2026-10-12', damage: 80e9 });
	const z = evaluate(input).zeroAttackers.find(x => x.name === 'Sometimes');
	assert.strictEqual(z.zeroWeeks, 1);
	assert.strictEqual(z.damageWeeks, 2);
});

test('a flagged member gets how much of their crests were spent against the guild mean hit', () => {
	const { input } = world({
		Weak: { damage: 20e9, lowAct: true },
		Strong: { damage: 110e9, lowAct: true },
	});
	const r = evaluate(input);
	const people = byName(r);
	assert.ok(people.Weak.dmgRatioAvg < 0.25, `Weak ratio ${people.Weak.dmgRatioAvg}`);
	assert.strictEqual(people.Weak.dmgAtOrAbove, false);
	assert.ok(people.Strong.dmgRatioAvg > 1, `Strong ratio ${people.Strong.dmgRatioAvg}`);
	assert.strictEqual(people.Strong.dmgAtOrAbove, true);
	assert.strictEqual(people.Weak.dmgN, 1);
	assert.ok(Math.abs(r.hitMean - 5.18e9) < 0.05e9, `hitMean ${r.hitMean}`);
});

test('the floor is a setting: the same member is at or above a low floor and below a high one', () => {
	const { input } = world({ Middling: { damage: 55e9, lowAct: true } });
	const lowFloor = byName(evaluate(input, { ...THRESHOLDS, hitFloor: 30 })).Middling;
	const highFloor = byName(evaluate(input, { ...THRESHOLDS, hitFloor: 90 })).Middling;
	assert.strictEqual(lowFloor.dmgAtOrAbove, true);
	assert.strictEqual(highFloor.dmgAtOrAbove, false);
});

test('a flagged member with no damage data in the period gets no damage verdict', () => {
	const { input } = world({ Quiet: { crests: 4000, lowAct: true } }, { fillers: 4 });
	const p = byName(evaluate(input)).Quiet;
	assert.strictEqual(p.dmgN, 0);
	assert.strictEqual(p.dmgRatioAvg, null);
	assert.strictEqual(p.dmgAtOrAbove, null);
});

test('the damage line never flags anyone by itself', () => {
	const { input } = world({ Weak: { damage: 5e9 } });
	assert.deepStrictEqual(evaluate(input).flagged, []);
});

test('the damage floor is a threshold with a default of 50 and a config key', () => {
	assert.strictEqual(THRESHOLDS.hitFloor, 50);
	assert.strictEqual(CONFIG_KEYS.hitFloor, 'GUILDDUEL_HIT_FLOOR');
	assert.strictEqual(thresholdsFromConfig(k => (k === 'GUILDDUEL_HIT_FLOOR' ? '65' : '')).hitFloor, 65);
	assert.strictEqual(thresholdsFromConfig(k => (k === 'GUILDDUEL_HIT_FLOOR' ? 'abc' : '')).hitFloor, 50);
	assert.strictEqual(thresholdsFromConfig(k => (k === 'GUILDDUEL_HIT_FLOOR' ? '0' : '')).hitFloor, 50);
});
