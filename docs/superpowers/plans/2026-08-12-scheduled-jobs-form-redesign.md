# Scheduled Jobs Form Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the misleading UTC-only "will fire" hint in the admin panel's Scheduled Jobs form with a live plain-language sentence that reflects the actual recurrence rule, reorder fields so the rule is established before the starting date, and split the starting date so a monthly day-of-month rule can never be contradicted by a mismatched typed date.

**Architecture:** Extract the day-resolution clamp logic from `computeMonthlyNext` into a new zero-dependency shared module (`utils/monthlyRecurrence.js`), importable by both the backend (`utils/jobScheduler.js`, `admin/server.js`) and the admin Vite frontend bundle (with a `commonjsOptions.include` fix required for the latter to actually work). The frontend then uses this shared logic plus `Date.UTC(...)`-based composition (never locale-string `Date` parsing) to build an always-consistent "starting" date and a live sentence describing the schedule, replacing two old UI elements (the UTC hint, and the post-save "Current next fire" line).

**Tech Stack:** Node.js (CommonJS), Vite 6 + Rollup (ESM bundle), `node:test` + `assert/strict`, vanilla JS/DOM (no framework).

## Global Constraints

- No backend recurrence semantics change. `fire_at`, `recurrence`, `day_of_month`, `last_day_offset` payload shapes to `PUT /api/scheduled-jobs/:id` and `POST /api/text-jobs` are unchanged.
- The day-of-month rule is UTC-anchored, matching existing `computeMonthlyNext` behavior. All "starting" date composition on the frontend must go through `Date.UTC(...)` — never `new Date(localDateTimeString)` or `new Date(dateString)`, since local-string parsing can silently cross a UTC month/day boundary (verified: `new Date('2026-08-31T20:00:00')` on UTC-4 produces `2026-09-01T00:00:00.000Z`).
- `utils/monthlyRecurrence.js` must have **zero `require`s** — pure `Date` math only, so it can be bundled into the browser frontend without pulling in Node-only dependencies.
- The extraction target is `resolveDayOfMonth` (the day-clamp logic inside `computeMonthlyNext`'s `build(m)` inner function), **not** `computeMonthlyNext` itself — that function's catch-up-loop (`while (next <= nowMs)`) doesn't apply at job-creation time, when there's no existing `fire_at` to advance from.
- `admin/vite.config.mjs` needs `commonjsOptions.include` to add a pattern matching the new shared file, or the frontend's named import of it will silently resolve to `undefined` at runtime with no build error (verified empirically — see `docs/superpowers/specs/2026-08-12-scheduled-jobs-form-redesign-design.md`, "Shared Module Extraction" section, for the exact verification method).
- Monthly "Starting" has no day or year picker — day is derived from the day-of-month rule, year is inferred (roll to next year if the computed date is in the past relative to now, current year otherwise).
- Live sentence shows only the next occurrence, never a multi-occurrence list (explicitly declined in design).
- Field order (both per-job card and create-job form, unified): Job Name → Posts To → Repeat every → (monthly only) Day of month + On/Before qualifier → Starting (Month+Time for monthly, Date+Time for daily/weekly) → live sentence → day-of-week filter (text jobs only) → Title/Body/Mentions (text jobs only).

---

### Task 1: Shared module + Vite config fix

**Files:**

- Create: `utils/monthlyRecurrence.js`
- Modify: `utils/jobScheduler.js` (use the extracted function; keep `computeMonthlyNext`'s own file/shape)
- Modify: `admin/server.js` (import `MONTHLY_LAST_DAY` from the new file instead of `utils/jobScheduler.js`)
- Modify: `admin/vite.config.mjs` (add `commonjsOptions.include`)
- Test: `utils/jobScheduler.test.js` (existing file — must still pass unchanged, verifying the refactor is behavior-preserving)

**Interfaces:**

- Consumes: nothing new.
- Produces: `utils/monthlyRecurrence.js` exports `{ resolveDayOfMonth, MONTHLY_LAST_DAY }` via `module.exports`. `resolveDayOfMonth(year, monthIndex, dayOfMonth, lastDayOffset = 0)` returns the resolved day-of-month integer for that UTC year/month under the given rule. Used by Task 2 (backend, already wired here) and Task 4 (frontend).

- [ ] **Step 1: Create the shared module**

Create `utils/monthlyRecurrence.js`:

```js
// Zero requires -- pure Date math only, so this can be bundled into the
// admin Vite frontend without pulling in any Node-only dependency.
const MONTHLY_LAST_DAY = -1;

// Given a UTC year/month and a day-of-month rule, resolves which day of
// that month the rule points to. dayOfMonth === MONTHLY_LAST_DAY means
// "the last day of the month, minus lastDayOffset days" -- clamped so the
// offset can never cross into the previous month (recomputed fresh per
// month using THAT month's own actual last day, so a stale/large offset
// saved while looking at a longer month re-clamps correctly against a
// shorter one, e.g. 28 saved in a 31-day month still clamps to 27 when
// evaluated against a 28-day February).
function resolveDayOfMonth(year, monthIndex, dayOfMonth, lastDayOffset = 0) {
    const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
    if (dayOfMonth === MONTHLY_LAST_DAY) {
        const offset = Math.min(Math.max(lastDayOffset || 0, 0), lastDay - 1);
        return lastDay - offset;
    }
    return Math.min(dayOfMonth, lastDay);
}

module.exports = { resolveDayOfMonth, MONTHLY_LAST_DAY };
```

- [ ] **Step 2: Refactor `computeMonthlyNext` to call the shared function**

In `utils/jobScheduler.js`, find:

```js
const MONTHLY_LAST_DAY = -1;

// Months aren't a fixed number of days, so monthly recurrence can't fit the
// days*ms formula below -- day_of_month is the source of truth for the day
// and is never read back off fire_at, otherwise a clamped short month would
// permanently ratchet the date down next cycle (Jan 31 -> Feb 28 -> Mar 28 ->
// ...). Clamping happens before the date is constructed, not via Date.UTC
// overflow (Date.UTC(y, 1, 31) rolls into March rather than clamping to 28).
function computeMonthlyNext(fireAtIso, count, dayOfMonth, nowMs, lastDayOffset = 0) {
    const prev = new Date(fireAtIso);
    const hh = prev.getUTCHours();
    const mm = prev.getUTCMinutes();
    const ss = prev.getUTCSeconds();
    const year = prev.getUTCFullYear();
    let month = prev.getUTCMonth();

    function build(m) {
        const lastDayOfMonth = new Date(Date.UTC(year, m + 1, 0)).getUTCDate();
        let day;
        if (dayOfMonth === MONTHLY_LAST_DAY) {
            // Clamp so "N days before" can never cross into the previous month,
            // even if a larger offset was saved while looking at a longer month
            // (e.g. 28 saved in a 31-day month, later evaluated against a 28-day
            // February) -- recomputed fresh per month, same principle as the
            // dayOfMonth clamp below.
            const offset = Math.min(Math.max(lastDayOffset || 0, 0), lastDayOfMonth - 1);
            day = lastDayOfMonth - offset;
        } else {
            day = Math.min(dayOfMonth, lastDayOfMonth);
        }
        return Date.UTC(year, m, day, hh, mm, ss);
    }

    month += count;
    let next = build(month);
    while (next <= nowMs) {
        month += count;
        next = build(month);
    }
    return new Date(next).toISOString();
}
```

Replace with:

```js
const { resolveDayOfMonth, MONTHLY_LAST_DAY } = require('./monthlyRecurrence');

// Months aren't a fixed number of days, so monthly recurrence can't fit the
// days*ms formula below -- day_of_month is the source of truth for the day
// and is never read back off fire_at, otherwise a clamped short month would
// permanently ratchet the date down next cycle (Jan 31 -> Feb 28 -> Mar 28 ->
// ...). Clamping happens before the date is constructed, not via Date.UTC
// overflow (Date.UTC(y, 1, 31) rolls into March rather than clamping to 28).
// Day-of-month resolution itself lives in monthlyRecurrence.js -- shared
// with the admin frontend's live-sentence preview, so both sides always
// agree on what a rule resolves to.
function computeMonthlyNext(fireAtIso, count, dayOfMonth, nowMs, lastDayOffset = 0) {
    const prev = new Date(fireAtIso);
    const hh = prev.getUTCHours();
    const mm = prev.getUTCMinutes();
    const ss = prev.getUTCSeconds();
    const year = prev.getUTCFullYear();
    let month = prev.getUTCMonth();

    function build(m) {
        const day = resolveDayOfMonth(year, m, dayOfMonth, lastDayOffset);
        return Date.UTC(year, m, day, hh, mm, ss);
    }

    month += count;
    let next = build(month);
    while (next <= nowMs) {
        month += count;
        next = build(month);
    }
    return new Date(next).toISOString();
}
```

Note this removes the file's own `const MONTHLY_LAST_DAY = -1;` (now imported instead) — make sure there isn't a duplicate declaration left behind.

- [ ] **Step 3: Update `utils/jobScheduler.js`'s exports**

Find:

```js
module.exports = { initJobScheduler, computeMonthlyNext, MONTHLY_LAST_DAY };
```

Replace with:

```js
module.exports = { initJobScheduler, computeMonthlyNext };
```

(`MONTHLY_LAST_DAY` is no longer re-exported from here — importers should get it from `./monthlyRecurrence` directly now. Task steps below update the one existing importer.)

- [ ] **Step 4: Update `admin/server.js`'s import**

Find:

```js
const { MONTHLY_LAST_DAY } = require('../utils/jobScheduler');
```

Replace with:

```js
const { MONTHLY_LAST_DAY } = require('../utils/monthlyRecurrence');
```

- [ ] **Step 5: Run the existing test suite to verify the refactor is behavior-preserving**

Run: `node --test utils/jobScheduler.test.js`
Expected: PASS, all 9 tests (unchanged from before this task — this test file is not modified in this task, it's the verification that `resolveDayOfMonth` extraction didn't change `computeMonthlyNext`'s observable behavior).

- [ ] **Step 6: Add the Vite `commonjsOptions.include` fix**

In `admin/vite.config.mjs`, find:

```js
    build: {
        outDir: '../dist',
        emptyOutDir: true,
    },
```

Replace with:

```js
    build: {
        outDir: '../dist',
        emptyOutDir: true,
        // utils/monthlyRecurrence.js is a plain CommonJS file imported directly
        // from admin/src/jobs.js (see Task 4) -- Vite/Rollup's CJS interop only
        // applies to node_modules by default, so a source-tree CJS import would
        // otherwise silently resolve every named export to undefined at runtime
        // (confirmed via a real build + bundle inspection, not just "doesn't
        // error" -- the naive version builds cleanly but breaks at runtime).
        commonjsOptions: { include: [/node_modules/, /monthlyRecurrence/] },
    },
```

- [ ] **Step 7: Verify the admin build still succeeds**

Run: `npm run build --prefix admin`
Expected: build succeeds, 0 errors. (Task 4 will add the actual import that exercises this config; this step just confirms the config change itself doesn't break the existing build.)

- [ ] **Step 8: Commit**

```bash
git add utils/monthlyRecurrence.js utils/jobScheduler.js admin/server.js admin/vite.config.mjs
git commit -m "refactor: extract resolveDayOfMonth into a shared zero-dependency module"
```

---

### Task 2: Backend `fire_at` composition helper (for reference by frontend, verify parity)

This task does NOT modify backend runtime behavior — it exists to write a parity test proving the frontend's UTC composition (built in Task 4) will produce results consistent with `resolveDayOfMonth`, before the frontend code depending on it is written. This catches composition bugs at the cheapest possible point (a pure function test) rather than during manual UI verification.

**Files:**

- Test: `utils/monthlyRecurrence.test.js` (new)

**Interfaces:**

- Consumes: `resolveDayOfMonth`, `MONTHLY_LAST_DAY` from `utils/monthlyRecurrence.js` (Task 1).
- Produces: nothing new — this is a test-only task confirming Task 1's extraction is correct in isolation, independent of `computeMonthlyNext`.

- [ ] **Step 1: Write tests for `resolveDayOfMonth` directly**

Create `utils/monthlyRecurrence.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveDayOfMonth, MONTHLY_LAST_DAY } = require('./monthlyRecurrence');

test('resolveDayOfMonth: fixed day of month, well within any month', () => {
  assert.equal(resolveDayOfMonth(2026, 0, 15), 15); // January 2026, day 15
});

test('resolveDayOfMonth: fixed day of month clamps to a shorter month', () => {
  assert.equal(resolveDayOfMonth(2026, 1, 31), 28); // February 2026 (28 days), asked for 31
});

test('resolveDayOfMonth: last day of month, no offset', () => {
  assert.equal(resolveDayOfMonth(2026, 1, MONTHLY_LAST_DAY), 28); // Feb 2026
  assert.equal(resolveDayOfMonth(2026, 0, MONTHLY_LAST_DAY), 31); // Jan 2026
});

test('resolveDayOfMonth: last day of month, leap year February', () => {
  assert.equal(resolveDayOfMonth(2028, 1, MONTHLY_LAST_DAY), 29); // Feb 2028 is a leap year
});

test('resolveDayOfMonth: N days before last day', () => {
  assert.equal(resolveDayOfMonth(2026, 1, MONTHLY_LAST_DAY, 2), 26); // Feb 2026, 2 before 28th
  assert.equal(resolveDayOfMonth(2026, 0, MONTHLY_LAST_DAY, 2), 29); // Jan 2026, 2 before 31st
});

test('resolveDayOfMonth: offset clamps rather than crossing into the previous month', () => {
  assert.equal(resolveDayOfMonth(2026, 1, MONTHLY_LAST_DAY, 40), 1); // Feb 2026, clamps to day 1
});

test('resolveDayOfMonth: negative offset treated as 0', () => {
  assert.equal(resolveDayOfMonth(2026, 1, MONTHLY_LAST_DAY, -5), 28);
});

test('resolveDayOfMonth: default lastDayOffset is 0 when omitted', () => {
  assert.equal(resolveDayOfMonth(2026, 1, MONTHLY_LAST_DAY), 28);
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `node --test utils/monthlyRecurrence.test.js`
Expected: PASS, all 8 tests. (These are new tests for behavior that already existed pre-refactor and was already covered indirectly by `jobScheduler.test.js` — this task adds direct, isolated coverage of the extracted function itself.)

- [ ] **Step 3: Commit**

```bash
git add utils/monthlyRecurrence.test.js
git commit -m "test: add direct coverage for resolveDayOfMonth"
```

---

### Task 3: Frontend composition + sentence-building helpers

This task writes the pure JS logic (date composition, sentence text) as standalone functions in `admin/src/jobs.js`, without yet wiring them into the render functions — Task 4 does the wiring. Separating logic-writing from DOM-wiring keeps this task's diff reviewable in isolation and matches this codebase's pattern of small focused helpers (`domPicker`, `dowPicker`, `lastDayOffsetField` are all structured this way already).

**Files:**

- Modify: `admin/src/jobs.js` (add new helpers; remove `formatUtcPreview`/`attachUtcPreview`; replace local `MONTHLY_LAST_DAY` constant with the shared import)

**Interfaces:**

- Consumes: `resolveDayOfMonth`, `MONTHLY_LAST_DAY` from `utils/monthlyRecurrence.js` (Task 1, imported via a relative path from `admin/src/jobs.js` — resolve the exact path at implementation time, e.g. `../../../utils/monthlyRecurrence.js`; verify it resolves by running the Step 6 build check below).
- Produces:
  - `composeFireAtUtc({ unit, month, dateStr, timeStr, dayOfMonth, lastDayOffset })` → returns a `Date` object (not yet `.toISOString()`'d) representing the composed UTC instant. For `unit === 'monthly'`: uses `month` (0-11) + `resolveDayOfMonth` + `timeStr` (`"HH:MM"`), infers year (this year, or next year if the resulting date is in the past). For `unit !== 'monthly'`: uses `dateStr` (`"YYYY-MM-DD"`) + `timeStr` directly, no day derivation.
  - `buildScheduleSentence({ unit, count, dayOfMonth, lastDayOffset, month, dateStr, timeStr })` → returns a string, the live sentence text, calling `composeFireAtUtc` internally to get the starting instant it describes.

- [ ] **Step 1: Remove the old UTC-only hint functions**

In `admin/src/jobs.js`, find and delete:

```js
function formatUtcPreview(fireLocal) {
  if (!fireLocal) return '';
  const d = new Date(fireLocal);
  if (isNaN(d)) return '';
  const pad = n => String(n).padStart(2, '0');
  return `Will fire at ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC on ${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// Appends a live "will fire at HH:MM UTC" hint under a datetime-local input,
// updating as the user types -- the field itself always drives the actual
// scheduled UTC instant (see utils.js utcToLocal), this is just a preview.
function attachUtcPreview(fireInput) {
  const hint = document.createElement('div');
  hint.className = 'muted-note';
  hint.style.marginTop = '4px';
  hint.textContent = formatUtcPreview(fireInput.value);
  fireInput.addEventListener('input', () => {
    hint.textContent = formatUtcPreview(fireInput.value);
  });
  return hint;
}
```

(Their two call sites, in the per-job card and create-job form render functions, are updated in Task 4 — this task only removes the now-unused definitions. Leaving the call sites temporarily broken between Task 3 and Task 4 is fine since both tasks land together before any review; if you're implementing Task 3 in isolation and want the file to still build standalone, you may temporarily leave the definitions in place and delete them as part of Task 4's edits instead — either ordering is acceptable, but do not leave both the old hint AND the new sentence in the shipped result.)

- [ ] **Step 2: Replace the local `MONTHLY_LAST_DAY` constant with the shared import**

Find, near the top of the file:

```js
import { state } from './state.js';
import { utcToLocal } from './utils.js';
import { createChipPicker } from './chipPicker.js';
```

Replace with:

```js
import { state } from './state.js';
import { utcToLocal } from './utils.js';
import { createChipPicker } from './chipPicker.js';
import { resolveDayOfMonth, MONTHLY_LAST_DAY } from '../../../utils/monthlyRecurrence.js';
```

(Verify this relative path is correct for this file's actual location, `admin/src/jobs.js` — three levels up reaches the repo root, then into `utils/`. If incorrect, adjust and note the corrected path in your task report.)

Then find, further down:

```js
const DOW = [['1','Mon'],['2','Tue'],['3','Wed'],['4','Thu'],['5','Fri'],['6','Sat'],['7','Sun']];
const MONTHLY_LAST_DAY = -1;
```

Replace with:

```js
const DOW = [['1','Mon'],['2','Tue'],['3','Wed'],['4','Thu'],['5','Fri'],['6','Sat'],['7','Sun']];
```

(The local `const MONTHLY_LAST_DAY = -1;` is removed — it's now imported. Every existing use of `MONTHLY_LAST_DAY` elsewhere in the file — in `domPicker`, `lastDayOffsetField`'s callers, `saveScheduledJob`, `submitNewTextJob` — continues to work unchanged since it's the same name, now sourced from the import instead of a local const.)

- [ ] **Step 3: Add month names and the UTC composition helper**

Add this near the top of the file, after the existing `DOW` constant:

```js
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// Composes the UTC instant a "starting" selection resolves to. For monthly
// jobs, the day is DERIVED from the day-of-month rule (never independently
// picked) and the year is inferred -- this year, unless that produces a
// past date, in which case next year. This is deliberately never built via
// new Date(localString): a local evening time can already be the next UTC
// day (e.g. 8pm EDT is past midnight UTC), which would silently make the
// derived day-of-month rule and the actual stored fire_at disagree by a
// day -- the exact class of bug this redesign exists to eliminate.
function composeFireAtUtc({ unit, month, dateStr, timeStr, dayOfMonth, lastDayOffset }) {
  const [hh, mm] = (timeStr || '00:00').split(':').map(n => parseInt(n, 10));

  if (unit === 'monthly') {
    const now = new Date();
    const thisYear = now.getUTCFullYear();
    function candidate(year) {
      const day = resolveDayOfMonth(year, month, dayOfMonth, lastDayOffset);
      return new Date(Date.UTC(year, month, day, hh, mm, 0));
    }
    let d = candidate(thisYear);
    if (d.getTime() <= now.getTime()) d = candidate(thisYear + 1);
    return d;
  }

  // Daily/weekly: dateStr is "YYYY-MM-DD" from a <input type="date">, parsed
  // as UTC calendar-date components directly (never new Date(dateStr), for
  // the same local-timezone-rollover reason as above).
  const [y, m, day] = (dateStr || '').split('-').map(n => parseInt(n, 10));
  if (!y || !m || !day) return null;
  return new Date(Date.UTC(y, m - 1, day, hh, mm, 0));
}
```

- [ ] **Step 4: Add the live sentence builder**

Add immediately after `composeFireAtUtc`:

```js
// Formats a composed UTC Date as "Month D, YYYY H:MM AM/PM" in the
// VIEWER's local time (a read-only display conversion -- this never feeds
// back into composition, which stays UTC throughout).
function formatSentenceDate(d) {
  const months = MONTHS;
  let hours = d.getHours();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${hours}:${mm} ${ampm}`;
}

function formatUtcClock(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

// Builds the read-only live-sentence text for the current in-progress form
// values (not saved job state) -- callers re-invoke this on every relevant
// field change so the sentence always reflects exactly what Save would
// currently persist.
function buildScheduleSentence({ unit, count, dayOfMonth, lastDayOffset, month, dateStr, timeStr }) {
  const start = composeFireAtUtc({ unit, month, dateStr, timeStr, dayOfMonth, lastDayOffset });
  if (!start || isNaN(start)) return '';

  const n = count || 1;
  let rulePart;
  if (unit === 'monthly') {
    if (dayOfMonth === MONTHLY_LAST_DAY) {
      rulePart = (lastDayOffset > 0)
        ? `${lastDayOffset} day(s) before the last day of the month`
        : 'on the last day of the month';
    } else {
      rulePart = `on the ${dayOfMonth}${ordinalSuffix(dayOfMonth)}`;
    }
    return `Will fire every ${n} month(s), ${rulePart}, starting ${formatSentenceDate(start)} your time (${formatUtcClock(start)}).`;
  }

  const unitLabel = unit === 'weekly' ? 'week(s)' : 'day(s)';
  return `Will fire every ${n} ${unitLabel}, starting ${formatSentenceDate(start)} your time.`;
}

function ordinalSuffix(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return 'th';
  switch (n % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}
```

- [ ] **Step 5: Verify the admin build still succeeds with these new (as-yet-unused) helpers**

Run: `npm run build --prefix admin`
Expected: build succeeds, 0 errors. This confirms the new import path from Step 2 resolves correctly and the `commonjsOptions.include` fix from Task 1 actually works — if the import path is wrong, this is where it surfaces (a build error, not a silent runtime `undefined`, since Rollup will fail to resolve a genuinely bad path outright).

- [ ] **Step 6: Commit**

```bash
git add admin/src/jobs.js
git commit -m "feat: add UTC-anchored fire_at composition and live sentence builder"
```

---

### Task 4: Rewire the per-job card and create-job form

This is the largest task: restructuring both render functions to the new field order, split date controls, and live sentence, using the helpers from Task 3.

**Files:**

- Modify: `admin/src/jobs.js` (`renderScheduledJobs`, `saveScheduledJob`, `renderCreateJobForm`, `submitNewTextJob`)

**Interfaces:**

- Consumes: `composeFireAtUtc`, `buildScheduleSentence`, `resolveDayOfMonth`, `MONTHLY_LAST_DAY`, `MONTHS` (Task 3). `domPicker`, `lastDayOffsetField`, `readLastDayOffset`, `dowPicker`, `readDowPicker`, `channelOptions`, `mentionsPicker`, `readMentionsPicker`, `setFieldError`, `clearFieldErrors`, `formatTileFireTime` (all pre-existing, unchanged).
- Produces: no new exports — this task changes the internal structure of `renderScheduledJobs`/`renderCreateJobForm` and their save handlers, called the same way from `admin/src/main.js` as today (no changes needed there).

- [ ] **Step 1: Rewrite the per-job card's field construction in `renderScheduledJobs`**

Find the whole block from the "Next fire field" comment through the `fields.append(fireField, recurField, domField, offsetField);` line and the two "Posts to" field blocks that follow it:

```js
    // Next fire field
    const fireField = document.createElement('div');
    fireField.className = 'sj-field';
    fireField.innerHTML = '<label>Next Fire (your local time)</label>';
    const fireInput = document.createElement('input');
    fireInput.type = 'datetime-local';
    fireInput.id = `sj-fire-${job.id}`;
    fireInput.value = utcToLocal(job.fire_at);
    fireField.append(fireInput, attachUtcPreview(fireInput));

    // Recurrence field
    const recurField = document.createElement('div');
    recurField.className = 'sj-field';
    recurField.innerHTML = '<label>Repeat every</label>';
    const recurRow = document.createElement('div');
    recurRow.className = 'sj-recur-row';
    const countInput = document.createElement('input');
    countInput.type = 'number';
    countInput.id = `sj-count-${job.id}`;
    countInput.value = count;
    countInput.min = '1';
    countInput.style.width = '60px';
    const unitSel = document.createElement('select');
    unitSel.id = `sj-unit-${job.id}`;
    for (const [val, label] of [['daily', 'Day(s)'], ['weekly', 'Week(s)'], ['monthly', 'Month(s)']]) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = label;
      if (unit === val) opt.selected = true;
      unitSel.appendChild(opt);
    }
    recurRow.append(countInput, unitSel);
    recurField.appendChild(recurRow);

    const domField = document.createElement('div');
    domField.className = 'sj-field';
    domField.innerHTML = '<label>Day of month</label>';
    const domSelect = domPicker(`sj-dom-${job.id}`, job.day_of_month);
    domField.appendChild(domSelect);
    domField.style.display = unit === 'monthly' ? '' : 'none';

    const offsetField = lastDayOffsetField(`sj-offset-${job.id}`, job.last_day_offset);
    offsetField.style.display = (unit === 'monthly' && domSelect.value === String(MONTHLY_LAST_DAY)) ? '' : 'none';

    domSelect.addEventListener('change', () => {
      offsetField.style.display = domSelect.value === String(MONTHLY_LAST_DAY) ? '' : 'none';
    });
    unitSel.addEventListener('change', () => {
      domField.style.display = unitSel.value === 'monthly' ? '' : 'none';
      offsetField.style.display = (unitSel.value === 'monthly' && domSelect.value === String(MONTHLY_LAST_DAY)) ? '' : 'none';
    });

    fields.append(fireField, recurField, domField, offsetField);

    // Optional "Posts to" channel field
    const chKey = JOB_CHANNEL_KEY[job.handler_path];
    if (chKey) {
      const chField = document.createElement('div');
      chField.className = 'sj-field';
      chField.innerHTML = '<label>Posts to</label>';
      const chSel = document.createElement('select');
      chSel.className = 'channel-select';
      chSel.innerHTML = channelOptions(state.allConfig.find(c => c.key === chKey)?.value);
      chSel.addEventListener('change', () => setJobChannel(chKey, chSel.value));
      chField.appendChild(chSel);
      fields.appendChild(chField);
    }

    if (job.type === 'text_job') {
      const chField = document.createElement('div');
      chField.className = 'sj-field';
      chField.innerHTML = '<label>Posts to</label>';
      const chSel = document.createElement('select');
      chSel.id = `tj-channel-${job.id}`;
      chSel.className = 'channel-select';
      chSel.innerHTML = channelOptions(job.channel_id);
      chField.appendChild(chSel);
      fields.appendChild(chField);

      const dowField = document.createElement('div');
      dowField.className = 'sj-field';
      dowField.innerHTML = '<label>Days</label>';
      dowField.appendChild(dowPicker(`tj-dow-${job.id}`, job.days_of_week));
      dowField.style.display = unit === 'monthly' ? 'none' : '';
      unitSel.addEventListener('change', () => {
        dowField.style.display = unitSel.value === 'monthly' ? 'none' : '';
      });
      fields.appendChild(dowField);
```

Replace with (note this reorders "Posts to" to appear right after the channel field logic is determined, before Repeat, and reworks the date section entirely — read carefully, this is a substantial restructure, not a small edit):

```js
    // Posts To -- moved earlier (was after date/recurrence fields) to match
    // the create-job form's existing field order and this redesign's unified
    // ordering: Job Name, Posts To, Repeat, Day of month, Starting, sentence.
    const chKey = JOB_CHANNEL_KEY[job.handler_path];
    if (chKey) {
      const chField = document.createElement('div');
      chField.className = 'sj-field';
      chField.innerHTML = '<label>Posts to</label>';
      const chSel = document.createElement('select');
      chSel.className = 'channel-select';
      chSel.innerHTML = channelOptions(state.allConfig.find(c => c.key === chKey)?.value);
      chSel.addEventListener('change', () => setJobChannel(chKey, chSel.value));
      chField.appendChild(chSel);
      fields.appendChild(chField);
    }
    if (job.type === 'text_job') {
      const chField = document.createElement('div');
      chField.className = 'sj-field';
      chField.innerHTML = '<label>Posts to</label>';
      const chSel = document.createElement('select');
      chSel.id = `tj-channel-${job.id}`;
      chSel.className = 'channel-select';
      chSel.innerHTML = channelOptions(job.channel_id);
      chField.appendChild(chSel);
      fields.appendChild(chField);
    }

    // Recurrence field
    const recurField = document.createElement('div');
    recurField.className = 'sj-field';
    recurField.innerHTML = '<label>Repeat every</label>';
    const recurRow = document.createElement('div');
    recurRow.className = 'sj-recur-row';
    const countInput = document.createElement('input');
    countInput.type = 'number';
    countInput.id = `sj-count-${job.id}`;
    countInput.value = count;
    countInput.min = '1';
    countInput.style.width = '60px';
    const unitSel = document.createElement('select');
    unitSel.id = `sj-unit-${job.id}`;
    for (const [val, label] of [['daily', 'Day(s)'], ['weekly', 'Week(s)'], ['monthly', 'Month(s)']]) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = label;
      if (unit === val) opt.selected = true;
      unitSel.appendChild(opt);
    }
    recurRow.append(countInput, unitSel);
    recurField.appendChild(recurRow);
    fields.appendChild(recurField);

    const domField = document.createElement('div');
    domField.className = 'sj-field';
    domField.innerHTML = '<label>Day of month</label>';
    const domSelect = domPicker(`sj-dom-${job.id}`, job.day_of_month);
    domField.appendChild(domSelect);
    domField.style.display = unit === 'monthly' ? '' : 'none';
    fields.appendChild(domField);

    const offsetField = lastDayOffsetField(`sj-offset-${job.id}`, job.last_day_offset);
    offsetField.style.display = (unit === 'monthly' && domSelect.value === String(MONTHLY_LAST_DAY)) ? '' : 'none';
    fields.appendChild(offsetField);

    // Starting: Month+Time (monthly) or Date+Time (daily/weekly). The
    // monthly path has NO day/year picker -- day is derived from the
    // day-of-month rule above, so a mismatched starting date can't be
    // entered. See composeFireAtUtc (jobs.js) for why this composes via
    // Date.UTC rather than a local datetime-local input.
    const startField = document.createElement('div');
    startField.className = 'sj-field';
    startField.innerHTML = '<label>Starting</label>';
    const startRow = document.createElement('div');
    startRow.className = 'sj-recur-row';

    const existingStart = new Date(job.fire_at);
    const monthSel = document.createElement('select');
    monthSel.id = `sj-month-${job.id}`;
    MONTHS.forEach((m, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = m;
      if (i === existingStart.getUTCMonth()) opt.selected = true;
      monthSel.appendChild(opt);
    });
    monthSel.style.display = unit === 'monthly' ? '' : 'none';

    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.id = `sj-date-${job.id}`;
    const pad2 = n => String(n).padStart(2, '0');
    dateInput.value = `${existingStart.getUTCFullYear()}-${pad2(existingStart.getUTCMonth() + 1)}-${pad2(existingStart.getUTCDate())}`;
    dateInput.style.display = unit === 'monthly' ? 'none' : '';

    const timeInput = document.createElement('input');
    timeInput.type = 'time';
    timeInput.id = `sj-time-${job.id}`;
    timeInput.value = `${pad2(existingStart.getUTCHours())}:${pad2(existingStart.getUTCMinutes())}`;

    startRow.append(monthSel, dateInput, timeInput);
    startField.appendChild(startRow);
    fields.appendChild(startField);

    const sentenceEl = document.createElement('div');
    sentenceEl.className = 'sj-field muted-note';
    sentenceEl.style.flexBasis = '100%';
    fields.appendChild(sentenceEl);

    function refreshSentence() {
      const dayOfMonth = unitSel.value === 'monthly' ? parseInt(domSelect.value, 10) : null;
      const lastDayOffset = (unitSel.value === 'monthly' && dayOfMonth === MONTHLY_LAST_DAY)
        ? readLastDayOffset(`sj-offset-${job.id}`) : 0;
      sentenceEl.textContent = buildScheduleSentence({
        unit: unitSel.value,
        count: parseInt(countInput.value, 10),
        dayOfMonth,
        lastDayOffset,
        month: parseInt(monthSel.value, 10),
        dateStr: dateInput.value,
        timeStr: timeInput.value,
      });
    }

    domSelect.addEventListener('change', () => {
      offsetField.style.display = domSelect.value === String(MONTHLY_LAST_DAY) ? '' : 'none';
      refreshSentence();
    });
    unitSel.addEventListener('change', () => {
      domField.style.display = unitSel.value === 'monthly' ? '' : 'none';
      offsetField.style.display = (unitSel.value === 'monthly' && domSelect.value === String(MONTHLY_LAST_DAY)) ? '' : 'none';
      monthSel.style.display = unitSel.value === 'monthly' ? '' : 'none';
      dateInput.style.display = unitSel.value === 'monthly' ? 'none' : '';
      refreshSentence();
    });
    for (const el of [countInput, monthSel, dateInput, timeInput]) {
      el.addEventListener('input', refreshSentence);
      el.addEventListener('change', refreshSentence);
    }
    document.getElementById(`sj-offset-${job.id}-qual`)?.addEventListener('change', refreshSentence);
    document.getElementById(`sj-offset-${job.id}-num`)?.addEventListener('input', refreshSentence);
    refreshSentence();

    if (job.type === 'text_job') {
      const dowField = document.createElement('div');
      dowField.className = 'sj-field';
      dowField.innerHTML = '<label>Days</label>';
      dowField.appendChild(dowPicker(`tj-dow-${job.id}`, job.days_of_week));
      dowField.style.display = unit === 'monthly' ? 'none' : '';
      unitSel.addEventListener('change', () => {
        dowField.style.display = unitSel.value === 'monthly' ? 'none' : '';
      });
      fields.appendChild(dowField);
```

Note: `lastDayOffsetField`'s internal `<select id="${idPrefix}-qual">`/`<input id="${idPrefix}-num">` (from the existing offset-picker helper, unchanged) are what the two `document.getElementById(...)?.addEventListener` lines above hook into — confirm these exact ID patterns still match `lastDayOffsetField`'s current implementation (`admin/src/jobs.js`, the function defined near `domPicker`) before wiring; the `?.` guards against the elements not existing yet on first call (they're created by `lastDayOffsetField` inside `offsetField`, appended earlier in this same block, so they should exist — the guard is defensive, not because it's expected to be null in normal operation).

- [ ] **Step 2: Remove the old "Current next fire (UTC)" line and update `saveScheduledJob`**

Find:

```js
    // UTC note
    const utcNote = document.createElement('div');
    utcNote.className = 'sj-utc-note muted-note';
    utcNote.style.marginTop = '10px';
    utcNote.textContent = `Current next fire (UTC): ${job.fire_at.slice(0,16).replace('T',' ')}`;

    const body = document.createElement('div');
    body.className = 'sj-body';
    body.append(fields, utcNote, actionsRow);
```

Replace with:

```js
    const body = document.createElement('div');
    body.className = 'sj-body';
    body.append(fields, actionsRow);
```

(The live sentence added in Step 1 fully replaces this — see design spec's Live Sentence section for why keeping both would be confusing: one showed saved state, one shows in-progress edits.)

- [ ] **Step 3: Rewrite `saveScheduledJob` to compose `fire_at` from the new fields**

Find:

```js
export async function saveScheduledJob(id) {
  const fireInput = document.getElementById(`sj-fire-${id}`);
  const fireLocal = fireInput.value;
  const count     = document.getElementById(`sj-count-${id}`).value;
  const unit      = document.getElementById(`sj-unit-${id}`).value;
  const domEl     = document.getElementById(`sj-dom-${id}`);
  const dayOfMonth = unit === 'monthly' ? parseInt(domEl.value, 10) : null;
  const lastDayOffset = (unit === 'monthly' && dayOfMonth === MONTHLY_LAST_DAY) ? readLastDayOffset(`sj-offset-${id}`) : null;

  if (!fireLocal) { setFieldError(fireInput, 'Next fire time is required'); return false; }
  setFieldError(fireInput, '');
  const fireAt   = new Date(fireLocal).toISOString();
  const recurrence = `${unit}:${count}`;

  const res = await fetch(`/api/scheduled-jobs/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fire_at: fireAt, recurrence, day_of_month: dayOfMonth, last_day_offset: lastDayOffset }),
  });
  const data = await res.json();
  if (!data.ok) { setFieldError(fireInput, data.error); return false; }

  const card = document.getElementById(`sj-fire-${id}`).closest('.sj-card');
  const utcLine = card.querySelector('.sj-utc-note');
  if (utcLine) utcLine.textContent = `Current next fire (UTC): ${fireAt.slice(0,16).replace('T',' ')}`;
  const tileFire = card.querySelector('.sj-tile-fire');
  if (tileFire) tileFire.textContent = formatTileFireTime(fireAt);

  const flashEl = document.getElementById(`sj-flash-${id}`);
  if (flashEl) { flashEl.classList.add('show'); setTimeout(() => flashEl.classList.remove('show'), 2000); }
  return true;
}
```

Replace with:

```js
export async function saveScheduledJob(id) {
  const count = document.getElementById(`sj-count-${id}`).value;
  const unit  = document.getElementById(`sj-unit-${id}`).value;
  const domEl = document.getElementById(`sj-dom-${id}`);
  const dayOfMonth = unit === 'monthly' ? parseInt(domEl.value, 10) : null;
  const lastDayOffset = (unit === 'monthly' && dayOfMonth === MONTHLY_LAST_DAY) ? readLastDayOffset(`sj-offset-${id}`) : null;

  const monthEl = document.getElementById(`sj-month-${id}`);
  const dateEl  = document.getElementById(`sj-date-${id}`);
  const timeEl  = document.getElementById(`sj-time-${id}`);
  const start = composeFireAtUtc({
    unit,
    month: unit === 'monthly' ? parseInt(monthEl.value, 10) : null,
    dateStr: unit !== 'monthly' ? dateEl.value : null,
    timeStr: timeEl.value,
    dayOfMonth,
    lastDayOffset: lastDayOffset || 0,
  });

  if (!start || isNaN(start)) { setFieldError(timeEl, 'A valid starting time is required'); return false; }
  setFieldError(timeEl, '');
  const fireAt = start.toISOString();
  const recurrence = `${unit}:${count}`;

  const res = await fetch(`/api/scheduled-jobs/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fire_at: fireAt, recurrence, day_of_month: dayOfMonth, last_day_offset: lastDayOffset }),
  });
  const data = await res.json();
  if (!data.ok) { setFieldError(timeEl, data.error); return false; }

  const card = document.getElementById(`sj-time-${id}`).closest('.sj-card');
  const tileFire = card.querySelector('.sj-tile-fire');
  if (tileFire) tileFire.textContent = formatTileFireTime(fireAt);

  const flashEl = document.getElementById(`sj-flash-${id}`);
  if (flashEl) { flashEl.classList.add('show'); setTimeout(() => flashEl.classList.remove('show'), 2000); }
  return true;
}
```

- [ ] **Step 4: Rewrite `renderCreateJobForm`'s field construction**

Find the whole block from the `chField`/`fireField` declarations through the `fields.append(nameField, chField, fireField, recurField, domField, offsetField, dowField, titleField, bodyField, mentionsField, actionsField);` line:

```js
  const chField = document.createElement('div');
  chField.className = 'sj-field';
  chField.innerHTML = '<label>Posts to</label>';
  const chSel = document.createElement('select');
  chSel.id = 'cj-channel';
  chSel.className = 'channel-select';
  chSel.innerHTML = channelOptions('');
  chField.appendChild(chSel);

  const fireField = document.createElement('div');
  fireField.className = 'sj-field';
  fireField.innerHTML = '<label>First Fire (your local time)</label>';
  const fireInput = document.createElement('input');
  fireInput.type = 'datetime-local';
  fireInput.id = 'cj-fire';
  fireField.append(fireInput, attachUtcPreview(fireInput));

  const recurField = document.createElement('div');
  recurField.className = 'sj-field';
  recurField.innerHTML = '<label>Repeat every</label>';
  const recurRow = document.createElement('div');
  recurRow.className = 'sj-recur-row';
  const countInput = document.createElement('input');
  countInput.type = 'number'; countInput.id = 'cj-count'; countInput.value = '1'; countInput.min = '1';
  countInput.style.width = '60px';
  const unitSel = document.createElement('select');
  unitSel.id = 'cj-unit';
  for (const [val, label] of [['daily', 'Day(s)'], ['weekly', 'Week(s)'], ['monthly', 'Month(s)']]) {
    const opt = document.createElement('option'); opt.value = val; opt.textContent = label;
    unitSel.appendChild(opt);
  }
  recurRow.append(countInput, unitSel);
  recurField.appendChild(recurRow);

  const domSelect = domPicker('cj-dom', null);
  const domField = document.createElement('div');
  domField.className = 'sj-field';
  domField.innerHTML = '<label>Day of month</label>';
  domField.appendChild(domSelect);
  domField.style.display = 'none';

  const offsetField = lastDayOffsetField('cj-offset', null);
  offsetField.style.display = 'none';
  domSelect.addEventListener('change', () => {
    offsetField.style.display = (domField.style.display !== 'none' && domSelect.value === String(MONTHLY_LAST_DAY)) ? '' : 'none';
  });

  const dowField = document.createElement('div');
  dowField.className = 'sj-field';
  dowField.innerHTML = '<label>Days</label>';
  dowField.appendChild(dowPicker('cj-dow', null));

  unitSel.addEventListener('change', () => {
    domField.style.display = unitSel.value === 'monthly' ? '' : 'none';
    dowField.style.display = unitSel.value === 'monthly' ? 'none' : '';
    offsetField.style.display = (unitSel.value === 'monthly' && domSelect.value === String(MONTHLY_LAST_DAY)) ? '' : 'none';
  });
```

Replace with:

```js
  const chField = document.createElement('div');
  chField.className = 'sj-field';
  chField.innerHTML = '<label>Posts to</label>';
  const chSel = document.createElement('select');
  chSel.id = 'cj-channel';
  chSel.className = 'channel-select';
  chSel.innerHTML = channelOptions('');
  chField.appendChild(chSel);

  const recurField = document.createElement('div');
  recurField.className = 'sj-field';
  recurField.innerHTML = '<label>Repeat every</label>';
  const recurRow = document.createElement('div');
  recurRow.className = 'sj-recur-row';
  const countInput = document.createElement('input');
  countInput.type = 'number'; countInput.id = 'cj-count'; countInput.value = '1'; countInput.min = '1';
  countInput.style.width = '60px';
  const unitSel = document.createElement('select');
  unitSel.id = 'cj-unit';
  for (const [val, label] of [['daily', 'Day(s)'], ['weekly', 'Week(s)'], ['monthly', 'Month(s)']]) {
    const opt = document.createElement('option'); opt.value = val; opt.textContent = label;
    unitSel.appendChild(opt);
  }
  recurRow.append(countInput, unitSel);
  recurField.appendChild(recurRow);

  const domSelect = domPicker('cj-dom', null);
  const domField = document.createElement('div');
  domField.className = 'sj-field';
  domField.innerHTML = '<label>Day of month</label>';
  domField.appendChild(domSelect);
  domField.style.display = 'none';

  const offsetField = lastDayOffsetField('cj-offset', null);
  offsetField.style.display = 'none';

  const dowField = document.createElement('div');
  dowField.className = 'sj-field';
  dowField.innerHTML = '<label>Days</label>';
  dowField.appendChild(dowPicker('cj-dow', null));

  // Starting: Month+Time (monthly) or Date+Time (daily/weekly). See
  // saveScheduledJob/composeFireAtUtc for why day/year are never directly
  // pickable for monthly jobs.
  const startField = document.createElement('div');
  startField.className = 'sj-field';
  startField.innerHTML = '<label>Starting</label>';
  const startRow = document.createElement('div');
  startRow.className = 'sj-recur-row';

  const monthSel = document.createElement('select');
  monthSel.id = 'cj-month';
  MONTHS.forEach((m, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = m;
    monthSel.appendChild(opt);
  });
  monthSel.style.display = 'none';

  const dateInput = document.createElement('input');
  dateInput.type = 'date';
  dateInput.id = 'cj-date';

  const timeInput = document.createElement('input');
  timeInput.type = 'time';
  timeInput.id = 'cj-time';
  timeInput.value = '09:00';

  startRow.append(monthSel, dateInput, timeInput);
  startField.appendChild(startRow);

  const sentenceEl = document.createElement('div');
  sentenceEl.className = 'sj-field muted-note';
  sentenceEl.id = 'cj-sentence';
  sentenceEl.style.flexBasis = '100%';

  function refreshCreateSentence() {
    const dayOfMonth = unitSel.value === 'monthly' ? parseInt(domSelect.value, 10) : null;
    const lastDayOffset = (unitSel.value === 'monthly' && dayOfMonth === MONTHLY_LAST_DAY)
      ? readLastDayOffset('cj-offset') : 0;
    sentenceEl.textContent = buildScheduleSentence({
      unit: unitSel.value,
      count: parseInt(countInput.value, 10),
      dayOfMonth,
      lastDayOffset,
      month: parseInt(monthSel.value, 10),
      dateStr: dateInput.value,
      timeStr: timeInput.value,
    });
  }

  domSelect.addEventListener('change', () => {
    offsetField.style.display = (domField.style.display !== 'none' && domSelect.value === String(MONTHLY_LAST_DAY)) ? '' : 'none';
    refreshCreateSentence();
  });
  unitSel.addEventListener('change', () => {
    domField.style.display = unitSel.value === 'monthly' ? '' : 'none';
    dowField.style.display = unitSel.value === 'monthly' ? 'none' : '';
    offsetField.style.display = (unitSel.value === 'monthly' && domSelect.value === String(MONTHLY_LAST_DAY)) ? '' : 'none';
    monthSel.style.display = unitSel.value === 'monthly' ? '' : 'none';
    dateInput.style.display = unitSel.value === 'monthly' ? 'none' : '';
    refreshCreateSentence();
  });
  for (const el of [countInput, monthSel, dateInput, timeInput]) {
    el.addEventListener('input', refreshCreateSentence);
    el.addEventListener('change', refreshCreateSentence);
  }
```

Note `dateInput.style.display` isn't set to `'none'` initially in this block (unlike `monthSel`) — the create form defaults `unitSel` to `'daily'` (first option, no `unit === val` match forced), so Date should be visible by default and Month hidden. Confirm this matches the existing default behavior (no `unit` variable exists in the create-form scope the way it does in the per-job-card scope, since there's no existing job to read `unit` from) — the create form's `unitSel` has no `selected` option explicitly set, so it defaults to the browser's first `<option>`, which is `'daily'`. This is consistent with `domField.style.display = 'none'` already being the create-form's existing default.

- [ ] **Step 5: Wire the offset picker's internal fields to refresh the create-form sentence, and append the new fields**

Find:

```js
  const titleField = document.createElement('div');
  titleField.className = 'sj-field';
  titleField.style.flexBasis = '100%';
  titleField.innerHTML = '<label>Title</label>';
  const titleInput = document.createElement('input');
  titleInput.type = 'text'; titleInput.id = 'cj-title'; titleInput.style.width = '100%';
  titleField.appendChild(titleInput);

  const bodyField = document.createElement('div');
  bodyField.className = 'sj-field';
  bodyField.style.flexBasis = '100%';
  bodyField.innerHTML = '<label>Body</label>';
  const bodyInput = document.createElement('textarea');
  bodyInput.id = 'cj-body'; bodyInput.rows = 4; bodyInput.style.width = '100%';
  bodyField.appendChild(bodyInput);

  const mentionsField = document.createElement('div');
  mentionsField.className = 'sj-field';
  mentionsField.style.flexBasis = '100%';
  mentionsField.innerHTML = '<label>Mentions (pings on send)</label>';
  mentionsField.appendChild(mentionsPicker('cj-mentions', []));

  const actionsField = document.createElement('div');
  actionsField.className = 'sj-field';
  const createBtn = document.createElement('button');
  createBtn.className = 'save-btn';
  createBtn.textContent = 'Create Job';
  createBtn.addEventListener('click', submitNewTextJob);
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'reset-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => { form.style.display = 'none'; });
  actionsField.append(createBtn, cancelBtn);

  const fields = document.createElement('div');
  fields.className = 'sj-fields';
  fields.append(nameField, chField, fireField, recurField, domField, offsetField, dowField, titleField, bodyField, mentionsField, actionsField);
  form.appendChild(fields);
}
```

Replace with:

```js
  const titleField = document.createElement('div');
  titleField.className = 'sj-field';
  titleField.style.flexBasis = '100%';
  titleField.innerHTML = '<label>Title</label>';
  const titleInput = document.createElement('input');
  titleInput.type = 'text'; titleInput.id = 'cj-title'; titleInput.style.width = '100%';
  titleField.appendChild(titleInput);

  const bodyField = document.createElement('div');
  bodyField.className = 'sj-field';
  bodyField.style.flexBasis = '100%';
  bodyField.innerHTML = '<label>Body</label>';
  const bodyInput = document.createElement('textarea');
  bodyInput.id = 'cj-body'; bodyInput.rows = 4; bodyInput.style.width = '100%';
  bodyField.appendChild(bodyInput);

  const mentionsField = document.createElement('div');
  mentionsField.className = 'sj-field';
  mentionsField.style.flexBasis = '100%';
  mentionsField.innerHTML = '<label>Mentions (pings on send)</label>';
  mentionsField.appendChild(mentionsPicker('cj-mentions', []));

  const actionsField = document.createElement('div');
  actionsField.className = 'sj-field';
  const createBtn = document.createElement('button');
  createBtn.className = 'save-btn';
  createBtn.textContent = 'Create Job';
  createBtn.addEventListener('click', submitNewTextJob);
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'reset-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => { form.style.display = 'none'; });
  actionsField.append(createBtn, cancelBtn);

  const fields = document.createElement('div');
  fields.className = 'sj-fields';
  fields.append(nameField, chField, recurField, domField, offsetField, startField, sentenceEl, dowField, titleField, bodyField, mentionsField, actionsField);
  form.appendChild(fields);
  refreshCreateSentence();
}
```

(`refreshCreateSentence()` is called once at the end, after all fields are in the DOM, so the sentence has correct initial text rather than being blank until the first user interaction — same pattern used in Step 1's per-job card `refreshSentence()` call.)

Also add listeners for the offset picker's internal fields, right after the `refreshCreateSentence` call at the end of the function (or immediately after `lastDayOffsetField('cj-offset', null)` is constructed — either placement is fine as long as it's after `offsetField`'s internal elements exist in the DOM):

```js
  document.getElementById('cj-offset-qual')?.addEventListener('change', refreshCreateSentence);
  document.getElementById('cj-offset-num')?.addEventListener('input', refreshCreateSentence);
```

- [ ] **Step 6: Rewrite `submitNewTextJob` to compose `fire_at` from the new fields**

Find:

```js
export async function submitNewTextJob() {
  const nameInput    = document.getElementById('cj-name');
  const channelInput = document.getElementById('cj-channel');
  const fireInput    = document.getElementById('cj-fire');
  const bodyInput    = document.getElementById('cj-body');
  clearFieldErrors([nameInput, channelInput, fireInput, bodyInput]);

  let hasError = false;
  if (!nameInput.value.trim()) { setFieldError(nameInput, 'Job name is required'); hasError = true; }
  if (!channelInput.value) { setFieldError(channelInput, 'Channel is required'); hasError = true; }
  if (!fireInput.value) { setFieldError(fireInput, 'First fire time is required'); hasError = true; }
  if (!bodyInput.value.trim()) { setFieldError(bodyInput, 'Body is required'); hasError = true; }
  if (hasError) return;

  const unit = document.getElementById('cj-unit').value;
  const cjDayOfMonth = unit === 'monthly' ? parseInt(document.getElementById('cj-dom').value, 10) : null;
  const payload = {
    name:       nameInput.value,
    channel_id: channelInput.value,
    title:      document.getElementById('cj-title').value,
    body:       bodyInput.value,
    fire_at:    new Date(fireInput.value).toISOString(),
    recurrence: `${unit}:${document.getElementById('cj-count').value}`,
    day_of_month: cjDayOfMonth,
    last_day_offset: (unit === 'monthly' && cjDayOfMonth === MONTHLY_LAST_DAY) ? readLastDayOffset('cj-offset') : null,
    days_of_week: readDowPicker('cj-dow'),
    mentions:   readMentionsPicker('cj-mentions'),
  };
```

Replace with:

```js
export async function submitNewTextJob() {
  const nameInput    = document.getElementById('cj-name');
  const channelInput = document.getElementById('cj-channel');
  const timeInput    = document.getElementById('cj-time');
  const bodyInput    = document.getElementById('cj-body');
  clearFieldErrors([nameInput, channelInput, timeInput, bodyInput]);

  let hasError = false;
  if (!nameInput.value.trim()) { setFieldError(nameInput, 'Job name is required'); hasError = true; }
  if (!channelInput.value) { setFieldError(channelInput, 'Channel is required'); hasError = true; }
  if (!timeInput.value) { setFieldError(timeInput, 'A starting time is required'); hasError = true; }
  if (!bodyInput.value.trim()) { setFieldError(bodyInput, 'Body is required'); hasError = true; }
  if (hasError) return;

  const unit = document.getElementById('cj-unit').value;
  const cjDayOfMonth = unit === 'monthly' ? parseInt(document.getElementById('cj-dom').value, 10) : null;
  const lastDayOffset = (unit === 'monthly' && cjDayOfMonth === MONTHLY_LAST_DAY) ? readLastDayOffset('cj-offset') : null;

  const start = composeFireAtUtc({
    unit,
    month: unit === 'monthly' ? parseInt(document.getElementById('cj-month').value, 10) : null,
    dateStr: unit !== 'monthly' ? document.getElementById('cj-date').value : null,
    timeStr: timeInput.value,
    dayOfMonth: cjDayOfMonth,
    lastDayOffset: lastDayOffset || 0,
  });
  if (!start || isNaN(start)) { setFieldError(timeInput, 'Could not compute a valid starting date'); return; }

  const payload = {
    name:       nameInput.value,
    channel_id: channelInput.value,
    title:      document.getElementById('cj-title').value,
    body:       bodyInput.value,
    fire_at:    start.toISOString(),
    recurrence: `${unit}:${document.getElementById('cj-count').value}`,
    day_of_month: cjDayOfMonth,
    last_day_offset: lastDayOffset,
    days_of_week: readDowPicker('cj-dow'),
    mentions:   readMentionsPicker('cj-mentions'),
  };
```

(The rest of `submitNewTextJob`, the `fetch(...)` call and error handling below this block, is unchanged — not shown here since it doesn't reference any of the removed/renamed fields.)

- [ ] **Step 7: Verify the admin build succeeds**

Run: `npm run build --prefix admin`
Expected: build succeeds, 0 errors.

- [ ] **Step 8: Manual verification in a running admin panel**

No automated test harness exists for this frontend file (per CLAUDE.md, UI changes are manually verified in a browser). Steps:

1. Start the admin panel directly (`node admin/server.js` on a free port, per the `meerbot-admin runs from main repo, not worktrees` gotcha — do not restart the PM2 `meerbot-admin` process for this). Requires `npm run build --prefix admin` to have been run first (server serves the built `dist/`, not raw `src/`).
2. Open the Scheduled Jobs tab.
3. **Create form, monthly path:** Click "+ Create Job". Confirm field order: Job Name, Posts To, Repeat every, (after selecting Month(s)) Day of month + Fire qualifier, Starting (Month dropdown + Time, no Date field), live sentence, Title, Body, Mentions. Select "Last day of month", "Before", "2". Confirm the sentence reads something like "Will fire every 1 month(s), 2 day(s) before the last day of the month, starting [Month] [Day], [Year] [time] your time ([time] UTC)." and that the displayed day matches what you'd expect for the current UTC month.
4. **Create form, daily path:** Switch Repeat unit to Day(s). Confirm Day of month/Fire qualifier hide, Starting switches to Date+Time (no Month dropdown), sentence updates to "Will fire every N day(s), starting..." with no UTC clarifier.
5. Fill in required fields (name, channel, body) and submit. Confirm the job appears in the tile list with a sensible next-fire time.
6. **Per-job card, monthly:** Expand the newly created job's card (if daily, edit it via the admin UI to monthly first, or create a second job as monthly). Confirm the same field order and live sentence appear, matching the create form's layout. Change the offset number and confirm the sentence updates live without saving.
7. Change to "On" and Save. Reload the page, re-expand the card, confirm the Month/Time/qualifier all reflect the saved state correctly and the sentence matches.
8. Check the browser console for new errors at each step (per the `gotcha-csp-inline-handlers` memory — all event wiring here uses `addEventListener`, consistent with that convention).
9. Delete the test job(s) created during this verification.

- [ ] **Step 9: Commit**

```bash
git add admin/src/jobs.js
git commit -m "feat: rebuild Scheduled Jobs form with live sentence and split starting date"
```

---

### Task 5: Docs sync

**Files:**

- Modify: `c:\vscode\DiscordBotAfkJ\CLAUDE.md` (Key Files table row for `admin/src/index.html` / the Scheduled Jobs tab description, and the `admin/src/jobs.js` module description if one exists in Key Files)
- Modify: `c:\vscode\DiscordBotAfkJ\ARCHITECTURE.md` (Scheduled Jobs tab section, if it describes the old date field/UTC hint)

**Interfaces:**

- Consumes: nothing (docs only).
- Produces: nothing (docs only).

- [ ] **Step 1: Update CLAUDE.md**

Search CLAUDE.md for the Scheduled Jobs tab description (in the Key Files table, likely near where the offset feature's Before/On row was documented in the previous feature). Update it to describe the new field order and the live sentence, removing any reference to the old "UTC hint" or "Current next fire" line if mentioned. Keep the addition brief (1-2 clauses), matching the existing terse table-row style.

- [ ] **Step 2: Update ARCHITECTURE.md**

Search ARCHITECTURE.md for the Scheduled Jobs tab section (added/updated during the previous last-day-offset feature). Update the description of the date/time input and the "will fire" preview to describe the new Month/Date + Time split and the live sentence instead of the old UTC-only hint.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md ARCHITECTURE.md
git commit -m "docs: document the redesigned Scheduled Jobs form fields and live sentence"
```

---

## Post-Implementation

After all tasks are committed and the final whole-branch review is clean, this feature is live for the admin panel once `npm run build --prefix admin` is run in the deployed checkout and `pm2 restart meerbot-admin` picks up the new `dist/` (no `--update-env` needed, admin panel reads config from DB). `utils/jobScheduler.js`'s refactor (Task 1) also needs `pm2 restart meerbot --update-env` to take effect for the bot process. Do not run these restarts without the user's go-ahead — hand the commands to the user rather than running them directly, per this repo's established convention.
