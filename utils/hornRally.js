function eventDates(h) {
	return h.prepare(
		`SELECT event_date, COUNT(*) AS attended FROM horn_rally_attendance
		 GROUP BY event_date ORDER BY event_date DESC`
	).all();
}

function participantsFor(h, eventDate) {
	return h.prepare(
		`SELECT m.id, m.ingame_name, EXISTS(SELECT 1 FROM member_afk a WHERE a.member_id = m.id) AS afk
		 FROM horn_rally_attendance r JOIN members m ON m.id = r.member_id
		 WHERE r.event_date = ?
		 ORDER BY m.ingame_name COLLATE NOCASE`
	).all(eventDate);
}

function nonParticipantsFor(h, eventDate) {
	return h.prepare(
		`SELECT m.id, m.ingame_name, EXISTS(SELECT 1 FROM member_afk a WHERE a.member_id = m.id) AS afk
		 FROM members m
		 WHERE m.active = 1 AND m.pending = 0
		   AND NOT EXISTS (SELECT 1 FROM horn_rally_attendance r
		                   WHERE r.member_id = m.id AND r.event_date = ?)
		 ORDER BY m.ingame_name COLLATE NOCASE`
	).all(eventDate);
}

function memberHornStatus(h, memberId) {
	const latest = h.prepare('SELECT MAX(event_date) AS d FROM horn_rally_attendance').get().d;
	if (!latest) return null;
	const lastAttended = h.prepare(
		'SELECT MAX(event_date) AS d FROM horn_rally_attendance WHERE member_id = ?'
	).get(memberId).d;
	return { latest, lastAttended, attendedLatest: lastAttended === latest };
}

function hornRallyText(status, afkNow) {
	if (!status) return '·';
	if (status.attendedLatest) return `${status.latest} · Participated`;
	const last = status.lastAttended ? `last attended ${status.lastAttended}` : 'never attended on record';
	return `${status.latest} · Missed${afkNow ? ' · AFK' : ''}\n${last}`;
}

function memberLine(row) {
	return `· ${row.ingame_name}${row.afk ? ' · AFK' : ''}`;
}

module.exports = { eventDates, participantsFor, nonParticipantsFor, memberHornStatus, hornRallyText, memberLine };
