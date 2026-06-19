import { Chart, registerables } from 'chart.js';
Chart.register(...registerables);

let chart  = null;
let state  = null;
let meId   = null;
let selectedIds = new Set();
let allSelected = true;

export async function initPowerChart(me) {
    const res  = await fetch('/api/power-history');
    const data = await res.json();

    meId = me?.memberId ?? null;

    const members = new Map();
    for (const row of data.rows) {
        if (!members.has(row.member_id)) {
            members.set(row.member_id, {
                id:          row.member_id,
                name:        row.ingame_name,
                warbandId:   row.warband_id,
                warbandName: row.warband_name,
                snapMap:     {},
            });
        }
        members.get(row.member_id).snapMap[row.snapshot_id] = row.combat_power_value;
    }

    state = { snapshots: data.snapshots, members };

    // Default: pre-select current user
    if (meId && members.has(meId)) {
        selectedIds = new Set([meId]);
        allSelected = false;
    } else {
        selectedIds = new Set();
        allSelected = true;
    }

    // Warband dropdown
    const wbFilter = document.getElementById('power-warband');
    const warbands = [...new Set([...members.values()].map(m => m.warbandName || 'Unassigned'))].sort();
    for (const wb of warbands) {
        const opt = document.createElement('option');
        opt.value = wb; opt.textContent = wb;
        wbFilter.appendChild(opt);
    }
    wbFilter.addEventListener('change', render);

    // Member checkbox dropdown
    buildDropdown(document.getElementById('power-member-wrap'), members, me);

    render();
}

function buildDropdown(container, members, me) {
    const wrap = document.createElement('div');
    wrap.className = 'member-dropdown';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'member-dropdown-btn';

    const menu = document.createElement('div');
    menu.className = 'member-dropdown-menu hidden';

    // "All members" row
    const allItem  = makeCheckItem('mb-all', 'All members', allSelected);
    const allCheck = allItem.querySelector('input');
    menu.appendChild(allItem);

    const divider = document.createElement('hr');
    menu.appendChild(divider);

    // Current user pinned at top
    const sorted = [...members.values()].sort((a, b) => {
        if (a.id === meId) return -1;
        if (b.id === meId) return 1;
        return a.name.localeCompare(b.name);
    });

    const grid = document.createElement('div');
    grid.className = 'member-grid';
    for (const m of sorted) {
        const label = m.id === meId ? m.name + ' (you)' : m.name;
        const item  = makeCheckItem(`mb-${m.id}`, label, selectedIds.has(m.id));
        if (m.id === meId) item.classList.add('me-item');
        const check = item.querySelector('input');
        check.dataset.memberId = m.id;
        grid.appendChild(item);
    }
    menu.appendChild(grid);

    // Open / close
    btn.addEventListener('click', e => {
        e.stopPropagation();
        menu.classList.toggle('hidden');
    });
    document.addEventListener('click', () => menu.classList.add('hidden'), { passive: true });
    menu.addEventListener('click', e => e.stopPropagation());

    // "All members" toggle
    allCheck.addEventListener('change', () => {
        if (allCheck.checked) {
            allSelected = true;
            selectedIds.clear();
            menu.querySelectorAll('input[data-member-id]').forEach(c => { c.checked = false; });
        } else {
            // Don't allow unchecking All with nothing selected
            if (selectedIds.size === 0) { allCheck.checked = true; return; }
            allSelected = false;
        }
        syncBtn();
        render();
    });

    // Individual member toggles
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
            render();
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
    const el    = document.createElement('label');
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

function render() {
    const { snapshots, members } = state;
    const wbSel = document.getElementById('power-warband').value;

    let filtered = [...members.values()];

    if (!allSelected && selectedIds.size > 0) {
        // Specific members selected — show only those
        filtered = filtered.filter(m => selectedIds.has(m.id));
    } else if (wbSel) {
        // "All" mode with warband filter
        filtered = filtered.filter(m => (m.warbandName || 'Unassigned') === wbSel);
    }

    filtered.sort((a, b) => {
        const lastSnap = snapshots[snapshots.length - 1]?.id;
        return (b.snapMap[lastSnap] || 0) - (a.snapMap[lastSnap] || 0);
    });

    const labels   = snapshots.map(s => s.scraped_at.slice(0, 10));
    const colors   = memberColors(filtered.length);
    const datasets = filtered.map((m, i) => {
        // In "All" mode: user's line is bold, others are muted; in select mode all equal
        const isMe  = m.id === meId;
        const muted = allSelected && !isMe;
        const color = colors[i];
        const borderColor = muted ? muteHsl(color, 0.9) : color;
        return {
            label:           m.name,
            data:            snapshots.map(s => m.snapMap[s.id] ? m.snapMap[s.id] / 1e6 : null),
            borderColor,
            backgroundColor: borderColor,
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

    chart = new Chart(document.getElementById('chart-power'), {
        type: 'line',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: filtered.length <= 5, labels: { color: '#8b92b8', font: { size: 11 }, boxWidth: 12, boxHeight: 12 } },
                tooltip: {
                    callbacks: {
                        label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y?.toFixed(1)}M`,
                    },
                },
            },
            scales: {
                x: { grid: { color: 'rgba(45,48,85,.6)' }, ticks: { color: '#8b92b8' } },
                y: {
                    grid:  { color: 'rgba(45,48,85,.6)' },
                    ticks: { color: '#8b92b8', callback: v => v + 'M' },
                    title: { display: true, text: 'Power (M)', color: '#8b92b8' },
                },
            },
        },
    });
}

function memberColors(n) {
    return Array.from({ length: n }, (_, i) =>
        `hsl(${Math.round((i * 360) / Math.max(n, 1))}, 65%, 60%)`
    );
}

function muteHsl(hsl, alpha) {
    // "hsl(H, S%, L%)" → "hsla(H, S%, L%, alpha)"
    return hsl.replace('hsl(', 'hsla(').replace(')', `, ${alpha})`);
}
