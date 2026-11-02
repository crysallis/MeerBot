# Member Warnings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (Daniel asked for native work, no subagents). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a leader-only `/warn` command set and a `member_warnings` record, plus an automatic warning logged whenever the post-scan 3+ day offline callout lists a member.

**Architecture:** Two bot-owned tables in `utils/db.js`. All warning logic lives in `utils/warnings.js` as functions that take a better-sqlite3 handle first (same shape as `guildDuelRecap.js`), so tests run on an in-memory DB. `utils/warningReport.js` holds the pure formatting. `slash-commands/warn.js` and a strike-confirm button handler are thin. `scan.js` calls one recording function after the scan.

**Tech Stack:** discord.js v14, better-sqlite3, `node --test` (`npm test`).

**Spec:** `docs/superpowers/specs/2026-11-02-member-warnings-design.md`

## Global Constraints

- No em dashes anywhere (code, strings, docs). Use `·` or `...`. No explanatory code comments.
- Every `/warn` reply is ephemeral. `setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)` on the command. `enforcePermissions(interaction, 'warn', sub)` first in `execute`.
- Default expiry is 3 months. Custom `expires` is `YYYY-MM-DD`, stored as end of that UTC day (`T23:59:59.999Z`).
- Active = `ended_at IS NULL` and `expires_at >= now`. Expired = past `expires_at`. Ended early = `ended_at` set (wins over expired). All derived at read time, no job.
- `strike` deletes the row. Only the `warning_log` row (action, actor, time, member) remains. Tests never touch the real `guild.db` rows beyond exact-id fixtures with cleanup in `afterEach`; handle-taking functions are tested on `new Database(':memory:')`.
- Automatic warning: reason `Offline 3+ days` (uses `INACTIVITY_DAYS`), `created_by = 'bot'`, `auto_add` log row. Dedup reads `warning_log` `auto_add` rows, never `member_warnings`.
- Docs sync in the same commit as behavior: `help.js`, `CLAUDE.md`, `README.md`, `ARCHITECTURE.md`.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`, preceded by a blank line. Gate each commit on `npm test` exit code, not a grep of its output.

## Review Focus

Inputs and conditions the spec implies but no obvious task test covers. Each has its test in the named task.

1. A strike leaving the reason in earlier `edit`/`expire` log rows. Expected: gone. (Task 2)
2. A struck automatic warning coming back on the next scan while the member is still offline. Expected: not re-created. (Task 2)
3. The same snapshot processed twice, or a member who returns and goes offline again. Expected: once per streak, a fresh one after a return. (Task 2)
4. `expires` malformed (`2026-02-30`, `soon`) or in the past. Expected: rejected with a plain message, nothing written. (Tasks 2 and 4)
5. A member with many long warnings, or a `list`/`report` with nothing to show. Expected: chunked under Discord's limits, and a plain empty message. (Task 3)
6. A strike confirm clicked by someone else, after a minute, or after the warning is already gone. Expected: refused, nothing deleted. (Task 4)

## File Structure

- Modify `utils/db.js`: CREATE both tables, `mergeMembers` repoint.
- Create `utils/warnings.js`: lifecycle, queries, automatic recording. Create `utils/warnings.test.js`.
- Create `utils/warningReport.js` and `utils/warningReport.test.js`: report ranking, history text, chunking.
- Create `slash-commands/warn.js` and `slash-commands/warn.test.js`.
- Create `utils/handlers/warnStrikeButtonHandler.js` and `utils/handlers/warnStrikeButtonHandler.test.js`; modify `index.js` button chain.
- Modify `slash-commands/scan.js`: shared inactive query, `recordOfflineWarnings` call.
- Modify `slash-commands/help.js`, `CLAUDE.md`, `README.md`, `ARCHITECTURE.md`.

---

### Task 1: Tables and merge repoint

**Files:**
- Modify: `utils/db.js` (CREATE block near `member_notes`, ~line 177; `mergeMembers` ~line 672)
- Test: `utils/db.test.js` (reuse `makeMergeMember` and `mergeFixtures`; extend its `afterEach` cleanup to delete from the two new tables by exact member id)

**Interfaces:**
- Produces: tables `member_warnings(id, member_id, reason, created_by, created_at, expires_at, ended_at, ended_by)` and `warning_log(id, warning_id, member_id, action, actor, at, detail)`. Column names exactly these; `warning_log.warning_id` has no FK.

- [ ] **Step 1: Write failing tests** in `utils/db.test.js`: `member_warnings table has the expected columns` and `warning_log table has the expected columns` (same `PRAGMA table_info` + sorted `deepEqual` style as the existing table tests); `mergeMembers repoints warnings and warning log rows onto the kept member` (insert one `member_warnings` and one `warning_log` row for the dropped fixture member, merge into the kept one, assert both rows now carry the kept id).
- [ ] **Step 2: Run** `node --test utils/db.test.js`. Expected: the three new tests FAIL.
- [ ] **Step 3: Implement** the CREATE TABLE IF NOT EXISTS statements (member_id `REFERENCES members(id)` on `member_warnings`, indexes on `member_warnings(member_id)` and `warning_log(member_id)`) and two `UPDATE ... SET member_id = ?` lines in `mergeMembers` next to `member_checkin_dms`.
- [ ] **Step 4: Run** `node --test utils/db.test.js`. Expected: all PASS.
- [ ] **Step 5: Commit** `feat: member_warnings and warning_log tables`.

### Task 2: Warning lifecycle and automatic recording

**Files:**
- Create: `utils/warnings.js`
- Test: `utils/warnings.test.js` (in-memory DB with the two new tables, plus minimal `members`, `snapshots`, `member_snapshots`, same copy-the-schema approach as `guildDuelRecap.test.js`; add one test that compares the in-memory column lists to the real `db.js` tables so drift fails loudly)

**Interfaces** (all take `h`, a better-sqlite3 handle; `now` is a `Date`, default `new Date()`):
- Produces:
  - `defaultExpiry(now): string` (ISO, now plus 3 calendar months UTC)
  - `parseExpiryDate(text, now): string | null` (ISO end of that UTC day; `null` for a malformed or non-real date; also `null` when that day's end is before `now`)
  - `warningStatus(w, now): 'active' | 'expired' | 'ended'`
  - `addWarning(h, { memberId, reason, createdBy, expiresAt, now }): number` (writes an `add` log row; `expiresAt` defaults to `defaultExpiry(now)`)
  - `editWarning(h, id, { reason, expiresAt }, actor, now): boolean` (only provided fields; false if nothing changed or id missing; log `detail` is JSON `{ reason: { from, to }, expires_at: { from, to } }` for changed fields only)
  - `expireWarning(h, id, actor, note, now): boolean` (false if missing or already ended; note goes in log detail)
  - `strikeWarning(h, id, actor, now): { memberId } | null` (deletes row, blanks `detail` on all prior log rows for that id, writes a `strike` row with null detail)
  - `listWarnings(h, memberId, now): Array<warning & { status, edits: Array<{ at, actor, detail }> }>` newest first
  - `countActive(h, memberId, now): number`
  - `pickerWarnings(h, memberId, mode, now): warning[]` where mode is `'edit'` (newest 25 existing, active first), `'expire'` (active only), `'strike'` (all)
  - `needsAutoWarning(h, memberId): boolean` (no `auto_add` log row yet, or a `member_snapshots` row with `last_active NOT LIKE '%d ago'` in a snapshot scraped after the latest `auto_add` row's `at`)
  - `recordOfflineWarnings(h, inactiveRows, { thresholdDays, now }): number` where `inactiveRows` is `[{ member_id, days_inactive }]`; returns how many were created

- [ ] **Step 1: Write failing tests**, named and asserting:
  - `defaultExpiry adds three calendar months`: `2026-11-02T10:00:00Z` gives `2027-02-02T10:00:00.000Z`.
  - `parseExpiryDate takes a real future date as end of that UTC day`: `'2026-12-31'` gives `'2026-12-31T23:59:59.999Z'`; `null` for `'2026-02-30'`, `'soon'`, `''`, and for a date before `now`.
  - `warningStatus`: active; expired when `expires_at` is past; `ended` when `ended_at` is set even if also past expiry.
  - `addWarning writes the row and an add log row`; `editWarning amends only given fields, never created_by or created_at, and logs old and new`; `editWarning returns false when nothing changes`.
  - `expireWarning keeps the row, sets ended_at and ended_by, logs the note`; `expireWarning refuses an already ended warning`.
  - `strikeWarning deletes the row and leaves one strike log row with no detail` and, Review Focus 1, `strikeWarning blanks detail on earlier edit and expire log rows for that warning` (assert no log row for that warning contains the old reason text).
  - `listWarnings shows expired and ended warnings with status, newest first, with edit lines`; `countActive ignores expired and ended`.
  - `pickerWarnings modes`: expire returns only active; edit caps at 25 with active first; strike returns all.
  - Review Focus 2 and 3: `recordOfflineWarnings creates one warning per member and a second call on the same data creates none`; `a struck automatic warning is not re-created while the member stays offline`; `a member seen active in a later snapshot gets a new automatic warning`; `the auto_add log row detail records the days inactive`; reason is `Offline 3+ days` for `thresholdDays: 3`; `created_by` is `bot`.
- [ ] **Step 2: Run** `node --test utils/warnings.test.js`. Expected: FAIL, module missing.
- [ ] **Step 3: Implement** everything in the Produces list in `utils/warnings.js`. Wrap multi-statement writes (strike scrub, add plus log) in `h.transaction`. Timestamps via `now.toISOString()` (never `datetime('now')`, mixing formats breaks string compares, see CLAUDE.md gotcha).
- [ ] **Step 4: Run** `node --test utils/warnings.test.js`. Expected: all PASS.
- [ ] **Step 5: Run** `npm test`; commit only on exit code 0. Commit `feat: warning lifecycle and automatic offline recording`.

### Task 3: Report and history formatting

**Files:**
- Create: `utils/warningReport.js`
- Test: `utils/warningReport.test.js`

**Interfaces:**
- Consumes: `warningStatus` from Task 2; warning rows shaped `{ id, member_id, reason, created_by, created_at, expires_at, ended_at, ended_by }`.
- Produces:
  - `buildReport(rows, { includeExpired }, now): Array<{ memberId, name, active, total, latest: { createdAt, reason, status } }>` where `rows` are warnings joined with `name`. Default keeps members with 1+ active, ranked by active count desc then latest `created_at` desc then name. `includeExpired` also keeps members whose warnings have all lapsed.
  - `reportLines(entries, { includeExpired }): string[]` one line per member: `**name** · N active · latest YYYY-MM-DD · reason...` (reason truncated at 80 characters with `...`).
  - `historyLines(warnings): string[]` one block per warning: `#id · status · reason`, then added by (`bot` shown as `MeerBot`, Discord ids as `<@id>`), dates, ended-early line, edit lines.
  - `chunkLines(lines, max = 3800): string[]` greedy, never splits a line, a single line over `max` is hard-cut with `...`.

- [ ] **Step 1: Write failing tests**: `ranks by active count then recency`; `drops members with only expired warnings by default and keeps them with includeExpired`; `report line truncates a long reason`; `empty rows give no entries` (Review Focus 5); `historyLines marks expired and ended early distinctly and shows edit lines`; `bot-created warnings read as MeerBot`; `chunkLines keeps every chunk under max and never splits a line`; `chunkLines hard-cuts one oversize line`.
- [ ] **Step 2: Run** `node --test utils/warningReport.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the four pure functions above.
- [ ] **Step 4: Run** it again. Expected: PASS.
- [ ] **Step 5: Commit** `feat: warning report and history formatting`.

### Task 4: The /warn command and strike confirm button

**Files:**
- Create: `slash-commands/warn.js`, `utils/handlers/warnStrikeButtonHandler.js`
- Modify: `index.js:131-139` (button chain)
- Test: `slash-commands/warn.test.js` (builder and autocomplete shape, like `slash-commands/guildduel.test.js`), `utils/handlers/warnStrikeButtonHandler.test.js` (fake interaction objects)

**Interfaces:**
- Consumes: everything in Tasks 2 and 3; `enforcePermissions(interaction, 'warn', sub)` from `utils/permissions`; `db` from `utils/db`.
- Produces:
  - `warn.js` exports `{ data, execute, autocomplete }`. Subcommands and options (in order): `add member reason [expires]`, `edit member warning [reason] [expires]`, `expire member warning [note]`, `strike member warning`, `list member`, `report [include_expired:boolean]`. `member` and `warning` use autocomplete; `reason` max length 500; `note` max length 200.
  - `handleWarnStrikeButton(interaction): Promise<boolean>`, returns false for any `customId` not starting `warn_strike`.
  - Button ids: `warn_strike:<warningId>:<userId>` (confirm) and `warn_strike_cancel:<userId>`.

- [ ] **Step 1: Write failing tests**:
  - `warn.test.js`: `/warn has exactly the six subcommands in order`; `add needs member and reason, expires optional`; `edit's reason and expires are optional`; `/warn is restricted to Manage Server by default` (`default_member_permissions` equals the ManageGuild bit); `member autocomplete returns only active non-pending members, at most 25`; `warning autocomplete scopes to the chosen member and mode` (values are warning ids as strings, label starts `#id`, length at most 100).
  - Button handler: `ignores customIds that are not warn_strike`; `refuses another user` (Review Focus 6, nothing deleted); `refuses a confirm older than 60 seconds`; `says so when the warning no longer exists`; `cancel changes nothing`; `confirm re-checks permission and strikes`. Use an injected/mocked `enforcePermissions` via the `module.exports` call pattern (see CLAUDE.md gotcha on mocks).
- [ ] **Step 2: Run** both test files. Expected: FAIL.
- [ ] **Step 3: Implement** `warn.js`: member lookup is `ingame_name = ? COLLATE NOCASE` on an active member, plain not-found reply otherwise; `add`/`edit` run `parseExpiryDate` and reply `Expiry must be a real future date as YYYY-MM-DD (to end a warning now, use /warn expire).` on `null`, writing nothing; `list` replies with the active count first, then `chunkLines(historyLines(...))` as embed descriptions (first via `reply`, rest via ephemeral `followUp`), and a plain message for a member with no warnings; `report` loads all warnings joined to members (`SELECT w.*, m.ingame_name AS name`), builds with `buildReport`, same chunking, plain message when empty. `strike` replies with a confirm and cancel `ActionRowBuilder` (Danger and Secondary), ephemeral, naming the warning id and member only (no reason text).
- [ ] **Step 4: Implement** `handleWarnStrikeButton`: parse customId; reject if `interaction.user.id` differs from the embedded user id, or `Date.now() - interaction.message.createdTimestamp > 60000`; `enforcePermissions(interaction, 'warn', 'strike')`; confirm calls `strikeWarning`, then `interaction.update` replacing the message with a one-line result and no buttons, then posts `🗑️ <@actor> struck warning #id for <member name>` to `COMMAND_LOG_CHANNEL_ID` via `interaction.client.channels.cache.get` (skip silently when unset). In `index.js`, extend the chain: after `handleGloryctaCancelButton`, `if (!handled) await handleWarnStrikeButton(interaction)` (make `handled` reassignable from each prior call).
- [ ] **Step 5: Run** `node --test slash-commands/warn.test.js utils/handlers/warnStrikeButtonHandler.test.js`. Expected: PASS. Then `node -e "require('./slash-commands/warn')"` from the repo root with no error (the admin server `require`s every command file to list subcommands, so loading must have no side effects).
- [ ] **Step 6: Run** `npm test`; commit on exit 0. Commit `feat: /warn commands and strike confirmation`.

### Task 5: Automatic recording after each scan

**Files:**
- Modify: `slash-commands/scan.js` (`postInactivityAlert` ~line 41, post-scan block ~line 228)
- Test: covered by Task 2's `recordOfflineWarnings` tests; here only a load check and a manual dry run.

**Interfaces:**
- Consumes: `recordOfflineWarnings(h, inactiveRows, { thresholdDays, now })` from Task 2.
- Produces: `loadInactiveRows(inactiveDays): Array<{ member_id, name, last_active, discord_id, days_inactive }>` in `scan.js`, the single query both the callout and the recorder use (same filters as now: latest snapshot, `m.active = 1`, no `member_afk` row, `last_active` like `Nd ago` with N at least `inactiveDays`; add `ms.member_id` to the select).

- [ ] **Step 1: Refactor** `postInactivityAlert` to build its list from `loadInactiveRows`, keeping the sort, lines, embed and footer exactly as they are.
- [ ] **Step 2: Add** `recordOfflineWarnings` call: in the post-scan block, immediately before `await postInactivityAlert(...)`, `try { const n = warnings.recordOfflineWarnings(db, loadInactiveRows(days).map(({ member_id, days_inactive }) => ({ member_id, days_inactive })), { thresholdDays: days, now: new Date() }); if (n) console.log(...) } catch (err) { console.error('[Warnings] ...', err.message) }`. It must run even when `INACTIVITY_ALERT_CHANNEL_ID` is unset, so it cannot live inside `postInactivityAlert`.
- [ ] **Step 3: Verify** `node -e "require('./slash-commands/scan')"` loads; run `npm test`, exit 0.
- [ ] **Step 4: Dry run against a copy**: copy `guild.db` to the scratchpad, run `recordOfflineWarnings` on it with the latest snapshot's inactive rows, confirm the count equals the number of members in the last callout and a second run returns 0. Never write to the real `guild.db`.
- [ ] **Step 5: Commit** `feat: log a warning for each member in the 3+ day offline callout`.

### Task 6: Help, docs, final check

**Files:**
- Modify: `slash-commands/help.js` (add a `warn` entry after `guildduel`, plus a `summaries.warn` line), `CLAUDE.md` (Key Files rows for `warnings.js`, `warningReport.js`, `warn.js`, `warnStrikeButtonHandler.js`; Slash Commands rows; Database Tables for both tables; the strike/dedup decisions), `README.md` (command table), `ARCHITECTURE.md` (schema list and a `warn.js` section)

- [ ] **Step 1: Add** the `help.js` entry: one line per subcommand, each ending `Only you see the reply.` and `Defaults to Manage Server only.` where applicable (the `/help` reply-visibility rule). Summary line: `add · edit · expire · strike · list · report member warnings`.
- [ ] **Step 2: Update** the three docs. State in `CLAUDE.md`: dedup reads `warning_log` `auto_add` rows so a strike sticks; strike scrubs earlier log detail; no em dashes.
- [ ] **Step 3: Check Ask MeerBot**: with a fake non-leader member, `buildCapabilitySummary`/`visibleCommands` must not list `/warn` (the Manage Server default is read off `slash-commands/warn.js`). Add the assertion to an existing Ask test file if one covers default-permission commands, otherwise verify by a one-off `node -e` and note the result in the commit body.
- [ ] **Step 4: Run** `npm test`, exit 0. Commit `docs: /warn in help, CLAUDE.md, README, ARCHITECTURE`. Then `git log --oneline -6` and `git status` to confirm everything landed.
- [ ] **Step 5: Hand Daniel the restart**: `pm2 restart meerbot --update-env` (and `meerbot-admin` is unaffected). Remind that the first scan after the restart logs a warning for everyone currently 3+ days offline, and that `/warn` needs its permission rules set on the admin Permissions tab if anyone beyond Manage Server holders should use it.
