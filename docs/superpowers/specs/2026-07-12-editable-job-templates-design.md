# Editable & Panel-Authored Scheduled Jobs — Design

## Problem

Scheduled job messages (scan reminder, daily reset, AFK expiry, birthday, anniversary,
weekly summary) are hardcoded strings in each handler file, and every job's *existence*
requires a code file (`script_jobs.handler_path`) wired into `SYSTEM_JOBS`. The immediate
need: the Daily Reset message references Guild Duel quests that only make sense Mon-Fri
(crest earning) — Sat/Sun the guild is attacking the boss instead, so a different message
needs to run on those two days.

Investigating that need surfaced the real request: Daily Reset has no data dependency at
all (no DB pulls, no computed values — just static text). It doesn't need to be "code with
editable wrapper text," it needs to be **content you author entirely from the admin panel,
on a schedule you set, with no code file at all** — the same way `/remindme` lets you
schedule a one-off message, but recurring and managed from the panel instead of a slash
command. That's the actual deliverable: a **text job** type.

## Two kinds of job, one editing surface

1. **Text jobs (new).** Fully panel-authored: schedule, repeat, day-of-week filter,
   channel, mentions, title, body. No handler file. You create, edit, and delete these
   entirely from the admin panel — nothing needs a code change or deploy. Daily Reset
   (Mon-Fri) and the new Sat/Sun message are both **text jobs** — dailyReset's existing
   handler file is retired, not duplicated.

2. **Code jobs (existing pattern, generalized).** For jobs that require a DB
   lookup/computation that can't reasonably be expressed as panel-typed text (e.g.
   "who just returned from AFK," which requires querying `member_afk`) — the lookup stays
   in code, but the human-authored wrapper text around it (title, intro line, footer)
   becomes panel-editable via `{{variable}}` tokens, and the computed part is exposed as
   **one pre-formatted block variable**, not a loop/conditional syntax. E.g. afkExpiry
   would expose `{{afk_expired_list}}` as a single newline-joined, already-formatted
   string — the query and per-row formatting stay in `afkExpiry.js`; only the surrounding
   text ("Welcome back to the following AFK users:" / footer) is editable.

   **This pass touches zero code jobs.** afkExpiry/birthdayCheck/anniversaryCheck/
   weeklySummary/scanReminder are untouched. The mechanism above is documented here for
   context on where this is headed, but building it out (a `job_templates`-style override
   table for code jobs, parallel to `text_jobs`) is future work, not part of this schema.

## Scope of this pass

**Build:**

- The `text_job` job type end-to-end: schema, generic tick handler, admin panel
  create/edit/delete UI, mention safety.
- Retire `handlers/dailyReset.js` as a code job. Recreate its Mon-Fri message as a text
  job (you author the exact wording; the late-warning footer is dropped from the message
  — see Late-run tracking below).
- You then create the Sat/Sun message yourself, as a second text job, through the new
  panel UI — this is the proof that the mechanism works, not something built for you in
  code.

**Explicitly out of scope for this pass:**

- The "code job with a block variable" mechanism (afkExpiry's `{{afk_expired_list}}` etc.)
  — described above for forward-compatibility of the schema only, not implemented now.
- Templating birthdayCheck, anniversaryCheck, weeklySummary, scanReminder.
- Conditional/loop syntax in variables (e.g. `{{#if}}`, `{{for_each}}`, repeat blocks) —
  considered and explicitly rejected as too much complexity for what this needs to do.
  Block variables (one pre-computed string, code-formatted) are the chosen alternative
  when a job needs a per-item list.

## Design

### Job dispatch: new `type = 'text_job'`

`jobScheduler.js`'s `tick()` already dispatches on `scheduled_jobs.type`
(`script_job` / `remindme` / `recruitment_followup`), each with its own detail table
joined in. `text_job` follows the same shape:

```sql
CREATE TABLE IF NOT EXISTS text_jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       INTEGER NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,            -- admin-facing label, e.g. "Daily Reset (Weekend)"
  channel_id   TEXT NOT NULL,
  title        TEXT,
  body         TEXT NOT NULL,
  mentions     TEXT,                     -- JSON array, see Mention safety
  days_of_week TEXT,                     -- e.g. "1,2,3,4,5" (ISO: Mon=1..Sun=7); NULL = every day
  log_name     TEXT NOT NULL UNIQUE      -- key into scheduler_log, e.g. "text_job_3"
);
```

`tick()` gains a branch: for `type === 'text_job'`, advance `fire_at` via the existing
`nextFire()` (same as `script_job` — a daily recurrence always rolls forward by one day
regardless of whether today matched the filter, so no special-case is needed there), check
`days_of_week` against today and skip sending if it doesn't match, otherwise render
`title`/`body` through `renderTemplate` (no variables in this pass since text jobs have no
code-computed data by definition — the substitution call is a no-op today but keeps the
code path identical to code jobs for later reuse), build the embed, send with
`allowedMentions` per the Mention safety section, and call `logJobRun(job.log_name, isLate)`.

This is a genuine job type alongside `script_job`/`remindme`/`recruitment_followup` —
not a special case bolted onto `script_job` — because unlike those, its content and
existence are entirely DB-driven with no `require()` of a handler file.

### Late-run tracking (generalized, not per-job)

Today only `dailyReset.js` computes lateness (`Date.now() - fire_at`, compares to
`LATE_WARNING_MINUTES` from `botConfig`) and only that job logs `late` to
`scheduler_log`. Since text jobs have no per-job code to put this logic in, it moves into
`tick()` itself: compute `lateMinutes` from `job.fire_at` once, for every job type, and
pass `isLate` into each type's `logJobRun` call. `MAX_LATE_MINUTES` (currently 120,
hardcoded in `dailyReset.js` — skip sending entirely if the bot was down that long) also
becomes a shared constant applied generically: if a job is over the max-late threshold,
skip the send but still log the run (so `/schedule` shows it happened, just suppressed) —
matches "remove it from the message but keep logging it."

Net effect: the `⚠️ Fired N min late` footer that used to appear *in the Discord message*
goes away entirely (text jobs don't have per-job code to conditionally add a footer, and
that's an accepted tradeoff) — but the lateness fact is still recorded in
`scheduler_log.late` for every job type, viewable via the existing job-run log in the
admin panel. This is strictly more coverage than today (previously only dailyReset logged
lateness at all).

### Variable substitution: `utils/jobTemplate.js`

```js
function renderTemplate(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (m, key) => key in vars ? String(vars[key]) : m);
}
```

Unknown tokens are left literal rather than replaced with empty string, so a typo'd
variable is visibly wrong instead of silently vanishing. Text jobs call this with an
empty `vars` object (no variables exist for pure text jobs) purely so the send path is
identical to what a future code job will do — not because text jobs need substitution
today.

### Admin panel

**New "Create Job" flow** (`admin/src/jobs.js`), producing a text job:

- Name (admin-facing label).
- Schedule: fire date/time (existing datetime-local picker pattern) + repeat
  (daily:N / weekly:N, existing pattern) + day-of-week filter (checkboxes Mon..Sun,
  default all checked = every day).
- Channel picker (existing `channelOptions()` pattern).
- Title field, Body textarea.
- Mentions picker (see Mention safety) — separate control from the text fields.
- Save creates the `scheduled_jobs` + `text_jobs` rows.

**Existing job cards** gain a Delete action for text jobs only (script/remindme/
recruitment-followup jobs stay code-managed, not deletable from the panel). Text job
cards reuse the existing fire-time/recurrence/enabled/channel editing UI already built
for system jobs, plus inline title/body/mentions editing (no separate "Edit Text"
toggle needed since for a text job that *is* the whole job).

New routes in `admin/server.js`:

- `POST /api/text-jobs` — creates `scheduled_jobs` (type='text_job') + `text_jobs` rows.
- `PUT /api/text-jobs/:id` — updates any of schedule/channel/title/body/mentions/
  days_of_week.
- `DELETE /api/text-jobs/:id` — deletes both rows (cascade via FK).

`GET /api/scheduled-jobs` gains the text_jobs join (parallel to how it already joins
`script_jobs`) so text jobs appear in the same list as system jobs, distinguished by
`type`.

### Mention safety

Free text an admin saves has none of the game-data validation the rest of the codebase
applies to OCR'd input. Where the actual risk lives, precisely:

- **`title`/`body` go into the embed** (`EmbedBuilder.setTitle`/`setDescription`), and
  Discord never scans embed text for mentions to notify on — `@everyone`, `<@&roleId>`,
  anything typed there renders as inert text by construction, regardless of
  `allowedMentions`. There is no ping path through these two fields, full stop.
- **The only path that can ping is `message.content`.** This codebase already sends real
  mentions this way (see `slash-commands/clashfronts.js`: `content` carries `<@id>` syntax,
  `allowedMentions: { users: [...] }` allow-lists which of those IDs are honored). Text
  jobs use the same mechanism: the structured `mentions` field is the only thing that ever
  writes into `content`, and `allowedMentions` is the enforced allow-list on that content —
  not decorative, since it's the actual guard on the one field that can notify. If the
  mention-building logic ever produced something unexpected in `content`, `allowedMentions`
  is what stops it from pinging.
- **The admin panel's mentions picker** (checkboxes for @everyone/@here, a role
  multi-select) is the only UI that writes to the `mentions` field — never derived from
  parsing `title`/`body`. Typing `@everyone` into the body has no effect beyond rendering
  as literal text in the embed; it never reaches `content`.

The `mentions` array → `{ content, allowedMentions }` mapping is pure, dependency-free
logic (no DB, no discord client) and is unit-tested directly — see `buildMentions` in
Testing below.

Variable *values* (not template text) are not sanitized in this pass — no variable in
scope carries free text (text jobs have none; a future code job's `{{afk_expired_list}}`
is built from DB names, not raw user input). **Revisit before any variable carries text
an admin didn't type themselves** — confirm `allowedMentions: { parse: [] }` on the whole
send still covers it rather than assuming.

## Testing

- Unit test `renderTemplate` (known key substitutes, unknown key left literal, no-op with
  empty vars).
- Unit test the generic lateness calc (`computeLateness`) (on-time run: not late; past
  `LATE_WARNING_MINUTES`: late but sendable; past `MAX_LATE_MINUTES`: too late to send).
- Unit test `days_of_week` filtering (`shouldFireToday`) (job with `"1,2,3,4,5"` skips on
  a mocked Saturday date, fires on a mocked Wednesday date; `null`/`""` fires every day).
- Unit test `buildMentions` (the `mentions` array → `{ content, allowedMentions }` mapping):
  empty array → empty content, `parse: []`; `{type:'everyone'}` → content contains
  `@everyone`, `parse: ['everyone']`; `{type:'here'}` → `parse: ['everyone']` (Discord's
  `parse` allow-list has no separate `'here'` flag — `'everyone'` covers both `@everyone`
  and `@here` in content); `{type:'role',id}` → `allowedMentions.roles` includes that id,
  `parse` stays `[]`; a role + `@everyone` together → both `parse: ['everyone']` and
  `roles: [id]` set correctly, not conflicting.
- Manual: create a text job from the panel end-to-end (schedule, channel, title, body,
  mentions), verify it fires and sends correctly, edit it, verify the edit takes effect,
  delete it, verify it's gone from `scheduled_jobs`/`text_jobs` and stops firing.
- Manual: save a text job with `@everyone` typed into the body, verify the sent message
  shows it as plain text with no ping; add `@everyone` via the mentions picker instead,
  verify that send does ping.
- Manual: retire `dailyReset.js`, recreate its Mon-Fri message as a text job with a
  Mon-Fri day filter, verify it still fires only on weekdays at the same time as before.
- Manual: create the Sat/Sun message as a second text job, verify both coexist
  independently (separate cards, separately toggleable) and only the correct one fires
  on a given day.
