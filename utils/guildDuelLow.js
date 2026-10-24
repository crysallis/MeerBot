const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

const THRESHOLDS = {
	actMin: 500,
	crestGap: -1000,
	lookback: 8,
	flagWeeks: 3,
	minWeeks: 4,
};

const CONFIG_KEYS = {
	actMin: 'GUILDDUEL_ACTIVENESS_MIN',
	crestGap: 'GUILDDUEL_CREST_GAP',
	flagWeeks: 'GUILDDUEL_FLAG_WEEKS',
	lookback: 'GUILDDUEL_LOOKBACK_WEEKS',
	minWeeks: 'GUILDDUEL_MIN_WEEKS',
};

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

function evaluate({ crestRows, actRows, activeIds, afkSpans = [] }, t = THRESHOLDS) {
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

	const flagged = [];
	for (const p of people.values()) {
		const out = {
			name: p.name,
			actN: p.actN,
			actUnder: p.actUnder,
			actAvg: p.actN ? p.actSum / p.actN : null,
			crestN: p.crestN,
			crestLow: p.crestLow,
			crestAvgGap: p.crestN ? p.gapSum / p.crestN : null,
		};
		const crestFlag = p.crestN >= t.minWeeks && p.crestLow >= t.flagWeeks;
		if (crestFlag || p.actUnder > 0) flagged.push(out);
	}

	flagged.sort((a, b) => b.actUnder - a.actUnder || b.crestLow - a.crestLow || a.crestAvgGap - b.crestAvgGap);
	return { flagged, actWeeks, crestWeeks, afkSkipped: afkSkipped.size };
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
	return { crestRows, actRows, activeIds, afkSpans };
}

module.exports = { THRESHOLDS, CONFIG_KEYS, thresholdsFromConfig, weekStartUtc, isCompleteScan, evaluate, loadRows };
