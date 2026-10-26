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

module.exports = { missingForPeriod, latestCrestsRow, upsertCrests, crestReport };
