# Monthly Last-Day-of-Month Offset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a monthly scheduled job fire N days before the last day of the month (instead of only on it), so a fixed rule like "remind 2 days before the shop resets" stays correct across variable month lengths without manual per-month edits.

**Architecture:** Add a nullable `last_day_offset` column to `scheduled_jobs`, meaningful only when `day_of_month = -1` (the existing "last day of month" sentinel). `computeMonthlyNext()` in `utils/jobScheduler.js` subtracts the offset from that month's actual last day, clamped so it can never cross into the previous month. The admin panel's "Day of month" picker reveals a Before/On qualifier + number field only when "Last day of month" is selected.

**Tech Stack:** Node.js, better-sqlite3, `node:test` + `assert/strict`, vanilla JS admin frontend (no framework).

## Global Constraints

- No "after last day" option — Before and On only (decided during brainstorming, see `docs/superpowers/specs/2026-08-11-monthly-last-day-offset-design.md`).
- Offset qualifier UI appears **only** when day-of-month is set to "Last day of month" (`-1`). Fixed numbered days never show it.
- The "Before N days" offset is clamped per-month using that month's own actual last day (`lastDayOfMonth - 1` max) — it must never cross into the previous month, even if a stale/large N was saved while looking at a longer month.
- `NULL` or `0` for `last_day_offset` means "on the last day" — today's existing `-1` behavior, unchanged. No backfill needed for existing rows.
- Follow this repo's established column-addition pattern exactly: `CREATE TABLE IF NOT EXISTS` reflects the current full shape (for fresh DBs), **and** a `PRAGMA table_info` check + conditional `ALTER TABLE` runs every startup (for existing DBs) — see `utils/db.js:368-377` for the precedent to copy.

---

### Task 1: Database column

**Files:**

- Modify: `utils/db.js:89-97` (the `scheduled_jobs` CREATE TABLE statement)
- Modify: `utils/db.js` (add a new startup column-check block, following the `translation_relay_messages` pattern at lines 368-377)

**Interfaces:**

- Consumes: nothing new.
- Produces: `scheduled_jobs.last_day_offset` (nullable INTEGER) available to any code that reads/writes `scheduled_jobs` rows.

- [ ] **Step 1: Add the column to the CREATE TABLE statement**

In `utils/db.js`, find:

```js
  CREATE TABLE IF NOT EXISTS scheduled_jobs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    type          TEXT NOT NULL,
    fire_at       TEXT NOT NULL,
    recurrence    TEXT,
    day_of_month  INTEGER,
    created_at    TEXT NOT NULL,
    enabled       INTEGER NOT NULL DEFAULT 1
  );
```

Change it to:

```js
  CREATE TABLE IF NOT EXISTS scheduled_jobs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    type            TEXT NOT NULL,
    fire_at         TEXT NOT NULL,
    recurrence      TEXT,
    day_of_month    INTEGER,
    last_day_offset INTEGER,
    created_at      TEXT NOT NULL,
    enabled         INTEGER NOT NULL DEFAULT 1
  );
```

- [ ] **Step 2: Add the startup column-check block for existing databases**

Immediately after the `translation_relay_messages` column-check block (after line 377, `if (!relayMessageCols.has(col)) db.exec(ddl); }`), add:

```js
// scheduled_jobs may already exist (shipped pre-offset-qualifier) without the
// last_day_offset column · SQLite has no ADD COLUMN IF NOT EXISTS, so check
// first. Safe to run every startup.
const scheduledJobCols = new Set(db.prepare("PRAGMA table_info(scheduled_jobs)").all().map(c => c.name));
for (const [col, ddl] of [
    ['last_day_offset', 'ALTER TABLE scheduled_jobs ADD COLUMN last_day_offset INTEGER'],
]) {
    if (!scheduledJobCols.has(col)) db.exec(ddl);
}
```

- [ ] **Step 3: Verify the column exists on the real dev DB**

Run:
```
node -e "require('dotenv').config(); const db = require('./utils/db'); console.log(require('better-sqlite3')(process.env.GUILD_DB_PATH).prepare(\"PRAGMA table_info(scheduled_jobs)\").all().map(c => c.name));"
```

Expected: array includes `last_day_offset`.

Note: run this against a worktree with its own `.env`/test DB if available, not directly against production `guild.db`, per this repo's dotenv/DB-isolation convention (`utils/db.js` falls back to production `guild.db` if `GUILD_DB_PATH` isn't loaded).

- [ ] **Step 4: Commit**

```bash
git add utils/db.js
git commit -m "feat: add last_day_offset column to scheduled_jobs"
```

---

### Task 2: `computeMonthlyNext` offset logic + tests

**Files:**

- Modify: `utils/jobScheduler.js:17-40` (`computeMonthlyNext` function)
- Create: `utils/jobScheduler.test.js`

**Interfaces:**

- Consumes: `scheduled_jobs.last_day_offset` (Task 1).
- Produces: `computeMonthlyNext(fireAtIso, count, dayOfMonth, nowMs, lastDayOffset)` — new 5th parameter, defaults to `0` when omitted so existing callers/tests without the offset concept keep working. `nextFire(job)` (the sole caller) passes `job.last_day_offset`.

- [ ] **Step 1: Write the failing tests**

Create `utils/jobScheduler.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeMonthlyNext } = require('./jobScheduler');

// All computeMonthlyNext calls use a nowMs far in the past so the "while (next <= nowMs)"
// loop never advances past the immediately-computed month -- isolates the one calculation
// under test from the "skip to future" catch-up behavior exercised separately below.
const FAR_PAST = 0;

test('computeMonthlyNext: fixed day of month, unaffected by offset param', () => {
  // Jan 15 09:00 UTC, monthly:1, day_of_month=15, no offset -> Feb 15 09:00 UTC
  const next = computeMonthlyNext('2026-01-15T09:00:00.000Z', 1, 15, FAR_PAST, 5);
  assert.equal(next, '2026-02-15T09:00:00.000Z');
});

test('computeMonthlyNext: last day of month, no offset (0) fires on the actual last day', () => {
  // From Jan -> next month is Feb 2026 (not a leap year), last day = 28
  const next = computeMonthlyNext('2026-01-31T20:00:00.000Z', 1, -1, FAR_PAST, 0);
  assert.equal(next, '2026-02-28T20:00:00.000Z');
});

test('computeMonthlyNext: last day of month, no offset argument defaults to on-the-last-day', () => {
  const next = computeMonthlyNext('2026-01-31T20:00:00.000Z', 1, -1, FAR_PAST);
  assert.equal(next, '2026-02-28T20:00:00.000Z');
});

test('computeMonthlyNext: 2 days before last day in a 28-day February', () => {
  // From Jan -> Feb 2026, last day 28, 2 days before -> the 26th
  const next = computeMonthlyNext('2026-01-31T20:00:00.000Z', 1, -1, FAR_PAST, 2);
  assert.equal(next, '2026-02-26T20:00:00.000Z');
});

test('computeMonthlyNext: 2 days before last day in a 31-day January', () => {
  // From Dec -> Jan 2027, last day 31, 2 days before -> the 29th
  const next = computeMonthlyNext('2026-12-31T20:00:00.000Z', 1, -1, FAR_PAST, 2);
  assert.equal(next, '2027-01-29T20:00:00.000Z');
});

test('computeMonthlyNext: offset clamps rather than crossing into the previous month', () => {
  // Feb 2026 has 28 days. An offset of 40 (absurdly large) must clamp to 27
  // (lastDayOfMonth - 1 = 27), landing on Feb 1, never rolling into January.
  const next = computeMonthlyNext('2026-01-31T20:00:00.000Z', 1, -1, FAR_PAST, 40);
  assert.equal(next, '2026-02-01T20:00:00.000Z');
});

test('computeMonthlyNext: offset re-clamps smaller in a shorter month than the one it was saved under', () => {
  // A job saved as "28 days before" while looking at a 31-day month should
  // still clamp correctly the moment it computes against a 28-day February.
  const next = computeMonthlyNext('2026-01-31T20:00:00.000Z', 1, -1, FAR_PAST, 28);
  assert.equal(next, '2026-02-01T20:00:00.000Z'); // clamps to 27 (28-1), same as the 40 case
});

test('computeMonthlyNext: last day of month with offset, leap year February', () => {
  // 2028 is a leap year -> Feb has 29 days. 2 days before -> the 27th.
  const next = computeMonthlyNext('2028-01-29T20:00:00.000Z', 1, -1, FAR_PAST, 2);
  assert.equal(next, '2028-02-27T20:00:00.000Z');
});

test('computeMonthlyNext: negative offset is treated as 0 (on last day)', () => {
  const next = computeMonthlyNext('2026-01-31T20:00:00.000Z', 1, -1, FAR_PAST, -5);
  assert.equal(next, '2026-02-28T20:00:00.000Z');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test utils/jobScheduler.test.js`
Expected: FAIL — `computeMonthlyNext` doesn't yet accept a 5th parameter, so every offset-related assertion produces the old on-the-last-day date instead of the offset date. The "no offset" tests may already pass; the offset tests must fail.

- [ ] **Step 3: Implement the offset logic**

In `utils/jobScheduler.js`, replace:

```js
function computeMonthlyNext(fireAtIso, count, dayOfMonth, nowMs) {
    const prev = new Date(fireAtIso);
    const hh = prev.getUTCHours();
    const mm = prev.getUTCMinutes();
    const ss = prev.getUTCSeconds();
    const year = prev.getUTCFullYear();
    let month = prev.getUTCMonth();

    function build(m) {
        const lastDayOfMonth = new Date(Date.UTC(year, m + 1, 0)).getUTCDate();
        const day = dayOfMonth === MONTHLY_LAST_DAY
            ? lastDayOfMonth
            : Math.min(dayOfMonth, lastDayOfMonth);
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

with:

```js
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

- [ ] **Step 4: Update the sole caller, `nextFire`**

In `utils/jobScheduler.js`, find:

```js
    if (unit === 'monthly') {
        return computeMonthlyNext(job.fire_at, count, job.day_of_month, Date.now());
    }
```

Change to:

```js
    if (unit === 'monthly') {
        return computeMonthlyNext(job.fire_at, count, job.day_of_month, Date.now(), job.last_day_offset);
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test utils/jobScheduler.test.js`
Expected: PASS, all 9 tests.

- [ ] **Step 6: Commit**

```bash
git add utils/jobScheduler.js utils/jobScheduler.test.js
git commit -m "feat: support N-days-before-last-day offset in computeMonthlyNext"
```

---

### Task 3: Admin API — validation, GET, PUT, POST

**Files:**

- Modify: `admin/server.js:295-338` (GET `/api/scheduled-jobs`)
- Modify: `admin/server.js:340-356` (`validateRecurrence`)
- Modify: `admin/server.js:358-393` (PUT `/api/scheduled-jobs/:id`)
- Modify: `admin/server.js:395-418` (`validateTextJobBody`)
- Modify: `admin/server.js:420-` (POST `/api/text-jobs`, and its PUT counterpart if present — grep for `app.put('/api/text-jobs/:id'` to find it)

**Interfaces:**

- Consumes: `scheduled_jobs.last_day_offset` (Task 1).
- Produces: `last_day_offset` field on every job object returned by `GET /api/scheduled-jobs`; accepted (and validated) by `PUT /api/scheduled-jobs/:id`, `POST /api/text-jobs`, and `PUT /api/text-jobs/:id`.

- [ ] **Step 1: Extend `validateRecurrence` to validate the offset**

(`PUT /api/text-jobs/:id`, at `admin/server.js:453`, destructures only `{ name, channel_id, title, body, days_of_week, mentions }` — it never touches `day_of_month`/`recurrence`. Schedule fields for both job types flow exclusively through `PUT /api/scheduled-jobs/:id` (the frontend's `saveTextJobFull` calls `saveScheduledJob(id)` first for exactly this reason). So `PUT /api/text-jobs/:id` needs no changes for this feature — skip it.)

Find:

```js
function validateRecurrence(recurrence, dayOfMonth) {
    const [unit, n] = (recurrence || 'daily:1').split(':');
    const count = parseInt(n || '1', 10);
    if (!['daily', 'weekly', 'monthly'].includes(unit) || isNaN(count) || count < 1) {
        return 'recurrence must be daily:N, weekly:N, or monthly:N (N >= 1)';
    }
    if (unit === 'monthly') {
        const dom = parseInt(dayOfMonth, 10);
        if (dayOfMonth === undefined || dayOfMonth === null || isNaN(dom) || dom === 0 || dom < -1 || dom > 31) {
            return 'day_of_month is required for monthly recurrence (1-31, or -1 for last day of month)';
        }
    }
    return null;
}
```

Replace with:

```js
function validateRecurrence(recurrence, dayOfMonth, lastDayOffset) {
    const [unit, n] = (recurrence || 'daily:1').split(':');
    const count = parseInt(n || '1', 10);
    if (!['daily', 'weekly', 'monthly'].includes(unit) || isNaN(count) || count < 1) {
        return 'recurrence must be daily:N, weekly:N, or monthly:N (N >= 1)';
    }
    if (unit === 'monthly') {
        const dom = parseInt(dayOfMonth, 10);
        if (dayOfMonth === undefined || dayOfMonth === null || isNaN(dom) || dom === 0 || dom < -1 || dom > 31) {
            return 'day_of_month is required for monthly recurrence (1-31, or -1 for last day of month)';
        }
        // last_day_offset only means something when day_of_month is the "last day"
        // sentinel -- reject a nonzero offset paired with a fixed numbered day so a
        // stale/leftover value from switching the dropdown can't silently apply.
        if (lastDayOffset !== undefined && lastDayOffset !== null && lastDayOffset !== 0) {
            if (dom !== MONTHLY_LAST_DAY) {
                return 'last_day_offset can only be set when day_of_month is -1 (last day of month)';
            }
            const offset = parseInt(lastDayOffset, 10);
            if (isNaN(offset) || offset < 0) {
                return 'last_day_offset must be a non-negative integer';
            }
        }
    }
    return null;
}
```

This references `MONTHLY_LAST_DAY`. `admin/server.js` doesn't currently import it from `jobScheduler.js` — add the import. Find the top of `admin/server.js` where other `utils/` modules are required (grep `require('../utils` or similar) and add:

```js
const { MONTHLY_LAST_DAY } = require('../utils/jobScheduler');
```

This requires `MONTHLY_LAST_DAY` to be exported from `utils/jobScheduler.js`. Find:

```js
module.exports = { initJobScheduler, computeMonthlyNext };
```

Change to:

```js
module.exports = { initJobScheduler, computeMonthlyNext, MONTHLY_LAST_DAY };
```

(If grepping the top of `admin/server.js` shows no existing `require('../utils/...')` pattern — e.g. it goes through a different `db` accessor layer instead — place the new require alongside whatever equivalent local-module imports already exist near the top of the file, keeping the same relative-path style.)

- [ ] **Step 3: Update GET `/api/scheduled-jobs` to include the new field**

In the `scriptRows` mapping, find:

```js
        `).all().map(r => ({
            id:           r.id,
            type:         'script_job',
            display:      JOB_DISPLAY[r.handler_path] ?? r.handler_path,
            handler_path: r.handler_path,
            fire_at:      r.fire_at,
            recurrence:   r.recurrence ?? 'daily:1',
            day_of_month: r.day_of_month,
            enabled:      r.enabled ?? 1,
        }));
```

Change the SQL and mapping together — find:
```js
            SELECT sj.id, sj.fire_at, sj.recurrence, sj.day_of_month, sj.enabled, scj.handler_path
```
to:
```js
            SELECT sj.id, sj.fire_at, sj.recurrence, sj.day_of_month, sj.last_day_offset, sj.enabled, scj.handler_path
```
and add `last_day_offset: r.last_day_offset,` to the mapped object (right after `day_of_month: r.day_of_month,`).

Do the identical two edits for the `textRows` query/mapping just below it (same two lines, `sj.day_of_month` → add `, sj.last_day_offset`, and add `last_day_offset: r.last_day_offset,` to that mapped object too).

- [ ] **Step 4: Update PUT `/api/scheduled-jobs/:id`**

Find:

```js
app.put('/api/scheduled-jobs/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { fire_at, recurrence, day_of_month, enabled } = req.body;

    if (fire_at) {
        const d = new Date(fire_at);
        if (isNaN(d)) return res.status(400).json({ error: 'Invalid fire_at datetime' });
    }

    if (recurrence) {
        const err = validateRecurrence(recurrence, day_of_month);
        if (err) return res.status(400).json({ error: err });
    }

    try {
        const exists = db.prepare('SELECT 1 FROM scheduled_jobs WHERE id = ? AND type IN (?, ?)').get(id, 'script_job', 'text_job');
        if (!exists) return res.status(404).json({ error: 'Job not found' });

        const fields = [];
        const values = [];
        if (enabled !== undefined)      { fields.push('enabled = ?');      values.push(enabled ? 1 : 0); }
        if (fire_at !== undefined)      { fields.push('fire_at = ?');      values.push(fire_at); }
        if (recurrence !== undefined)   { fields.push('recurrence = ?');   values.push(recurrence); }
        if (day_of_month !== undefined) { fields.push('day_of_month = ?'); values.push(day_of_month); }

        if (fields.length) {
            values.push(id);
            db.prepare(`UPDATE scheduled_jobs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
        }

        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
```

Replace with:

```js
app.put('/api/scheduled-jobs/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { fire_at, recurrence, day_of_month, last_day_offset, enabled } = req.body;

    if (fire_at) {
        const d = new Date(fire_at);
        if (isNaN(d)) return res.status(400).json({ error: 'Invalid fire_at datetime' });
    }

    if (recurrence) {
        const err = validateRecurrence(recurrence, day_of_month, last_day_offset);
        if (err) return res.status(400).json({ error: err });
    }

    try {
        const exists = db.prepare('SELECT 1 FROM scheduled_jobs WHERE id = ? AND type IN (?, ?)').get(id, 'script_job', 'text_job');
        if (!exists) return res.status(404).json({ error: 'Job not found' });

        const fields = [];
        const values = [];
        if (enabled !== undefined)         { fields.push('enabled = ?');         values.push(enabled ? 1 : 0); }
        if (fire_at !== undefined)         { fields.push('fire_at = ?');         values.push(fire_at); }
        if (recurrence !== undefined)      { fields.push('recurrence = ?');      values.push(recurrence); }
        if (day_of_month !== undefined)    { fields.push('day_of_month = ?');    values.push(day_of_month); }
        if (last_day_offset !== undefined) { fields.push('last_day_offset = ?'); values.push(last_day_offset); }

        if (fields.length) {
            values.push(id);
            db.prepare(`UPDATE scheduled_jobs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
        }

        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
```

- [ ] **Step 5: Update `validateTextJobBody` and POST `/api/text-jobs`**

Find:

```js
function validateTextJobBody(body) {
    const { name, channel_id, body: msgBody, fire_at, recurrence, day_of_month } = body;
    if (!name || !String(name).trim()) return 'name is required';
    if (!channel_id) return 'channel_id is required';
    if (!msgBody || !String(msgBody).trim()) return 'body is required';
    if (!fire_at || isNaN(new Date(fire_at))) return 'Invalid fire_at datetime';

    const recurErr = validateRecurrence(recurrence, day_of_month);
    if (recurErr) return recurErr;
```

Change the destructure and the `validateRecurrence` call:

```js
function validateTextJobBody(body) {
    const { name, channel_id, body: msgBody, fire_at, recurrence, day_of_month, last_day_offset } = body;
    if (!name || !String(name).trim()) return 'name is required';
    if (!channel_id) return 'channel_id is required';
    if (!msgBody || !String(msgBody).trim()) return 'body is required';
    if (!fire_at || isNaN(new Date(fire_at))) return 'Invalid fire_at datetime';

    const recurErr = validateRecurrence(recurrence, day_of_month, last_day_offset);
    if (recurErr) return recurErr;
```

Then find:

```js
app.post('/api/text-jobs', (req, res) => {
    const err = validateTextJobBody(req.body);
    if (err) return res.status(400).json({ error: err });

    const { name, channel_id, title, body: msgBody, fire_at, recurrence, day_of_month, days_of_week, mentions } = req.body;
    const now = new Date().toISOString();
    const unit = (recurrence || 'daily:1').split(':')[0];
    // A monthly job must fire every month regardless of weekday -- force
    // all-days here as a backstop even though the UI hides the dow picker
    // while monthly is selected.
    const effectiveDow = unit === 'monthly' ? null : (days_of_week || null);

    try {
        const insertJob = db.prepare(
            'INSERT INTO scheduled_jobs (type, fire_at, recurrence, day_of_month, created_at) VALUES (?, ?, ?, ?, ?)'
        ).run('text_job', fire_at, recurrence || 'daily:1', unit === 'monthly' ? day_of_month : null, now);
```

Replace with:

```js
app.post('/api/text-jobs', (req, res) => {
    const err = validateTextJobBody(req.body);
    if (err) return res.status(400).json({ error: err });

    const { name, channel_id, title, body: msgBody, fire_at, recurrence, day_of_month, last_day_offset, days_of_week, mentions } = req.body;
    const now = new Date().toISOString();
    const unit = (recurrence || 'daily:1').split(':')[0];
    // A monthly job must fire every month regardless of weekday -- force
    // all-days here as a backstop even though the UI hides the dow picker
    // while monthly is selected.
    const effectiveDow = unit === 'monthly' ? null : (days_of_week || null);
    const effectiveOffset = (unit === 'monthly' && day_of_month === MONTHLY_LAST_DAY) ? (last_day_offset || 0) : null;

    try {
        const insertJob = db.prepare(
            'INSERT INTO scheduled_jobs (type, fire_at, recurrence, day_of_month, last_day_offset, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run('text_job', fire_at, recurrence || 'daily:1', unit === 'monthly' ? day_of_month : null, effectiveOffset, now);
```

Note: `MONTHLY_LAST_DAY` is now imported at the top of this file from Step 2 above.

- [ ] **Step 6: Verify the file has no leftover references to the old 4-arg `validateRecurrence` signature**

Run: `grep -n "validateRecurrence(" admin/server.js`
Expected: every call site passes 3 arguments (`recurrence, day_of_month, last_day_offset` or the equivalent local variable names) — none still pass only 2.

- [ ] **Step 7: Commit**

```bash
git add admin/server.js utils/jobScheduler.js
git commit -m "feat: validate and persist last_day_offset through the scheduled-jobs admin API"
```

---

### Task 4: Admin UI — offset picker

**Files:**

- Modify: `admin/src/jobs.js:102-118` (`domPicker`) — add a new helper next to it
- Modify: `admin/src/jobs.js` (per-job card render, ~lines 242-251)
- Modify: `admin/src/jobs.js` (create-job form render, ~lines 496-510)
- Modify: `admin/src/jobs.js` (`saveScheduledJob`, ~lines 370-400)
- Modify: `admin/src/jobs.js` (`submitNewTextJob`, ~lines 552-589)

**Interfaces:**

- Consumes: `job.last_day_offset` from `GET /api/scheduled-jobs` (Task 3); `last_day_offset` field accepted by `PUT /api/scheduled-jobs/:id` and `POST /api/text-jobs` (Task 3).
- Produces: `lastDayOffsetField(idPrefix, jobId, initialOffset)` — new exported-from-module (not exported to other files, just a local function like `domPicker`) helper returning a `<div class="sj-field">` containing the Before/On select + number input, plus a `readLastDayOffset(idPrefix, jobId)` helper returning the offset as an integer (`0` when "On" is selected or the field is hidden).

- [ ] **Step 1: Add the offset field builder next to `domPicker`**

In `admin/src/jobs.js`, immediately after the `domPicker` function (after its closing `}` around line 118), add:

```js
// Only meaningful when day_of_month is MONTHLY_LAST_DAY (-1). "On" needs no
// number (implicitly offset 0); "Before" reveals a required >=1 number input.
// The per-month clamp that prevents crossing into the previous month happens
// server-side in computeMonthlyNext -- this field has no client-side max.
function lastDayOffsetField(idPrefix, initialOffset) {
  const wrap = document.createElement('div');
  wrap.className = 'sj-field';
  wrap.id = `${idPrefix}-wrap`;
  wrap.innerHTML = '<label>Fire</label>';

  const row = document.createElement('div');
  row.className = 'sj-recur-row';

  const qualSel = document.createElement('select');
  qualSel.id = `${idPrefix}-qual`;
  for (const [val, label] of [['on', 'On'], ['before', 'Before']]) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = label;
    qualSel.appendChild(opt);
  }

  const numInput = document.createElement('input');
  numInput.type = 'number';
  numInput.id = `${idPrefix}-num`;
  numInput.min = '1';
  numInput.style.width = '60px';

  const initial = parseInt(initialOffset, 10) || 0;
  if (initial > 0) {
    qualSel.value = 'before';
    numInput.value = String(initial);
  } else {
    qualSel.value = 'on';
    numInput.value = '1';
    numInput.style.display = 'none';
  }

  qualSel.addEventListener('change', () => {
    numInput.style.display = qualSel.value === 'before' ? '' : 'none';
  });

  const daysLabel = document.createElement('span');
  daysLabel.textContent = 'day(s)';
  daysLabel.className = 'muted-note';

  row.append(qualSel, numInput, daysLabel);
  wrap.appendChild(row);
  return wrap;
}

// Reads the offset field built by lastDayOffsetField. Returns 0 for "On" or
// when the qualifier select isn't present (e.g. day-of-month isn't "last day").
function readLastDayOffset(idPrefix) {
  const qualSel = document.getElementById(`${idPrefix}-qual`);
  if (!qualSel || qualSel.value === 'on') return 0;
  const numInput = document.getElementById(`${idPrefix}-num`);
  const n = parseInt(numInput.value, 10);
  return isNaN(n) || n < 1 ? 1 : n;
}
```

- [ ] **Step 2: Wire it into the per-job card render**

Find (per-job card render, inside the function that builds `domField`):

```js
    const domField = document.createElement('div');
    domField.className = 'sj-field';
    domField.innerHTML = '<label>Day of month</label>';
    domField.appendChild(domPicker(`sj-dom-${job.id}`, job.day_of_month));
    domField.style.display = unit === 'monthly' ? '' : 'none';
    unitSel.addEventListener('change', () => {
      domField.style.display = unitSel.value === 'monthly' ? '' : 'none';
    });

    fields.append(fireField, recurField, domField);
```

Replace with:

```js
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
```

This references `MONTHLY_LAST_DAY` as a client-side constant (distinct from the server-side one imported in Task 3 — the admin frontend is a separate bundle, no shared import path). Add near the top of `admin/src/jobs.js`, alongside any other top-level constants (check for an existing `const` block near the top of the file, e.g. by running `grep -n "^const\|^import" admin/src/jobs.js | head -20`, and add it there):

```js
const MONTHLY_LAST_DAY = -1;
```

- [ ] **Step 3: Wire it into the create-job form render**

Find:

```js
  const domField = document.createElement('div');
  domField.className = 'sj-field';
  domField.innerHTML = '<label>Day of month</label>';
  domField.appendChild(domPicker('cj-dom', null));
  domField.style.display = 'none';

  const dowField = document.createElement('div');
  dowField.className = 'sj-field';
  dowField.innerHTML = '<label>Days</label>';
  dowField.appendChild(dowPicker('cj-dow', null));

  unitSel.addEventListener('change', () => {
    domField.style.display = unitSel.value === 'monthly' ? '' : 'none';
    dowField.style.display = unitSel.value === 'monthly' ? 'none' : '';
  });
```

Replace with:

```js
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

Then find, further down in the same function:

```js
  const fields = document.createElement('div');
  fields.className = 'sj-fields';
  fields.append(nameField, chField, fireField, recurField, domField, dowField, titleField, bodyField, mentionsField, actionsField);
```

Replace with:

```js
  const fields = document.createElement('div');
  fields.className = 'sj-fields';
  fields.append(nameField, chField, fireField, recurField, domField, offsetField, dowField, titleField, bodyField, mentionsField, actionsField);
```

- [ ] **Step 4: Send the offset in `saveScheduledJob`**

Find:

```js
export async function saveScheduledJob(id) {
  const fireInput = document.getElementById(`sj-fire-${id}`);
  const fireLocal = fireInput.value;
  const count     = document.getElementById(`sj-count-${id}`).value;
  const unit      = document.getElementById(`sj-unit-${id}`).value;
  const domEl     = document.getElementById(`sj-dom-${id}`);
  const dayOfMonth = unit === 'monthly' ? parseInt(domEl.value, 10) : null;

  if (!fireLocal) { setFieldError(fireInput, 'Next fire time is required'); return false; }
  setFieldError(fireInput, '');
  const fireAt   = new Date(fireLocal).toISOString();
  const recurrence = `${unit}:${count}`;

  const res = await fetch(`/api/scheduled-jobs/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fire_at: fireAt, recurrence, day_of_month: dayOfMonth }),
  });
```

Replace with:

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
```

- [ ] **Step 5: Send the offset in `submitNewTextJob`**

Find:

```js
  const unit = document.getElementById('cj-unit').value;
  const payload = {
    name:       nameInput.value,
    channel_id: channelInput.value,
    title:      document.getElementById('cj-title').value,
    body:       bodyInput.value,
    fire_at:    new Date(fireInput.value).toISOString(),
    recurrence: `${unit}:${document.getElementById('cj-count').value}`,
    day_of_month: unit === 'monthly' ? parseInt(document.getElementById('cj-dom').value, 10) : null,
    days_of_week: readDowPicker('cj-dow'),
    mentions:   readMentionsPicker('cj-mentions'),
  };
```

Replace with:

```js
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

- [ ] **Step 6: Manual verification in a running admin panel**

This is frontend DOM code with no existing test harness in this repo (per CLAUDE.md, UI changes get manually verified in a browser, not unit-tested). Steps:

1. Start the admin panel per this repo's dev instructions (`node admin/server.js` on a free port, per the `meerbot-admin runs from main repo, not worktrees` gotcha — do not restart the PM2 `meerbot-admin` process for this).
2. Open the Scheduled Jobs tab.
3. Create a new text job (or edit an existing one), set Repeat to Month(s), Day of month to "Last day of month" — confirm the "Fire: [On/Before] [num] day(s)" row appears.
4. Confirm switching Day of month back to a fixed number (e.g. 15) hides the Fire row.
5. Select "Before", enter 2, save. Reload the page (re-fetch `/api/scheduled-jobs`) and confirm the card still shows "Before" / "2" after reload (proves the round-trip through the API and back).
6. Switch back to "On" and save; confirm reload shows "On" with the number field hidden.
7. Check the browser console for errors at each step (this repo's CSP blocks inline handlers silently — confirm no console errors from that class of bug, per the `gotcha-csp-inline-handlers` memory).

- [ ] **Step 7: Commit**

```bash
git add admin/src/jobs.js
git commit -m "feat: add Before/On last-day offset picker to the Scheduled Jobs admin UI"
```

---

### Task 5: Docs sync

**Files:**

- Modify: `c:\vscode\DiscordBotAfkJ\CLAUDE.md` (Database Tables section — `scheduled_jobs` row; Scheduled Messages section if relevant)

**Interfaces:**

- Consumes: nothing (docs only).
- Produces: nothing (docs only).

- [ ] **Step 1: Update the `scheduled_jobs` line in CLAUDE.md's Database Tables section**

Find the line describing `scheduled_jobs` in the Database Tables section of `CLAUDE.md` (search for `scheduled_jobs` · unified job queue). Add a mention of `last_day_offset`, e.g. append to that table row's description: "`last_day_offset` (nullable, meaningful only when `day_of_month=-1`: N = fire N days before the last day of the month; NULL/0 = on the last day)".

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document last_day_offset in CLAUDE.md"
```

---

## Post-Implementation

After all tasks are committed, this feature is done for production use once `pm2 restart meerbot-admin` (no `--update-env` needed, per this repo's convention — the admin panel reads config from DB) picks up the new `admin/server.js`/`admin/src/jobs.js`, and `pm2 restart meerbot --update-env` picks up the new `utils/jobScheduler.js`/`utils/db.js`. Do not run these restarts without the user's go-ahead (per this repo's `feedback-pm2-needs-elevation` convention — hand the commands to the user rather than running them directly).
