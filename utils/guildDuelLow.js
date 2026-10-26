const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

const THRESHOLDS = {
	actMin: 500,
	crestGap: -1000,
	lookback: 8,
	flagWeeks: 3,
	minWeeks: 4,
	hitFloor: 50,
};

const CONFIG_KEYS = {
	actMin: 'GUILDDUEL_ACTIVENESS_MIN',
	crestGap: 'GUILDDUEL_CREST_GAP',
	flagWeeks: 'GUILDDUEL_FLAG_WEEKS',
	lookback: 'GUILDDUEL_LOOKBACK_WEEKS',
	minWeeks: 'GUILDDUEL_MIN_WEEKS',
	hitFloor: 'GUILDDUEL_HIT_FLOOR',
};

const HIT_CRESTS = 200;
const DAMAGE_MIN_ROWS = 10;

function weekStartUtc(input) {
	const d = new Date(input);
	const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
	const daysSinceMonday = (d.getUTCDay() + 6) % 7;
	return new Date(today - daysSinceMonday * DAY).toISOString().slice(0, 10);
}

function isCompleteScan(weekStart, scrapedAt) {
	return Date.parse(scrapedAt) >= Date.parse(`${weekStart}T00:00:00Z`) + 4 * DAY + 18 * HOUR;
}

function median(nums) {
	const s = [...nums].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
}

function latestWeeks(weeks, n) {
	return [...new Set(weeks)].sort().slice(-n);
}

function recentWeeks(weeks, n) {
	const sorted = [...new Set(weeks)].sort();
	if (!sorted.length) return sorted;
	const cutoff = new Date(Date.parse(`${sorted[sorted.length - 1]}T00:00:00Z`) - (n - 1) * 7 * DAY).toISOString().slice(0, 10);
	return sorted.filter(w => w >= cutoff);
}

function groupBy(rows, keyFn) {
	const map = new Map();
	for (const r of rows) {
		const k = keyFn(r);
		if (!map.has(k)) map.set(k, []);
		map.get(k).push(r);
	}
	return map;
}

function makeAfkCheck(afkSpans) {
	const byMember = groupBy(afkSpans, s => s.memberId);
	return (memberId, week) => {
		const weekStart = Date.parse(`${week}T00:00:00Z`);
		const weekEnd = weekStart + 7 * DAY;
		return (byMember.get(memberId) || []).some(s =>
			Date.parse(s.startedAt) < weekEnd && (s.endedAt == null || Date.parse(s.endedAt) >= weekStart)
		);
	};
}

// Damage is context, never a trigger on its own. A week only counts once enough members have damage
// recorded (the weekend scan ran), hits are crests / 200, and "spent" is a member's damage per crest
// earned against the guild's mean damage per hit that week. Crests earned with no damage are listed
// separately, since that is the clearest red flag.
function damageContext({ crestRows, damageRows, activeIds, isAfkWeek, crestWeeks }) {
	const dealtBy = new Map(damageRows.filter(r => r.damage > 0).map(r => [`${r.memberId}|${r.week}`, r.damage]));
	const dealersPerWeek = new Map();
	for (const r of damageRows) if (r.damage > 0) dealersPerWeek.set(r.week, (dealersPerWeek.get(r.week) || 0) + 1);
	const weeks = crestWeeks.filter(w => (dealersPerWeek.get(w) || 0) >= DAMAGE_MIN_ROWS);

	const weekMean = new Map();
	let allDamage = 0;
	let allHits = 0;
	for (const wk of weeks) {
		let damage = 0;
		let hits = 0;
		for (const r of crestRows) {
			if (r.week !== wk || r.crests <= 0 || isAfkWeek(r.memberId, wk)) continue;
			const d = dealtBy.get(`${r.memberId}|${wk}`);
			if (!d) continue;
			damage += d;
			hits += r.crests / HIT_CRESTS;
		}
		if (hits > 0) {
			weekMean.set(wk, damage / hits);
			allDamage += damage;
			allHits += hits;
		}
	}

	const people = new Map();
	for (const r of crestRows) {
		const mean = weekMean.get(r.week);
		if (!mean || r.crests <= 0 || !activeIds.has(r.memberId) || isAfkWeek(r.memberId, r.week)) continue;
		const damage = dealtBy.get(`${r.memberId}|${r.week}`) || 0;
		if (!people.has(r.memberId)) people.set(r.memberId, { name: r.name, n: 0, ratioSum: 0, zeroWeeks: 0, zeroCrests: 0 });
		const p = people.get(r.memberId);
		p.n++;
		p.ratioSum += damage > 0 ? damage / (r.crests / HIT_CRESTS) / mean : 0;
		if (damage === 0 && r.crests >= HIT_CRESTS) {
			p.zeroWeeks++;
			p.zeroCrests += r.crests;
		}
	}
	return { people, weeks: [...weeks], hitMean: allHits > 0 ? allDamage / allHits : null };
}

function evaluate({ crestRows, actRows, activeIds, afkSpans = [], damageRows = [] }, t = THRESHOLDS) {
	const isAfkWeek = makeAfkCheck(afkSpans);
	const afkSkipped = new Set();
	const notAfk = (memberId, week) => {
		if (!isAfkWeek(memberId, week)) return true;
		if (activeIds.has(memberId)) afkSkipped.add(memberId);
		return false;
	};

	const completeAct = actRows
		.map(r => ({ ...r, week: weekStartUtc(r.scrapedAt) }))
		.filter(r => isCompleteScan(r.week, r.scrapedAt));
	const actWeeks = recentWeeks(completeAct.map(r => r.week), t.lookback);
	const crestWeeks = latestWeeks(crestRows.map(r => r.week), t.lookback);

	const actUsable = completeAct.filter(r => notAfk(r.memberId, r.week));
	const crestUsable = crestRows.filter(r => notAfk(r.memberId, r.week));

	const crestMedian = new Map();
	for (const [wk, rows] of groupBy(crestUsable.filter(r => crestWeeks.includes(r.week)), r => r.week)) {
		crestMedian.set(wk, median(rows.map(r => r.crests)));
	}

	const people = new Map();
	const slot = r => {
		if (!people.has(r.memberId)) {
			people.set(r.memberId, { name: r.name, actN: 0, actUnder: 0, actSum: 0, crestN: 0, crestLow: 0, gapSum: 0 });
		}
		return people.get(r.memberId);
	};

	for (const r of actUsable) {
		if (!actWeeks.includes(r.week) || !activeIds.has(r.memberId)) continue;
		const p = slot(r);
		p.actN++;
		p.actSum += r.activeness;
		if (r.activeness < t.actMin) p.actUnder++;
	}
	for (const r of crestUsable) {
		const med = crestMedian.get(r.week);
		if (!med || !activeIds.has(r.memberId)) continue;
		const p = slot(r);
		const gap = r.crests - med;
		p.crestN++;
		p.gapSum += gap;
		if (gap < t.crestGap) p.crestLow++;
	}

	const dmg = damageContext({ crestRows, damageRows, activeIds, isAfkWeek, crestWeeks });
	const damageOf = id => {
		const d = dmg.people.get(id);
		const avg = d && d.n ? d.ratioSum / d.n : null;
		return { dmgN: d ? d.n : 0, dmgRatioAvg: avg, dmgAtOrAbove: avg == null ? null : avg >= t.hitFloor / 100 };
	};

	const flagged = [];
	for (const [id, p] of people) {
		const out = {
			name: p.name,
			actN: p.actN,
			actUnder: p.actUnder,
			actAvg: p.actN ? p.actSum / p.actN : null,
			crestN: p.crestN,
			crestLow: p.crestLow,
			crestAvgGap: p.crestN ? p.gapSum / p.crestN : null,
			...damageOf(id),
		};
		const crestFlag = p.crestN >= t.minWeeks && p.crestLow >= t.flagWeeks;
		if (crestFlag || p.actUnder > 0) flagged.push(out);
	}

	flagged.sort((a, b) => b.actUnder - a.actUnder || b.crestLow - a.crestLow || a.crestAvgGap - b.crestAvgGap);

	const zeroAttackers = [...dmg.people.values()]
		.filter(d => d.zeroWeeks > 0)
		.map(d => ({ name: d.name, zeroWeeks: d.zeroWeeks, damageWeeks: d.n, crests: d.zeroCrests }))
		.sort((a, b) => b.zeroWeeks - a.zeroWeeks || b.crests - a.crests || a.name.localeCompare(b.name));

	return { flagged, zeroAttackers, damageWeeks: dmg.weeks, hitMean: dmg.hitMean, actWeeks, crestWeeks, afkSkipped: afkSkipped.size };
}

function thresholdsFromConfig(get) {
	const t = { ...THRESHOLDS };
	for (const [field, key] of Object.entries(CONFIG_KEYS)) {
		const n = Number.parseInt(get(key), 10);
		if (Number.isFinite(n) && n > 0) t[field] = field === 'crestGap' ? -n : n;
	}
	return t;
}

function loadRows(db) {
	const crestRows = db.prepare(`
		SELECT g.member_id AS memberId, m.ingame_name AS name, g.period_start AS week, g.crests AS crests
		FROM guild_duel_rankings g JOIN members m ON m.id = g.member_id
		WHERE g.crests IS NOT NULL
	`).all();
	const damageRows = db.prepare(`
		SELECT g.member_id AS memberId, m.ingame_name AS name, g.period_start AS week, g.damage AS damage
		FROM guild_duel_rankings g JOIN members m ON m.id = g.member_id
		WHERE g.damage IS NOT NULL
		ORDER BY g.period_start, g.member_id
	`).all();
	const actRows = db.prepare(`
		SELECT ms.member_id AS memberId, m.ingame_name AS name, s.scraped_at AS scrapedAt, ms.activeness AS activeness
		FROM member_snapshots ms
		JOIN snapshots s ON s.id = ms.snapshot_id
		JOIN members m ON m.id = ms.member_id
		WHERE ms.member_id IS NOT NULL AND s.scraped_at >= date('now', '-150 days')
	`).all();
	const activeIds = new Set(
		db.prepare("SELECT id FROM members WHERE active = 1 AND pending = 0").all().map(r => r.id)
	);
	const afkSpans = [
		...db.prepare("SELECT member_id AS memberId, started_at AS startedAt, ended_at AS endedAt FROM member_afk_history").all(),
		...db.prepare(`
			SELECT member_id AS memberId, set_at AS startedAt,
			       CASE WHEN return_date IS NULL THEN NULL ELSE return_date || 'T23:59:59.999Z' END AS endedAt
			FROM member_afk
		`).all(),
	];
	return { crestRows, damageRows, actRows, activeIds, afkSpans };
}

module.exports = { THRESHOLDS, CONFIG_KEYS, thresholdsFromConfig, weekStartUtc, isCompleteScan, evaluate, loadRows };
