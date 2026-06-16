# MeerBot Commands

> Use `/help` in Discord for a filtered view based on your permissions. Use `/help command:name` for detail on a specific command.

---

## Public Commands

### /member
Look up a guild member's stats, power history, and rankings.

| Usage | Description |
|---|---|
| `/member name:` | Look up by in-game name (autocompletes) |
| `/member user:` | Look up by @mention if the user is linked |

---

### /guild
Guild-wide statistics. All subcommands use the most recent scan snapshot.

| Usage | Description |
|---|---|
| `/guild power` | All members ranked by combat power (highest first) |
| `/guild top number:` | Top N members by power (default 10, max 50) |
| `/guild inactive` | Members ranked by last active (longest offline first) |
| `/guild activeness` | Members ranked by activeness score (lowest first) |
| `/guild growth` | Top 5 members by power increase vs previous snapshot |
| `/guild nogrowth` | Members with zero power growth vs previous snapshot |
| `/guild status` | Guild summary: member count, total power, active counts, last scan time |
| `/guild newcomers` | Members who were not in the previous snapshot |
| `/guild chart number:` | Power growth line chart over the last 10 scans. Optional N limits to top N by power. |
| `/guild warbands` | All warbands with member counts, total power, and average activeness |
| `/guild unlinked` | Active members not yet linked to a Discord account |

List commands show inline badges:
- `🆕` joined this week
- `✈️` currently AFK

---

### /link
Link your Discord account to your in-game name so the bot can find you by @mention.

| Usage | Description |
|---|---|
| `/link ingame_name:` | Link yourself. Warns if a link already exists on either side. |
| `/link ingame_name: confirm:True` | Overwrite an existing conflicting link after reviewing the warning. |

---

### /anniversary
Guild anniversary milestones (1 month / 3 months / 6 months / yearly) based on join date.

| Usage | Description |
|---|---|
| `/anniversary list count:` | Next N upcoming anniversaries (default 5, max 20) |
| `/anniversary upcoming days:` | All anniversaries in the next N days (default 30, max 365) |

---

### /remindme
Set a personal reminder. The bot will DM you when the time arrives, or mention you in the channel if your DMs are off.

| Usage | Description |
|---|---|
| `/remindme set time: message:` | Set a reminder. Duration format: `2h`, `1d12h`, `45m` (min 1h · max 90d) |
| `/remindme list` | List your pending reminders with IDs and time remaining |
| `/remindme cancel id:` | Cancel a pending reminder by its ID |

---

### /birthday
Register and celebrate guild member birthdays.

| Usage | Description |
|---|---|
| `/birthday register month: day:` | Register your birthday. Feb 29 is allowed for leap-day births. |
| `/birthday list` | List all registered birthdays sorted by month/day |
| `/birthday remove` | Remove your registered birthday |

---

### /wishlist
Guild feature wishlist.

| Usage | Description |
|---|---|
| `/wishlist add item: priority:` | Submit an item with `high` / `medium` / `low` priority |
| `/wishlist list` | View all items sorted by priority then date |
| `/wishlist remove id:` | Remove an item by its ID |

---

### /ping
Health check. Replies with Pong and the measured latency in ms, with a tiered comment.

---

### /help
Show all commands you have access to, or get details on a specific one.

| Usage | Description |
|---|---|
| `/help` | List all commands visible to you |
| `/help command:name` | Show all subcommands and descriptions for that command |

---

## Leader / Admin Commands

> These commands require specific roles or permissions configured in the admin panel.

### /afk
Mark members as AFK to exempt them from inactivity alerts.

| Usage | Description |
|---|---|
| `/afk set name: reason: return_date:` | Mark a member AFK. Reason and return date are optional. Date format: YYYY-MM-DD. |
| `/afk clear name:` | Remove AFK status from a member |
| `/afk list` | Show all currently AFK members |

---

### /note
Private leader notes on members.

| Usage | Description |
|---|---|
| `/note add name: text:` | Add a note to a member |
| `/note view name:` | View all notes for a member, with IDs and timestamps |
| `/note delete id:` | Delete a specific note by its ID |

---

### /rename
Correct a member's in-game name in the database.

| Usage | Description |
|---|---|
| `/rename old_name: new_name:` | Updates the member record, logs the change to history, and adds a name correction so future scans map correctly. If the new name already exists, the two records are merged. |

---

### /review
Review members the scanner flagged as new or unrecognized.

| Usage | Description |
|---|---|
| `/review list` | List pending members awaiting review, with power and warband |
| `/review approve name:` | Confirm a pending member is real and correctly named |
| `/review merge pending_name: into_name:` | Merge a pending duplicate into an existing member |
| `/review remove name:` | Mark a member who left the guild as inactive |
| `/review return name:` | Reactivate a member previously marked inactive |

---

### /roster
Manage guild membership roles (RKF RiffRaff · RKF Frop).

| Usage | Description |
|---|---|
| `/roster add guild: user:` | Add a member to a guild. Removes the onboarding role if present and sends a welcome message. |
| `/roster remove guild: user:` | Remove a member from a guild |
| `/roster transfer user: to_guild:` | Move a member from one guild to the other |

---

### /recruitment
Track recruitment prospects with stats, status, and auto follow-up reminders.

| Usage | Description |
|---|---|
| `/recruitment add name: power: contacted: server: ...` | Add a prospect. Optional: DR/sup arena/lab/dual ranks, interest, response, status. Schedules a 2-day follow-up reminder. |
| `/recruitment list` | View prospects (defaults to scouting + invited). Filters: status, interest, server, date. |
| `/recruitment update name: ...` | Update any field: status, interest, response, power, server, ranks |
| `/recruitment remove name:` | Remove a prospect and cancel any pending follow-up reminder |

Status values: `scouting` · `invited` · `joined` · `declined`

---

### /season
Manage ally seasons and their server lists.

| Usage | Description |
|---|---|
| `/season add name:` | Create a new season (inactive by default) |
| `/season activate season:` | Mark a season as active |
| `/season inactivate season:` | Mark a season as inactive |
| `/season allyadd season: server:` | Add an ally server number to a season |
| `/season allyremove season: server:` | Remove an ally server number from a season |
| `/season allylist season:` | List ally servers for a season (omit season for the active one) |

---

### /anniversary set
Override a member's join date in the database.

| Usage | Description |
|---|---|
| `/anniversary set member: date:` | Set a member's `first_seen` date. Format: YYYY-MM-DD. Autocompletes member name. |

---

### /newsletter
Guild newsletter tools. Generates Claude-drafted issues using notes and live DB context.

| Usage | Description |
|---|---|
| `/newsletter note add text: category:` | Log a note for the next newsletter. Category: `event` / `member` / `season` / `other` |
| `/newsletter note list` | Show all notes logged since the last newsletter |
| `/newsletter note remove id:` | Delete a note by ID |
| `/newsletter generate` | Generate a draft newsletter as a .txt attachment. Includes material summary + Claude draft. |
| `/newsletter seed` | Import past newsletters from the newsletter channel into the DB. Re-runnable. |

---

### /scan
Trigger a live guild member scan. Requires BlueStacks and the game to be open. Authorized user only.

| Usage | Description |
|---|---|
| `/scan` | Scrapes the guild member list, saves a snapshot, then posts an inactivity alert for members offline too long (AFK-exempt members excluded) |

---

### /link (admin)
| Usage | Description |
|---|---|
| `/link ingame_name: user:` | Link a different Discord user to an in-game name. Requires Manage Server permission. |
