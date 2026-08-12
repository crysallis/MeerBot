# Scheduled Jobs Form Redesign — Design

## Problem

The admin panel's Scheduled Jobs form (both the per-job expanded card and the "Create
Job" form) has two related problems:

1. **The "Will fire at HH:MM UTC on YYYY-MM-DD" hint is misleading for monthly jobs
   with a day-of-month rule.** It's a pure UTC conversion of the literal "First Fire" /
   "Next Fire" datetime field the user typed — it has no awareness of `day_of_month` or
   `last_day_offset` at all. For a job set to "Last day of month, 2 days before," the
   hint shows whatever the typed date converts to, not what the rule will actually
   produce on recurrence. This reads as a schedule prediction but isn't one.

2. **The date field lets you enter a value that contradicts your own day-of-month
   rule.** E.g. picking "Last day of month, 2 days before" but typing a "First Fire"
   date of the 15th — nothing in the form flags or prevents this mismatch. The first
   fire literally uses the typed date (unaffected by the day-of-month rule); only
   *subsequent* fires are computed via `computeMonthlyNext`. This split is invisible in
   the current UI.

## Scope

- Redesign both render paths in `admin/src/jobs.js`: the per-job expanded card
  (`renderScheduledJobs`) and the create-job form (`renderCreateJobForm`).
- Replace the static UTC-conversion hint with a live-updating plain-language sentence
  describing the actual recurrence rule, computed via the real day-of-month clamp logic
  (not a re-derived approximation).
- Reorder fields so the rule (repeat/day-of-month) is established before the starting
  date, matching how you'd describe the schedule out loud.
- Split the "starting" date/time into separate controls, structured so a
  self-contradicting date can't be entered for monthly jobs with a day-of-month rule.
- No backend behavior change: `fire_at` is still assembled into one ISO string and
  posted to the existing `PUT /api/scheduled-jobs/:id` / `POST /api/text-jobs`
  endpoints, unchanged. This is a frontend-composition change, not a schedule-semantics
  change.

## Shared Module Extraction (prerequisite)

To compute an accurate live sentence, the frontend needs the *real* clamp/offset math —
not a duplicated reimplementation that could drift from the backend's actual behavior.
`computeMonthlyNext` itself isn't the right extraction target: it takes an *existing*
`fireAtIso` and advances by `count` months with a catch-up loop (`while (next <= nowMs)`)
— machinery the frontend doesn't want, since at create/edit time there's no existing
fire_at to advance from, only a rule to resolve into a specific day.

The part that's actually shared is the day-resolution logic inside `computeMonthlyNext`'s
`build(m)` inner function — given a year, a month, and the day-of-month rule, what day of
that month does the rule resolve to:

```js
// utils/monthlyRecurrence.js -- zero requires, pure Date math only
const MONTHLY_LAST_DAY = -1;

function resolveDayOfMonth(year, monthIndex, dayOfMonth, lastDayOffset = 0) {
    const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
    if (dayOfMonth === MONTHLY_LAST_DAY) {
        return lastDay - Math.min(Math.max(lastDayOffset || 0, 0), lastDay - 1);
    }
    return Math.min(dayOfMonth, lastDay);
}

module.exports = { resolveDayOfMonth, MONTHLY_LAST_DAY };
```

`utils/jobScheduler.js`'s `computeMonthlyNext` keeps its own file and shape, but its
`build(m)` body calls `resolveDayOfMonth(year, m, dayOfMonth, lastDayOffset)` instead of
inlining the clamp logic — behavior-preserving by construction (same expression, just
named and shared). `admin/server.js` imports `MONTHLY_LAST_DAY` from the new file instead
of `jobScheduler.js` (where it's currently re-exported).

**Module format — plain CommonJS, verified against this project's actual Vite setup.**
`utils/monthlyRecurrence.js` uses `module.exports`, matching every other file in
`utils/`. A raw `import { resolveDayOfMonth } from '../../utils/monthlyRecurrence.js'`
inside a Vite-bundled frontend file does NOT work by default — verified empirically: Vite/
Rollup's default `commonjsOptions.include` is `[/node_modules/]`, so a source-tree CJS
file never goes through CJS-interop and named imports resolve to `undefined` at runtime
(confirmed via a real build + inspecting the emitted bundle, not just a "doesn't error"
check — the naive version *builds cleanly* but silently produces `void 0` everywhere,
which would only surface as a bug during manual testing).

**Fix:** add `commonjsOptions.include` to `admin/vite.config.mjs`:

```js
build: {
    outDir: '../dist',
    emptyOutDir: true,
    commonjsOptions: { include: [/node_modules/, /monthlyRecurrence/] },
},
```

With this, `admin/src/jobs.js` can `import { resolveDayOfMonth, MONTHLY_LAST_DAY } from
'../../../utils/monthlyRecurrence.js'` and the named exports resolve to the real
function/value in the built bundle (verified: grepped the built `dist/assets/*.js` and
confirmed the real function reference appears, not `void 0`).

This is the single source of truth going forward: one function
(`resolveDayOfMonth`), three importers (backend scheduler's `computeMonthlyNext`,
backend API validation for `MONTHLY_LAST_DAY`, frontend sentence builder).

## Field Order

Applies to both the per-job expanded card and the create-job form, unified:

```
Job Name
Posts To
Repeat every [N] [Day(s) / Week(s) / Month(s)]
  ↳ (Monthly only) Day of month: [1-31 / Last day of month]
  ↳ (Monthly only, if Last day of month) Fire: [On / Before] [N] day(s)
Starting:
  ↳ (Monthly) Month: [Jan-Dec dropdown]  +  Time: [HH:MM AM/PM]
  ↳ (Daily/Weekly) Date: [date picker]  +  Time: [HH:MM AM/PM]
Live sentence (read-only, updates on every relevant field change)
[... existing text-job-only fields: Days-of-week (daily/weekly only), Title, Body, Mentions ...]
```

Notes:
- "Posts to" moves earlier in the per-job card (currently after date/recurrence/DOM
  fields) to match the create-job form's existing earlier position — both paths now
  agree.
- The day-of-week picker (`dowPicker`, text-jobs only, e.g. "post only on weekdays")
  is a *different* concept from `day_of_month` — it's an additional filter on top of
  daily/weekly recurrence, already hidden for monthly jobs today. It stays where it is
  in the field flow, positioned after the Starting/sentence block since it doesn't
  participate in computing the next-fire date shown there.

## Starting Controls

**Timezone anchor — UTC, matching existing backend behavior.** `computeMonthlyNext`
works entirely in UTC today (`getUTCHours`, `Date.UTC`) and this redesign does not
change that (see Scope). This has a concrete consequence for composition: "last day of
August" must be resolved as the last day of August *in UTC*, and the Month picker must
be understood as selecting the UTC month — not composed via `new Date(localDateTimeString)`,
which interprets the string in the browser's local timezone and can silently roll the
UTC month/day by one (verified: `new Date('2026-08-31T20:00:00')` on a UTC-4 machine
produces `2026-09-01T00:00:00.000Z` — a real, not hypothetical, boundary case, and
exactly what produced the original misleading hint in the first place). If composition
used local time here, the derived day (Aug 31, from the rule) and the day the backend
later reads back from the stored `fire_at` (Sep 1 UTC) would disagree — reintroducing
the exact mismatch this redesign exists to eliminate, just one layer deeper.

**Monthly recurrence:** no day or year picker — the day is fully determined by
`day_of_month`/`last_day_offset`, so offering a separate day input would let the user
contradict their own rule (the bug this redesign exists to fix). Only:
- **Month** — a `<select>` with 12 options (January–December), representing the UTC
  month.
- **Time** — reuse the existing time-of-day input approach (see Time Control below),
  representing UTC hours/minutes. The live sentence (below) shows the resulting instant
  in the user's local time as well, so the UTC framing doesn't have to be mentally
  translated by hand — but the picker itself operates in UTC to keep composition exact.

Year is never user-facing. It's inferred: build a candidate date via `Date.UTC(year,
selectedMonthIndex, resolveDayOfMonth(year, selectedMonthIndex, dayOfMonth,
lastDayOffset), hh, mm)` using the current UTC year; if that candidate is in the past
relative to now, rebuild with `year + 1`. This mirrors the existing bootstrap pattern in
`nextDailyAt`/`nextWeeklyAt` (`utils/jobScheduler.js`, both already UTC-based), applied
here client-side for the initial `fire_at`. Note `resolveDayOfMonth` needs the year to
resolve leap-year February correctly, so the candidate is built in two passes: resolve
with this-year first, check past/future, only recompute with next year if needed (Feb
29 vs Feb 28 could differ between the two).

**Daily/Weekly recurrence:** a **Date** input (`type="date"`, a real calendar date
picker, interpreted as UTC calendar date — see below) + the same **Time** control,
replacing today's single `type="datetime-local"` field. No derived-day complexity here
— the user picks a real calendar date directly, same freedom as today, just split into
two controls for visual consistency with the monthly path. Composition: parse the
`type="date"` value (`YYYY-MM-DD`) into UTC year/month/day components (never through
`new Date(dateString)` for the same local-timezone-rollover reason as above — use the
component parts directly in `Date.UTC(...)`), combined with the Time control's hh/mm via
`Date.UTC(year, month, day, hh, mm)`.

**Time control:** keep it simple — reuse `type="time"` (24-hour under the hood, browser
renders per locale). Its `.value` is a locale-independent `HH:MM` string; parse the hour/
minute components directly and feed them into `Date.UTC(...)` as shown above — never
route through `new Date(combinedLocalString)`.

**Live-sentence local-time display:** even though the pickers are UTC-anchored, the
live sentence (below) shows the user's own local time as the human-readable summary
(e.g. "starting Aug 31 2026 8:00 PM your time (Sep 1 00:00 UTC)") by converting the
already-correctly-composed `Date.UTC(...)` instant to local via the browser's normal
`Date` methods (`getHours()`, `getDate()`, etc. on the same `Date` object) — this
conversion is display-only and never feeds back into composition.

## Live Sentence

A single read-only text block, updated on every `change`/`input` event from any field
that affects it (repeat count/unit, day-of-month, offset qualifier/number, month
selector or date, time). Rebuilds using `resolveDayOfMonth` (imported from the shared
module, monthly only) plus the `Date.UTC(...)` composition described in Starting
Controls, applied to the current in-progress form values — not by re-reading saved job
state — so it reflects exactly what would be saved if the user hit Save right now.

**Monthly, on the last day:**
> Will fire every [N] month(s), on the last day of the month, starting [Month Day, Year]
> [H:MM AM/PM] your time ([H:MM] UTC).

**Monthly, N days before the last day:**
> Will fire every [N] month(s), [N2] day(s) before the last day of the month, starting
> [Month Day, Year] [H:MM AM/PM] your time ([H:MM] UTC).

**Monthly, fixed day:**
> Will fire every [N] month(s), on the [Nth], starting [Month Day, Year] [H:MM AM/PM]
> your time ([H:MM] UTC).

**Daily:**
> Will fire every [N] day(s), starting [Month Day, Year] [H:MM AM/PM] your time.

**Weekly:**
> Will fire every [N] week(s), starting [Month Day, Year] [H:MM AM/PM] your time.

The UTC clarifier is only shown for Monthly (where the picker is UTC-anchored and could
plausibly differ from local by a day near month boundaries — see Starting Controls);
Daily/Weekly's Date+Time controls are local by nature (a `type="date"` picker has no
inherent timezone), so no UTC clarifier applies there.

Only the *next* occurrence's starting date is shown (not a multi-occurrence list — this
was explicitly decided against, to keep the form uncluttered). The displayed
"[Month Day, Year] [time]" is the same first-fire date the job will actually be saved
with (see Starting Controls above) — for monthly jobs this is guaranteed consistent
with the rule by construction, since there's no way to enter a contradicting day.

This sentence fully replaces:
- The old `formatUtcPreview`/`attachUtcPreview` hint (deleted).
- The old static "Current next fire (UTC): ..." line shown below the fields on the
  per-job card (`.sj-utc-note`, currently updated only after a successful save) — the
  live sentence supersedes it; having both would be redundant and potentially
  contradictory (one showing saved state, one showing in-progress edits).

## Data Flow / Payload (unchanged)

`saveScheduledJob`, `submitNewTextJob`, and their PUT/POST payloads are unchanged in
shape — still one `fire_at` ISO string, `recurrence`, `day_of_month`, `last_day_offset`.
Only how `fire_at`'s underlying `Date` gets constructed changes: instead of reading one
`datetime-local` input's `.value` through `new Date(fireLocal)`, the save functions now
read the Month+Time (monthly) or Date+Time (daily/weekly) pair and the day-of-month/
offset fields, and build the `Date` via the `Date.UTC(...)` composition described in
Starting Controls (never `new Date(localString)`, per the timezone-anchor decision
above). This derivation logic must be a single shared local helper (e.g.
`computeFormFireAt(...)`) called by both the live-sentence updater and the save
functions, so the two can never disagree about what "the starting date" resolves to —
this was already the plan's intent; the correction here is only that the helper's
internal composition must go through `Date.UTC(...)`, not string-based `Date` parsing.

## Out of Scope

- No change to backend recurrence semantics, validation, or the DB schema — this is a
  frontend composition/UX change only.
- No multi-occurrence preview list (explicitly declined).
- No change to the day-of-week (`dowPicker`) filter's own behavior — only its position
  relative to the new Starting block.
- Daily/Weekly jobs do not gain a "starting day is derived" behavior — only Monthly
  jobs have a day derived from a rule; Daily/Weekly keep a freely-editable date, just
  split into two controls instead of one.
