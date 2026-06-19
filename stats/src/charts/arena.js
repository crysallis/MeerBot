import { escHtml } from '../utils.js';

export async function initArena(me) {
    const res = await fetch('/api/arena');
    const { arena, supArena } = await res.json();

    document.getElementById('arena-table').innerHTML = renderArenaTable(arena, me);
    document.getElementById('sup-arena-table').innerHTML = renderSupArenaTable(supArena, me);
}

function renderArenaTable(rows, me) {
    if (!rows.length) return '<div class="empty-state">No arena data yet.</div>';
    const scanDate = rows[0]?.scanned_at?.slice(0, 10) ?? '';
    let html = `<table class="data-table"><thead><tr>
        <th>#</th><th>Member</th><th>Points</th><th>Warband</th>
    </tr></thead><tbody>`;
    for (const r of rows) {
        const isMe = r.id === me?.memberId;
        html += `<tr${isMe ? ' class="me"' : ''}>
            <td data-label="#">${rankBadge(r.rank)}</td>
            <td data-label="Member">${escHtml(r.ingame_name)}</td>
            <td data-label="Points">${r.points?.toLocaleString() ?? '--'}</td>
            <td data-label="Warband"><span class="warband-tag">${escHtml(r.warband_name || 'None')}</span></td>
        </tr>`;
    }
    html += `</tbody></table>`;
    if (scanDate) html += `<div class="scan-note">Latest scan: ${scanDate}</div>`;
    return html;
}

function renderSupArenaTable(rows, me) {
    if (!rows.length) return '<div class="empty-state">No supreme arena data yet.</div>';

    const periods = [...new Set(rows.map(r => r.period_start))].sort().reverse();
    const latest  = periods[0];
    const prev    = periods[1];

    const latestRows = rows.filter(r => r.period_start === latest).sort((a, b) => a.rank - b.rank);
    const prevMap    = {};
    if (prev) {
        for (const r of rows.filter(r => r.period_start === prev)) prevMap[r.id] = r;
    }

    let html = `<table class="data-table"><thead><tr>
        <th>#</th><th>Member</th>${prev ? '<th>vs prev</th>' : ''}
    </tr></thead><tbody>`;
    for (const r of latestRows) {
        const isMe = r.id === me?.memberId;
        let delta  = '';
        if (prev) {
            const p = prevMap[r.id];
            if (p) {
                const diff = r.rank - p.rank;
                if (diff < 0) delta = `<span class="delta-pos">+${Math.abs(diff)}</span>`;
                else if (diff > 0) delta = `<span class="delta-neg">-${diff}</span>`;
                else delta = `<span class="delta-neu">--</span>`;
            } else {
                delta = `<span class="delta-neu">new</span>`;
            }
        }
        html += `<tr${isMe ? ' class="me"' : ''}>
            <td data-label="#">${rankBadge(r.rank)}</td>
            <td data-label="Member">${escHtml(r.ingame_name)}</td>
            ${prev ? `<td data-label="vs prev">${delta}</td>` : ''}
        </tr>`;
    }
    html += `</tbody></table><div class="scan-note">Period: ${latest}${prev ? ` vs ${prev}` : ''}</div>`;
    return html;
}

function rankBadge(r) {
    const cls = r === 1 ? 'r1' : r === 2 ? 'r2' : r === 3 ? 'r3' : '';
    return `<span class="rank-badge ${cls}">${r}</span>`;
}
