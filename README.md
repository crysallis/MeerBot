# MeerBot

Discord bot for AFK Journey guild management. Reads from a shared SQLite database populated by the AFKDataMining scraper and exposes guild statistics, member lookups, and admin tools as Discord slash commands.

---

## Prerequisites

- **Node.js 18+**
- **PM2** for persistent process management (`npm install -g pm2`)
- The AFKDataMining scraper set up and having run at least one scan
- A Discord application with a bot token ([discord.com/developers](https://discord.com/developers))

---

## Setup

```powershell
npm install
```

Copy `.env.example` to `.env` and fill in all values (see Configuration below).

### Register slash commands and start

```powershell
# Start both the bot and admin panel via PM2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

Admin panel runs at `http://localhost:3001` (binds `127.0.0.1`). On the host PC it opens with full access, no login. It can also be exposed to guild leadership remotely via a Cloudflare Tunnel + Discord login -- see [admin/REMOTE_ACCESS.md](admin/REMOTE_ACCESS.md). The UI is responsive: on phones/tablets the section tabs collapse into a hamburger drawer and wide tables reflow/scroll. A `/theme-demo` page previews all DaisyUI component classes in the active theme.

The stats site (`stats/`) is a separate Vite + Tailwind v4 + DaisyUI v5 app that exposes member stats publicly at `riffraff.meerbot.dev`. Both sites share the same modular theme files under `shared/themes/`.

### Updating after code changes

```powershell
pm2 restart meerbot --update-env
```

---

## Configuration

### Required .env values (secrets and paths -- must stay in .env)

| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Bot token from Discord Developer Portal |
| `APPLICATION_ID` | Your application/client ID |
| `GUILD_ID` | Discord server ID to register slash commands to |
| `DEV_REGISTER` | Set to `true` to auto-register slash commands on startup |
| `SCRAPER_PYTHON` | Full path to the venv Python executable |
| `SCRAPER_SCRIPT` | Full path to `scraper.py` |
| `GUILD_DB_PATH` | Full path to `guild.db` (optional, defaults to `../../AFKDataMining/guild.db`) |
| `ADMIN_PORT` | Port for the admin panel (optional, defaults to `3001`) |
| `ADMIN_PUBLIC_HOST` / `ADMIN_OAUTH_REDIRECT` / `DISCORD_CLIENT_SECRET` / `SESSION_SECRET` | Only needed to expose the admin panel remotely (Cloudflare Tunnel + Discord OAuth2). See [admin/REMOTE_ACCESS.md](admin/REMOTE_ACCESS.md) |

### Configurable via admin panel (or .env as fallback)

Channel IDs and thresholds are stored in the `bot_config` DB table and editable at `http://localhost:3001` without restarting. The .env values below act as fallbacks if no DB override exists.

**Job timing is not here** -- next fire time and repeat interval for each scheduled job are set directly in the admin panel's **Scheduled Jobs** tab and stored in the `scheduled_jobs` table.

| Variable | Description | Default |
|---|---|---|
| `SCAN_AUTHORIZED_USER` | Discord user ID allowed to run `/scan` | — |
| `SCAN_REMINDER_CHANNEL_ID` | Channel for daily scan reminders | — |
| `WEEKLY_SUMMARY_CHANNEL_ID` | Channel for Monday weekly summaries | — |
| `BIRTHDAY_CHANNEL_ID` | Channel for birthday messages | — |
| `ANNIVERSARY_CHANNEL_ID` | Channel for guild anniversary messages | — |
| `INACTIVITY_ALERT_CHANNEL_ID` | Channel for post-scan inactivity alerts | — |
| `GENERAL_CHANNEL_ID` | Channel for scheduled auto-posts | — |
| `COMMAND_LOG_CHANNEL_ID` | Channel for slash command audit log | — |
| `NEWSLETTER_CHANNEL_ID` | Channel to seed past newsletters from | `1303788137876684931` |

---

## Slash commands

### Public commands

| Command | Description |
|---|---|
| `/guild power` | All members ranked by combat power |
| `/guild top [number]` | Top N members by power (default 10, max 50) |
| `/guild inactive` | Members ranked by last active (longest offline first) |
| `/guild activeness` | Members ranked by activeness score (lowest first) |
| `/guild growth` | Top 5 members by power increase vs previous snapshot · shows `prev → current (+delta)` · excludes members with no prior record |
| `/guild nogrowth` | Members with zero or negative power growth |
| `/guild status` | Guild summary: member count, total power, active counts |
| `/guild newcomers` | Members not present in the previous snapshot |
| `/guild chart [number]` | Power growth line chart for current members over the last 10 scans |
| `/guild warbands` | All warbands with member counts, total power, and average activeness |
| `/guild unlinked` | Active members not yet linked to a Discord account |
| `/member name:` | Stats and up to 8 weeks of history for a member |
| `/member user:` | Same, but look up by @mention if the user is linked |
| `/invasion` | Alert the Homestead role of an invasion (optional `name:`/`user:`, defaults to you) |
| `/link ingame_name:` | Link your Discord account to your in-game name |
| `/birthday register` | Register your birthday (month/day) |
| `/birthday list` | List all registered birthdays |
| `/birthday remove` | Remove your birthday |
| `/remindme set time: message:` | Set a personal reminder (min 1h · max 90d). DM delivery, falls back to channel mention. |
| `/remindme list` | List your pending reminders with IDs and time remaining |
| `/remindme cancel id:` | Cancel a pending reminder by ID |
| `/ping` | Latency check with a tiered fun comment |
| `/help` | Show all commands (filtered by your permissions) |
| `/anniversary list count:` | Next N upcoming guild anniversaries (default 5, ephemeral) |
| `/anniversary upcoming days:` | All anniversaries in the next N days (default 30, ephemeral) |
| `/anniversary set member: date:` | Override a member's join date (first_seen) in the DB |

### Leader / admin commands

| Command | Description |
|---|---|
| `/scan` | Trigger a live guild scrape (authorized user only) · always runs the roster scan; enabled mode scans run alongside |
| `/roster add guild: user:` | Add a Discord member to a guild role (RiffRaff or Frop) · removes Who Dis? role |
| `/roster remove guild: user:` | Remove a Discord member from a guild role |
| `/roster transfer user: to_guild:` | Move a member from one guild to the other |
| `/rename old: new:` | Rename a member · merges into the target if that name already exists (dedupe) |
| `/review list` | List members the scanner flagged as new/unrecognized (`pending`) |
| `/review approve name:` | Confirm a pending member is real and correctly named |
| `/review merge pending_name: into_name:` | Merge a pending duplicate into an existing member |
| `/note add name: text:` | Add a note to a member |
| `/note view name:` | View all notes for a member |
| `/note delete id:` | Delete a note by ID |
| `/afk set name:` | Mark a member AFK, exempts from inactivity alerts |
| `/afk clear name:` | Remove AFK status |
| `/afk list` | List all currently AFK members |
| `/newsletter note add text: [category:]` | Log a note or event for the next newsletter |
| `/newsletter note list` | Show all notes since the last newsletter |
| `/newsletter note remove id:` | Delete a note by ID |
| `/newsletter generate` | Generate a draft newsletter via Claude. Returns a .txt with material summary + draft. No sign-off included. |
| `/newsletter seed` | Import past newsletters from the newsletter channel. Re-runnable after each new issue. |

> **Permissions:** All commands support DB-backed role and channel allowlists, configurable from the admin panel's **Permissions** tab without restarting. Per-command and per-subcommand rules are stored in `command_permissions` and checked at runtime by `enforcePermissions()`. `/review` also has a hardcoded code-level gate to the authorized scan user. Commands with no configured DB rules fall back to their built-in Discord permission level (`ManageGuild` for admin commands, public for everything else).

### Visual indicators

List commands show badges inline with member names:
- `🆕` · member joined this week (since Monday 00:00 UTC)
- `✈️` · member is currently marked AFK

---

## Automated tasks

| Task | Schedule | Description |
|---|---|---|
| Birthday check | Daily at midnight UTC (default) | Posts birthday embed for any member with a birthday today |
| Scan reminder | Daily at 20:00 UTC (default) | Reminds the authorized user to run a scan |
| Weekly summary | Every 7 days from Monday 09:00 UTC (default) | Posts power/growth summary · compares latest scan to oldest scan from the past 7 days |
| AFK expiry | Daily at midnight UTC (default) | Clears AFK records past their return date and notifies the inactivity channel |
| Anniversary check | Daily at 18:00 UTC (default) | Posts 1mo/3mo/6mo/yearly guild anniversaries for active members |
| Daily reset | Daily at midnight UTC (default) | Guild Supremacy/DR reminder. Skipped if bot offline more than 2h past fire time. |

All tasks run through a single unified job scheduler (`utils/jobScheduler.js`) backed by the `scheduled_jobs` DB table. **Next fire time and repeat interval for each job are configurable from the admin panel's Scheduled Jobs tab** -- no restart needed for schedule changes. User reminders (`/remindme`) use the same queue as one-shot jobs. The scheduler polls every 30 seconds.

---

## Security

To report a vulnerability, use the [GitHub private advisory](https://github.com/crysallis/MeerBot/security/advisories/new). See [SECURITY.md](SECURITY.md) for scope and what to expect.

---

## Project structure

```
MeerBot/
    index.js                    Entry point. Loads commands, handles interactions, rate limiter.
    deploy-commands.js          Registers slash commands with Discord API.
    config.js                   Static parameters: rate limit, ping tiers.
    ecosystem.config.js         PM2 multi-process config (meerbot + meerbot-admin).
    shared/
        theme.css               @import index for all per-theme files + compat aliases + theme controls.
        themes/
            jewel.css           Jewel palette (dark + light blocks, DaisyUI var names).
            chili.css           Chili palette.
            tigereye.css        Tigereye palette.
            plum.css            Plum palette.
            lapis.css           Lapis palette.
            synthwave.css       Synthwave palette (OKLCH colours from DaisyUI generator).
    stats/                      Public stats site (Vite + Tailwind v4 + DaisyUI v5).
        src/
            index.html          Stats UI — guild stats, charts, member tables.
            main.js             Entry point, theme/login logic, chart init.
            style.css           Tailwind + DaisyUI import + layout overrides.
            charts/             Chart.js chart builders (overview, dreamrealm, arena, lab).
    admin/
        server.js               Express admin panel server (binds 127.0.0.1:3001).
        auth.js                 Discord OAuth2 + tiered RBAC (read/manage/local), CSRF, audit, presence.
        public/index.html       Plain HTML admin UI — edit config without touching code.
        public/theme-demo.html  DaisyUI component showcase — all themes × dark/light.
        public/style.css        Admin panel layout and component overrides.
        REMOTE_ACCESS.md        How to expose the panel via Cloudflare Tunnel + OAuth.
    slash-commands/
        guild.js                All /guild subcommands incl. chart, warbands, unlinked.
        newsletter.js           /newsletter note/generate/seed · Claude-drafted newsletters.
        member.js               /member lookup with autocomplete.
        invasion.js             /invasion Homestead invasion alert (role ping).
        link.js                 /link with autocomplete.
        scan.js                 /scan + post-scan inactivity alert. Always passes --guild.
        roster.js               /roster add/remove/transfer · Discord role management for
                                RiffRaff and Frop guilds.
        rename.js               /rename with autocomplete · merges on name collision.
        review.js               /review list/approve/merge for scanner-flagged pending members.
        note.js                 /note add/view/delete.
        afk.js                  /afk set/clear/list.
        birthday.js             /birthday register/list/remove.
        help.js                 /help with permission-aware filtering.
        ping.js                 /ping health check with tiered quips.
        remindme.js             /remindme set / list / cancel personal reminders.
        anniversary.js          /anniversary list / upcoming / set (override first_seen).
        reactions.js            /reactions management for message-reaction rules.
        season.js               /season management.
        wishlist.js             /wishlist management.
        recruitment.js          /recruitment prospect tracking.
    utils/
        db.js                   SQLite connection + bot-only table creation (shared scan tables owned by the miner).
        botConfig.js            DB-backed config store. get(key) reads DB > ENV > default.
        jobScheduler.js         Unified job queue. Single 30s poller dispatches all job types.
        jobLog.js               Shared helper for scheduled jobs to record runs to scheduler_log.
        commandLogger.js        Audit log for every slash command invocation.
        permissions.js          Permission rules + DB-backed runtime enforcement.
                                enforce() for code-level checks (scanUser, admin).
                                enforcePermissions() checks command_permissions table
                                (role + channel allowlists per command/subcommand).
        handlers/
            scanReminder.js     Daily scan reminder handler.
            weeklySummary.js    Monday weekly power summary handler.
            birthdayCheck.js    Daily birthday check handler + buildBirthdayEmbed() export.
            afkExpiry.js        Daily expired AFK record cleanup handler.
            anniversaryCheck.js Daily guild anniversary handler + milestoneFor() export.
            dailyReset.js       Daily reset message handler (max 2h late window).
            translationRoleHandler.js  guildMemberUpdate handler. Fires when a member
                                gains the translation role -- DMs a bilingual embed
                                with instructions, then removes the role. Falls back
                                to a general channel message if DMs are off.
    scripts/
        merge-dupes.js          One-shot cleanup that collapses OCR phantom duplicate members.
        sync-join-dates.js      One-time backfill of first_seen from Discord join dates.
        list-channels.js        Fetch all guild channels and dump to data/discord-channels.json.
        list-roles.js           Fetch all guild roles and dump to data/discord-roles.json.
    data/
        birthday-wishes.json    Rotating birthday wish messages (editable without restart).
        discord-channels.json   Snapshot of all server channels (IDs, names, categories).
        discord-roles.json      Snapshot of all server roles (IDs, names, member counts).
    .env                        Environment variables (not committed to git).
```
