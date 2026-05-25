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
    if (interaction.isAutocomplete()) { ... route to cmd.autocomplete() ... return; }
    if (!interaction.isChatInputCommand()) return;
    if (isRateLimited()) { ... reject ... return; }
    await cmd.execute(interaction);
});
```

Autocomplete is checked first and short-circuits before the rate limiter. This ensures the autocomplete dropdown stays responsive even if the main rate limit is hit.

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
birthdays           Discord user birthdays. UNIQUE(user_id, guild_id).
members             Guild members. Linked by discord_id to Discord users.
                    ingame_name is the primary key (UNIQUE).
member_name_history Audit log of name changes from /rename.
name_corrections    OCR correction map. Written by scraper, readable by bot.
member_notes        Admin notes on members. Multiple notes per member.
member_afk          AFK status. One row per member (UNIQUE on member_id).
```

The `members` table is the join hub. It links:
- To `member_snapshots` via `members.id = member_snapshots.member_id`
- To `birthdays` via `members.discord_id = birthdays.user_id`
- To `member_afk` via `members.id = member_afk.member_id`
- To `member_notes` via `members.id = member_notes.member_id`

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

All eight `/guild` subcommands in one file. Shared helpers:

- `getLatestSnapshot()` · fetches the most recent snapshot row
- `getPrevSnapshotId(latestId)` · fetches the snapshot before the latest (for growth/nogrowth comparisons)
- `currentWeekStart()` · returns Monday 00:00 UTC as an ISO string (mirrors the Python logic)
- `newMemberIds(snapshotId)` · returns a Set of member_ids whose `first_seen` is >= this week's Monday
- `afkMemberIds()` · returns a Set of member_ids currently in `member_afk`
- `badge(memberId, newIds, afkIds)` · returns `' ✈️'`, `' 🆕'`, both, or empty string

Every list command (`power`, `top`, `inactive`, `activeness`, `nogrowth`) calls both `newMemberIds` and `afkMemberIds` and appends the result of `badge()` to each member's line.

**Growth comparison** uses a `LEFT JOIN` so members with no prior snapshot still appear (showing their full current power as growth). **NoGrowth** uses an `INNER JOIN` to exclude newcomers — a member with no prior snapshot hasn't "not grown," they just joined.

### member.js

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

Uses `execFile` (not `exec`) to avoid shell injection — arguments are passed as an array, not a string:

```javascript
execFile(PYTHON, [SCRAPER], { cwd: path.dirname(SCRAPER) }, callback)
```

`cwd` is set to the scraper's directory so relative imports within the Python project resolve correctly.

The callback runs `postInactivityAlert()` after a successful scan. This queries `member_snapshots` joined against `member_afk` (LEFT JOIN, `afk.member_id IS NULL` to exclude AFK members) where `last_seen_approx < now - 3 days`.

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

### birthday.js

Day validation uses a hardcoded days-per-month array with February set to 29 (allowing leap year birthdays to be registered without requiring a year):

```javascript
const DAYS_IN_MONTH = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
```

The `/birthday test` subcommand calls `buildBirthdayEmbed()` directly from `birthdayCheck.js`, which is the same function used by the real daily check. This ensures the preview is pixel-accurate to the real message.

---

## utils/birthdayCheck.js

### Embed builder

`buildBirthdayEmbed(userId, username, month, day)` is a pure function (no side effects, no Discord API calls). It queries the DB for the linked guild member, constructs the embed, and returns `{ content, embed, displayName }`. Both the scheduler and the `/birthday test` command call this same function.

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

### Scheduler

`scheduleBirthdayCheck()` calculates milliseconds until the next UTC midnight using `Date.UTC()` (avoids local timezone offset), fires once, then sets a 24-hour interval. This means the first check fires precisely at the next midnight even if the bot starts mid-day.

---

## utils/scanReminder.js / weeklySummary.js

Both use `setInterval` with 60-second ticks. Each tick checks the current UTC time against the configured `HH:MM` string. `weeklySummary.js` also checks `getUTCDay() === 1` (Monday).

This approach is simpler than a cron library and sufficient for minute-precision scheduling. The trade-off is that if the bot is restarted at exactly the trigger minute, the check fires on the next tick (up to 60 seconds late).

---

## data/birthday-wishes.json

A plain JSON array of strings. Read fresh on every birthday message using `fs.readFileSync()` rather than `require()`. Node's `require()` caches module results, so changes to the file would not be picked up without a restart. `readFileSync` has no cache, so edits take effect immediately for the next birthday message without any restart required.

---

## deploy-commands.js

Reads all `.js` files from `slash-commands/`, collects their `.data.toJSON()` representations, and PUT them to the Discord guild commands endpoint via the Discord REST API. Running this replaces all guild slash commands atomically. Called automatically on startup when `DEV_REGISTER=true`.

For production with multiple guilds, this would be replaced with global command registration. For a single private guild, guild-scoped commands are preferred because they update instantly (global commands can take up to an hour to propagate).

---

## PM2

The bot runs under PM2 in `fork` mode (single process). Cluster mode is not appropriate for Discord bots — it would spawn multiple bot instances all connecting to the Discord gateway simultaneously, causing duplicate responses and gateway conflicts.

PM2 watches for process exit and restarts automatically. `pm2 startup` + `pm2 save` configures it to survive reboots.

```powershell
pm2 restart meerbot --update-env   # picks up .env changes
pm2 logs meerbot --lines 50        # recent log output
pm2 monit                          # live CPU/memory dashboard
```

---

## Security model

| Layer | Mechanism |
|---|---|
| Admin commands | `setDefaultMemberPermissions(ManageGuild)` · Discord hides from non-admins |
| /scan | Authorized user ID check in execute(), plus ManageGuild bypass for admins |
| Rate limiting | Global sliding window, 20 commands per 60 seconds |
| SQL injection | All queries use `better-sqlite3` prepared statements with `?` parameters |
| Token security | `.env` listed in `.gitignore`, never committed |
| Subprocess | `execFile` with array arguments, no shell interpolation |
| Ephemeral responses | All admin output uses `MessageFlags.Ephemeral` |
