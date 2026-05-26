# Discord Bot · MeerBot

discord.js v15 · better-sqlite3 · PM2 · Node.js

Companion to `C:\vscode\AFKDataMining`. Reads the shared guild DB.
See global context at `C:\Users\crysa\.claude\CLAUDE.md`.

## Deploy
```
pm2 restart meerbot --update-env
pm2 logs meerbot --lines 20 --nostream
```
`DEV_REGISTER=true` in .env auto-registers slash commands on every startup.

## Key Files
| File | Purpose |
|---|---|
| `index.js` | Entry point, command loader, rate limiter |
| `config.js` | All tuneable parameters (rate limit, ping tiers, late warning threshold) |
| `utils/db.js` | DB connection + all table CREATE/migrations |
| `utils/scheduledMessages.js` | Timed auto-posts · add new messages to MESSAGES array here |
| `utils/afkExpiry.js` | Daily midnight UTC · clears expired AFK records, posts to inactivity channel |
| `utils/anniversaryCheck.js` | Daily at `ANNIVERSARY_TIME` UTC · posts guild anniversaries for active members (1/3/6 mo + yearly) |
| `utils/weeklySummary.js` | Monday 09:00 UTC · power growth summary embed |
| `utils/scanReminder.js` | Daily 20:00 UTC · pings authorized user to run /scan |
| `utils/birthdayCheck.js` | Daily at midnight · checks birthday table, posts embed |
| `utils/commandLogger.js` | Posts a Dyno-style audit embed for every slash command to `COMMAND_LOG_CHANNEL_ID` |
| `utils/jobLog.js` | Shared helper · scheduled jobs call `logJobRun(name)` to record runs in `scheduler_log` |

## Slash Commands
| Command | Notes |
|---|---|
| `/ping` | Latency check with tiered quips · tiers in config.js |
| `/scan` | Runs Python scraper, posts results · authorized user only |
| `/member` | Member stats + power growth line chart (QuickChart GET URL) |
| `/guild chart` | Multi-line power growth for all members (QuickChart POST → short URL) |
| `/afk set/clear/list` | AFK management · set_by stores Discord user ID (not username) |
| `/link` | Links a Discord user to an in-game name |
| `/rename` | Corrects an in-game name (updates name_corrections table) |
| `/note` | Adds/views notes on a member |
| `/birthday` | Birthday registration + test subcommand |
| `/schedule` | View scheduled jobs with last/next runs · ephemeral, no hardcoded restriction (use Discord role permissions if needed) |
| `/anniversary` | list / upcoming / test · ephemeral except `test` which posts the embed in the current channel with pings suppressed |

## Database Tables (key ones)
- `members` · ingame_name, discord_id, first_seen
- `snapshots` · one row per scan run
- `member_snapshots` · power/activeness per member per snapshot
- `member_afk` · active AFK records · return_date is YYYY-MM-DD
- `scheduler_log` · sent_date dedup + full timestamp + late flag for auto-messages
- `name_corrections` · OCR correction map

## Scheduled Messages
Defined in `utils/scheduledMessages.js` MESSAGES array. Each entry has:
- `name` · unique key used for scheduler_log dedup
- `channelEnv` · env var name holding the channel ID
- `utcHour/utcMinute` · when to fire
- `maxLateMinutes` · skip entirely if bot was down longer than this

Global thresholds in `config.js`: `lateWarningMinutes = 30` (adds late footer to embed).

### Current messages
| name | channel env | time UTC | maxLate |
|---|---|---|---|
| `daily_reset` | `GENERAL_CHANNEL_ID` | 00:00 | 120 min |

## Environment Notes
- Node.js v21.7.1 · technically outside better-sqlite3's supported range (20/22/24+) but works fine · don't suggest a Node upgrade just because of the EBADENGINE warning
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

## Key Decisions Made
- `set_by` fields store Discord user ID, displayed as `<@id> / ingame_name`
- Historical power values stored as `"86329K"` text + `float(86329 * 1000)` numeric
- Charts use QuickChart.io · GET URL for single-member, POST /chart/create for guild (30 lines too long for GET)
- Rate limit is global sliding window (all users combined), not per-user
- AFK expiry checked daily at midnight UTC · date-only return_date means no finer precision needed
