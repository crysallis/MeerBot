const EXPIRY_MONTHS = 3;
const EDIT_PICKER_LIMIT = 25;

function defaultExpiry(now = new Date()) {
    const d = new Date(now);
    d.setUTCMonth(d.getUTCMonth() + EXPIRY_MONTHS);
    return d.toISOString();
}

function parseExpiryDate(text, now = new Date()) {
    if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    const [y, m, d] = text.split('-').map(Number);
    const day = new Date(Date.UTC(y, m - 1, d));
    if (day.getUTCFullYear() !== y || day.getUTCMonth() !== m - 1 || day.getUTCDate() !== d) return null;
    const end = new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999));
    return end < now ? null : end.toISOString();
}

function warningStatus(w, now = new Date()) {
    if (w.ended_at) return 'ended';
    return w.expires_at < now.toISOString() ? 'expired' : 'active';
}

function writeLog(h, { warningId, memberId, action, actor, now, detail = null }) {
    h.prepare(`INSERT INTO warning_log (warning_id, member_id, action, actor, at, detail)
               VALUES (?, ?, ?, ?, ?, ?)`).run(warningId, memberId, action, actor, now.toISOString(), detail);
}

function addWarning(h, { memberId, reason, createdBy, expiresAt, now = new Date(), action = 'add', detail = null }) {
    return h.transaction(() => {
        const id = Number(h.prepare(`INSERT INTO member_warnings (member_id, reason, created_by, created_at, expires_at)
                                     VALUES (?, ?, ?, ?, ?)`)
            .run(memberId, reason, createdBy, now.toISOString(), expiresAt ?? defaultExpiry(now)).lastInsertRowid);
        writeLog(h, { warningId: id, memberId, action, actor: createdBy, now, detail });
        return id;
    })();
}

function editWarning(h, id, { reason, expiresAt }, actor, now = new Date()) {
    return h.transaction(() => {
        const row = h.prepare('SELECT * FROM member_warnings WHERE id = ?').get(id);
        if (!row) return false;
        const changes = {};
        if (reason !== undefined && reason !== row.reason) changes.reason = { from: row.reason, to: reason };
        if (expiresAt !== undefined && expiresAt !== row.expires_at) changes.expires_at = { from: row.expires_at, to: expiresAt };
        if (!Object.keys(changes).length) return false;
        h.prepare('UPDATE member_warnings SET reason = ?, expires_at = ? WHERE id = ?')
            .run(changes.reason ? reason : row.reason, changes.expires_at ? expiresAt : row.expires_at, id);
        writeLog(h, { warningId: id, memberId: row.member_id, action: 'edit', actor, now, detail: JSON.stringify(changes) });
        return true;
    })();
}

function expireWarning(h, id, actor, note, now = new Date()) {
    return h.transaction(() => {
        const row = h.prepare('SELECT * FROM member_warnings WHERE id = ?').get(id);
        if (!row || row.ended_at) return false;
        h.prepare('UPDATE member_warnings SET ended_at = ?, ended_by = ? WHERE id = ?').run(now.toISOString(), actor, id);
        writeLog(h, { warningId: id, memberId: row.member_id, action: 'expire', actor, now, detail: note || null });
        return true;
    })();
}

function strikeWarning(h, id, actor, now = new Date()) {
    return h.transaction(() => {
        const row = h.prepare('SELECT member_id FROM member_warnings WHERE id = ?').get(id);
        if (!row) return null;
        h.prepare('DELETE FROM member_warnings WHERE id = ?').run(id);
        h.prepare('UPDATE warning_log SET detail = NULL WHERE warning_id = ?').run(id);
        writeLog(h, { warningId: id, memberId: row.member_id, action: 'strike', actor, now });
        return { memberId: row.member_id };
    })();
}

function loadWarnings(h, memberId, now) {
    return h.prepare('SELECT * FROM member_warnings WHERE member_id = ? ORDER BY created_at DESC, id DESC')
        .all(memberId)
        .map(w => ({ ...w, status: warningStatus(w, now) }));
}

function listWarnings(h, memberId, now = new Date()) {
    const editStmt = h.prepare(`SELECT at, actor, detail FROM warning_log
                                WHERE warning_id = ? AND action = 'edit' ORDER BY id`);
    const noteStmt = h.prepare(`SELECT detail FROM warning_log
                                WHERE warning_id = ? AND action = 'expire' ORDER BY id DESC LIMIT 1`);
    return loadWarnings(h, memberId, now).map(w => ({
        ...w,
        edits: editStmt.all(w.id),
        endNote: w.ended_at ? (noteStmt.get(w.id)?.detail ?? null) : null,
    }));
}

function countActive(h, memberId, now = new Date()) {
    return loadWarnings(h, memberId, now).filter(w => w.status === 'active').length;
}

function pickerWarnings(h, memberId, mode, now = new Date()) {
    const all = loadWarnings(h, memberId, now);
    if (mode === 'expire') return all.filter(w => w.status === 'active');
    if (mode === 'strike') return all;
    const rank = w => (w.status === 'active' ? 0 : 1);
    return all.slice().sort((a, b) => rank(a) - rank(b)).slice(0, EDIT_PICKER_LIMIT);
}

function needsAutoWarning(h, memberId, lastSeenApprox) {
    const last = h.prepare(`SELECT at FROM warning_log WHERE member_id = ? AND action = 'auto_add'
                            ORDER BY id DESC LIMIT 1`).get(memberId);
    if (!last) return true;
    return !!lastSeenApprox && lastSeenApprox > last.at;
}

function recordOfflineWarnings(h, inactiveRows, { thresholdDays, now = new Date() }) {
    let created = 0;
    for (const r of inactiveRows) {
        if (!needsAutoWarning(h, r.member_id, r.last_seen_approx)) continue;
        addWarning(h, {
            memberId: r.member_id,
            reason: `Offline ${thresholdDays}+ days`,
            createdBy: 'bot',
            now,
            action: 'auto_add',
            detail: JSON.stringify({ days_inactive: r.days_inactive }),
        });
        created++;
    }
    return created;
}

module.exports = {
    defaultExpiry, parseExpiryDate, warningStatus, addWarning, editWarning, expireWarning, strikeWarning,
    listWarnings, countActive, pickerWarnings, needsAutoWarning, recordOfflineWarnings,
};
