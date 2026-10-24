const { test } = require('node:test');
const assert = require('node:assert');
const { weekStartUtc, isCompleteScan, evaluate, thresholdsFromConfig, THRESHOLDS } = require('./guildDuelLow');

const MONDAYS = ['2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19'];
const DAY = 24 * 60 * 60 * 1000;

function sundayNoon(monday) {
	return new Date(Date.parse(`${monday}T12:00:00Z`) + 6 * DAY).toISOString();
}

function build({ members, actFn = () => 1000, crestFn = () => 4000, scrapedFn = sundayNoon }) {
	const actRows = [];
	const crestRows = [];
	members.forEach((name, i) => {
		MONDAYS.forEach((wk, w) => {
			const a = actFn(name, w);
			if (a != null) actRows.push({ memberId: i + 1, name, scrapedAt: scrapedFn(wk, w), activeness: a });
			const c = crestFn(name, w);
			if (c != null) crestRows.push({ memberId: i + 1, name, week: wk, crests: c });
		});
	});
	return { actRows, crestRows, activeIds: new Set(members.map((_, i) => i + 1)) };
}

const BASE = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];

test('weekStartUtc returns the Monday on or before the instant (UTC)', () => {
	assert.strictEqual(weekStartUtc('2026-10-18T05:24:39Z'), '2026-10-12');
	assert.strictEqual(weekStartUtc('2026-10-19T00:00:00Z'), '2026-10-19');
	assert.strictEqual(weekStartUtc('2026-10-18T23:59:59Z'), '2026-10-12');
});

test('isCompleteScan needs the last scan on or after Friday 18:00 UTC', () => {
	assert.strictEqual(isCompleteScan('2026-10-19', '2026-10-22T03:03:33Z'), false);
	assert.strictEqual(isCompleteScan('2026-09-28', '2026-10-02T23:25:57Z'), true);
	assert.strictEqual(isCompleteScan('2026-10-12', '2026-10-18T05:24:39Z'), true);
});

test('flags a member whose crests sit far under the weekly median in enough weeks', () => {
	const out = evaluate(build({
		members: [...BASE, 'LOW'],
		crestFn: (n, w) => (n === 'LOW' && w < 4 ? 2500 : 4000),
	}));
	assert.deepStrictEqual(out.flagged.map(f => f.name), ['LOW']);
	assert.strictEqual(out.flagged[0].crestLow, 4);
});

test('the crest gap is measured against that week, so a guild-wide dip flags nobody', () => {
	const out = evaluate(build({
		members: [...BASE, 'X'],
		crestFn: (n, w) => (w === 2 || w === 3 || w === 4 ? 2800 : 4300),
	}));
	assert.strictEqual(out.flagged.length, 0);
});

test('one complete week under the activeness minimum flags on its own', () => {
	const out = evaluate(build({
		members: [...BASE, 'IDLE'],
		actFn: (n, w) => (n === 'IDLE' && w === 5 ? THRESHOLDS.actMin - 1 : 1000),
	}));
	assert.deepStrictEqual(out.flagged.map(f => f.name), ['IDLE']);
	assert.strictEqual(out.flagged[0].actUnder, 1);
});

test('activeness exactly at the minimum is not flagged', () => {
	const out = evaluate(build({
		members: [...BASE, 'EDGE'],
		actFn: (n) => (n === 'EDGE' ? THRESHOLDS.actMin : 1000),
	}));
	assert.strictEqual(out.flagged.length, 0);
});

test('a few big spenders neither move the benchmark nor get flagged', () => {
	const out = evaluate(build({
		members: [...BASE, 'WHALE1', 'WHALE2'],
		actFn: (n) => (n.startsWith('WHALE') ? 3000 : 1000),
		crestFn: (n) => (n.startsWith('WHALE') ? 7000 : 4000),
	}));
	assert.strictEqual(out.flagged.length, 0);
	});

test('activeness weeks whose final scan came too early are ignored', () => {
	const early = (wk, w) => (w < 5 ? new Date(Date.parse(`${wk}T12:00:00Z`) + 3 * DAY).toISOString() : sundayNoon(wk));
	const out = evaluate(build({
		members: [...BASE, 'IDLE'],
		actFn: (n, w) => (n === 'IDLE' && w < 5 ? 100 : 1000),
		scrapedFn: early,
	}));
	assert.strictEqual(out.flagged.length, 0);
	assert.deepStrictEqual(out.actWeeks, ['2026-10-19']);
});

test('the lookback is a calendar window, so an old low week stops counting', () => {
	const out = evaluate(build({
		members: [...BASE, 'OLD'],
		actFn: (n, w) => (n === 'OLD' && w === 0 ? 100 : 1000),
	}), { ...THRESHOLDS, lookback: 3 });
	assert.strictEqual(out.flagged.length, 0);
	assert.deepStrictEqual(out.actWeeks, ['2026-10-05', '2026-10-12', '2026-10-19']);
});

test('needs the minimum number of weeks of crest data before flagging', () => {
	const out = evaluate(build({
		members: [...BASE, 'NEW'],
		crestFn: (n, w) => (n === 'NEW' ? (w >= 3 ? 2500 : null) : 4000),
	}));
	assert.strictEqual(out.flagged.length, 0);
});

test('inactive members are not evaluated', () => {
	const data = build({
		members: [...BASE, 'GONE'],
		crestFn: (n) => (n === 'GONE' ? 1000 : 4000),
	});
	data.activeIds.delete(8);
	assert.strictEqual(evaluate(data).flagged.length, 0);
});

test('a week overlapping an AFK period is skipped for activeness', () => {
	const data = build({
		members: [...BASE, 'AWAY'],
		actFn: (n, w) => (n === 'AWAY' && w === 5 ? 100 : 1000),
	});
	data.afkSpans = [{ memberId: 8, startedAt: '2026-10-20T00:00:00Z', endedAt: '2026-10-27T23:59:59Z' }];
	const out = evaluate(data);
	assert.strictEqual(out.flagged.length, 0);
	assert.strictEqual(out.afkSkipped, 1);
});

test('an open-ended AFK period skips every week since it started', () => {
	const data = build({
		members: [...BASE, 'AWAY'],
		crestFn: (n, w) => (n === 'AWAY' && w >= 2 ? 2000 : 4000),
	});
	data.afkSpans = [{ memberId: 8, startedAt: '2026-09-25T00:00:00Z', endedAt: null }];
	assert.strictEqual(evaluate(data).flagged.length, 0);
});

test('an AFK period that ended before the week does not exempt it', () => {
	const data = build({
		members: [...BASE, 'BACK'],
		actFn: (n, w) => (n === 'BACK' && w === 5 ? 100 : 1000),
	});
	data.afkSpans = [{ memberId: 8, startedAt: '2026-09-01T00:00:00Z', endedAt: '2026-10-10T23:59:59Z' }];
	const out = evaluate(data);
	assert.deepStrictEqual(out.flagged.map(f => f.name), ['BACK']);
});

test('thresholdsFromConfig applies valid overrides and stores the crest gap as negative', () => {
	const values = { GUILDDUEL_ACTIVENESS_MIN: '650', GUILDDUEL_CREST_GAP: '1200', GUILDDUEL_FLAG_WEEKS: '2', GUILDDUEL_LOOKBACK_WEEKS: '6', GUILDDUEL_MIN_WEEKS: '3' };
	const t = thresholdsFromConfig(k => values[k]);
	assert.deepStrictEqual(t, { actMin: 650, crestGap: -1200, flagWeeks: 2, lookback: 6, minWeeks: 3 });
});

test('thresholdsFromConfig falls back to the defaults on blank, zero, negative or non-numeric values', () => {
	const values = { GUILDDUEL_ACTIVENESS_MIN: '', GUILDDUEL_CREST_GAP: '0', GUILDDUEL_FLAG_WEEKS: '-2', GUILDDUEL_LOOKBACK_WEEKS: 'abc', GUILDDUEL_MIN_WEEKS: undefined };
	assert.deepStrictEqual(thresholdsFromConfig(k => values[k]), THRESHOLDS);
});
