import { Chart, registerables } from 'chart.js';
import { getCSSVar, cssVarRgba, escHtml } from '../utils.js';
Chart.register(...registerables);

let chart   = null;
let allData = null;
let meRef   = null;

export async function initDreamRealm(me) {
    meRef = me;
    const res = await fetch('/api/dream-realm');
    allData   = await res.json();

    const bossEl = document.getElementById('dr-boss');
    const dateEl = document.getElementById('dr-date');

    for (const b of allData.bosses) {
        const opt = document.createElement('option');
        opt.value = b.id; opt.textContent = b.name;
        bossEl.appendChild(opt);
    }

    function updateDates() {
        const bossId = parseInt(bossEl.value);
        const dates  = [...new Set(
            allData.scores.filter(s => s.boss_id === bossId).map(s => s.scan_date)
        )].sort().reverse();

        dateEl.innerHTML = '';
        for (const d of dates) {
            const opt = document.createElement('option');
            opt.value = d; opt.textContent = d;
            dateEl.appendChild(opt);
        }
        renderDR(me);
    }

    bossEl.addEventListener('change', updateDates);
    dateEl.addEventListener('change', () => renderDR(me));

    if (allData.bosses.length) updateDates();
}

function renderDR(me) {
    const bossId   = parseInt(document.getElementById('dr-boss').value);
    const date     = document.getElementById('dr-date').value;

    const rows = allData.scores
        .filter(s => s.boss_id === bossId && s.scan_date === date)
        .sort((a, b) => a.rank - b.rank);

    // Previous date for delta
    const prevDate = [...new Set(
        allData.scores.filter(s => s.boss_id === bossId).map(s => s.scan_date)
    )].sort().reverse().find(d => d < date);

    const prevMap = {};
    if (prevDate) {
        for (const s of allData.scores.filter(s => s.boss_id === bossId && s.scan_date === prevDate)) {
            prevMap[s.member_id] = s;
        }
    }

    // Bar chart
    const labels = rows.map(r => r.ingame_name);
    const values = rows.map(r => parseScore(r.score));
    const colors = rows.map(r => r.member_id === me?.memberId ? getCSSVar('--accent') : tierColor(r.tier));

    if (chart) {
        chart.data.labels   = labels;
        chart.data.datasets[0].data            = values;
        chart.data.datasets[0].backgroundColor = colors;
        chart.update();
    } else {
        chart = new Chart(document.getElementById('chart-dr'), {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    label: 'Score',
                    data: values,
                    backgroundColor: colors,
                    borderRadius: 3,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                indexAxis: 'y',
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: ctx => ' ' + rows[ctx.dataIndex].score } },
                },
                scales: {
                    x: { grid: { color: 'rgba(45,48,85,.6)' }, ticks: { color: '#8b92b8', callback: v => fmtScore(v) } },
                    y: { grid: { color: 'rgba(45,48,85,.6)' }, ticks: { color: '#8b92b8', font: { size: 11 } } },
                },
            },
        });
        chart._recolor = () => renderDR(meRef);
    }

    // Table
    const hasDelta = Object.keys(prevMap).length > 0;
    let html = `<table class="data-table"><thead><tr>
        <th>#</th><th>Member</th><th>Score</th><th>Tier</th>
        ${hasDelta ? '<th>vs prev</th>' : ''}
    </tr></thead><tbody>`;

    for (const r of rows) {
        const isMe  = r.member_id === me?.memberId;
        const prev  = prevMap[r.member_id];
        let delta   = '';
        if (hasDelta && prev) {
            const diff = parseScore(r.score) - parseScore(prev.score);
            if (diff > 0) delta = `<span class="delta-pos">+${fmtScore(diff)}</span>`;
            else if (diff < 0) delta = `<span class="delta-neg">${fmtScore(diff)}</span>`;
            else delta = `<span class="delta-neu">--</span>`;
        } else if (hasDelta) {
            delta = `<span class="delta-neu">new</span>`;
        }
        html += `<tr${isMe ? ' class="me"' : ''}>
            <td data-label="#">${rankBadge(r.rank)}</td>
            <td data-label="Member">${escHtml(r.ingame_name)}</td>
            <td data-label="Score"><strong>${escHtml(r.score)}</strong></td>
            <td data-label="Tier"><span class="tier-badge tier-${escHtml(r.tier || 'common')}">${escHtml(r.tier || 'common')}</span></td>
            ${hasDelta ? `<td data-label="Change">${delta}</td>` : ''}
        </tr>`;
    }
    html += '</tbody></table>';
    if (prevDate) html += `<div class="scan-note">Comparing to ${prevDate}</div>`;

    document.getElementById('dr-table').innerHTML = html;
}

function parseScore(s) {
    if (!s) return 0;
    const m = String(s).match(/^([\d.]+)([KMG]?)$/i);
    if (!m) return 0;
    const v = parseFloat(m[1]);
    const u = m[2].toUpperCase();
    return u === 'K' ? v * 1e3 : u === 'M' ? v * 1e6 : u === 'G' ? v * 1e9 : v;
}

function fmtScore(v) {
    if (v >= 1e6) return (v / 1e6).toFixed(0) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
    return v < 0 ? '-' + fmtScore(-v) : String(v);
}

function tierColor(tier) {
    if (tier === 'hard')  return cssVarRgba('--hard',   0.75);
    if (tier === 'epic')  return cssVarRgba('--epic',   0.75);
    return cssVarRgba('--common', 0.75);
}

function rankBadge(r) {
    const cls = r === 1 ? 'r1' : r === 2 ? 'r2' : r === 3 ? 'r3' : '';
    return `<span class="rank-badge ${cls}">${r}</span>`;
}
