# Discord Bot · MeerBot

## Connected Repo

This bot is one half of a two-repo system. The other half is the Python scraper at `C:\vscode\AFKDataMining`.
They share `C:\vscode\AFKDataMining\guild.db`. Neither repo is standalone.
See global context at `C:\Users\crysa\.claude\CLAUDE.md`.

## Session Start

1. `mempalace wake-up` (global CLAUDE.md step 1) loads recent context.
2. Search `afkdatamining/gotchas` -- always, every session. These are the landmine rooms: hard-won constraints that silently break things when missed.
3. Search recent updates to the afkdatamining and discordbotafkj wings, each new session so you are up on the last few things discussed, back 2 days should be good enough.
3. Give a brief what's-done / what's-pending summary before starting the task.

Project knowledge: `afkdatamining` wing (rooms: status, src, decisions, gotchas, pending) · `discordbotafkj` wing (rooms: data, general, admin, scripts, slash_commands, gotchas, pending). Search `src` for mode-scan parser internals, `pending` for blocked/deferred work.

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
| `utils/db.js` | DB connection + bot-only table CREATEs (shared scan/identity tables are owned by the miner's `db.py`) · exports `mergeMembers`, `getWarbands`, `renameWarband`, `setMemberWarband` |
| `utils/botConfig.js` | DB-backed config store · `get(key)` reads DB → ENV → default · `set(key,val)` writes DB · `getAll()` for admin UI |
| `utils/scheduledMessages.js` | Timed auto-posts · add new messages to MESSAGES array here |
| `utils/afkExpiry.js` | Daily midnight UTC · clears expired AFK records, posts to inactivity channel |
| `utils/anniversaryCheck.js` | Daily at `ANNIVERSARY_TIME` UTC · posts guild anniversaries for active members (1/3/6 mo + yearly) |
| `utils/weeklySummary.js` | Monday 09:00 UTC · power growth summary embed |
| `utils/scanReminder.js` | Daily 20:00 UTC · pings authorized user to run /scan |
| `utils/birthdayCheck.js` | Daily at midnight · checks birthday table, posts embed |
| `utils/commandLogger.js` | Posts a Dyno-style audit embed for every slash command to `COMMAND_LOG_CHANNEL_ID` · uses cache.get (not fetch) |
| `utils/handlers/translationRoleHandler.js` | `guildMemberUpdate` handler · detects translation role gain (ID `1516271538217943131`) · DMs bilingual embed, then removes the role · fallback to general channel if DMs off |
| `utils/handlers/promoCodeHandler.js` | `messageCreate` handler · watches promo codes channel (`1229551249209430066`) · extracts codes (bold, `Code:` label, solo post, AFKJ prefix, serial codes) · INSERT OR IGNORE into `promo_codes` · exports `getRecentCodes(n)` for future on-join use |
| `utils/jobLog.js` | Shared helper · scheduled jobs call `logJobRun(name)` to record runs in `scheduler_log` |
| `admin/server.js` | Express admin panel server (binds 127.0.0.1:3001) · PM2 process `meerbot-admin` · all `/api/*` gated by `auth.js` · serves `/daisyui.css` from `node_modules/daisyui/daisyui.css` |
| `admin/auth.js` | Admin panel auth/RBAC · Discord OAuth2 login, session, three tiers (read/manage/local), CSRF, audit · `OPERATIONS` registry maps each editable action to a tab + default tier (override via `panel_op_access`) · `panel_roles` = role->tier · new tabs add an `OPERATIONS` entry so they appear in the Access tab automatically |
| `admin/REMOTE_ACCESS.md` | How to expose the panel via Cloudflare Tunnel (`admin.meerbot.dev`) + OAuth setup · for going beyond localhost |
| `admin/public/index.html` | Plain HTML admin UI · **Commands** tab (command/event channel settings · the old "Channels" tab, renamed; job-owned channels are NOT here) + thresholds + **Members** tab (rename/link/merge/approve/warband) + **Warbands** tab (add/rename/archive) + **Access** tab (local-only · per-op tiers, role->tier, audit log) + **Scheduled Jobs** cards (each job-owned channel renders as a "Posts to" select in its card · `JOB_CHANNEL_KEY` map) · login overlay + tier-gated controls · responsive ≤768px: hamburger drawer nav (header utilities relocate into it via matchMedia), Members table reflows to cards, other tables scroll · desktop look unchanged |
| `admin/public/style.css` | Admin panel layout overrides · uses `var(--border-color)` (our border-color var -- NOT DaisyUI's `--border` which is a width) and DaisyUI component classes |
| `admin/public/theme-demo.html` | Standalone DaisyUI showcase at `/theme-demo` · all component classes rendered in the active theme · uses only DaisyUI component classes + CSS var inline styles (no Tailwind utilities, no CDN -- CSP blocks it) |
| `shared/theme.css` | `@import` index for all 6 per-theme files + `:root` compat aliases + `.theme-picker`/`.mode-btn` CSS · adding a new theme = new file + import + option in both sites' theme selects |
| `shared/themes/*.css` | One file per palette (jewel/chili/tigereye/plum/lapis/synthwave) · each has `[data-theme="X"][data-mode="dark"]` and `[data-theme="X"][data-mode="light"]` blocks · uses DaisyUI var names (`--color-base-100` etc.) + our custom vars (`--border-color`, `--hover-bg`, `--card-shadow`, `--hard/--epic/--common`, `--radius`) · `--card-shadow: 0 0 8px 5px var(--border-color)` in all blocks |
| `stats/src/style.css` | Tailwind v4 + DaisyUI v5 entry · `@import "tailwindcss"; @plugin "daisyui" { themes: false; }` · layout + component overrides |
| `stats/src/index.html` | Public stats UI · DaisyUI component classes (`btn`, `badge`, `table`, `stat`, `card`) · Theme Preview tab shows all vars/components in active theme |
| `ecosystem.config.js` | PM2 multi-process config · defines `meerbot` + `meerbot-admin` |

## Slash Commands
| Command | Notes |
|---|---|
| `/ping` | Latency check with tiered quips · tiers in config.js |
| `/scan` | Runs Python scraper, posts results · then posts inactivity alert (active members only, AFK excluded) · authorized user only |
| `/member` | Member stats + power growth line chart (QuickChart GET URL) |
| `/invasion` | Alert the Homestead role that a homestead is being invaded · optional `name` (in-game, autocomplete) or `user` (linked Discord) · defaults to caller · posts an embed + role ping to `HOMESTEAD_CHANNEL_ID` |
| `/guild chart` | Multi-line power growth for all members (QuickChart POST → short URL) |
| `/guild unlinked` | Active members with no Discord account linked |
| `/afk set/clear/list` | AFK management · set_by stores Discord user ID (not username) |
| `/link` | Links a Discord user to an in-game name |
| `/rename` | Corrects an in-game name · merges into the target via `mergeMembers` if that name already exists |
| `/review` | list / approve / merge / remove / return · manage `pending` members + mark members left (`remove` → inactive) or reactivate (`return`) · scan user only |
| `/note` | Adds/views notes on a member |
| `/birthday` | Birthday registration (register / list / remove) |
| `/anniversary` | list / upcoming / set · upcoming guild anniversaries (ephemeral) · `set` overrides a member's first_seen date |
| `/wishlist` | add / list / remove · guild feature wishlist · permissions managed via Discord |
| `/season` | add / activate / inactivate / allyadd / allyremove / allylist · ally season + server management |
| `/recruitment` | add / list / update / remove · prospect tracking · 2-day follow-up reminder via job scheduler |
| `/newsletter note add/list/remove` | Capture notes/events between issues for the next newsletter |
| `/newsletter generate` | Claude-drafted newsletter using notes + DB context (new members, anniversaries, season) since last newsletter |
| `/newsletter seed` | Import past newsletters from the Discord newsletter channel into DB (re-runnable) |

## Database Tables (key ones)

Schema ownership: the miner (`AFKDataMining/src/db.py`) owns the shared scan/identity tables (members, snapshots, member_snapshots, warbands, name_corrections, member_name_history); the bot owns everything else. CREATE statements always reflect the current shape · schema changes are ALTERed once against guild.db then folded into the owner's CREATE, no migration trail on startup.
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
- `panel_roles` · role_id (PK), tier (read/manage/local) · maps Discord roles to admin-panel access tiers · seeded Riff/Raff→manage, RiffRaffians→read
- `panel_audit` · id, discord_id, action, target, at · one row per successful admin-panel mutation (actor = Discord ID, or `local`)
- `panel_op_access` · op_key (PK), tier · per-operation tier override (set via the Access tab) · absent = use the code default in `auth.js` `OPERATIONS`
- `panel_presence` · discord_id (PK), name, avatar, last_seen · heartbeat for "who's actively viewing the panel" · the page polls `GET /api/presence` every 45s, active = seen within 2 min · header shows other active viewers as a hover-fanning avatar stack · logins also write a `LOGIN` row to `panel_audit`
- `sessions` · auto-created/managed by `better-sqlite3-session-store` for admin-panel logins
- `promo_codes` · code (UNIQUE), posted_at (ISO datetime), message_id · auto-populated by `promoCodeHandler` on every new message in the promo codes channel · seeded via `scripts/backfill-promo-codes.js` · use `getRecentCodes(n)` from the handler for the planned on-join welcome feature

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
- Admin panel remote access (optional · only when exposed past localhost): `ADMIN_PUBLIC_HOST`, `ADMIN_OAUTH_REDIRECT`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `SESSION_SECRET` · full setup in `admin/REMOTE_ACCESS.md`. Local browser to 127.0.0.1 is always the `local` tier (no login); remote requires Discord OAuth2 and a Riff/Raff/RiffRaffian role.
- Channel IDs and timing values are now DB-backed via `bot_config` · env vars still work as fallbacks but prefer editing via admin panel
- `GENERAL_CHANNEL_ID` env var · general channel for scheduled messages (1229548159081123893)
- `COMMAND_LOG_CHANNEL_ID` env var · bot-chatter channel for command audit log (1343099233045184594)
- `ANNIVERSARY_CHANNEL_ID` env var · riffraff guild channel for anniversary posts (1303421884687192174)
- `ANNIVERSARY_TIME` env var · `HH:MM` UTC for anniversary post time (default `18:00` = 2pm EDT / 1pm EST)

## Discord Roles Reference

Full role list (with IDs, member counts, hoist/managed flags) lives at `data/discord-roles.json`.
Refresh with `node scripts/list-roles.js` whenever roles change.
Local-only (gitignored) · the repo is public, server layout stays out of it.

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
| `1516271538217943131` | Translation | — | One-shot trigger · bot DMs instructions then removes it |

## Discord Channels Reference

Full channel list (with IDs, categories, types) lives at `data/discord-channels.json`.
Refresh with `node scripts/list-channels.js` whenever the server adds/renames channels.
Local-only (gitignored) · the repo is public, server layout stays out of it.

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
| `HOMESTEAD_CHANNEL_ID` | homestead | 1403623893444329564 (default in CONFIG_META) |

## Key Decisions Made
- `set_by` fields store Discord user ID, displayed as `<@id> / ingame_name`
- Historical power values stored as `"86329K"` text + `float(86329 * 1000)` numeric
- Charts use QuickChart.io · GET URL for single-member, POST /chart/create for guild (30 lines too long for GET)
- Rate limit is global sliding window (all users combined), not per-user
- AFK expiry checked daily at midnight UTC · date-only return_date means no finer precision needed
- `GatewayIntentBits.GuildMembers` is enabled (privileged · must also be on in Discord Dev Portal → Bot → Server Members Intent) · required for `guildMemberUpdate` events
- Both slash command interactions and autocomplete drop silently if `interaction.guildId !== GUILD_ID` (foreign guild guard in index.js)
- `enforcePermissions` fails closed on DB error · returns false + "temporarily unavailable" message · never fails open
- Translation role (`1516271538217943131`) is a one-shot trigger · bot DMs the member then removes the role immediately · not a persistent role
- Admin panel `local` tier is granted by request ORIGIN, not by any role · a request is local iff Host is loopback AND no Cloudflare headers (`cf-connecting-ip`/`cf-ray`) · cloudflared also connects from 127.0.0.1, so the Host (not remoteAddress) is the real discriminator · do NOT "simplify" the Host guard or the local check to just an IP test, it would either lock out the local PC or leak reserved ops to the tunnel
- Admin panel server-side authorization (`admin/auth.js` `authorize`) is the real enforcement · the frontend `lockTiers()` only DISABLES controls it never hides them (read = all edits disabled except `.view-ok` filters + tab nav; manage = `.needs-local` controls disabled; local = nothing) · a MutationObserver re-runs `lockTiers()` after every dynamic re-render · every `/api/*` mutation still re-checks tier + CSRF and fails closed
- Admin panel access is data-driven: `OPERATIONS` registry (code defaults, grouped by tab) + `panel_op_access` (UI overrides) decide each action's tier · `/api/access*` is hardwired local-only and non-overridable (no remote lockout) · a role can be granted `read`/`manage` only, never `local` (local = origin), and a remote session is clamped to `manage` even if a role is mis-mapped · default op tiers: restart/refresh/scan-modes/scan-auth-user = local, everything else editable = manage, all GETs = read · CONVENTION: every new admin tab registers its mutations in `OPERATIONS` so they show up in the Access tab
- Theme system: DaisyUI v5 + Tailwind v4 · stats site has a full build pipeline; admin has no build so DaisyUI is served self-hosted from `node_modules/daisyui/daisyui.css` via `/daisyui.css` route in `admin/server.js` · Tailwind CDN is blocked by admin CSP so `theme-demo.html` uses only DaisyUI component classes + CSS var inline styles
- `--border-color` is our custom border-color variable · do NOT use `--border` which DaisyUI v5 reserves for border-width (`1px`) · pasting from the DaisyUI theme generator will include `--border: 1px` -- strip it, then add `--border-color: <value>` manually · same strip list: `--radius-selector`, `--radius-field`, `--radius-box`, `--size-selector`, `--size-field`, `--depth`, `--noise`, `color-scheme: "dark"` (remove quotes)
- `cssVarRgba()` in stats JS parses hex only · themes using OKLCH colours (synthwave) will produce transparent chart lines from that helper · not yet fixed
