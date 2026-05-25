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
# Start via PM2 (registers commands automatically on boot when DEV_REGISTER=true)
pm2 start index.js --name meerbot
pm2 save
pm2 startup
```

### Updating after code changes

```powershell
pm2 restart meerbot --update-env
```

---

## Configuration (.env)

| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Bot token from Discord Developer Portal |
| `APPLICATION_ID` | Your application/client ID |
| `GUILD_ID` | Discord server ID to register slash commands to |
| `DEV_REGISTER` | Set to `true` to auto-register slash commands on startup |
| `SCAN_AUTHORIZED_USER` | Discord user ID allowed to run `/scan` |
| `SCAN_REMINDER_CHANNEL_ID` | Channel to post daily scan reminders |
| `SCAN_REMINDER_TIME` | Time to post reminder in `HH:MM` UTC (e.g. `20:00`) |
| `WEEKLY_SUMMARY_CHANNEL_ID` | Channel to post Monday weekly summaries |
| `WEEKLY_SUMMARY_TIME` | Time to post summary in `HH:MM` UTC (e.g. `09:00`) |
| `BIRTHDAY_CHANNEL_ID` | Channel to post birthday messages |
| `INACTIVITY_ALERT_CHANNEL_ID` | Channel to post post-scan inactivity alerts |
| `SCRAPER_PYTHON` | Full path to the venv Python executable |
| `SCRAPER_SCRIPT` | Full path to `scraper.py` |

---

## Slash commands

### Public commands

| Command | Description |
|---|---|
| `/guild power` | All members ranked by combat power |
| `/guild top [number]` | Top N members by power (default 10, max 50) |
| `/guild inactive` | Members ranked by last active (longest offline first) |
| `/guild activeness` | Members ranked by activeness score (lowest first) |
| `/guild growth` | Top 5 members by power increase vs previous snapshot |
| `/guild nogrowth` | Members with zero or negative power growth |
| `/guild status` | Guild summary: member count, total power, active counts |
| `/guild newcomers` | Members not present in the previous snapshot |
| `/member name:` | Stats and up to 8 weeks of history for a member |
| `/member user:` | Same, but look up by @mention if the user is linked |
| `/link ingame_name:` | Link your Discord account to your in-game name |
| `/birthday register` | Register your birthday (month/day) |
| `/birthday list` | List all registered birthdays |
| `/birthday remove` | Remove your birthday |

### Admin commands (Manage Server permission required)

| Command | Description |
|---|---|
| `/scan` | Trigger a live guild scrape (authorized user only) |
| `/rename old: new:` | Rename a member, logs history and adds name correction |
| `/note add name: text:` | Add a note to a member |
| `/note view name:` | View all notes for a member |
| `/note delete id:` | Delete a note by ID |
| `/afk set name:` | Mark a member AFK, exempts from inactivity alerts |
| `/afk clear name:` | Remove AFK status |
| `/afk list` | List all currently AFK members |
| `/birthday test [user:]` | Preview the birthday embed (admin only) |

### Visual indicators

List commands show badges inline with member names:
- `🆕` · member joined this week (since Monday 00:00 UTC)
- `✈️` · member is currently marked AFK

---

## Automated tasks

| Task | Schedule | Description |
|---|---|---|
| Birthday check | Daily at UTC midnight | Posts birthday embed for any member with a birthday today |
| Scan reminder | Daily at `SCAN_REMINDER_TIME` | Reminds the authorized user to run a scan |
| Weekly summary | Mondays at `WEEKLY_SUMMARY_TIME` | Posts power/growth summary for the whole guild |

---

## Project structure

```
DiscordBotAfkJ/
    index.js                    Entry point. Loads commands, handles interactions, rate limiter.
    deploy-commands.js          Registers slash commands with Discord API.
    slash-commands/
        guild.js                All /guild subcommands.
        member.js               /member lookup with autocomplete.
        link.js                 /link with autocomplete.
        scan.js                 /scan + post-scan inactivity alert.
        rename.js               /rename with autocomplete.
        note.js                 /note add/view/delete.
        afk.js                  /afk set/clear/list.
        birthday.js             /birthday register/list/remove/test.
        help.js                 /help with permission-aware filtering.
        ping.js                 /ping health check.
    utils/
        db.js                   SQLite connection, schema creation.
        birthdayCheck.js        Birthday embed builder and scheduler.
        scanReminder.js         Daily scan reminder scheduler.
        weeklySummary.js        Monday weekly summary scheduler.
    data/
        birthday-wishes.json    Rotating birthday wish messages (editable without restart).
    .env                        Environment variables (not committed to git).
```
