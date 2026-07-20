import { Chart, registerables } from 'chart.js';
import { escHtml, getCSSVar } from '../utils.js';
Chart.register(...registerables);

let chart = null;
let state = null;
let meId  = null;

export async function initGuildDuel(me) {
    const res  = await fetch('/api/guild-duel');
    const data = await res.json();

    meId = me?.memberId ?? null;

    const memberMap = new Map();
    function getMember(r) {
        if (!memberMap.has(r.member_id)) {
            memberMap.set(r.member_id, {
                id:             r.member_id,
                name:           r.ingame_name,
                warbandId:      r.warband_id,
                warbandName:    r.warband_name || 'Unassigned',
                crestsByPeriod: {},
            });
        }
        return memberMap.get(r.member_id);
    }

    for (const r of data.rows) {
        getMember(r).crestsByPeriod[r.period_start] = r.crests;
    }

    const absentByPeriod = new Map();
    for (const r of data.absent) {
        getMember(r); // ensure the member exists in memberMap even if they never had a single crest row
        if (!absentByPeriod.has(r.period_start)) absentByPeriod.set(r.period_start, new Set());
        absentByPeriod.get(r.period_start).add(r.member_id);
    }

    state = { periods: data.periods, memberMap, absentByPeriod };

    // Warband filter
    const wbFilter = document.getElementById('gd-warband-filter');
    const warbands = [...new Set([...memberMap.values()].map(m => m.warbandName))].sort();
    for (const wb of warbands) {
        const opt = document.createElement('option');
        opt.value = wb; opt.textContent = wb;
        wbFilter.appendChild(opt);
    }
    wbFilter.addEventListener('change', renderAll);

    // Period selector: most recent period first, then older periods, then "All Time"
    const periodSel = document.getElementById('gd-period-select');
    const reversed = [...state.periods].reverse();
    for (const p of reversed) {
        const opt = document.createElement('option');
        opt.value = p; opt.textContent = p;
        periodSel.appendChild(opt);
    }
    const allOpt = document.createElement('option');
    allOpt.value = 'all'; allOpt.textContent = 'All Time';
    periodSel.appendChild(allOpt);
    if (reversed.length) periodSel.value = reversed[0];
    periodSel.addEventListener('change', renderAll);

    buildMemberDropdown(document.getElementById('gd-member-wrap'), memberMap, me);

    renderAll();
}

let selectedIds = new Set();
let allSelected = true;

function renderAll() {
    renderChart();
    renderLists();
}

function renderChart() {
    const { periods, memberMap } = state;
    const wbSel = document.getElementById('gd-warband-filter').value;

    let filtered = [...memberMap.values()];
    if (!allSelected && selectedIds.size > 0) {
        filtered = filtered.filter(m => selectedIds.has(m.id));
    } else if (wbSel) {
        filtered = filtered.filter(m => m.warbandName === wbSel);
    }

    const lastPeriod = periods[periods.length - 1];
    filtered.sort((a, b) =>
        (b.crestsByPeriod[lastPeriod] || 0) - (a.crestsByPeriod[lastPeriod] || 0)
    );

    const labels   = periods;
    const colors   = memberColors(filtered.length);
    const datasets = filtered.map((m, i) => {
        const isMe  = m.id === meId;
        const muted = allSelected && !isMe;
        const color = colors[i];
        return {
            label:           m.name,
            data:            periods.map(p => m.crestsByPeriod[p] ?? null),
            borderColor:     muted ? muteHsl(color, 0.9) : color,
            backgroundColor: muted ? muteHsl(color, 0.9) : color,
            borderWidth:     muted ? 1 : isMe ? 2.5 : 2,
            pointRadius:     muted ? 0 : 2,
            spanGaps:        true,
            tension:         0.2,
        };
    });

    if (chart) {
        chart.data.labels   = labels;
        chart.data.datasets = datasets;
        chart.options.plugins.legend.display = filtered.length <= 5;
        chart.update();
        return;
    }

    chart = new Chart(document.getElementById('chart-guildduel'), {
        type: 'line',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend:  { display: filtered.length <= 5, labels: { color: getCSSVar('--color-base-content'), font: { size: 11 }, boxWidth: 12, boxHeight: 12 } },
                tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y ?? 0}` } },
            },
            scales: {
                x: { grid: { color: getCSSVar('--color-base-content') }, ticks: { color: getCSSVar('--color-base-content') } },
                y: {
                    grid:  { color: getCSSVar('--color-base-content') },
                    ticks: { color: getCSSVar('--color-base-content') },
                    title: { display: true, text: 'Crests', color: getCSSVar('--color-base-content') },
                },
            },
        },
    });
    chart._recolor = renderChart;
}

function renderLists() {
    const { periods, memberMap, absentByPeriod } = state;
    const wbSel  = document.getElementById('gd-warband-filter').value;
    const period = document.getElementById('gd-period-select').value;

    let members = [...memberMap.values()];
    if (wbSel) members = members.filter(m => m.warbandName === wbSel);

    let hadRows, noRows;

    if (period === 'all') {
        hadRows = members
            .map(m => ({ m, total: Object.values(m.crestsByPeriod).reduce((a, b) => a + b, 0), count: Object.keys(m.crestsByPeriod).length }))
            .filter(r => r.count > 0)
            .sort((a, b) => b.total - a.total);
        noRows = members
            .filter(m => Object.keys(m.crestsByPeriod).length === 0)
            .sort((a, b) => a.name.localeCompare(b.name));
    } else {
        const absentIds = absentByPeriod.get(period) || new Set();
        hadRows = members
            .filter(m => m.crestsByPeriod[period] !== undefined)
            .map(m => ({ m, total: m.crestsByPeriod[period], count: 1 }))
            .sort((a, b) => b.total - a.total);
        noRows = members
            .filter(m => absentIds.has(m.id))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    document.getElementById('gd-had-crests').innerHTML = renderHadTable(hadRows, period);
    document.getElementById('gd-no-crests').innerHTML  = renderNoTable(noRows);
}

function renderHadTable(rows, period) {
    if (!rows.length) return '<div class="empty-state">No data for this filter.</div>';
    const label = period === 'all' ? 'Total Crests' : 'Crests';
    let html = `<table class="data-table"><thead><tr><th>Member</th><th>Warband</th><th>${label}</th></tr></thead><tbody>`;
    for (const { m, total } of rows) {
        const isMe = m.id === meId;
        html += `<tr${isMe ? ' class="me"' : ''}>
            <td data-label="Member">${escHtml(m.name)}</td>
            <td data-label="Warband"><span class="warband-tag">${escHtml(m.warbandName)}</span></td>
            <td data-label="${label}"><strong>${total}</strong></td>
        </tr>`;
    }
    html += '</tbody></table>';
    return html;
}

function renderNoTable(rows) {
    if (!rows.length) return '<div class="empty-state">Everyone had crests.</div>';
    let html = '<table class="data-table"><thead><tr><th>Member</th><th>Warband</th></tr></thead><tbody>';
    for (const m of rows) {
        const isMe = m.id === meId;
        html += `<tr${isMe ? ' class="me"' : ''}>
            <td data-label="Member">${escHtml(m.name)}</td>
            <td data-label="Warband"><span class="warband-tag">${escHtml(m.warbandName)}</span></td>
        </tr>`;
    }
    html += '</tbody></table>';
    return html;
}

function memberColors(n) {
    return Array.from({ length: n }, (_, i) =>
        `hsl(${Math.round((i * 360) / Math.max(n, 1))}, 65%, 60%)`
    );
}

function muteHsl(hsl, alpha) {
    return hsl.replace('hsl(', 'hsla(').replace(')', `, ${alpha})`);
}

function buildMemberDropdown(container, members, me) {
    const wrap = document.createElement('div');
    wrap.className = 'member-dropdown';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'member-dropdown-btn';

    const menu = document.createElement('div');
    menu.className = 'member-dropdown-menu hidden';

    const allItem  = makeCheckItem('gd-mb-all', 'All members', allSelected);
    const allCheck = allItem.querySelector('input');
    menu.appendChild(allItem);

    const divider = document.createElement('hr');
    menu.appendChild(divider);

    const sorted = [...members.values()].sort((a, b) => {
        if (a.id === meId) return -1;
        if (b.id === meId) return 1;
        return a.name.localeCompare(b.name);
    });

    const grid = document.createElement('div');
    grid.className = 'member-grid';
    for (const m of sorted) {
        const label = m.id === meId ? m.name + ' (you)' : m.name;
        const item  = makeCheckItem(`gd-mb-${m.id}`, label, selectedIds.has(m.id));
        if (m.id === meId) item.classList.add('me-item');
        const check = item.querySelector('input');
        check.dataset.memberId = m.id;
        grid.appendChild(item);
    }
    menu.appendChild(grid);

    btn.addEventListener('click', e => {
        e.stopPropagation();
        menu.classList.toggle('hidden');
    });
    document.addEventListener('click', () => menu.classList.add('hidden'), { passive: true });
    menu.addEventListener('click', e => e.stopPropagation());

    allCheck.addEventListener('change', () => {
        if (allCheck.checked) {
            allSelected = true;
            selectedIds.clear();
            menu.querySelectorAll('input[data-member-id]').forEach(c => { c.checked = false; });
        } else {
            if (selectedIds.size === 0) { allCheck.checked = true; return; }
            allSelected = false;
        }
        syncBtn();
        renderChart();
    });

    menu.querySelectorAll('input[data-member-id]').forEach(check => {
        check.addEventListener('change', () => {
            const id = parseInt(check.dataset.memberId);
            if (check.checked) {
                selectedIds.add(id);
                allCheck.checked = false;
                allSelected = false;
            } else {
                selectedIds.delete(id);
                if (selectedIds.size === 0) {
                    allCheck.checked = true;
                    allSelected = true;
                }
            }
            syncBtn();
            renderChart();
        });
    });

    function syncBtn() {
        if (allSelected) {
            btn.textContent = 'All members ▾';
        } else if (selectedIds.size === 1) {
            const m = members.get([...selectedIds][0]);
            btn.textContent = (m?.name ?? '?') + ' ▾';
        } else {
            const names = [...selectedIds].map(id => members.get(id)?.name).filter(Boolean);
            btn.textContent = `${names[0]} +${names.length - 1} ▾`;
        }
    }

    wrap.appendChild(btn);
    wrap.appendChild(menu);
    container.appendChild(wrap);
    syncBtn();
}

function makeCheckItem(id, label, checked) {
    const el     = document.createElement('label');
    el.className = 'member-check-item';
    el.htmlFor   = id;
    const check  = document.createElement('input');
    check.type   = 'checkbox';
    check.id     = id;
    check.checked = checked;
    const span = document.createElement('span');
    span.textContent = label;
    el.appendChild(check);
    el.appendChild(span);
    return el;
}
