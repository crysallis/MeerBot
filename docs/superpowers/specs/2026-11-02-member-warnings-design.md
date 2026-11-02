# Member warnings · design

Status: draft for approval · 2026-11-02 · bot repo (`MeerBot`), no miner changes.

## Intent

Leadership has no record of a member's pattern. The bot already raises two signals (the 3+ day offline list after each `/scan`, and `/guildduel low`) but both are alerts that leave nothing behind, so a member who is flagged four times over a season looks identical to one flagged once. This adds a warning log: every warning against a member is recorded with who added it, when, what for, and when it stops counting, and leaders can pull one member's whole history or a collective report.

Warnings are a record, not enforcement. Nothing happens automatically because a warning exists.

## Goals

- Record warnings per member with a free-text reason, who added it, when, and an expiry. There is no type list; none is known yet.
- Leaders can add, edit, expire early, and strike (delete) a warning.
- One member's full history in one view, with the active count first.
- A collective report in the style of `/guildduel low`.
- The 3+ day offline callout logs a warning automatically for every member it lists, linked to Discord or not, once per absence streak. The warning records that the member reached the 3 day limit.
- Every `/warn` action leaves a persistent log row, including the bot's own automatic add.

## Non-goals

- No automatic consequence of any kind (no DMs, role changes, kicks, escalation thresholds).
- No message to the member about their warning, public or DM. Not yet. The data must not make adding one later hard.
- Nothing surfaced in `/member`. `/member` is open to everyone, warnings are leader-only.
- No stats-site or admin-panel UI in this version.
- No other automatic sources (`/guildduel low`, non-participation) in this version. Non-participation warnings are manual.

## Anti-goals (a failure even if it technically works)

- A struck warning leaving its contents anywhere (reason text) once confirmed.
- Any `/warn` reply visible to non-leaders. Every reply is ephemeral.
- A warning silently vanishing from history by expiring. Expired and ended-early warnings stay visible in `/warn list`.
- The automatic warning firing repeatedly for the same absence streak.

## Decided

Lifecycle and wording, as agreed:

- **Active** means not ended early and not past its expiry. **Expired** means past its expiry. **Ended early** means a leader expired it by hand. All three are computed when read; there is no background job.
- Default expiry is 3 months (roughly one in-game season) from creation. A leader can set a different date on a single warning.
- **Expire now** keeps the warning in history, marked ended early with who and when.
- **Strike** deletes the row permanently. It is the undo for a warning that should not exist. It needs a confirm button. The only trace is the log row (who struck one, for which member, when) plus the existing channel audit embed.
- The automatic warning is tied to the 3+ day offline callout posted in chat after each `/scan` (`postInactivityAlert` in `scan.js`), not to the check-in DM. The 3 day rule is what the warning records, so it applies to every member the callout lists whether or not they have a linked Discord account. AFK members and inactive members are already excluded by the callout's own query. It stays whatever the member does next (answers, returns); a leader can expire or strike it.
- The callout re-posts every scan while a member stays offline, so the warning needs its own once-per-absence-streak rule: a member gets a new automatic warning only if they have never had one, or a later snapshot shows them active again since their last one. That check reads the `auto_add` rows in `warning_log`, not `member_warnings`, so striking an automatic warning does not make the next scan re-create it.
- Commands (`/warn`): `add`, `edit`, `expire`, `strike`, `list`, `report`.
- `expire`, `strike` and `edit` pick the member first, then the warning from an autocomplete scoped to that member (value = warning id). `list` shows each warning's `#id` so an id can also be typed.
- Everything `/warn` does is logged to the existing command-log channel automatically (`commandLogger`) and to a new persistent log table.

## Constraints

- discord.js v14, better-sqlite3, existing conventions: bot-owned tables are `CREATE TABLE IF NOT EXISTS` in `utils/db.js` (no migration trail), permissions through `enforcePermissions` and the admin Permissions tab, `setDefaultMemberPermissions(ManageGuild)` so an unconfigured command is not open to everyone (same as `/guildduel add`), pure logic in a tested module under `utils/` with the command only loading rows and rendering (same split as `guildDuelLow.js`).
- `mergeMembers` must repoint warnings and log rows onto the kept member.
- `commandLogger` records the typed option values (truncated at 60 chars) in the command-log channel, so a typed reason appears there. This relies on that channel being leader-only (bot-chatter is private today).
- `commandLogger` logs the invocation, not the outcome. A strike that is cancelled at the confirm button still produces an invocation embed. The log row and a channel line at confirm time are the record of an actual strike.
- Docs sync with the commit: `help.js` entry per subcommand with its reply-visibility tag, CLAUDE.md (key files, DB tables), README/ARCHITECTURE.
- Ask MeerBot builds per-member command lists from `help.js` plus `setDefaultMemberPermissions`; confirm `/warn` does not appear for non-leaders.
- No em dashes in docs or strings. No explanatory code comments.

## Data (builder's call on exact SQL, shape decided)

`member_warnings`: id, member_id (FK members), reason (free text), created_by (Discord id, or `bot`), created_at, expires_at, ended_at (nullable), ended_by (nullable).

`warning_log`: id, warning_id (no FK, the row may be deleted), member_id, action (`add` / `edit` / `expire` / `strike` / `auto_add`), actor (Discord id or `bot`), at, detail (nullable). For `edit`, detail holds old and new values of the fields changed. For `strike`, detail is always empty, and the strike also blanks `detail` on every earlier log row for that warning (an `edit` row holds the old and new reason text), keeping only action, actor and time.

Active count and status are derived at read time from `ended_at` and `expires_at`.

## Behavior

- `/warn add member reason [expires]`: member by autocomplete (active, non-pending members). `expires` is a `YYYY-MM-DD` date (UTC end of day), default 3 months out, matching how `/afk` takes `return_date`. Ephemeral confirmation.
- `/warn edit member warning [reason] [expires]`: amends only the fields given. Created-by and created-at never change. The picker shows the member's newest 25 non-struck warnings, active first, so an expiry can be extended on a recently lapsed one. Logged with old and new values.
- `/warn expire member warning [note]`: sets `ended_at`/`ended_by`. Picker shows active warnings only. Optional note is stored in the log detail.
- `/warn strike member warning`: picker shows all the member's warnings. Replies with a confirm button; only the invoker can click it, it times out, and it re-checks permissions like the glory cancel button. On confirm: delete the row, write the log row (no contents), post a one-line strike notice to the command-log channel. On cancel or timeout: nothing changes.
- `/warn list member`: ephemeral embed, active count first, then every warning (active, expired, ended early) newest first with `#id`, reason, added by, dates, and edit lines drawn from the log. Chunked like other long embeds.
- `/warn report`: ephemeral embed in the `/guildduel low` style. Default lists members with at least one active warning, ranked by active count, with the most recent warning's date and reason (truncated). There is no per-kind grouping because warnings have no type. An `include_expired` option also lists members whose warnings have all lapsed, with all-time totals. Pure logic in `utils/warningReport.js` with tests.
- Automatic warning: in the post-scan block, for each member in the callout's inactive list who passes the once-per-streak rule above, create a warning: reason `Offline 3+ days` (using the configured `INACTIVITY_DAYS`), created_by `bot`, default expiry, plus an `auto_add` log row whose detail records the days inactive at that scan. It runs on the same query the callout uses and does not depend on the callout channel being configured or the post succeeding. It is not behind the check-in test-mode gate, since a warning sends nothing to anyone. The first scan after this ships will log a warning for everyone currently listed as 3+ days offline.

## Left to the builder

- Exact column types, indexes, and function names in `utils/db.js`.
- Embed layout, colors, chunking sizes, wording of ephemeral replies.
- Confirm-button timeout length and `custom_id` format.
- Test structure (pure functions in `utils/`, plus `db`-touching cases against a temp DB, never the real `guild.db`; see the existing test-cleanup gotchas).

## My calls (not discussed with you)

- Free-text reason only, no type list (decided by you, since no list is known yet). If a list appears later it is one new column; automatic warnings are recognizable today by `created_by = 'bot'`.
- The report's per-member line shows the most recent warning's date and truncated reason, since it cannot group by kind.
- `expires` as a date, `include_expired` as the report's only option, edit picker limited to the newest 25, expire note optional.
- Edit log rows keep old and new values, so history shows what changed.
- Member picker for `add` limited to active, non-pending members.
- Automatic warning dedups on `warning_log` `auto_add` rows so a strike sticks, and is not behind the check-in test-mode gate.
- The first scan after shipping back-fills a warning for everyone currently 3+ days offline.
