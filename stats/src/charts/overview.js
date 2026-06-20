import { Chart, registerables } from 'chart.js';
import { getCSSVar, cssVarRgba } from '../utils.js';
Chart.register(...registerables);

const WB_KEYS = ['riffraff', 'kings', 'sobaquitos'];

function wbKey(name) {
    const lower = (name || '').toLowerCase();
    for (const key of WB_KEYS) {
        if (lower.includes(key)) return key;
    }
    return null;
}

function wbGradColors() {
    const s = getComputedStyle(document.documentElement);
    return {
        riffraff:   [s.getPropertyValue('--wb-riffraff-from').trim(), s.getPropertyValue('--wb-riffraff-to').trim()],
        kings:      [s.getPropertyValue('--wb-kings-from').trim(),    s.getPropertyValue('--wb-kings-to').trim()],
        sobaquitos: [s.getPropertyValue('--wb-sobaquitos-from').trim(),s.getPropertyValue('--wb-sobaquitos-to').trim()],
    };
}

export async function initOverview(me) {
    const [membRes, wbRes] = await Promise.all([
        fetch('/api/members'),
        fetch('/api/warbands'),
    ]);
    const { members, lastScan } = await membRes.json();
    const warbands = await wbRes.json();

    const totalPower = members.reduce((s, m) => s + (m.combat_power_value || 0), 0);
    const scanDate   = lastScan ? new Date(lastScan).toLocaleDateString() : 'Unknown';

    document.getElementById('overview-cards').innerHTML = `
        <div class="stat-card"><div class="stat-value">${members.length}</div><div class="stat-label">Active Members</div></div>
        <div class="stat-card"><div class="stat-value">${fmtPower(totalPower)}</div><div class="stat-label">Total Guild Power</div></div>
        <div class="stat-card"><div class="stat-value">${scanDate}</div><div class="stat-label">Last Scan</div></div>
    `;

    // Warband power breakdown (horizontal bar)
    const wbMap = {};
    for (const wb of warbands) wbMap[wb.id] = { name: wb.name, power: 0, count: 0 };
    wbMap[0] = { name: 'Unassigned', power: 0, count: 0 };
    for (const m of members) {
        const key = m.warband_id ?? 0;
        if (!wbMap[key]) wbMap[key] = { name: 'Unknown', power: 0, count: 0 };
        wbMap[key].power += m.combat_power_value || 0;
        wbMap[key].count += 1;
    }
    const wbEntries = Object.values(wbMap).filter(w => w.count > 0);

    // afterLayout runs after chartArea is known, so pixel-space gradients are valid
    const gradPlugin = {
        id: 'wbGrad',
        afterLayout(chart) {
            const { ctx, chartArea } = chart;
            chart.data.datasets[0].backgroundColor = wbEntries.map(w => {
                const key = wbKey(w.name);
                if (!key) return cssVarRgba('--color-neutral-content', 0.5);
                const [c1, c2] = wbGradColors()[key];
                const g = ctx.createLinearGradient(chartArea.left, 0, chartArea.right, 0);
                g.addColorStop(0, c1);
                g.addColorStop(1, c2);
                return g;
            });
        },
    };

    new Chart(document.getElementById('chart-warband'), {
        type: 'bar',
        data: {
            labels: wbEntries.map(w => w.name),
            datasets: [{
                label: 'Total Power',
                data:  wbEntries.map(w => w.power / 1e9),
                backgroundColor: wbEntries.map(() => 'transparent'),
                borderRadius: 4,
            }],
        },
        options: chartOpts({
            indexAxis: 'y',
            plugins: { legend: { display: false } },
            scales: { x: { title: { display: true, text: 'Power (B)' } } },
        }),
        plugins: [gradPlugin],
    });
    // gradPlugin.afterLayout recreates gradients on every chart.update() so no _recolor needed

    // Top 10 members horizontal bar
    const top10  = [...members].slice(0, 10);
    const meColors = () => top10.map(m =>
        m.id === me?.memberId ? getCSSVar('--color-primary') : cssVarRgba('--color-neutral-content', 0.55)
    );

    const topChart = new Chart(document.getElementById('chart-top10'), {
        type: 'bar',
        data: {
            labels: top10.map(m => m.ingame_name),
            datasets: [{
                label: 'Power',
                data:  top10.map(m => (m.combat_power_value || 0) / 1e6),
                backgroundColor: meColors(),
                borderRadius: 4,
            }],
        },
        options: chartOpts({
            indexAxis: 'y',
            plugins: { legend: { display: false } },
            scales: { x: { title: { display: true, text: 'Power (M)' } } },
        }),
    });
    topChart._recolor = () => {
        topChart.data.datasets[0].backgroundColor = meColors();
    };
}

function fmtPower(val) {
    if (val >= 1e9) return (val / 1e9).toFixed(2) + 'B';
    if (val >= 1e6) return (val / 1e6).toFixed(0) + 'M';
    return val.toLocaleString();
}

function chartOpts(extra = {}) {
    return {
        responsive: true,
        maintainAspectRatio: true,
        ...extra,
        plugins: {
            ...(extra.plugins || {}),
            tooltip: { callbacks: {} },
        },
        scales: {
            ...(extra.scales || {}),
            x: {
                grid:  { color: 'rgba(45,48,85,.6)' },
                ticks: { color: '#8b92b8' },
                ...(extra.scales?.x || {}),
            },
            y: {
                grid:  { color: 'rgba(45,48,85,.6)' },
                ticks: { color: '#8b92b8' },
                ...(extra.scales?.y || {}),
            },
        },
    };
}
