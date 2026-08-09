# MeerBot · Architecture

## Overview

MeerBot is a discord.js v14 slash command bot. It is purely a read/write layer on top of a shared SQLite database — it never calls the game directly. All game data flows in through the Python scraper.

```
guild.db (SQLite, WAL mode)
    ^                   ^
    | reads             | writes
    |                   |
MeerBot             AFKDataMining
(discord.js)        (Python scraper)
    |
    | slash commands
    v
Discord API
```

The two processes share the same file safely because SQLite WAL mode allows concurrent readers alongside a single writer without locking conflicts.

---

## Entry point · index.js

Startup sequence:

1. `require('dotenv').config()` · loads `.env` into `process.env`
2. `require('./utils/db')` · executes the schema creation block (all `CREATE TABLE IF NOT EXISTS` statements run, safe to call every boot)
3. `fs.readdirSync('slash-commands/')` · loads every `.js` file in the slash-commands directory and registers the command in `client.slashCommands` Map
4. If `DEV_REGISTER=true` · calls `deploy-commands.js` to register/update slash commands with the Discord API for the configured guild
5. `client.login(token)` · connects to the Discord gateway

### Global rate limiter

A sliding window rate limiter runs before every command dispatch:

```javascript
const RATE_WINDOW_MS = 60_000;  // 1 minute window
const RATE_MAX       = 20;      // max 20 commands per window

const cmdTimestamps = [];       // in-memory array of recent command timestamps

function isRateLimited() {
    const now = Date.now();
    // Drop timestamps outside the window
    while (cmdTimestamps.length && cmdTimestamps[0] < now - RATE_WINDOW_MS) {
        cmdTimestamps.shift();
    }
    if (cmdTimestamps.length >= RATE_MAX) return true;
    cmdTimestamps.push(now);
    return false;
}
```

This is global across all users. If any combination of users hits 20 commands in 60 seconds, all further commands are rejected with an ephemeral message until the window clears. Autocomplete interactions are excluded from the count since they fire continuously while a user is typing.

### Interaction routing

```javascript
client.on('interactionCreate', async interaction => {
    if (interaction.isAutocomplete()) {
        if (interaction.guildId !== GUILD_ID) return;  // foreign guild guard
        ... route to cmd.autocomplete() ...
        return;
    }
    if (!interaction.isChatInputCommand()) return;
    if (interaction.guildId !== GUILD_ID) return;      // foreign guild guard
    if (isRateLimited()) { ... reject ... return; }
    await cmd.execute(interaction);
});
```

Autocomplete is checked first and short-circuits before the rate limiter. This ensures the autocomplete dropdown stays responsive even if the main rate limit is hit.

Both autocomplete and command interactions are dropped silently if they originate from a guild other than the configured `GUILD_ID`. Without this guard, any server the bot is accidentally invited to would have full access to guild data.

### guildMemberUpdate events

```javascript
client.on('guildMemberUpdate', (oldMember, newMember) =>
    handleTranslationRole(oldMember, newMember, client));
```

The handler in `utils/handlers/translationRoleHandler.js` checks whether the translation role (`1516271538217943131`) was gained in this specific update (present in `newMember.roles.cache` but not in `oldMember.roles.cache`). If so, it:

1. DMs the member a bilingual (English/Spanish) embed with instructions for the interaction-bot.com translation bot.
2. If the DM fails (user has DMs disabled), posts a lighthearted fallback message in the general channel mentioning them.
3. Removes the translation role from the member regardless of DM success -- it is a one-shot trigger, not a persistent role.

Requires `GatewayIntentBits.GuildMembers` (privileged intent -- must also be enabled in the Discord Developer Portal under Bot → Server Members Intent).

---

## utils/db.js (Database Layer)

Uses `better-sqlite3`, a synchronous SQLite driver. All queries are blocking — no async/await needed. This is intentional: it simplifies command handlers significantly and is appropriate for a low-concurrency Discord bot.

```javascript
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
```

WAL mode is set on every connection. This is idempotent and ensures the setting is active even if the database file was created by a different process.

### Schema

All tables are created on startup via `CREATE TABLE IF NOT EXISTS`:

```sql
command_permissions Per-command/subcommand allowlists. type = 'role' | 'channel'.
                    value_id is a Discord role ID or channel ID. Checked by
                    enforcePermissions() at runtime. Editable from admin Permissions tab.
                    UNIQUE(command, subcommand, type, value_id).
birthdays           Discord user birthday registrations. UNIQUE(user_id, guild_id).
members             Guild members. Linked by discord_id to Discord users.
                    ingame_name is the primary key (UNIQUE). active = in latest scan.
                    pending = 1 when the scanner could not confidently match the read
                    to an existing member (awaiting /review).
                    warband_id = current warband (synced from scan, manually overridable).
                    last_scanned_at = when the member was last read by a scan (set by scraper).
guilds              Top-level guild (RKF RiffRaff, RKF Frop). id, name UNIQUE,
                    override_role_ids (JSON array of Discord role IDs that bypass
                    transfer approval entirely for moves touching this guild).
warbands            Sub-unit within a guild (id, name UNIQUE, sort_order, archived,
                    guild_id FK, leader_role_id -- must approve transfers into/out of
                    this warband, member_role_id -- granted/removed on transfer).
                    Rename here propagates everywhere via renameWarband(). Bot-owned
                    (Discord role management is a bot concern); the miner still reads
                    this table read-only to resolve OCR'd warbands during scanning.
member_name_history Audit log of name changes from /rename and admin panel.
name_corrections    OCR correction map. Written by scraper and /rename, readable by bot.
member_notes        Admin notes on members. Multiple notes per member (/note command).
member_afk          AFK status. One row per member (UNIQUE on member_id).
scheduled_jobs      Unified job queue. One row per pending or recurring job.
                    type = 'script_job' | 'text_job' | 'remindme' | 'recruitment_followup'.
                    fire_at is next execution time.
remindme_jobs       Sub-table for type='remindme'. Holds user_id, channel_id, message.
                    ON DELETE CASCADE from scheduled_jobs.
script_jobs         Sub-table for type='script_job'. Holds handler_path to module.
                    ON DELETE CASCADE from scheduled_jobs.
text_jobs           Sub-table for type='text_job'. Fully panel-authored scheduled
                    message: name, channel_id, title, body, mentions (JSON array),
                    days_of_week (comma-separated ISO 1-7, NULL = every day),
                    log_name (UNIQUE, the scheduler_log key). No code file or deploy
                    needed to create/edit -- see admin/src/jobs.js.
                    ON DELETE CASCADE from scheduled_jobs.
recruitment_followups Sub-table for type='recruitment_followup'. 2-day follow-up reminder
                    for /recruitment add. Holds user_id, recruitment_id, channel_id.
                    ON DELETE CASCADE from scheduled_jobs.
scheduler_log       Audit log of every job execution. No uniqueness constraint --
                    every fire (including an accidental double-fire from an edited
                    fire_at) writes its own row, on purpose, so duplicates are visible
                    instead of silently absorbed. Pruned to the last 90 days by
                    jobLog.js on each write (see below).
bot_config          DB-backed config store. key/value overrides editable via admin panel.
                    Lookup order: DB > ENV > hardcoded default in CONFIG_META.
message_reactions   Configurable auto-response rules. Pattern matching (contains/exact/
                    regex/@mention), response type (reply/message/emoji/DM), per-user
                    cooldown, optional channel filter, optional embed fields.
ally_seasons        Ally season registry. id, name UNIQUE, active (0/1).
                    Multiple seasons can be inactive; only one is typically active.
ally_servers        Ally server numbers per season. UNIQUE(server_number, season_id).
                    ON DELETE CASCADE when a season is deleted.
recruitment         Prospect tracking. Stores power, server, rank columns, interest,
                    response, status (scouting/invited/joined/declined).
wishlist            Guild feature wishlist. priority (high/medium/low),
                    status (not started/in progress/done), submitted_by Discord user ID.
newsletters         Archived newsletter issues. Seeded from Discord channel via /newsletter seed.
                    posted_at is the authoritative anchor for the "since last newsletter" window.
newsletter_notes    Running memory for the next issue (events, member news, season notes).
                    created_at > MAX(newsletters.posted_at) = relevant to next generate call.
panel_roles         Admin-panel access map. role_id -> tier (read/manage). Seeded
                    Riff/Raff=manage, RiffRaffians=read. Editable in the Access tab.
panel_op_access     Per-operation tier overrides (op_key -> tier). Absent = use the
                    code default in auth.js OPERATIONS.
panel_audit         Admin-panel audit log. One row per login + per successful mutation
                    (discord_id or 'local', action, target, at).
panel_presence      Presence heartbeat. discord_id -> name/avatar/last_seen. Drives the
                    "who's viewing" avatar stack; active = seen within 2 min.
sessions            Admin-panel login sessions (auto-managed by better-sqlite3-session-store).
transfer_approvals  Pending/resolved /roster transfer requests. transfer_id (UUID, used
                    in button custom_id), member_id, from/to_warband_id, direction
                    (pull|push, informational -- audits which side initiated), status
                    (requested|approved|denied), approver_user_id + acted_at (who
                    resolved it and when -- null while requested), message_id (the
                    channel post, edited on resolution).
transfer_approval_eligibility  One row per Discord user id eligible to approve/deny a
                    specific transfer, recorded at request time. message_id is the
                    DM sent to them (null if their DMs were closed). This is the
                    authorization source for button clicks -- checked by recorded
                    eligibility rather than a live role re-check, so the DM'd set and
                    the clickable set can never diverge (matters on the vacant-leader
                    fallback path, where multiple guild override roles can all be
                    eligible but only one is stored as transfer_approvals.approving_role_id).
```

The `members` table is the join hub. It links:
- To `member_snapshots` via `members.id = member_snapshots.member_id`
- To `birthdays` via `members.discord_id = birthdays.user_id`
- To `member_afk` via `members.id = member_afk.member_id`
- To `member_notes` via `members.id = member_notes.member_id`

### Canonical names & member deduplication

`members` is the single source of truth for a member's name. Everything downstream keys off
`member_id`, and display queries select `members.ingame_name` (via `COALESCE(m.ingame_name,
ms.name)` join) rather than the raw per-snapshot OCR text — so a rename in one place propagates
to every chart, summary, and lookup with no re-scan.

The scraper resolves each OCR read *into* this roster (alias → exact → fuzzy → else flag
`pending`), which prevents a noisy read from spawning a duplicate member row. When duplicates
still need collapsing, `mergeMembers(keepId, dropId)` (exported from `utils/db.js`) repoints all
of the dropped member's rows (`member_snapshots`, `member_notes`, `member_afk`,
`member_name_history`) onto the keeper, aliases the dropped name into `name_corrections`, carries
over a Discord link if the keeper lacks one, and deletes the dropped row — all in one transaction.

`mergeMembers` is the shared primitive behind `/rename` (merge-on-collision), `/review merge`,
the admin panel **Members** tab, and the one-shot `scripts/merge-dupes.js`.

---

## Slash command architecture

Each file in `slash-commands/` exports:

```javascript
module.exports = {
    data: new SlashCommandBuilder()...,   // command definition
    async execute(interaction) { ... },   // required
    async autocomplete(interaction) { ... } // optional
};
```

The loader in `index.js` checks for both `data` and `execute` before registering. `autocomplete` is optional and only called when the interaction is an autocomplete event for that command name.

### guild.js

All eleven `/guild` subcommands in one file. Shared helpers:

- `getLatestSnapshot()` · fetches the most recent snapshot row
- `getPrevSnapshotId(latestId)` · fetches the snapshot before the latest (for growth/nogrowth comparisons)
- `currentWeekStart()` · returns Monday 00:00 UTC as an ISO string (mirrors the Python logic)
- `newMemberIds(snapshotId)` · returns a Set of member_ids whose `first_seen` is >= this week's Monday
- `afkMemberIds()` · returns a Set of member_ids currently in `member_afk`
- `badge(memberId, newIds, afkIds)` · returns `' ✈️'`, `' 🆕'`, both, or empty string

Every list command (`power`, `top`, `inactive`, `activeness`, `nogrowth`) calls both `newMemberIds` and `afkMemberIds` and appends the result of `badge()` to each member's line.

**Growth comparison** and **NoGrowth** both use an `INNER JOIN` against the previous snapshot, so members with no prior record are excluded entirely. Growth display format: `prev → current (+delta)`.

### member.js

Displays the latest row (`ORDER BY scanned_at DESC LIMIT 1`, no period filtering
even for period-keyed tables like `supreme_arena_rankings`/`guild_duel_rankings`)
from each mode's ranking table: AFK Stages, Supreme Arena, Arena, Honor Duel,
Arcane Lab, Guild Duel Crests, plus a separate multi-row Dream Realm field
(per-boss). Guild Duel Crests shows `{crests} (#{rank})` rather than just a
rank, since crests (not placement alone) is the tracked stat — see
AFKDataMining's `guild_duel_rankings` schema (owned by the Python miner, this
repo only reads it).

Supports two lookup modes selected at runtime:

```javascript
if (mentionedUser) {
    // query by members.discord_id = mentionedUser.id
} else {
    // query by members.ingame_name LIKE name
}
```

History is fetched in a separate query joining `member_snapshots -> snapshots -> members`, ordered by `scraped_at DESC LIMIT 8`. Displayed as a monospace code block table since history data is not a ranked list (code blocks are only problematic for long ranked lists on mobile).

### scan.js

Uses `execFile` (not `exec`) to avoid shell injection -- arguments are passed as an array, not a string:

```javascript
execFile(PYTHON, [SCRAPER, "--guild", ...modeFlags], { cwd: path.dirname(SCRAPER) }, callback)
```

`--guild` is always included so the roster scan always runs regardless of which mode flags are enabled. `modeFlags` is built from `bot_config` keys (`SCAN_DREAM_REALM`, `SCAN_ARENA`, etc.) at invocation time. `cwd` is set to the scraper's directory so relative imports within the Python project resolve correctly.

Permission check order: `enforcePermissions(interaction, 'scan', null)` first (DB-backed role/channel allowlist), then `enforce(interaction, 'scanUser')` (hardcoded scan-user ID check). Both must pass.

The callback runs `postInactivityAlert()` after a successful scan. This queries `member_snapshots` joined against `member_afk` (LEFT JOIN, `afk.member_id IS NULL` to exclude AFK members) and filters by `last_active` text matching `/^\d+d\s*ago$/i` with the day count >= `INACTIVITY_DAYS` (default 3).

### roster.js

Manages Discord role assignment for guild/warband membership. Three subcommands:

- **`add guild: user:`** -- adds the guild's role to the target member, removes the `Who Dis?` onboarding role if present, and optionally sends a welcome message to the guild's configured welcome channel (keyed by `ROSTER_WELCOME_<GUILD>_CHANNEL_ID` in `bot_config`). Guild-level only (RiffRaff/Frop) -- unrelated to warbands.
- **`remove guild: user:`** -- removes the guild role.
- **`transfer user: to_warband:`** -- requests moving a member to a different warband (autocomplete over the live `warbands` table). The target must already be linked (`members.discord_id` set via `/link`) -- blocks with an error otherwise, since there'd be nothing to key `transfer_approvals.member_id` off. No-ops with an error reply if the target is already in that warband.

  Approval routing (`resolveApprover()` in `utils/transferApproval.js`), in precedence order:
  1. Initiator holds a guild override role (`guilds.override_role_ids`) for either side's guild -> bypass, executes immediately.
  2. Initiator holds the `leader_role_id` for BOTH the source and destination warband -> bypass (no other party has standing to approve).
  3. Initiator leads exactly one side -> the OTHER side's warband leader must approve ("pull": initiator leads destination, source approves; "push": initiator leads source, destination approves). Falls back to that side's guild override roles if `leader_role_id` is unset or currently held by nobody in Discord.
  4. Initiator leads neither side and holds no override role (shouldn't normally be reachable past `command_permissions`) -> still creates a request, defaulting the approver to the destination warband's leader, so an eligible approver can deny it.

  A bypass calls `applyTransferRoles()` (also exported for the button handler to reuse) directly. Otherwise it creates a `transfer_approvals` row, posts an Approve/Deny-button embed to `TRANSFER_APPROVAL_CHANNEL_ID` (the-not-so-round-table), and DMs every currently-eligible approver the same embed -- recording each of them in `transfer_approval_eligibility` regardless of whether the DM actually sent, since that table (not a live role check) is what authorizes a later button click.

  **Approval only changes Discord roles, never `guild.db`.** `members.warband_id` is left for the next mining scan to resolve via OCR -- the in-game guild/warband move is a separate, human-driven action in AFK Journey that may not happen at the same moment as the Discord-side approval.

Permission to run `/roster transfer` at all is entirely DB-backed via `enforcePermissions(interaction, 'roster', subcommand)` -- no hardcoded role check. The override/leader roles above are a separate, later gate (can this approval be bypassed / who must approve), not a replacement for that command-level permission.

### transferButtonHandler.js

`index.js`'s `interactionCreate` handler's only `isButton()` branch (added for this feature -- previously the bot had no button interactions at all). Dispatches on `custom_id` prefix `transfer_approve:`/`transfer_deny:`.

Clickable from either the channel post or a DM. A DM interaction has no `interaction.guild`/`interaction.member` (DMs aren't inside any guild), so the handler resolves the bot's one managed guild explicitly via `process.env.GUILD_ID` instead of relying on interaction context -- the same code path handles both origins.

Authorization checks `transfer_approval_eligibility` (was this user recorded eligible for this specific request) rather than re-deriving role membership at click time. This matters on the vacant-leader-role fallback path: `resolveEligibleApprovers()` can return multiple eligible people across several guild override roles, but only one role id is stored on `transfer_approvals.approving_role_id` -- checking that single role at click time would incorrectly reject some of the people who were actually DM'd.

Calls `interaction.deferUpdate()` immediately after the eligibility/status gates, before any role edits or REST fetches -- `applyTransferRoles()` plus several member/user lookups can exceed Discord's 3s interaction ack deadline. On resolution it edits whichever message was clicked, then syncs every other surviving copy (the channel post, if the click came from a DM or vice versa, and every other eligible approver's DM) to the resolved state via `Promise.all`.

### note.js / afk.js

Both use `setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)` on the `SlashCommandBuilder`. This causes Discord to hide the command entirely from users without that permission — they never see it in the `/` menu. All responses are ephemeral so note content stays private in the channel.

`member_afk` has a `UNIQUE` constraint on `member_id` and the insert uses `INSERT OR REPLACE`, so setting AFK on someone already AFK just updates the reason/date rather than erroring.

### help.js

Uses autocomplete (not `addChoices`) for the `command:` option. This allows the autocomplete function to filter results based on the caller's permissions at query time:

```javascript
async autocomplete(interaction) {
    const focused = interaction.options.getFocused().toLowerCase();
    const visible = visibleCommands(interaction);  // filters by ManageGuild + scan auth
    const filtered = visible.filter(k => k.includes(focused));
    await interaction.respond(filtered.map(k => ({ name: k, value: k })));
}
```

The `execute` handler also checks permissions before showing admin command detail, so even if someone types a command name manually they get a clean rejection rather than documentation for a command they can't use.

### newsletter.js

Handles `/newsletter note add/list/remove`, `/newsletter generate`, and `/newsletter seed`.

The temporal anchor for all queries is `MAX(posted_at) FROM newsletters` -- the "since last newsletter" window. `generate` queries new members, departures (`active=0, last_scanned_at > since`), anniversaries (daily milestone walk from `sinceDate` to today using `milestoneFor()` inlined from `anniversaryCheck.js`), the active season, and all pending notes. It then pulls all past newsletters from the DB as style reference and calls the Claude API (`claude-sonnet-4-6`, `max_tokens: 1500`) to produce a draft. Output is a `.txt` attachment with a material summary at the top followed by the Claude draft. No sign-off is generated -- Kit adds that before posting.

`seed` paginates through the newsletter channel (`channel.messages.fetch({ limit: 100, before: lastId })`) until the batch is empty, filtering for human-authored messages > 300 chars and deduplicating against existing `posted_at` timestamps. Re-running seed after a new newsletter is posted is the intended workflow for updating the anchor.

### birthday.js

Day validation uses a hardcoded days-per-month array with February set to 29 so leap-day birthdays (Feb 29) can still be registered:

```javascript
const DAYS_IN_MONTH = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
```

---

## utils/handlers/birthdayCheck.js

### Embed builder

`buildBirthdayEmbed(userId, username, month, day)` is a pure function (no side effects, no Discord API calls). It queries the DB for the linked guild member, constructs the embed, and returns `{ content, embed, displayName }`. The scheduled daily birthday check calls it.

### Year-over-year power growth

```javascript
function lastYearPower(memberId, month, day) {
    const target = `${currentYear - 1}-${month}-${day}`;
    // Search +-14 days around last year's birthday
    db.prepare(`
        SELECT ms.combat_power_value FROM member_snapshots ms
        JOIN snapshots s ON s.id = ms.snapshot_id
        WHERE ms.member_id = ? AND s.scraped_at BETWEEN ? AND ?
        ORDER BY ABS(julianday(s.scraped_at) - julianday(?))
        LIMIT 1
    `).get(memberId, windowStart, windowEnd, target);
}
```

SQLite's `julianday()` converts dates to a continuous float (Julian Day Number), allowing `ABS(diff)` to find the closest snapshot to the birthday date last year. The +-14 day window accounts for weeks where no scan was run around that date. If nothing is found within the window, growth is omitted from the embed.

---

## utils/handlers/translationRelayHandler.js

Relays a message posted in one admin-panel-configured Discord channel into every other channel in the same `relay_group`, translated by Claude Haiku 4.5, posted via a per-channel webhook so it appears under the original author's real name/avatar (`User X (app)`) rather than the bot's own identity.

### Batching

Consecutive same-author, non-reply messages in the same source channel within a configurable window (`translation_relay_batch_timeout_seconds`, default 10s, max 15s) combine into one Claude call and one relayed post per target channel, instead of firing independently. A reply, a different author, or a message from a different source channel force-flushes whatever batch is open and starts fresh. Batch state lives in an in-memory `Map` (`openBatches`, keyed by `relay_group`) with a per-batch `setTimeout`; `takeBatch()` synchronously claims/clears a group's slot so a timeout firing and an interrupting message racing for the same batch can't both process it.

### Data model

`translation_relay_messages` holds one row per relayed copy of a message, including the original (`channel_id` = source channel). Every copy of the same logical message shares one `relay_group_message_id` (the source row's own `id`), used to resolve reply-quote lookups and to find sibling copies for reaction/edit/delete sync. `batch_message_ids` stores `[{messageId, text}]` -- one entry per original Discord message folded into the batch, each with that line's own source text -- which is what makes it possible to precisely rebuild a batch after one line is edited or deleted, rather than only ever operating on an unsplittable joined blob.

### Translation call

`callClaude(sourceLanguage, targetLanguages, lines)` sends the whole batch as one numbered-list prompt and expects back a single JSON object keyed by target language, each value an array of translated lines in the same order -- one call handles every target language and every batched line at once, not one call per language or per message. `max_tokens` scales with both line count and target-language count (`BASE_MAX_TOKENS + lines.length * targetLanguages.length * PER_LINE_PER_LANGUAGE_TOKENS`, floored at the pre-batching baseline of 1024) since batching multiplies required output size. The system prompt explicitly forbids markdown-fencing the JSON response (Claude does it anyway often enough that `stripCodeFence()` still strips any fence defensively before `JSON.parse`, even after the prompt names the exact behavior to avoid). On translation failure, the message still relays untranslated with a flag-emoji reaction per target channel as a fallback signal.

### Attachments

`message.attachments` is captured onto each batch entry as `{url, name}` pairs and passed straight into the webhook `files` payload on send -- no re-hosting, no DB persistence, read once at send time. Because attachments are never persisted, `resyncRelayGroup()` (the shared edit/delete engine, below) has no attachment data to work with -- editing or deleting a line with an image re-flows the surviving text but cannot retain or re-attach the image.

### Reaction sync

`handleTranslationReactionSync()`, wired to `messageReactionAdd`/`messageReactionRemove`, mirrors a reaction bidirectionally across every copy of a relay group. Webhooks cannot react to messages at all (no such method exists on `discord.js`'s `WebhookClient`), so this always goes through the bot's own client/user account -- which means the synced reaction re-fires the same event, guarded against via `user.id === client.user.id`. This is not a reproduction of the real per-user reaction count, just one reaction from the bot's account mirrored onto each sibling.

### Edit and delete sync

`handleTranslationEditSync()`/`handleTranslationDeleteSync()`, wired to `messageUpdate`/`messageDelete`, re-translate and edit (or delete) every relayed copy when the source message changes. Both share `rebuildBatchAfterChange()` (replace or remove one entry from a batch's `{messageId,text}[]` array) and `resyncRelayGroup()` (rebuild the combined text, re-translate, re-derive the quote-prefix if the message was a reply, and edit every sibling copy via webhook).

Two guards precede any write in both handlers:

- `row.message_id !== message.id` -- `getRelayMessageByMessageId` matches a row either by its own `message_id` or by any entry inside *any* row's `batch_message_ids` (every sibling copy stores the source message's id for quote-lookup purposes), so a lookup by the source's own id can ambiguously return the source row or a sibling row with no guaranteed ordering. Only a genuine own-`message_id` match is trusted; anything else is treated as not-found.
- `row.id !== row.relay_group_message_id` -- only the source row has these equal (set together at insert time); a copy row can never pass. Editing/deleting a relayed *copy* is a documented no-op, matching the design intent that a moderator manually deleting a copy needs no special bot handling.

Both handlers route their entire body through `enqueueRelay()` (the same per-`relay_group` promise-chain queue batching uses), keyed by the row's actual `relay_group` string derived via `db.getRelayChannelByChannelId(row.channel_id).relay_group` -- not the numeric `relay_group_message_id`. This prevents a concurrent edit and delete on the same batch from interleaving; each queued task re-reads the row fresh rather than closing over a pre-queue snapshot, so one task always sees the other's effect if it ran first.

**Known limitation:** both handlers only ever act on a batch's anchor (first) message, since `row.message_id` is set once at insert time and never repoints. Editing or deleting a non-first line of an already-relayed batch is a no-op -- and once the anchor itself is deleted, every remaining line in that batch becomes permanently un-editable/undeletable, not just a one-off edge case. Accepted as a low-priority gap (deletes are rare); fixing it would need a source-row-only DB lookup, not a guard relaxation, since relaxing the guard alone would reintroduce the exact multi-row-match ambiguity described above.

---

## utils/permissions.js

Two complementary permission systems:

**Code-level checks (`enforce`)** -- static rules defined in the `PERMS` map: `everyone`, `admin` (ManageGuild), `scanUser` (matches `SCAN_AUTHORIZED_USER` from botConfig), `scanOrAdmin`, `riffOrRaff`. Called as `await enforce(interaction, 'scanUser')`. Returns `true` and continues, or sends an ephemeral rejection and returns `false`.

**DB-backed checks (`enforcePermissions`)** -- reads `command_permissions` rows for the given `(command, subcommand)` pair. Two constraint types:

- `type = 'role'` -- caller must hold at least one of the listed role IDs.
- `type = 'channel'` -- command must be invoked in one of the listed channel IDs.

If no rows exist for a command, `enforcePermissions` returns `true` (no restriction). This makes all commands open-by-default until an explicit allowlist is configured. Rules are managed from the admin panel's **Permissions** tab (command/subcommand dropdowns, role and channel chip pickers).

Most commands call `enforcePermissions` first and then an additional `enforce` check if needed (e.g. `/scan` requires both a DB allowlist pass and the scan-user ID check). New commands should call `enforcePermissions` as their first gate.

---

## utils/botConfig.js (DB-backed config layer)

Channel IDs, thresholds, and permission settings are read through `botConfig.get(key)` rather than `process.env` directly. Job timing is **not** in botConfig -- it lives directly on the `scheduled_jobs` row and is editable from the admin panel's Scheduled Jobs tab. The lookup order is:

1. `bot_config` table in SQLite (DB override set via admin panel)
2. `process.env[key]` (`.env` file value)
3. Hardcoded default defined in `CONFIG_META` inside `botConfig.js`

```javascript
function get(key, fallback = '') {
    const row = db.prepare('SELECT value FROM bot_config WHERE key = ?').get(key);
    if (row) return row.value;
    if (process.env[key]) return process.env[key];
    return CONFIG_META[key]?.default ?? fallback;
}
```

`CONFIG_META` is the registry of all known keys -- their human-readable labels, descriptions, categories, and defaults. The admin panel uses `getAll()` to render the UI; `CONFIG_META` membership also serves as an allowlist that prevents arbitrary keys being written to the DB via the API.

Values are always stored and returned as strings. Callers that need a number cast explicitly: `Number(botConfig.get('INACTIVITY_DAYS', '3'))`.

---

## admin/server.js (Admin panel)

An Express server bound to `127.0.0.1`. Runs as a separate PM2 process (`meerbot-admin`) so it never needs a restart when the bot restarts. It is reachable remotely via a **Cloudflare Tunnel** (`admin.meerbot.dev` -> `127.0.0.1:3001`) -- the process itself never opens a public port; only the local `cloudflared` daemon connects to it. See `admin/REMOTE_ACCESS.md` for the deployment + OAuth setup.

### Authentication & access tiers (`admin/auth.js`)

All `/api/*` routes are gated by `auth.authorize`, which fails closed. Three tiers, ranked `read` < `manage` < `local`:

- **read** -- view everything, no edits (RiffRaffian role, remote)
- **manage** -- day-to-day edits, minus reserved infra ops (Riff/Raff roles, remote)
- **local** -- everything, including reserved ops; **granted by request origin only** -- a request is `local` iff its `Host` is loopback AND it carries no Cloudflare headers (`cf-connecting-ip`/`cf-ray`). Tunnel traffic always carries those, so the host PC is the only `local` origin. A remote session is clamped to `manage` even if a role is mis-mapped, and a role can never be granted `local`.

Remote users authenticate with **Discord OAuth2** (`identify` scope); their tier comes from their guild roles via `panel_roles`. Sessions live in the `sessions` table (`better-sqlite3-session-store`), cookies are `HttpOnly`/`Secure`/`SameSite=Lax`, mutations require a CSRF synchronizer token, and `helmet` + rate limiting are applied. Which tier each action needs is data-driven: the `OPERATIONS` registry holds a default tier per action (grouped by tab), overridable at runtime via `panel_op_access` (edited in the Access tab). Logins and every successful mutation are written to `panel_audit`.

REST API:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/config` | Full config snapshot with source badges (DB/ENV/DEFAULT) |
| `PUT` | `/api/config/:key` | Write a DB override for a key |
| `DELETE` | `/api/config/:key` | Remove DB override, revert to ENV or DEFAULT |
| `GET` | `/api/channels` | Live channel list fetched from Discord API via the bot client |
| `GET` | `/api/roles` | Live role list fetched from Discord API via the bot client |
| `GET` | `/api/command-permissions` | All `command_permissions` rows grouped by command/subcommand |
| `POST` | `/api/command-permissions` | Add a role or channel constraint for a command/subcommand |
| `DELETE` | `/api/command-permissions/:id` | Remove a constraint row |
| `GET` | `/api/bot-status` | PM2 status for the `meerbot` process (status, CPU, memory, uptime) |
| `POST` | `/api/bot/restart` | Runs `pm2 restart meerbot --update-env` |
| `GET` | `/api/scheduled-jobs` | All jobs (system `script_job` + panel-authored `text_job`) with display name, `fire_at`, `recurrence`, enabled state |
| `PUT` | `/api/scheduled-jobs/:id` | Update `fire_at`, `recurrence`, and/or `enabled` for a job |
| `POST` | `/api/text-jobs` | Create a new panel-authored text job (name, channel, title, body, mentions, days_of_week) -- inserts both the `scheduled_jobs` row and its `text_jobs` sub-row |
| `PUT` | `/api/text-jobs/:id` | Update a text job's content/channel/mentions/day-filter |
| `DELETE` | `/api/text-jobs/:id` | Remove a text job entirely (cascades via `scheduled_jobs` FK) |
| `GET` | `/api/jobs` | Last 50 rows from `scheduler_log` (filterable/sortable in UI); `text_job_*` log names are resolved to the job's current display name via a live join against `text_jobs` |
| `GET` | `/api/members` | Roster with latest power/warband, `pending` flagged first |
| `PUT` | `/api/members/:id` | Rename (merges via `mergeMembers` if the name already exists) |
| `POST` | `/api/members/:id/link` | Set or clear the Discord link |
| `POST` | `/api/members/:id/approve` | Clear the `pending` flag |
| `POST` | `/api/members/merge` | `{ keepId, dropId }` · collapse a duplicate |
| `POST` | `/api/members/:id/warband` | `{ warband_id }` · manual current-warband override |
| `GET` | `/api/warbands` | Warband list with active member counts |
| `POST` | `/api/warbands` | `{ name }` · add a warband |
| `PUT` | `/api/warbands/:id` | Rename (propagates everywhere via `renameWarband`) |
| `POST` | `/api/warbands/:id/archive` | `{ archived }` · hide from scans/filters, keep history |
| `PUT` | `/api/warbands/:id/roles` | `{ leader_role_id, member_role_id }` · either may be `null` to clear |
| `PUT` | `/api/warbands/:id/guild` | `{ guild_id }` · assign a warband to a parent guild |
| `GET` | `/api/guilds` | Guild list (`override_role_ids` parsed to an array) |
| `PUT` | `/api/guilds/:id/override-roles` | `{ role_ids: [...] }` · whole-array replace of transfer-approval-bypass roles |
| `GET` | `/api/seasons` | Season list with server counts |
| `POST` | `/api/seasons` | `{ name }` · create a season (inactive by default) |
| `PUT` | `/api/seasons/:id` | Update name and/or active status |
| `DELETE` | `/api/seasons/:id` | Delete season + cascade servers (nullifies recruitment refs first) |
| `GET` | `/api/seasons/:id/servers` | Sorted list of server numbers for a season |
| `POST` | `/api/seasons/:id/servers` | `{ numbers: [...] }` · bulk add server numbers |
| `DELETE` | `/api/seasons/:id/servers` | `{ numbers: [...] }` · bulk remove server numbers |
| `GET` | `/api/message-reactions` | All configured message reaction rules |
| `POST` | `/api/message-reactions` | Create a new reaction rule |
| `PUT` | `/api/message-reactions/:id` | Update a reaction rule |
| `DELETE` | `/api/message-reactions/:id` | Delete a reaction rule |
| `POST` | `/api/message-reactions/reload` | No-op acknowledgement (cache auto-refreshes every 5 min) |
| `GET` | `/api/dream-realm-bosses` / `POST` / `PUT /:id` / `DELETE /:id` | Manage Dream Realm boss list per season |
| `GET` | `/api/presence` | Heartbeat + list of currently-active viewers (read tier) |
| `GET` | `/api/access` | Operations (by tab) + role->tier map + recent audit log (**local only**) |
| `PUT` | `/api/access/op` | `{ op_key, tier }` · set/clear a per-operation tier override (**local only**) |
| `PUT` | `/api/access/role` | `{ role_id, tier }` · set/clear a role's tier (read/manage; **local only**) |
| `GET` | `/auth/me` · `GET /auth/login` · `GET /auth/callback` · `POST /auth/logout` | Discord OAuth2 login + session identity (outside `/api`) |

The admin panel UI has tabs for: **Commands** (command/event channel settings -- formerly "Channels"; each row reads "feature -> channel"), **Job Timing**, **Thresholds**, **Config** (DB-backed key/value config), **Permissions** (command_permissions allowlists -- role and channel pickers per command/subcommand), **Reactions**, **Scheduled Jobs**, **Job Runs**, **Members**, **Warbands**, **Seasons**, **DR Bosses**, and **Access** (local-only -- per-operation tiers, role->tier grants, audit log). Channel settings owned by a system `script_job` (birthday, anniversary, scan reminder, weekly summary) are not in the Commands tab -- they render as a "Posts to" channel select inside that job's Scheduled Jobs card (`JOB_CHANNEL_KEY` maps handler_path -> config key). The header shows the logged-in user (circular Discord avatar) and a presence stack of other active viewers; controls above the current tier are disabled (never hidden).

### Scheduled Jobs tab (admin/src/jobs.js)

Each job -- system `script_job` or panel-authored `text_job` alike -- renders as a
collapsible `.sj-tile`: a compact grid cell showing name, enabled/disabled status
badge, and next local fire time. Clicking a tile expands it in place (`.sj-card.expanded`,
spans the full grid width) into the full edit form: fire date/time (with a live
"will fire at HH:MM UTC" hint under the input, `attachUtcPreview`), repeat interval,
channel, and -- for text jobs -- title, body, day-of-week filter, and a mentions
picker. All three actions (Enabled/Disabled toggle, Delete Job [text jobs only],
Save) live together in one `actionsRow` at the bottom of the expanded body.

A "Create Job" form (`#cjForm`) at the top of the tab creates new text jobs from
scratch -- no code file or deploy required. Both create and edit paths validate
required fields (name, time, channel, body) inline (red border + message under the
field) before the API call, rather than surfacing a raw 400 as a browser `alert()`.

The mentions picker and the Permissions tab's role/channel pickers share one module,
`admin/src/chipPicker.js` (`createChipPicker({ options, initial, placeholder })`) --
a dropdown that adds a removable chip per selection, styled from the active DaisyUI
theme rather than every option being listed as its own chip up front.

**Responsive layout.** The panel is desktop-first but adds a `@media (max-width: 768px)` layer that leaves the desktop look untouched. On mobile/tablet: a hamburger button opens a slide-out drawer (`#drawer`) holding the section nav, and the header utility controls (theme picker, mode toggle, Restart, logout) are relocated into the drawer via a `matchMedia` listener (`setupMobileChrome`) -- moved, not duplicated, so element IDs, handlers, and `lockTiers()` keep working. The Members table reflows into stacked labeled cards (`.cards-sm` + `data-label` per cell); all other tables scroll horizontally inside their card. Form controls are 16px to avoid iOS zoom-on-focus.

The panel supports 6 themes (Jewel, Chili, Tigereye, Plum, Lapis, Synthwave) in dark and light mode. Theme and mode are persisted to `localStorage`; an anti-FOUC script in `<head>` applies the saved choice before first paint. A `/theme-demo` page (served as `admin/public/theme-demo.html`) renders all DaisyUI component classes and custom vars in the active theme for visual verification.

The config PUT endpoint validates the key against `CONFIG_META` before writing, preventing arbitrary DB writes. The scheduled-jobs PUT validates that `recurrence` matches `daily:N` or `weekly:N` and that `fire_at` is a valid datetime.

Channel ID and threshold config changes take effect after bot restart. **Scheduled job timing changes take effect within 30 seconds** -- the scheduler reads `fire_at` from the DB on every tick, no restart required.

---

## utils/jobScheduler.js (Unified Job Queue)

All scheduled work -- system recurring jobs and user-created reminders -- flows through a single DB-backed job queue. This replaces the previous model of six independent `setInterval` loops.

### Schema (table inheritance pattern)

```text
scheduled_jobs          -- queue entry: type, fire_at, recurrence
    |
    +-- script_jobs     -- type='script_job': handler_path to require()
    |
    +-- text_jobs       -- type='text_job': name, channel_id, title, body,
    |                      mentions, days_of_week, log_name (panel-authored)
    |
    +-- remindme_jobs   -- type='remindme': user_id, channel_id, message
```

Each job type has its own sub-table. The scheduler JOINs both sub-tables on every tick and dispatches by `type`.

### Recurrence format

Stored in `scheduled_jobs.recurrence` as `daily:N` or `weekly:N` where N is the repeat count. Examples: `daily:1` (every day), `daily:2` (every 2 days), `weekly:1` (every 7 days), `weekly:2` (every 14 days).

### Startup bootstrap

`initJobScheduler(client)` checks whether each system job exists in `scheduled_jobs` (identified by `handler_path`). If a row is missing, it is inserted with a hardcoded initial `fire_at` (e.g. next 20:00 UTC for scan reminder, next Monday 09:00 UTC for weekly summary). Bootstrap runs once per job lifetime -- after that, `fire_at` is owned by the scheduler and editable via the admin panel.

Adding a new recurring system job requires only a handler file and one entry in the `SYSTEM_JOBS` array in `jobScheduler.js`. No changes to `index.js` or the scheduler core.

### Poll loop

```javascript
setInterval(() => tick(client), 30_000);
```

Every 30 seconds, the tick queries `WHERE fire_at <= datetime('now')`. For each due job:

- **`script_job`**: `require(handler_path)` and call the handler. After firing, advance `fire_at` by the recurrence interval -- anchored to the previous `fire_at`, not wall clock, preventing drift:

  ```javascript
  function nextFire(job) {
      const [unit, n] = job.recurrence.split(':');
      const days = unit === 'weekly' ? parseInt(n) * 7 : parseInt(n);
      return new Date(new Date(job.fire_at).getTime() + days * 86_400_000).toISOString();
  }
  ```

- **`text_job`**: fully panel-authored, no handler file. `fire_at` advances the same way as `script_job` (before the send, so a failure doesn't retry every tick). `handleTextJob` checks `days_of_week` first (`shouldFireToday`) and returns immediately on a non-firing day -- before any lateness check or log write, so a Mon-Fri job ticking on a Saturday produces no `scheduler_log` row at all, not a skipped/late one. If it does fire today, `computeLateness` compares `fire_at` to now against `bot_config.LATE_WARNING_MINUTES` (late footer) and the fixed `MAX_LATE_MINUTES` = 120 (skip sending entirely, but still log). Title/body pass through `renderTemplate` (currently a no-op passthrough -- `{{var}}` substitution is wired but no variables are registered yet). `mentions` (JSON array of `{type: 'everyone'|'here'|'role', id?}`) goes through `buildMentions`, the only function allowed to turn that into real Discord mention syntax in the message `content` -- embeds never notify regardless of `allowedMentions`, so content is the actual ping guard, not decoration. See `utils/jobTemplate.js`.

- **`remindme`**: deliver via DM (fallback to channel mention), then `DELETE` the row. `ON DELETE CASCADE` cleans `remindme_jobs` automatically.

- **`recruitment_followup`**: post a 2-day follow-up embed to the channel (and DM the creator). Then `DELETE` the row. `ON DELETE CASCADE` cleans `recruitment_followups` automatically.

The immediate `tick(client)` call on startup catches any jobs that fired while the bot was offline.

### Handler interface

Each file in `utils/handlers/` exports a single async function:

```javascript
module.exports = async function handler(client, job) { ... }
```

The `job` object contains all columns from the JOIN (including `fire_at`, `handler_path`, `recurrence`). Handlers that need to export utilities for slash commands (e.g. `buildBirthdayEmbed`, `milestoneFor`) attach them as named exports on the function:

```javascript
module.exports.buildBirthdayEmbed = buildBirthdayEmbed;
```

### weeklySummary handler

The weekly comparison baseline is the oldest snapshot taken within the past 7 days, falling back to the immediately previous snapshot if only one scan exists in that window. This gives a true weekly delta rather than a scan-to-scan delta.

### Daily Reset (retired as a handler, now a text_job)

`dailyReset.js` was retired once panel-authored text jobs shipped -- the weekday
crest-earning reminder and the weekend boss-attack reminder are now two ordinary
`text_job` rows (different `days_of_week`, different body text), created and edited
entirely from the admin panel's Scheduled Jobs tab. No handler file, no deploy,
for either one. See the `text_job` dispatch path above.

---

## data/birthday-wishes.json

A plain JSON array of strings. Read fresh on every birthday message using `fs.readFileSync()` rather than `require()`. Node's `require()` caches module results, so changes to the file would not be picked up without a restart. `readFileSync` has no cache, so edits take effect immediately for the next birthday message without any restart required.

---

## deploy-commands.js

Reads all `.js` files from `slash-commands/`, collects their `.data.toJSON()` representations, and PUT them to the Discord guild commands endpoint via the Discord REST API. Running this replaces all guild slash commands atomically. Called automatically on startup when `DEV_REGISTER=true`.

For production with multiple guilds, this would be replaced with global command registration. For a single private guild, guild-scoped commands are preferred because they update instantly (global commands can take up to an hour to propagate).

---

## PM2

Two processes are defined in `ecosystem.config.js`:

- `meerbot` -- the Discord bot (`index.js`)
- `meerbot-admin` -- the admin panel (`admin/server.js`)

Both run in `fork` mode (single process each). Cluster mode is not appropriate for Discord bots -- it would spawn multiple bot instances all connecting to the Discord gateway simultaneously, causing duplicate responses and gateway conflicts.

```powershell
pm2 start ecosystem.config.js      # start both processes
pm2 restart meerbot --update-env   # restart bot, picks up .env changes
pm2 logs meerbot --lines 50        # recent bot log output
pm2 monit                          # live CPU/memory dashboard
```

The admin process never needs `--update-env` because it reads all config from the DB at request time, not at startup.

---

## Security model

| Layer | Mechanism |
|---|---|
| DB-backed allowlists | `enforcePermissions()` checks `command_permissions` (role + channel) per command/subcommand |
| Code-level gates | `enforce()` for static rules (scanUser ID, ManageGuild) applied on top of DB check |
| Admin commands | `setDefaultMemberPermissions(ManageGuild)` -- Discord hides from non-admins as a fallback |
| Rate limiting | Global sliding window, 20 commands per 60 seconds |
| Guild ID guard | Both autocomplete and command interactions silently dropped if `interaction.guildId !== GUILD_ID` |
| Permission fail-closed | `enforcePermissions()` catches DB errors and returns `false` (deny) -- never fails open |
| SQL injection | All queries use `better-sqlite3` prepared statements with `?` parameters |
| Token security | `.env` listed in `.gitignore`, never committed |
| Subprocess | `execFile` with array arguments, no shell interpolation |
| Ephemeral responses | All admin output uses `MessageFlags.Ephemeral` |
| Admin panel | Bound to `127.0.0.1`; reachable remotely only through a Cloudflare Tunnel -- Discord OAuth2 login with role-derived access tiers (read/manage/local), `local` reserved to the host PC by request origin -- CSRF synchronizer token on mutations, `helmet` with explicit CSP (self + unsafe-inline for scripts/styles + Discord CDN for avatars), rate limiting, session cookies (HttpOnly/Secure/SameSite=Lax) -- key writes validated against `CONFIG_META` allowlist -- Host + Origin allowlist blocks DNS rebinding -- logins + mutations audited |
| Inline onclick safety | Admin panel buttons that pass user data use `data-*` attributes + `dataset` reads -- never string-interpolated into JS. Note: `escHtml()` does not escape single quotes, so inline JS string context is always unsafe for user data. |
| Vulnerability reporting | `SECURITY.md` at repo root -- GitHub private advisory only, no public issue path |
| Cache over fetch | `commandLogger` and scheduled handler channel lookups use `channels.cache.get()` not `.fetch()` to avoid unnecessary API calls |
