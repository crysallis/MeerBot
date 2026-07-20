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

    renderAll();
}

function renderAll() {
    // filled in by Task 3
}
