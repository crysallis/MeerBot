import { Chart, registerables } from 'chart.js';
import { getCSSVar, cssVarRgba } from '../utils.js';
Chart.register(...registerables);

const BAD_THRESHOLD = 500;

let chart  = null;
let state  = null;
let meId   = null;
let selectedIds = new Set();
let allSelected = true;
let viewMode    = 'all'; // 'all' | 'top10' | 'bottom10' | 'custom' -- top10/bottom10 rank by avg activeness, mutually exclusive with allSelected/selectedIds

export async function initActivenessChart(me) {
    const res  = await fetch('/api/activeness-history');
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
        members.get(row.member_id).snapMap[row.snapshot_id] = row.activeness;
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
    const wbFilter = document.getElementById('activeness-warband');
    const warbands = [...new Set([...members.values()].map(m => m.warbandName || 'Unassigned'))].sort();
    for (const wb of warbands) {
        const opt = document.createElement('option');
        opt.value = wb; opt.textContent = wb;
        wbFilter.appendChild(opt);
    }
    wbFilter.addEventListener('change', render);

    // Member checkbox dropdown
    buildDropdown(document.getElementById('activeness-member-wrap'), members, me);

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

    // "Top 10" / "Bottom 10" rows -- ranked by avg activeness over the visible
    // period, mutually exclusive with All and with individual member picks.
    // Listed first per explicit request.
    const top10Item    = makeCheckItem('ac-top10', 'Top 10 (by avg activeness)', viewMode === 'top10');
    const top10Check    = top10Item.querySelector('input');
    const bottom10Item = makeCheckItem('ac-bottom10', 'Bottom 10 (by avg activeness)', viewMode === 'bottom10');
    const bottom10Check = bottom10Item.querySelector('input');
    menu.appendChild(top10Item);
    menu.appendChild(bottom10Item);

    // "All members" row
    const allItem  = makeCheckItem('ac-all', 'All members', allSelected);
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
        const item  = makeCheckItem(`ac-${m.id}`, label, selectedIds.has(m.id));
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

    // Clears every other mode's checked state -- called before entering any
    // single mode so exactly one of All/Top10/Bottom10/individual is active.
    function clearOtherModes(except) {
        if (except !== 'all')      allCheck.checked = false;
        if (except !== 'top10')    top10Check.checked = false;
        if (except !== 'bottom10') bottom10Check.checked = false;
        if (except !== 'custom')   menu.querySelectorAll('input[data-member-id]').forEach(c => { c.checked = false; });
    }

    // "All members" toggle
    allCheck.addEventListener('change', () => {
        if (allCheck.checked) {
            viewMode = 'all';
            allSelected = true;
            selectedIds.clear();
            clearOtherModes('all');
        } else {
            // Don't allow unchecking All with nothing else selected
            allCheck.checked = true;
            return;
        }
        syncBtn();
        render();
    });

    // "Top 10" / "Bottom 10" toggles
    top10Check.addEventListener('change', () => {
        if (top10Check.checked) {
            viewMode = 'top10';
            allSelected = false;
            selectedIds.clear();
            clearOtherModes('top10');
        } else {
            top10Check.checked = true;
            return;
        }
        syncBtn();
        render();
    });
    bottom10Check.addEventListener('change', () => {
        if (bottom10Check.checked) {
            viewMode = 'bottom10';
            allSelected = false;
            selectedIds.clear();
            clearOtherModes('bottom10');
        } else {
            bottom10Check.checked = true;
            return;
        }
        syncBtn();
        render();
    });

    // Individual member toggles
    menu.querySelectorAll('input[data-member-id]').forEach(check => {
        check.addEventListener('change', () => {
            const id = parseInt(check.dataset.memberId);
            if (check.checked) {
                viewMode = 'custom';
                selectedIds.add(id);
                allSelected = false;
                allCheck.checked = false;
                top10Check.checked = false;
                bottom10Check.checked = false;
            } else {
                selectedIds.delete(id);
                if (selectedIds.size === 0) {
                    viewMode = 'all';
                    allCheck.checked = true;
                    allSelected = true;
                }
            }
            syncBtn();
            render();
        });
    });

    function syncBtn() {
        if (viewMode === 'top10') {
            btn.textContent = 'Top 10 (avg) ▾';
        } else if (viewMode === 'bottom10') {
            btn.textContent = 'Bottom 10 (avg) ▾';
        } else if (allSelected) {
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
    const wbSel = document.getElementById('activeness-warband').value;

    let filtered = [...members.values()];

    if (viewMode === 'top10' || viewMode === 'bottom10') {
        // Warband scoping applies first when selected -- Top 10/Bottom 10
        // then ranks within that scope, not across the whole guild.
        if (wbSel) {
            filtered = filtered.filter(m => (m.warbandName || 'Unassigned') === wbSel);
        }
        // Ranked by avg activeness over the visible period -- this only
        // decides WHO is shown and their order; the lines plotted below are
        // still each member's raw per-snapshot values, unaveraged.
        const ranked = filtered
            .map(m => ({ m, avg: avgActiveness(m, snapshots) }))
            .filter(r => r.avg != null)
            .sort((a, b) => viewMode === 'top10' ? b.avg - a.avg : a.avg - b.avg);
        filtered = ranked.slice(0, 10).map(r => r.m);
    } else if (!allSelected && selectedIds.size > 0) {
        // Specific members selected — show only those
        filtered = filtered.filter(m => selectedIds.has(m.id));
    } else if (wbSel) {
        // "All" mode with warband filter
        filtered = filtered.filter(m => (m.warbandName || 'Unassigned') === wbSel);
    }

    if (viewMode !== 'top10' && viewMode !== 'bottom10') {
        filtered.sort((a, b) => {
            const lastSnap = snapshots[snapshots.length - 1]?.id;
            return (b.snapMap[lastSnap] || 0) - (a.snapMap[lastSnap] || 0);
        });
    }
    // In top10/bottom10 mode, `filtered` is already ordered by avg activeness
    // from the ranking step above: highest-avg first for top10 (per explicit
    // request), most-concerning (lowest-avg) first for bottom10.

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
            data:            snapshots.map(s => m.snapMap[s.id] ?? null),
            borderColor,
            backgroundColor: borderColor,
            borderWidth:     muted ? 1 : isMe ? 2.5 : 2,
            pointRadius:     muted ? 0 : 2,
            spanGaps:        true,
            tension:         0.2,
        };
    });

    // Flat dashed reference line at the known "bad" threshold -- excluded
    // from the legend so it doesn't get mixed in with real member lines.
    const thresholdDataset = {
        label:           'Low activeness threshold',
        data:            labels.map(() => BAD_THRESHOLD),
        borderColor:     'rgba(220, 50, 50, 0.6)',
        borderWidth:     1.5,
        borderDash:      [6, 4],
        pointRadius:     0,
        spanGaps:        true,
        tension:         0,
        fill:            false,
    };
    datasets.push(thresholdDataset);

    // Top 10 / Bottom 10 always produce 10 named lines -- always show the
    // legend there so each line is identifiable, unlike the plain <=5 cutoff
    // used for the unbounded All-members/warband view.
    const showLegend = viewMode === 'top10' || viewMode === 'bottom10' || filtered.length <= 5;

    if (chart) {
        chart.data.labels   = labels;
        chart.data.datasets = datasets;
        chart.options.plugins.legend.display = showLegend;
        chart.update();
        return;
    }

    chart = new Chart(document.getElementById('chart-activeness'), {
        type: 'line',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: {
                    display: showLegend,
                    labels: {
                        color: getCSSVar('--color-base-content'), font: { size: 11 }, boxWidth: 12, boxHeight: 12,
                        filter: item => item.text !== 'Low activeness threshold',
                    },
                },
                tooltip: {
                    callbacks: {
                        label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y}`,
                    },
                },
            },
            scales: {
                x: { grid: { color: getCSSVar('--color-base-content') }, ticks: { color: getCSSVar('--color-base-content') } },
                y: {
                    min: 0,
                    grid:  { color: getCSSVar('--color-base-content') },
                    ticks: { color: getCSSVar('--color-base-content') },
                    title: { display: true, text: 'Activeness', color: getCSSVar('--color-base-content') },
                },
            },
        },
    });
}

// Average of a member's real (non-null) snapshot readings over the currently
// visible period -- used only to rank/select Top 10 / Bottom 10, never to
// plot (the chart itself always draws raw per-snapshot values).
function avgActiveness(member, snapshots) {
    const values = snapshots.map(s => member.snapMap[s.id]).filter(v => v != null);
    if (!values.length) return null;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
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
