import { escHtml } from '../utils.js';

export async function initLab(me) {
    const [labRes, honorRes] = await Promise.all([
        fetch('/api/lab'),
        fetch('/api/honor'),
    ]);
    const rows  = await labRes.json();
    const honor = await honorRes.json();

    document.getElementById('lab-table').innerHTML   = renderLabTable(rows, me);
    document.getElementById('honor-table').innerHTML = renderHonorTable(honor, me);
}

function renderLabTable(rows, me) {
    if (!rows.length) return '<div class="empty-state">No arcane lab data yet.</div>';

    const scanDate = rows[0]?.scanned_at?.slice(0, 10) ?? '';
    let html = `<table class="data-table"><thead><tr>
        <th>#</th><th>Member</th><th>Difficulty</th><th>Floor</th>
        <th>Points</th><th>Warband</th>
    </tr></thead><tbody>`;

    for (const r of rows) {
        const isMe = r.id === me?.memberId;
        html += `<tr${isMe ? ' class="me"' : ''}>
            <td data-label="#">${rankBadge(r.rank)}</td>
            <td data-label="Member">${escHtml(r.ingame_name)}</td>
            <td data-label="Difficulty">${escHtml(r.difficulty ?? '--')}</td>
            <td data-label="Floor">${r.floor ?? '--'}</td>
            <td data-label="Points">${r.points?.toLocaleString() ?? '--'}</td>
            <td data-label="Warband"><span class="warband-tag">${escHtml(r.warband_name || 'None')}</span></td>
        </tr>`;
    }
    html += `</tbody></table>`;
    if (scanDate) html += `<div class="scan-note">Latest scan: ${scanDate}</div>`;
    return html;
}

function renderHonorTable(rows, me) {
    if (!rows.length) return '<div class="empty-state">No honor duel data yet.</div>';
    const scanDate = rows[0]?.scanned_at?.slice(0, 10) ?? '';
    let html = `<table class="data-table"><thead><tr>
        <th>#</th><th>Member</th><th>Points</th>
    </tr></thead><tbody>`;
    for (const r of rows) {
        const isMe = r.id === me?.memberId;
        html += `<tr${isMe ? ' class="me"' : ''}>
            <td data-label="#">${rankBadge(r.rank)}</td>
            <td data-label="Member">${escHtml(r.ingame_name)}</td>
            <td data-label="Points">${r.honor_points?.toLocaleString() ?? '--'}</td>
        </tr>`;
    }
    html += `</tbody></table>`;
    if (scanDate) html += `<div class="scan-note">Latest scan: ${scanDate}</div>`;
    return html;
}

function rankBadge(r) {
    const cls = r === 1 ? 'r1' : r === 2 ? 'r2' : r === 3 ? 'r3' : '';
    return `<span class="rank-badge ${cls}">${r}</span>`;
}
