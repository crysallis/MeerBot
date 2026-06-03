# Discord Bot · MeerBot

discord.js v14 · better-sqlite3 · PM2 · Node.js

Companion to `C:\vscode\AFKDataMining`. Reads the shared guild DB.
See global context at `C:\Users\crysa\.claude\CLAUDE.md`.

## Deploy
```
pm2 restart meerbot --update-env
pm2 logs meerbot --lines 20 --nostream
```
`DEV_REGISTER=true` in .env auto-registers slash commands on every startup.

Start both bot + admin panel (first time or after `ecosystem.config.js` changes):
```
pm2 start ecosystem.config.js
pm2 save
```
Admin panel: `http://localhost:3001` · separate PM2 process `meerbot-admin` · never needs `--update-env` (reads config from DB)

## Key Files
| File | Purpose |
|---|---|
| `index.js` | Entry point, command loader, rate limiter |
| `config.js` | Rate limit + ping tier constants (static code config only) |
| `utils/db.js` | DB connection + all table CREATE/migrations · exports `mergeMembers`, `getWarbands`, `renameWarband`, `setMemberWarband` |
| `utils/botConfig.js` | DB-backed config store · `get(key)` reads DB → ENV → default · `set(key,val)` writes DB · `getAll()` for admin UI |
| `utils/scheduledMessages.js` | Timed auto-posts · add new messages to MESSAGES array here |
| `utils/afkExpiry.js` | Daily midnight UTC · clears expired AFK records, posts to inactivity channel |
| `utils/anniversaryCheck.js` | Daily at `ANNIVERSARY_TIME` UTC · posts guild anniversaries for active members (1/3/6 mo + yearly) |
| `utils/weeklySummary.js` | Monday 09:00 UTC · power growth summary embed |
| `utils/scanReminder.js` | Daily 20:00 UTC · pings authorized user to run /scan |
| `utils/birthdayCheck.js` | Daily at midnight · checks birthday table, posts embed |
| `utils/commandLogger.js` | Posts a Dyno-style audit embed for every slash command to `COMMAND_LOG_CHANNEL_ID` |
| `utils/jobLog.js` | Shared helper · scheduled jobs call `logJobRun(name)` to record runs in `scheduler_log` |
| `admin/server.js` | Express admin panel server (port 3001, localhost only) · PM2 process `meerbot-admin` |
| `admin/public/index.html` | Plain HTML admin UI · channel IDs, timing, thresholds + **Members** tab (rename/link/merge/approve/warband) + **Warbands** tab (add/rename/archive) |
| `ecosystem.config.js` | PM2 multi-process config · defines `meerbot` + `meerbot-admin` |

## Slash Commands
| Command | Notes |
|---|---|
| `/ping` | Latency check with tiered quips · tiers in config.js |
| `/scan` | Runs Python scraper, posts results · then posts inactivity alert (active members only, AFK excluded) · authorized user only |
| `/member` | Member stats + power growth line chart (QuickChart GET URL) |
| `/guild chart` | Multi-line power growth for all members (QuickChart POST → short URL) |
| `/afk set/clear/list` | AFK management · set_by stores Discord user ID (not username) |
| `/link` | Links a Discord user to an in-game name |
| `/rename` | Corrects an in-game name · merges into the target via `mergeMembers` if that name already exists |
| `/review` | list / approve / merge / remove / return · manage `pending` members + mark members left (`remove` → inactive) or reactivate (`return`) · scan user only |
| `/note` | Adds/views notes on a member |
| `/birthday` | Birthday registration (register / list / remove) |
| `/schedule` | View scheduled jobs with last/next runs · ephemeral, no hardcoded restriction (use Discord role permissions if needed) |
| `/anniversary` | list / upcoming · upcoming guild anniversaries (ephemeral) |
| `/wishlist` | add / list / remove · guild feature wishlist · permissions managed via Discord |
| `/season` | add / activate / inactivate / allyadd / allyremove / allylist · ally season + server management |
| `/recruitment` | add / list / update / remove · prospect tracking · 2-day follow-up reminder via job scheduler |

## Database Tables (key ones)
- `members` · ingame_name (canonical, UNIQUE), discord_id, first_seen, `active` (latest-scan-only · 1 iff read in the most recent scan, else 0 · re-found = auto-reactivated), `last_scanned_at` (when last actually read by a scan), `pending` (scanner couldn't match read → awaiting /review), `warband_id` (current warband · synced from scan, manually overridable)
- `warbands` · canonical warband list (id, name UNIQUE, sort_order, archived) · rename here propagates everywhere
- `snapshots` · one row per scan run
- `member_snapshots` · power/activeness per member per snapshot
- `member_afk` · active AFK records · return_date is YYYY-MM-DD
- `scheduler_log` · sent_date dedup + full timestamp + late flag for auto-messages
- `name_corrections` · OCR correction map
- `bot_config` · key/value admin overrides · precedence: DB > ENV > hardcoded default
- `wishlist` · id, item, priority (high/medium/low), submitted_by (Discord user ID), submitted_at
- `ally_seasons` · id, name UNIQUE, active (0/1) · multiple can be inactive; seasons prepped before going active
- `ally_servers` · id, server_number, season_id · UNIQUE(server_number, season_id) · cascades on season delete
- `recruitment` · id, name, power, server_id, dr_rank, sup_arena_rank, lab_rank, dual_rank, interest, response, status (scouting/invited/joined/declined · default scouting), contacted_at, created_by, created_at
- `recruitment_followups` · id, job_id (→ scheduled_jobs), user_id, recruitment_id, channel_id · 2-day follow-up reminder

## Scheduled Messages
Defined in `utils/scheduledMessages.js` MESSAGES array. Each entry has:
- `name` · unique key used for scheduler_log dedup
- `channelEnv` · env var name holding the channel ID
- `utcHour/utcMinute` · when to fire
- `maxLateMinutes` · skip entirely if bot was down longer than this

Global late warning threshold: `LATE_WARNING_MINUTES` in `bot_config` table (default 30 min) · editable via admin panel.

### Current messages
| name | channel env | time UTC | maxLate |
|---|---|---|---|
| `daily_reset` | `GENERAL_CHANNEL_ID` | 00:00 | 120 min |

## Environment Notes
- Node.js v21.7.1 · technically outside better-sqlite3's supported range (20/22/24+) but works fine · don't suggest a Node upgrade just because of the EBADENGINE warning
- `ADMIN_PORT` env var · port for admin panel server (default `3001`)
- Channel IDs and timing values are now DB-backed via `bot_config` · env vars still work as fallbacks but prefer editing via admin panel
- `GENERAL_CHANNEL_ID` env var · general channel for scheduled messages (1229548159081123893)
- `COMMAND_LOG_CHANNEL_ID` env var · bot-chatter channel for command audit log (1343099233045184594)
- `ANNIVERSARY_CHANNEL_ID` env var · riffraff guild channel for anniversary posts (1303421884687192174)
- `ANNIVERSARY_TIME` env var · `HH:MM` UTC for anniversary post time (default `18:00` = 2pm EDT / 1pm EST)

## Discord Roles Reference

Full role list (with IDs, member counts, hoist/managed flags) lives at `data/discord-roles.json`.
Refresh with `node scripts/list-roles.js` whenever roles change.

Key roles for code references:

| ID | Name | Members | Purpose |
|---|---|---|---|
| `1229572649651404830` | Riff | 1 | Top leader |
| `1229554049788018808` | Raff | 5 | Co-leaders |
| `1401783863960666143` | RiffRaffians | 30 | Main guild membership |
| `1434417743616147557` | Kingdom | 32 | Sister guild |
| `1482484067965599846` | Penguins | 15 | Sister guild |
| `1299596817402695680` | Frog | 16 | Sister guild |
| `1269053193996996709` | Senior | 17 | Tenure tier |
| `1269053550156058634` | Junior | 4 | Tenure tier |
| `1269053789239771187` | Newbie | 6 | Tenure tier |
| `1269052266682519582` | AFK Forever | 15 | Inactive members |

## Discord Channels Reference

Full channel list (with IDs, categories, types) lives at `data/discord-channels.json`.
Refresh with `node scripts/list-channels.js` whenever the server adds/renames channels.

Channels referenced by env vars (snapshot · check the JSON for everything else):

| Env var | Channel name | ID |
|---|---|---|
| `BIRTHDAY_CHANNEL_ID` | riffraff | 1303421884687192174 |
| `INACTIVITY_ALERT_CHANNEL_ID` | leader-chat | 1235470919422709831 |
| `SCAN_REMINDER_CHANNEL_ID` | bot-chatter | 1343099233045184594 |
| `WEEKLY_SUMMARY_CHANNEL_ID` | bot-chatter | 1343099233045184594 |
| `COMMAND_LOG_CHANNEL_ID` | bot-chatter | 1343099233045184594 |
| `GENERAL_CHANNEL_ID` | general | 1229548159081123893 |
| `ANNIVERSARY_CHANNEL_ID` | riffraff | 1303421884687192174 |
| `RECRUITMENT_REMINDER_CHANNEL_ID` | *(set via admin panel)* | — |

## Key Decisions Made
- `set_by` fields store Discord user ID, displayed as `<@id> / ingame_name`
- Historical power values stored as `"86329K"` text + `float(86329 * 1000)` numeric
- Charts use QuickChart.io · GET URL for single-member, POST /chart/create for guild (30 lines too long for GET)
- Rate limit is global sliding window (all users combined), not per-user
- AFK expiry checked daily at midnight UTC · date-only return_date means no finer precision needed
