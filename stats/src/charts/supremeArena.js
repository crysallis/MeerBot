import { Chart, registerables } from 'chart.js';
import { escHtml } from '../utils.js';
Chart.register(...registerables);

let memberChart  = null;
let warbandChart = null;
let state        = null;
let meId         = null;

export async function initSupArena(me) {
    const res = await fetch('/api/arena');
    const { supArena } = await res.json();

    meId = me?.memberId ?? null;

    // Build memberMap: id -> { id, name, warbandId, warbandName, ranks: { period -> rank } }
    const memberMap = new Map();
    for (const r of supArena) {
        if (!memberMap.has(r.id)) {
            memberMap.set(r.id, {
                id:          r.id,
                name:        r.ingame_name,
                warbandId:   r.warband_id,
                warbandName: r.warband_name || 'Unassigned',
                ranks:       {},
            });
        }
        memberMap.get(r.id).ranks[r.period_start] = r.rank;
    }

    const periods  = [...new Set(supArena.map(r => r.period_start))].sort();
    const latest   = periods[periods.length - 1];
    const prev     = periods[periods.length - 2];
    const warbands = [...new Set([...memberMap.values()].map(m => m.warbandName))].sort();

    state = { memberMap, periods, latest, prev };

    // Warband filter (table)
    const wbFilter = document.getElementById('sa-warband-filter');
    for (const wb of warbands) {
        const opt = document.createElement('option');
        opt.value = wb; opt.textContent = wb;
        wbFilter.appendChild(opt);
    }
    wbFilter.addEventListener('change', () => renderTable(wbFilter.value));
    renderTable('');

    // Member select (history chart)
    const memberSel = document.getElementById('sa-member-select');
    const byRank    = [...memberMap.values()].sort((a, b) =>
        (a.ranks[latest] ?? 9999) - (b.ranks[latest] ?? 9999)
    );
    for (const m of byRank) {
        const opt = document.createElement('option');
        opt.value       = m.id;
        opt.textContent = m.name + (m.id === meId ? ' (you)' : '');
        memberSel.appendChild(opt);
    }
    if (meId && memberMap.has(meId)) memberSel.value = meId;
    memberSel.addEventListener('change', renderMemberChart);
    renderMemberChart();

    // Warband select (warband chart)
    const wbChartSel = document.getElementById('sa-wb-chart-select');
    for (const wb of warbands) {
        const opt = document.createElement('option');
        opt.value = wb; opt.textContent = wb;
        wbChartSel.appendChild(opt);
    }
    if (meId && memberMap.has(meId)) {
        wbChartSel.value = memberMap.get(meId).warbandName;
    }
    wbChartSel.addEventListener('change', renderWarbandChart);
    renderWarbandChart();
}

function renderTable(wbFilter) {
    const { memberMap, latest, prev } = state;

    let rows = [...memberMap.values()]
        .filter(m => m.ranks[latest] !== undefined)
        .sort((a, b) => a.ranks[latest] - b.ranks[latest]);

    if (wbFilter) rows = rows.filter(m => m.warbandName === wbFilter);

    if (!rows.length) {
        document.getElementById('sa-table').innerHTML = '<div class="empty-state">No data for this filter.</div>';
        return;
    }

    let html = `<table class="data-table"><thead><tr>
        <th>#</th><th>Member</th><th>Warband</th>${prev ? '<th>vs prev</th>' : ''}
    </tr></thead><tbody>`;

    for (const m of rows) {
        const isMe = m.id === meId;
        let delta  = '';
        if (prev) {
            const prevRank = m.ranks[prev];
            if (prevRank !== undefined) {
                const diff = m.ranks[latest] - prevRank;
                if (diff < 0)      delta = `<span class="delta-pos">+${Math.abs(diff)}</span>`;
                else if (diff > 0) delta = `<span class="delta-neg">-${diff}</span>`;
                else               delta = `<span class="delta-neu">--</span>`;
            } else {
                delta = `<span class="delta-neu">new</span>`;
            }
        }
        html += `<tr${isMe ? ' class="me"' : ''}>
            <td data-label="#">${rankBadge(m.ranks[latest])}</td>
            <td data-label="Member">${escHtml(m.name)}</td>
            <td data-label="Warband"><span class="warband-tag">${escHtml(m.warbandName)}</span></td>
            ${prev ? `<td data-label="vs prev">${delta}</td>` : ''}
        </tr>`;
    }
    html += `</tbody></table><div class="scan-note">Period: ${latest}${prev ? ` vs ${prev}` : ''}</div>`;
    document.getElementById('sa-table').innerHTML = html;
}

function renderMemberChart() {
    const { memberMap, periods } = state;
    const sel = document.getElementById('sa-member-select');
    const m   = memberMap.get(parseInt(sel.value));
    if (!m) return;

    const labels = periods;
    const data   = periods.map(p => m.ranks[p] ?? null);

    if (memberChart) {
        memberChart.data.labels      = labels;
        memberChart.data.datasets[0] = buildMemberDataset(m, data);
        memberChart.update();
        return;
    }

    memberChart = new Chart(document.getElementById('chart-sa-member'), {
        type: 'line',
        data: { labels, datasets: [buildMemberDataset(m, data)] },
        options: rankChartOptions('Rank'),
    });
}

function renderWarbandChart() {
    const { memberMap, periods } = state;
    const sel      = document.getElementById('sa-wb-chart-select');
    const wbName   = sel.value;
    const members  = [...memberMap.values()].filter(m => m.warbandName === wbName);
    const last5    = periods.slice(-5);
    const colors   = memberColors(members.length);

    const datasets = members
        .sort((a, b) => (a.ranks[last5[last5.length - 1]] ?? 9999) - (b.ranks[last5[last5.length - 1]] ?? 9999))
        .map((m, i) => ({
            label:           m.name + (m.id === meId ? ' ★' : ''),
            data:            last5.map(p => m.ranks[p] ?? null),
            borderColor:     colors[i],
            backgroundColor: colors[i],
            borderWidth:     m.id === meId ? 2.5 : 1.5,
            pointRadius:     3,
            spanGaps:        true,
            tension:         0.2,
        }));

    if (warbandChart) {
        warbandChart.data.labels   = last5;
        warbandChart.data.datasets = datasets;
        warbandChart.options.plugins.legend.display = members.length <= 12;
        warbandChart.update();
        return;
    }

    warbandChart = new Chart(document.getElementById('chart-sa-warband'), {
        type: 'line',
        data: { labels: last5, datasets },
        options: {
            ...rankChartOptions('Rank'),
            plugins: {
                ...rankChartOptions('Rank').plugins,
                legend: { display: members.length <= 12, labels: { color: '#8b92b8', font: { size: 11 }, boxWidth: 12, boxHeight: 12 } },
            },
        },
    });
}

function buildMemberDataset(m, data) {
    return {
        label:           m.name,
        data,
        borderColor:     m.id === meId ? 'hsl(220,80%,65%)' : 'hsl(270,60%,65%)',
        backgroundColor: m.id === meId ? 'hsl(220,80%,65%)' : 'hsl(270,60%,65%)',
        borderWidth:     2,
        pointRadius:     4,
        spanGaps:        true,
        tension:         0.2,
    };
}

function rankChartOptions(yLabel) {
    return {
        responsive:          true,
        maintainAspectRatio: true,
        interaction:         { mode: 'index', intersect: false },
        plugins: {
            legend:  { display: false },
            tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: #${ctx.parsed.y}` } },
        },
        scales: {
            x: { grid: { color: 'rgba(45,48,85,.6)' }, ticks: { color: '#8b92b8' } },
            y: {
                reverse: true,
                grid:    { color: 'rgba(45,48,85,.6)' },
                ticks:   { color: '#8b92b8', callback: v => `#${v}` },
                title:   { display: true, text: yLabel, color: '#8b92b8' },
            },
        },
    };
}

function rankBadge(r) {
    const cls = r === 1 ? 'r1' : r === 2 ? 'r2' : r === 3 ? 'r3' : '';
    return `<span class="rank-badge ${cls}">${r}</span>`;
}

function memberColors(n) {
    return Array.from({ length: n }, (_, i) =>
        `hsl(${Math.round((i * 360) / Math.max(n, 1))}, 65%, 60%)`
    );
}
