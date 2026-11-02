const { warningStatus } = require('./warnings');

const REASON_PREVIEW = 80;

function truncate(text, max) {
    return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function who(actor) {
    return actor === 'bot' ? 'MeerBot' : `<@${actor}>`;
}

function buildReport(rows, { includeExpired }, now = new Date()) {
    const byMember = new Map();
    for (const w of rows) {
        if (!byMember.has(w.member_id)) byMember.set(w.member_id, { memberId: w.member_id, name: w.name, active: 0, total: 0, latestRow: null });
        const e = byMember.get(w.member_id);
        e.total++;
        if (warningStatus(w, now) === 'active') e.active++;
        if (!e.latestRow || w.created_at > e.latestRow.created_at || (w.created_at === e.latestRow.created_at && w.id > e.latestRow.id)) e.latestRow = w;
    }
    return [...byMember.values()]
        .filter(e => includeExpired || e.active > 0)
        .map(({ latestRow, ...e }) => ({
            ...e,
            latest: { createdAt: latestRow.created_at, reason: latestRow.reason, status: warningStatus(latestRow, now) },
        }))
        .sort((a, b) =>
            b.active - a.active
            || (a.latest.createdAt < b.latest.createdAt ? 1 : a.latest.createdAt > b.latest.createdAt ? -1 : 0)
            || a.name.localeCompare(b.name));
}

function reportLines(entries, { includeExpired }) {
    return entries.map(e => {
        const count = includeExpired ? `${e.active} active (${e.total} total)` : `${e.active} active`;
        return `**${e.name}** · ${count} · latest ${e.latest.createdAt.slice(0, 10)} · ${truncate(e.latest.reason, REASON_PREVIEW)}`;
    });
}

function editLine(edit) {
    let parts = [];
    try {
        const d = JSON.parse(edit.detail);
        if (d.reason) parts.push(`reason "${d.reason.from}" to "${d.reason.to}"`);
        if (d.expires_at) parts.push(`expiry ${d.expires_at.from.slice(0, 10)} to ${d.expires_at.to.slice(0, 10)}`);
    } catch {
        parts = [];
    }
    return `edited by ${who(edit.actor)} · ${edit.at.slice(0, 10)}${parts.length ? `: ${parts.join('; ')}` : ''}`;
}

function historyLines(warnings) {
    return warnings.map(w => {
        const label = w.status === 'ended' ? 'ended early' : w.status;
        const lines = [
            `**#${w.id}** · ${label} · ${w.reason}`,
            `added by ${who(w.created_by)} · ${w.created_at.slice(0, 10)} · expires ${w.expires_at.slice(0, 10)}`,
        ];
        if (w.ended_at) lines.push(`ended early by ${who(w.ended_by)} · ${w.ended_at.slice(0, 10)}${w.endNote ? ` · "${w.endNote}"` : ''}`);
        for (const e of w.edits ?? []) lines.push(editLine(e));
        return lines.join('\n');
    });
}

function chunkLines(lines, max = 3800, sep = '\n') {
    const chunks = [];
    let current = '';
    for (const raw of lines) {
        const line = truncate(raw, max);
        if (!current) current = line;
        else if (current.length + sep.length + line.length <= max) current += sep + line;
        else { chunks.push(current); current = line; }
    }
    if (current) chunks.push(current);
    return chunks;
}

module.exports = { buildReport, reportLines, historyLines, chunkLines };
