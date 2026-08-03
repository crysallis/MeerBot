# Activeness Chart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Activeness" tab to the RiffRaff stats site that graphs each active member's raw `activeness` score (0-1600ish) over time, one line per member, mirroring the existing Power Growth tab almost exactly, plus a fixed reference line at y=500 marking the known "bad" threshold.

**Architecture:** One new read-only API endpoint (`GET /api/activeness-history`) that mirrors the existing `/api/power-history` query shape exactly, swapping `combat_power_value` for `activeness`. One new frontend chart module (`stats/src/charts/activeness.js`) cloned from `power.js`'s structure (warband filter, multi-select member dropdown, "me" pinned/preselected, muting in All-mode) with two differences: no /1e6 y-axis scaling (activeness is graphed at raw point value), and an extra flat dashed dataset drawn at y=500 across all snapshot labels to visually flag the "bad" threshold. Wired into `index.html` as a new tab and into `main.js`'s existing lazy-tab-init pattern.

**Tech Stack:** Express + better-sqlite3 (backend), Chart.js v4 via `chart.js` npm package (frontend, no new dependencies), Vite build.

## Global Constraints

- No new npm dependencies — the y=500 threshold line is drawn as a plain Chart.js dataset, not via `chartjs-plugin-annotation` (not installed, per project's minimal-dependency convention).
- Filter to `members.active = 1 AND pending = 0` — same "only active members" filter as `/api/power-history`, no additional AFK exclusion.
- No test framework exists in this repo (deferred per project memory) — verification steps below are manual: `node --check` for syntax, `npm run build` (Vite) for the frontend module, direct SQL checks via the `mcp__sqlite__read_query` MCP tool for data shape, and a browser smoke test for the finished tab.
- Follow existing code style exactly: 4-space indent in `server.js`, 2-space indent in `stats/src/*.js` (confirm against neighboring code in each file before writing).

---

### Task 1: Backend — `GET /api/activeness-history` endpoint

**Files:**
- Modify: `stats/server.js` (add new route directly after the existing `/api/power-history` route, which ends at line 108)

**Interfaces:**
- Produces: `GET /api/activeness-history` → `{ snapshots: [{id, scraped_at}], rows: [{member_id, ingame_name, warband_id, warband_name, snapshot_id, activeness}] }` — same response shape as `/api/power-history` (`stats/server.js:90-108`), field `combat_power_value` renamed to `activeness`.

- [ ] **Step 1: Confirm the existing `/api/power-history` route shape**

Read `stats/server.js:90-108` if not already in context. It is:

```js
// GET /api/power-history — all snapshots with per-member power values
app.get('/api/power-history', (req, res) => {
    try {
        const snapshots = db.prepare('SELECT id, scraped_at FROM snapshots ORDER BY scraped_at').all();
        const rows = db.prepare(`
            SELECT m.id as member_id, m.ingame_name, m.warband_id, w.name as warband_name,
                   ms.snapshot_id, ms.combat_power_value
            FROM members m
            LEFT JOIN warbands w ON w.id = m.warband_id
            JOIN member_snapshots ms ON ms.member_id = m.id
            WHERE m.active = 1 AND m.pending = 0
            ORDER BY m.ingame_name, ms.snapshot_id
        `).all();
        res.json({ snapshots, rows });
    } catch (err) {
        console.error('[stats] /api/power-history error:', err);
        res.status(500).json({ error: 'Database error' });
    }
});
```

- [ ] **Step 2: Add the new route immediately after it**

Insert directly after the closing `});` of `/api/power-history` (after line 108):

```js

// GET /api/activeness-history — all snapshots with per-member activeness scores
app.get('/api/activeness-history', (req, res) => {
    try {
        const snapshots = db.prepare('SELECT id, scraped_at FROM snapshots ORDER BY scraped_at').all();
        const rows = db.prepare(`
            SELECT m.id as member_id, m.ingame_name, m.warband_id, w.name as warband_name,
                   ms.snapshot_id, ms.activeness
            FROM members m
            LEFT JOIN warbands w ON w.id = m.warband_id
            JOIN member_snapshots ms ON ms.member_id = m.id
            WHERE m.active = 1 AND m.pending = 0
            ORDER BY m.ingame_name, ms.snapshot_id
        `).all();
        res.json({ snapshots, rows });
    } catch (err) {
        console.error('[stats] /api/activeness-history error:', err);
        res.status(500).json({ error: 'Database error' });
    }
});
```

- [ ] **Step 3: Syntax-check the file**

Run: `node --check stats/server.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Verify the query against the live DB**

Use the `mcp__sqlite__read_query` MCP tool (already connected to `guild.db`) to run:

```sql
SELECT m.id as member_id, m.ingame_name, m.warband_id, w.name as warband_name,
       ms.snapshot_id, ms.activeness
FROM members m
LEFT JOIN warbands w ON w.id = m.warband_id
JOIN member_snapshots ms ON ms.member_id = m.id
WHERE m.active = 1 AND m.pending = 0
ORDER BY m.ingame_name, ms.snapshot_id
LIMIT 10
```

Expected: 10 rows returned, each with a non-null `member_id`, `ingame_name`, `snapshot_id`, and `activeness` (0-1600ish range, may be 0 for early import-only snapshots — that's expected per the miner's historical-import behavior).

- [ ] **Step 5: Start the stats server and hit the endpoint directly**

Run (from `stats/` directory, adjust if there's an existing npm script): `node server.js &` then `curl -s http://localhost:<STATS_PORT>/api/activeness-history | head -c 500` (check `stats/server.js` top or `.env` for the actual port env var/default if not obvious). If the route is behind `auth.requireMember` middleware (it is — confirmed by `app.use('/api', auth.requireMember)` at `stats/server.js:55`, applied before route registration), an unauthenticated curl will get a 401/redirect — that's expected and fine, it confirms the route is registered and gated correctly. Stop the server after (`kill %1` or equivalent) — do not leave a stray dev server running.
Expected: some JSON or auth-rejection response, not a 404 (a 404 would mean the route wasn't registered) and not a 500 (which would mean the SQL is broken).

- [ ] **Step 6: Commit**

```bash
git add stats/server.js
git commit -m "feat(stats): add /api/activeness-history endpoint"
```

---

### Task 2: Frontend — `activeness.js` chart module

**Files:**
- Create: `stats/src/charts/activeness.js`
- Reference (read-only, do not modify): `stats/src/charts/power.js`, `stats/src/utils.js`

**Interfaces:**
- Consumes: `getCSSVar`, `cssVarRgba` from `stats/src/utils.js` (same imports as `power.js:2`); `GET /api/activeness-history` from Task 1.
- Produces: `export async function initActivenessChart(me)` — same signature as `initPowerChart(me)` in `power.js:11`, called by `main.js` in Task 3.

- [ ] **Step 1: Create the file by adapting `power.js` structure**

`power.js` (full content already read — see file for the baseline) implements: module-level state (`chart`, `state`, `meId`, `selectedIds`, `allSelected`), `initPowerChart(me)` which fetches history, builds per-member snapshot maps, wires the warband `<select>` and member checkbox dropdown, then calls `render()`; `buildDropdown(...)`, `makeCheckItem(...)`, `render()`, `memberColors(n)`, `muteHsl(hsl, alpha)` as supporting functions.

Write `stats/src/charts/activeness.js` with this exact content — structurally identical to `power.js` except: (a) fetch URL and field name changed from power to activeness, (b) no `/1e6` scaling on chart data or tooltip, (c) y-axis label changed, (d) an extra flat threshold dataset added at render time, excluded from the legend and from member-count-based legend-hiding logic:

```js
import { Chart, registerables } from 'chart.js';
import { getCSSVar, cssVarRgba } from '../utils.js';
Chart.register(...registerables);

const BAD_THRESHOLD = 500;

let chart  = null;
let state  = null;
let meId   = null;
let selectedIds = new Set();
let allSelected = true;

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
    const wbSel = document.getElementById('activeness-warband').value;

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

    if (chart) {
        chart.data.labels   = labels;
        chart.data.datasets = datasets;
        chart.options.plugins.legend.display = filtered.length <= 5;
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
                    display: filtered.length <= 5,
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

function memberColors(n) {
    return Array.from({ length: n }, (_, i) =>
        `hsl(${Math.round((i * 360) / Math.max(n, 1))}, 65%, 60%)`
    );
}

function muteHsl(hsl, alpha) {
    // "hsl(H, S%, L%)" → "hsla(H, S%, L%, alpha)"
    return hsl.replace('hsl(', 'hsla(').replace(')', `, ${alpha})`);
}
```

Note on the threshold-line tooltip: since it's a real dataset, hovering near y=500 will show a "Low activeness threshold: 500" tooltip row alongside member rows at that index — this is expected and useful (confirms which members are below it at that snapshot), not a bug to fix.

- [ ] **Step 2: Syntax-check via Vite build**

This file uses ES module `import`/`export` syntax that plain `node --check` won't handle. Instead run the project's Vite build, which will fail loudly on any syntax error in the new file:

Run: `npm run build --prefix stats` (or `cd stats && npm run build`, matching whichever the project's existing build docs use — check `stats/package.json` scripts if unsure)
Expected: build succeeds with no errors mentioning `activeness.js`. (It's fine that `index.html`/`main.js` don't reference it yet — Vite will still bundle any file that's part of the module graph once Task 3 wires the import in; if Task 2 is built standalone before Task 3's import exists, this step may report the file as unused/unreferenced rather than erroring — that's acceptable, the real syntax check happens again in Task 3's build step once it's imported.)

- [ ] **Step 3: Commit**

```bash
git add stats/src/charts/activeness.js
git commit -m "feat(stats): add activeness chart module"
```

---

### Task 3: Wire up the new tab in `index.html` and `main.js`

**Files:**
- Modify: `stats/src/index.html` (add tab button + new `<section>`, right after the existing Power Growth section)
- Modify: `stats/src/main.js` (import + lazy-init wiring)

**Interfaces:**
- Consumes: `initActivenessChart(me)` from Task 2.

- [ ] **Step 1: Add the tab button**

In `stats/src/index.html`, find the tabs block (currently lines 40-49):

```html
    <div class="tabs" id="tabs">
      <button class="tab active" data-tab="overview">Overview</button>
      <button class="tab" data-tab="power">Power Growth</button>
      <button class="tab" data-tab="dreamrealm">Dream Realm</button>
      ...
```

Add a new button immediately after the Power Growth button:

```html
    <div class="tabs" id="tabs">
      <button class="tab active" data-tab="overview">Overview</button>
      <button class="tab" data-tab="power">Power Growth</button>
      <button class="tab" data-tab="activeness">Activeness</button>
      <button class="tab" data-tab="dreamrealm">Dream Realm</button>
      ...
```

- [ ] **Step 2: Add the new section**

Find the Power Growth section (currently lines 66-83):

```html
    <!-- Power Growth -->
    <section id="tab-power" class="tab-content hidden">
      <div class="controls">
        <label>
          Warband
          <select id="power-warband">
            <option value="">All Warbands</option>
          </select>
        </label>
        <label>
          Members
          <div id="power-member-wrap"></div>
        </label>
      </div>
      <div class="chart-box full">
        <canvas id="chart-power"></canvas>
      </div>
    </section>
```

Add a new section immediately after its closing `</section>`, using the `ac-` / `activeness-` id prefixes to match `activeness.js`'s `getElementById` calls exactly:

```html

    <!-- Activeness -->
    <section id="tab-activeness" class="tab-content hidden">
      <div class="controls">
        <label>
          Warband
          <select id="activeness-warband">
            <option value="">All Warbands</option>
          </select>
        </label>
        <label>
          Members
          <div id="activeness-member-wrap"></div>
        </label>
      </div>
      <div class="chart-box full">
        <canvas id="chart-activeness"></canvas>
      </div>
    </section>
```

- [ ] **Step 3: Wire the import and init call in `main.js`**

In `stats/src/main.js`, add the import next to the existing `initPowerChart` import (line 6):

```js
import { initPowerChart } from './charts/power.js';
import { initActivenessChart } from './charts/activeness.js';
```

Add the init call in `activateTab` next to the existing power line (currently line 129):

```js
        if (name === 'power')      await initPowerChart(me);
        if (name === 'activeness') await initActivenessChart(me);
```

- [ ] **Step 4: Build and verify no errors**

Run: `npm run build --prefix stats` (or the equivalent from within `stats/`)
Expected: build succeeds, output mentions the new `activeness.js` module being bundled, no errors.

- [ ] **Step 5: Manual browser smoke test**

Start the stats server per its normal dev process (check `stats/package.json` or existing docs for the dev script — likely `npm run dev --prefix stats` or similar; if PM2-managed in production, use the dev flow locally instead of restarting the live PM2 process for this check). Log in, click the new "Activeness" tab, and confirm:
- The tab renders without a console error (check browser devtools console)
- A line chart appears with at least one line (your own, if you're a tracked member) plus a dashed line at y=500
- The Warband dropdown and Members dropdown both populate and filtering works (select a different warband, select "All members", select an individual member)
- Hovering the chart shows a tooltip with raw activeness numbers (not decimals/M-suffixed like the power chart)
- Switching to the Power Growth tab and back to Activeness doesn't duplicate the chart or break rendering (tests the lazy-init-once guard in `main.js`'s `initialized` map)

Stop the dev server when done.

- [ ] **Step 6: Commit**

```bash
git add stats/src/index.html stats/src/main.js
git commit -m "feat(stats): wire up Activeness tab"
```

---

### Task 4: Update project documentation

**Files:**
- Modify: `CLAUDE.md` (project root) — per the project's standing "docs sync on every commit" convention

**Interfaces:** None (documentation only).

- [ ] **Step 1: Confirm `CLAUDE.md` has no stats-site file/endpoint table to update**

`CLAUDE.md`'s "Key Files" table documents the bot and admin panel in detail (e.g. `admin/src/jobs.js`, `admin/server.js` rows) but has no equivalent per-file breakdown for `stats/src/*` — the stats site isn't itemized at that granularity anywhere in the file as of this plan's writing. Grep `CLAUDE.md` for `stats/src` to confirm this is still the case when this task runs. If confirmed, no edit is needed and this task is a no-op — skip Step 2. If a stats-site table has since been added, add one row for `stats/src/charts/activeness.js` (purpose: "Activeness chart, mirrors power.js") and one for the `/api/activeness-history` endpoint, matching that table's existing column format exactly.

- [ ] **Step 2: Commit (only if Step 1 found a table to update)**

```bash
git add CLAUDE.md
git commit -m "docs: note Activeness tab in CLAUDE.md"
```

---

## Verification Summary (end-to-end)

After all 4 tasks are complete:
1. `node --check stats/server.js` passes.
2. `npm run build --prefix stats` succeeds with no errors.
3. Browser smoke test (Task 3 Step 5) passes all listed checks.
4. `mcp__sqlite__read_query` confirms `/api/activeness-history`'s underlying query returns real `activeness` values in the expected 0-1600ish range for active, non-pending members.
