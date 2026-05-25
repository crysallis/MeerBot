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
| `utils/weeklySummary.js` | Monday 09:00 UTC · power growth summary embed |
| `utils/scanReminder.js` | Daily 20:00 UTC · pings authorized user to run /scan |
| `utils/birthdayCheck.js` | Daily at midnight · checks birthday table, posts embed |

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
- `maxLateMinutes` · skip entirely if bot was down longer than this (daily_reset = 120)

Global thresholds in `config.js`: `lateWarningMinutes = 30` (adds late footer to embed).

## Key Decisions Made
- `set_by` fields store Discord user ID, displayed as `<@id> / ingame_name`
- Historical power values stored as `"86329K"` text + `float(86329 * 1000)` numeric
- Charts use QuickChart.io · GET URL for single-member, POST /chart/create for guild (30 lines too long for GET)
- Rate limit is global sliding window (all users combined), not per-user
- AFK expiry checked daily at midnight UTC · date-only return_date means no finer precision needed
