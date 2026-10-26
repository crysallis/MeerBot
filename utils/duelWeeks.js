const DAY_MS = 86400000;

function parseUtcDate(str) {
    if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
    const d = new Date(`${str}T00:00:00Z`);
    return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== str ? null : d;
}

function isoDate(d) {
    return d.toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
    return isoDate(new Date(parseUtcDate(dateStr).getTime() + n * DAY_MS));
}

function weekStartOf(str) {
    const d = parseUtcDate(str);
    if (!d) return null;
    return isoDate(new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY_MS));
}

// A member is excluded when an AFK period touched the duel week: a current record that
// started before the week ended (unless its return date already passed before the week),
// or any history row overlapping it. AFK that began after the week does not count.
function afkMemberIdsForWeek(handle, weekStart, onlyMemberId = null) {
    const weekEnd = `${addDays(weekStart, 7)}T00:00:00.000Z`;
    const weekStartIso = `${weekStart}T00:00:00.000Z`;
    const ids = new Set();
    for (const r of handle.prepare('SELECT member_id, set_at, return_date FROM member_afk').all()) {
        if (onlyMemberId != null && r.member_id !== onlyMemberId) continue;
        if (r.set_at < weekEnd && !(r.return_date && r.return_date < weekStart)) ids.add(r.member_id);
    }
    for (const r of handle.prepare(
        'SELECT member_id FROM member_afk_history WHERE started_at < ? AND (ended_at IS NULL OR ended_at >= ?)'
    ).all(weekEnd, weekStartIso)) {
        if (onlyMemberId == null || r.member_id === onlyMemberId) ids.add(r.member_id);
    }
    return ids;
}

function isMemberAfkForWeek(handle, memberId, weekStart) {
    return afkMemberIdsForWeek(handle, weekStart, memberId).has(memberId);
}

module.exports = { parseUtcDate, isoDate, addDays, weekStartOf, afkMemberIdsForWeek, isMemberAfkForWeek };
