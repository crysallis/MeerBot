const { afkMemberIdsForWeek } = require('./duelWeeks');

function missingForPeriod(db, period) {
	return db.prepare(`
		SELECT m.ingame_name FROM members m
		WHERE m.active = 1 AND m.pending = 0
		  AND NOT EXISTS (SELECT 1 FROM guild_duel_rankings g
		                  WHERE g.member_id = m.id AND g.period_start = ? AND g.crests IS NOT NULL)
		ORDER BY m.ingame_name COLLATE NOCASE
	`).all(period);
}

function latestCrestsRow(db, memberId) {
	return db.prepare(`
		SELECT rank, crests FROM guild_duel_rankings
		WHERE member_id = ? AND crests IS NOT NULL
		ORDER BY scanned_at DESC LIMIT 1
	`).get(memberId);
}

function upsertCrests(db, memberId, period, rank, crests, scannedAt) {
	db.prepare(`
		INSERT INTO guild_duel_rankings (member_id, period_start, rank, crests, scanned_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(member_id, period_start) DO UPDATE SET
			rank = COALESCE(excluded.rank, rank), crests = excluded.crests, scanned_at = excluded.scanned_at
	`).run(memberId, period, rank, crests, scannedAt);
}

function crestReport(db) {
	const periods = db.prepare(
		'SELECT DISTINCT period_start FROM guild_duel_rankings WHERE crests IS NOT NULL ORDER BY period_start'
	).all().map(r => r.period_start);

	const rows = db.prepare(`
		SELECT m.id as member_id, m.ingame_name, m.warband_id, w.name as warband_name,
		       g.period_start, g.crests
		FROM guild_duel_rankings g
		JOIN members m ON m.id = g.member_id
		LEFT JOIN warbands w ON w.id = m.warband_id
		WHERE g.crests IS NOT NULL
		ORDER BY g.period_start, g.crests DESC
	`).all();

	const absent = db.prepare(`
		SELECT m.id as member_id, m.ingame_name, m.warband_id, w.name as warband_name,
		       p.period_start
		FROM members m
		CROSS JOIN (SELECT DISTINCT period_start FROM guild_duel_rankings WHERE crests IS NOT NULL) p
		LEFT JOIN warbands w ON w.id = m.warband_id
		LEFT JOIN guild_duel_rankings g
		       ON g.member_id = m.id AND g.period_start = p.period_start AND g.crests IS NOT NULL
		WHERE m.active = 1 AND m.pending = 0 AND g.member_id IS NULL
		ORDER BY p.period_start, m.ingame_name
	`).all();

	return { periods, rows, absent };
}

// The most recent week that has crests, with that same week's damage (null when none was recorded).
function latestDuelWeek(db, memberId) {
	return db.prepare(`
		SELECT period_start, rank, crests, damage FROM guild_duel_rankings
		WHERE member_id = ? AND crests IS NOT NULL
		ORDER BY scanned_at DESC LIMIT 1
	`).get(memberId);
}

// A week only counts as having damage data once the weekend scan clearly ran (10+ members with damage),
// so a week from before damage capture is never reported as "no damage".
function weekHasDamageData(db, period, minRows = 10) {
	return db.prepare('SELECT COUNT(*) AS n FROM guild_duel_rankings WHERE period_start = ? AND damage > 0')
		.get(period).n >= minRows;
}

function formatDuelDamage(damage) {
	if (damage >= 1e9) {
		const b = damage / 1e9;
		const shown = b >= 100 ? Math.round(b) : Math.round(b * 10) / 10;
		return `${Number.isInteger(shown) ? shown : shown.toFixed(1)}B`;
	}
	return `${Math.round(damage / 1e6)}M`;
}

function duelDamageText(row, weekHasData, afk = false) {
	if (row && row.damage > 0) return afk ? `${formatDuelDamage(row.damage)} · AFK` : formatDuelDamage(row.damage);
	if (afk) return 'AFK';
	return row && weekHasData ? 'No damage' : '·';
}

function duelCrestsText(row, afk = false, currentlyAfk = false) {
	if (row && row.crests != null) {
		const base = `${row.crests}${row.rank != null ? ` (#${row.rank})` : ''}`;
		return afk ? `${base} · AFK` : base;
	}
	return currentlyAfk ? 'AFK' : '·';
}

// Weekly damage for the stats site: only weeks where the weekend scan clearly ran (10+ members with
// damage), the damage rows for those weeks, and who was AFK in each (same rule as the recap).
function damageReport(db, minRows = 10) {
	const periods = db.prepare(`
		SELECT period_start FROM guild_duel_rankings WHERE damage > 0
		GROUP BY period_start HAVING COUNT(*) >= ? ORDER BY period_start
	`).all(minRows).map(r => r.period_start);
	if (!periods.length) return { periods: [], rows: [], afk: {} };

	const marks = periods.map(() => '?').join(',');
	const rows = db.prepare(`
		SELECT member_id, period_start, damage FROM guild_duel_rankings
		WHERE damage > 0 AND period_start IN (${marks})
		ORDER BY period_start, damage DESC
	`).all(...periods);

	const afk = {};
	for (const p of periods) afk[p] = [...afkMemberIdsForWeek(db, p)];
	return { periods, rows, afk };
}

module.exports = {
	missingForPeriod, latestCrestsRow, upsertCrests, crestReport, damageReport,
	latestDuelWeek, weekHasDamageData, duelDamageText, duelCrestsText,
};
