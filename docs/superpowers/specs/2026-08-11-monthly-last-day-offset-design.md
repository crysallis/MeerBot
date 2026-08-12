# Monthly "Last Day of Month" Offset Qualifier — Design

## Problem

Scheduled jobs with `recurrence: monthly` support a `day_of_month` field, including a
`-1` sentinel meaning "the last day of the month" (handled in `computeMonthlyNext()`,
`utils/jobScheduler.js`). There's no way to say "N days before the last day" — which
matters because the last day of a month isn't a fixed offset from a fixed anchor: 2 days
before Jan 31 is the 29th, but 2 days before Feb 28 is the 26th. A user wanting "remind
everyone 2 days before the shop resets" (shop resets on the last day of each month)
currently has to manually update the job every month, which defeats the point of
recurrence.

A fixed numbered day (e.g. "the 3rd of every month") doesn't have this problem — a
before/after offset from a fixed day is always the same fixed day, so the offset
qualifier is only meaningful when the target is "last day of month."

## Scope

- Add a **Before / On** qualifier (no "After" — decided unnecessary during brainstorming)
  usable only when `day_of_month = -1` (last day of month).
- "Before N days" always resolves within the *same* month — never crosses into the
  previous month, even if N is large enough that it would (clamped).
- No changes to fixed-day-of-month behavior, weekly/daily recurrence, or any other
  scheduled-job type.

## Data Model

Add one nullable column to `scheduled_jobs`:

```sql
ALTER TABLE scheduled_jobs ADD COLUMN last_day_offset INTEGER;
```

(then fold into the `CREATE TABLE IF NOT EXISTS scheduled_jobs` statement in
`utils/db.js`, per this repo's no-migration-trail convention.)

Semantics:
- Meaningful **only** when `day_of_month = -1`. Ignored/irrelevant for any other
  `day_of_month` value or any non-monthly recurrence.
- `NULL` or `0` → "on the last day" (today's existing `-1` behavior, unchanged — old rows
  need no backfill).
- Positive integer `N` → "N days before the last day of the month."
- Never negative. There is no "after" case.

## Fire-Date Computation

`computeMonthlyNext()` in `utils/jobScheduler.js`, inside the `build(m)` helper's
`day_of_month === MONTHLY_LAST_DAY` branch:

```js
const lastDayOfMonth = new Date(Date.UTC(year, m + 1, 0)).getUTCDate();
const offset = Math.min(Math.max(job.last_day_offset || 0, 0), lastDayOfMonth - 1);
const day = dayOfMonth === MONTHLY_LAST_DAY
    ? lastDayOfMonth - offset
    : Math.min(dayOfMonth, lastDayOfMonth);
```

The clamp `Math.min(offset, lastDayOfMonth - 1)` is evaluated fresh per month, using
*that* month's own actual last day — so a job saved as "28 days before" while looking at
a 31-day month automatically re-clamps to a smaller effective offset in February, rather
than crossing into January. This is the same "recompute from source, don't ratchet"
principle already used for the day-of-month clamp on the line below it.

The fixed-day branch is untouched.

## Admin UI (`admin/src/jobs.js`)

In `domPicker` (and its counterpart in the create-job form), when the day-of-month
`<select>` value is `-1`, reveal a second row:

- A dropdown: **Before** / **On**.
- A number input, `min=1`, shown and required only when **Before** is selected; hidden
  (and value treated as 0) when **On** is selected.

No client-side max — the per-month clamp described above is authoritative and
self-corrects across month-length changes without the UI needing to predict every
month's length.

On save, this posts `last_day_offset` alongside the existing `day_of_month` and
`recurrence` fields to the job create/update endpoints (`admin/server.js`), which pass
it straight through to the `scheduled_jobs` row.

Existing jobs with `day_of_month = -1` and no stored offset render as **On** by default
(`last_day_offset ?? 0`).

## Out of Scope

- "After last day" (rolls into next month) — considered and explicitly dropped.
- Offsets on fixed numbered days — redundant with just picking the target day directly.
- Cross-month offsets — deliberately clamped out, not supported.
