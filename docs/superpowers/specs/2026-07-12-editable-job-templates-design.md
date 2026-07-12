# Editable Scheduled Job Templates — Design

## Problem

Scheduled job messages (scan reminder, daily reset, AFK expiry, birthday, anniversary,
weekly summary) are hardcoded strings in each handler file. The immediate need: the
Daily Reset message references Guild Duel quests that only make sense Mon-Fri (crest
earning) — Sat/Sun the guild is attacking the boss instead, so the message needs to say
something different, and neither variant should require a code deploy to edit going
forward.

## Scope

This pass covers **Daily Reset only**, split into a weekday job and a weekend job, each
with admin-editable title/body text. It is built so the same mechanism (a `job_templates`
table + `{{variable}}` substitution) can be extended to other jobs later without a schema
change — but no other job is touched in this pass.

Explicitly out of scope for this pass:
- Templating afkExpiry, birthdayCheck, anniversaryCheck, weeklySummary, scanReminder.
- Admin-authored brand-new jobs (create a job from scratch in the panel).
- Conditional/loop syntax in variables (e.g. `{{#if}}`, repeat blocks). Substitution is
  flat key → string replace only.
- A structured bullet-list editor. The body is one free-text field; bullets are typed as
  literal `• text` lines same as today.

## Design

### Storage: `job_templates` table

```sql
CREATE TABLE IF NOT EXISTS job_templates (
  handler_path TEXT PRIMARY KEY,
  title        TEXT,
  body         TEXT,
  mentions     TEXT,   -- JSON array, see Mention safety below
  updated_at   TEXT NOT NULL
);
```

A row exists only once an admin has edited that job's text via the panel — mirrors the
`bot_config` DB-override-over-code-default pattern already used elsewhere in this repo.
No row means the handler's hardcoded default title/body is used (and no configured
mentions), so this ships with zero required migration/backfill.

### Variable substitution: `utils/jobTemplate.js`

```js
function renderTemplate(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (m, key) => key in vars ? String(vars[key]) : m);
}
```

Each handler declares its own small `vars` object built from whatever it already computes
in code (DB pulls, math, etc. all stay in code — only the human-authored wrapper text
becomes editable). Daily Reset exposes `{{late_minutes}}`. Unknown tokens are left
literal rather than replaced with empty string, so a typo'd variable is visibly wrong
instead of silently vanishing.

### Daily Reset split into two jobs

Two `SYSTEM_JOBS` entries in `jobScheduler.js`, both firing daily at 00:00 like today:

- `./handlers/dailyReset` — Mon-Fri. No-ops (returns early, no message, no log) on Sat/Sun.
- `./handlers/dailyResetWeekend` — Sat/Sun. No-ops on Mon-Fri.

They are independent jobs per the "two different jobs, not tied together" decision —
separate rows in `scheduled_jobs`/`script_jobs`, separately toggleable/editable in the
admin panel, no shared recurrence concept.

Both call a shared helper, e.g. `postResetMessage(client, job, { logName, defaultTitle, defaultBody })`
that:
1. Checks the day-of-week guard for that variant; returns early if not today.
2. Computes `lateMinutes` (existing logic, unchanged) and the `MAX_LATE_MINUTES` skip.
3. Looks up `job_templates` for this handler's path; falls back to `defaultTitle`/`defaultBody`
   if no row.
4. Runs both through `renderTemplate` with `{ late_minutes: lateMinutes }`.
5. Builds the embed (title, body as description, late-footer if applicable) and sends it
   to `GENERAL_CHANNEL_ID`.
6. Calls `logJobRun(logName, isLate)` — `logName` differs per variant (`daily_reset` /
   `daily_reset_weekend`) so `/schedule` and the admin panel's job-run log distinguish them.

The weekday job keeps its current default body (the existing 6-bullet Guild Duel Quests
text). The weekend job's default body is new text reflecting the boss-attack phase — you
write this text; it is a business/tone decision (not a mechanical extraction), so drafting
that copy is not something to reflect just from the codebase.

### Admin panel

`admin/src/jobs.js`: each job card gets an "Edit Text" toggle revealing:
- Title textfield, pre-filled from `job_templates` if present, else the code default.
- Body textarea, same pre-fill rule.
- A static hint line listing that job's available variables, e.g. `Variables: {{late_minutes}}`.
- A mentions picker (checkboxes/select for @everyone, @here, and guild roles) — separate
  control from the text fields, see Mention safety below.
- Save button (separate from the existing fire-time/recurrence Save).
- "Reset to default" link — deletes the `job_templates` row for that handler_path.

New route `PUT /api/scheduled-jobs/:id/template` in `admin/server.js`: looks up the job's
`handler_path` from `scheduled_jobs`/`script_jobs` by `:id`, upserts
`(handler_path, title, body, mentions, updated_at)` into `job_templates`. `DELETE` on the
same route removes the row (reset to default).

`GET /api/scheduled-jobs` gains `template_title`/`template_body` (current effective values,
DB override or code default) plus a `variables` array per job, so the panel can render the
edit form and hint line without a second round-trip. The two Daily Reset handler defaults
(and their variable lists) live in a small lookup the server route reads from — same shape
as the existing `JOB_DISPLAY` map in `admin/server.js`.

### Handler default text as source of truth for "what variables exist"

Rather than a separate variables registry, each handler exports its default
title/body/vars shape (e.g. `module.exports.template = { defaultTitle, defaultBody, vars: ['late_minutes'] }`)
so the admin route can read it directly — avoids the defaults drifting out of sync between
the handler and a separately maintained list.

### Mention safety

Title/body are free text an admin can save without any of the game state validation the
rest of the codebase applies to OCR'd data — so two guardrails, decided together:

1. **Mentions are never parsed out of template text.** Every templated send passes
   `allowedMentions: { parse: [] }` to `channel.send()`. If a saved title/body contains
   `@everyone`, `@here`, or `<@&roleId>`, Discord renders it as inert plain text — it will
   not ping anyone. This is enforced at the send call, not by scrubbing the saved string,
   so it can't be bypassed by a template that wasn't anticipated.
2. **Real mentions come from a separate structured field, not typed text.** `job_templates`
   gains a `mentions` column (JSON array of `{ type: 'everyone' | 'here' | 'role' | 'user', id? }`).
   The admin panel exposes this as an explicit picker (role/channel/@everyone/@here) next to
   the title/body fields — visually and mechanically distinct from the free-text areas. Only
   entries from this field are turned into real mention syntax and added to `allowedMentions.parse`
   / `allowedMentions.roles` at send time. If someone types `@everyone` into the body, it is
   expected to render literally as text — visible and correctable via the mentions picker,
   not silently either firing or silently stripped.

`renderTemplate` itself does no escaping of variable values in this pass — the only variable
today (`{{late_minutes}}`) is a number computed in code, not free text, so there's nothing to
sanitize yet. **This must be revisited before any future variable carries free text an admin
didn't type** (e.g. an AFK `{{reason}}` or in-game `{{name}}` for afkExpiry) — those values
should go through the same "rendered as literal text, never as live mentions" treatment,
since `allowedMentions: { parse: [] }` on the whole send already covers this case too, but
it's worth re-confirming when that variable is added rather than assuming it still holds.

## Testing

- Unit test `renderTemplate` (known key substitutes, unknown key left literal, no keys/no-op).
- Unit test the day-of-week guards for both handlers (mock `Date`, assert no-op on wrong
  days, assert send attempted on right days).
- Manual: edit Daily Reset (weekday) text in admin panel, verify it saves and the next
  simulated fire uses it; verify "Reset to default" reverts to code default; verify the
  weekend job is a separate, independently toggleable card.
- Manual: save a template with `@everyone` typed into the body, verify the sent message
  shows it as plain text with no ping; add `@everyone` via the mentions picker instead,
  verify that send does ping.
