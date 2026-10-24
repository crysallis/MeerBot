function archiveEnded(db, memberId, endedAt) {
    return db.prepare(`
        INSERT INTO member_afk_history (member_id, started_at, ended_at, return_date, reason)
        SELECT member_id, set_at, ?, return_date, reason FROM member_afk WHERE member_id = ?
    `).run(endedAt, memberId);
}

function archiveExpired(db, today) {
    return db.prepare(`
        INSERT INTO member_afk_history (member_id, started_at, ended_at, return_date, reason)
        SELECT member_id, set_at, return_date || 'T23:59:59.999Z', return_date, reason
        FROM member_afk WHERE return_date IS NOT NULL AND return_date < ?
    `).run(today);
}

module.exports = { archiveEnded, archiveExpired };
