import { Chart, registerables } from 'chart.js';
import { getCSSVar, cssVarRgba, escHtml } from '../utils.js';
Chart.register(...registerables);

let chartsByTier = new Map();
let allData      = null;
let meRef        = null;
let rowsRef      = [];

const TIER_ORDER = ['common', 'hard', 'epic', 'hell', 'endless'];

function tierRank(tier) {
    const i = TIER_ORDER.indexOf(tier || 'common');
    return i === -1 ? TIER_ORDER.length : i; // unrecognized tiers sort after endless, not silently dropped
}

function groupByTier(rows) {
    const groups = new Map(); // tier -> rows[]
    for (const r of rows) {
        const t = r.tier || 'common';
        if (!groups.has(t)) groups.set(t, []);
        groups.get(t).push(r);
    }
    for (const list of groups.values()) {
        list.sort((a, b) => parseScore(b.score) - parseScore(a.score));
    }
    // Best tier first (descending tier rank) for display order.
    return [...groups.entries()].sort((a, b) => tierRank(b[0]) - tierRank(a[0]));
}

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
        .filter(s => s.boss_id === bossId && s.scan_date === date);

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

    const tierGroups = groupByTier(rows);

    // Bar charts · one per tier group, each with its own scale so a max Hell
    // score never visually dwarfs a max Endless score on a shared axis.
    rowsRef = rows;
    const container = document.getElementById('chart-dr-container');

    const seenTiers = new Set(tierGroups.map(([t]) => t));
    for (const tier of [...chartsByTier.keys()]) {
        if (!seenTiers.has(tier)) {
            chartsByTier.get(tier).destroy();
            chartsByTier.delete(tier);
            const el = document.getElementById(`chart-dr-wrap-${tier}`);
            if (el) el.remove();
        }
    }

    for (const [tier, tierRows] of tierGroups) {
        let wrap = document.getElementById(`chart-dr-wrap-${tier}`);
        if (!wrap) {
            wrap = document.createElement('div');
            wrap.id = `chart-dr-wrap-${tier}`;
            wrap.className = 'tier-chart-wrap';
            const heading = document.createElement('div');
            heading.className = 'tier-group-heading';
            heading.innerHTML = `<span class="tier-badge tier-${tier}">${tier}</span>`;
            const canvas = document.createElement('canvas');
            canvas.id = `chart-dr-${tier}`;
            wrap.appendChild(heading);
            wrap.appendChild(canvas);
            container.appendChild(wrap);
        }

        const labels = tierRows.map(r => r.ingame_name);
        const values = tierRows.map(r => parseScore(r.score));
        const colors = tierRows.map(r => r.member_id === me?.memberId ? getCSSVar('--color-primary') : tierColor(tier));

        const existing = chartsByTier.get(tier);
        if (existing) {
            existing.data.labels = labels;
            existing.data.datasets[0].data            = values;
            existing.data.datasets[0].backgroundColor = colors;
            existing.update();
            continue;
        }

        const newChart = new Chart(document.getElementById(`chart-dr-${tier}`), {
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
                    tooltip: { callbacks: { label: ctx => ' ' + tierRows[ctx.dataIndex].score } },
                },
                scales: {
                    x: { grid: { color: getCSSVar('--color-base-content') }, ticks: { color: getCSSVar('--color-base-content'), callback: v => fmtScore(v) } },
                    y: { grid: { color: getCSSVar('--color-base-content') }, ticks: { color: getCSSVar('--color-base-content'), font: { size: 11 } } },
                },
            },
        });
        newChart._recolor = () => renderDR(meRef);
        chartsByTier.set(tier, newChart);
    }

    // Table · grouped by tier, best tier first, sorted by score within each tier
    const hasDelta = Object.keys(prevMap).length > 0;

    let html = '';
    for (const [tier, tierRows] of tierGroups) {
        html += `<div class="tier-group">
            <h3 class="tier-group-heading"><span class="tier-badge tier-${escHtml(tier)}">${escHtml(tier)}</span></h3>
            <table class="data-table"><thead><tr>
                <th>#</th><th>Member</th><th>Score</th>
                ${hasDelta ? '<th>vs prev</th>' : ''}
            </tr></thead><tbody>`;

        for (const r of tierRows) {
            const isMe = r.member_id === me?.memberId;
            const prev = prevMap[r.member_id];
            let delta  = '';
            if (hasDelta) {
                if (prev && prev.tier === r.tier) {
                    const diff = parseScore(r.score) - parseScore(prev.score);
                    if (diff > 0) delta = `<span class="delta-pos">+${fmtScore(diff)}</span>`;
                    else if (diff < 0) delta = `<span class="delta-neg">${fmtScore(diff)}</span>`;
                    else delta = `<span class="delta-neu">--</span>`;
                } else if (prev) {
                    delta = `<span class="delta-neu">tier changed</span>`;
                } else {
                    delta = `<span class="delta-neu">new</span>`;
                }
            }
            html += `<tr${isMe ? ' class="me"' : ''}>
                <td data-label="#">${rankBadge(r.rank)}</td>
                <td data-label="Member">${escHtml(r.ingame_name)}</td>
                <td data-label="Score"><strong>${escHtml(r.score)}</strong></td>
                ${hasDelta ? `<td data-label="Change">${delta}</td>` : ''}
            </tr>`;
        }
        html += '</tbody></table></div>';
    }

    if (prevDate) html += `<div class="scan-note">Comparing to ${prevDate}</div>`;

    document.getElementById('dr-table').innerHTML = html;
}

function parseScore(s) {
    if (!s) return 0;
    const m = String(s).match(/^([\d.]+)([KMGB]?)$/i);
    if (!m) return 0;
    const v = parseFloat(m[1]);
    const u = m[2].toUpperCase();
    return u === 'K' ? v * 1e3 : u === 'M' ? v * 1e6 : u === 'G' ? v * 1e9 : u === 'B' ? v * 1e9 : v;
}

function fmtScore(v) {
    if (v >= 1e9) return (v / 1e9).toFixed(0) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(0) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
    return v < 0 ? '-' + fmtScore(-v) : String(v);
}

function tierColor(tier) {
    if (tier === 'hard')    return cssVarRgba('--hard',    0.75);
    if (tier === 'epic')    return cssVarRgba('--epic',    0.75);
    if (tier === 'hell')    return cssVarRgba('--hell',    0.75);
    if (tier === 'endless') return cssVarRgba('--endless', 0.75);
    return cssVarRgba('--common', 0.75);
}

function rankBadge(r) {
    const cls = r === 1 ? 'r1' : r === 2 ? 'r2' : r === 3 ? 'r3' : '';
    return `<span class="rank-badge ${cls}">${r}</span>`;
}
