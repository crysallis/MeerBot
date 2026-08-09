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

## Test Bot

A second bot process, `meerbot-test`, runs the bot only (no admin/stats) against a separate
Discord application + test server + isolated DB, for trying changes before they reach the real
guild. It runs from its own git worktree checkout at `C:\vscode\DiscordBotAfkJ-test` (branch
`test-bot` by default, `main` as the fork point) with its own `.env` — **not** PM2's `env_file`
option, which was tried first and confirmed unreliable (`pm2 env` showed nothing injected,
which briefly caused the test process to load the real `.env` and log in as the real bot). A
separate checkout means `index.js`'s plain `require('dotenv').config()` resolves the right file
automatically by `cwd`, no PM2 env-injection dependency at all.

Workflow: branch off `main` inside `DiscordBotAfkJ-test`, commit there, `pm2 restart meerbot-test`
to pick up changes, test live in the test Discord server. When it's good, merge/PR into `main`,
then `git pull` + `pm2 restart meerbot --update-env` in the real checkout.

```
pm2 start ecosystem.config.js --only meerbot-test   # not started by default
pm2 restart meerbot-test
pm2 logs meerbot-test --lines 20 --nostream
```

Test env vars (`GUILD_DB_PATH=...guild.test.db`, `DEV_REGISTER=true`, distinct `DISCORD_TOKEN`/
`APPLICATION_ID`/`GUILD_ID`) live only in the test checkout's `.env`, gitignored. `guild.test.db`
was seeded as a one-time `VACUUM INTO` snapshot of the real `guild.db` and diverges independently
from there.

## Key Files
| File | Purpose |
|---|---|
| `index.js` | Entry point, command loader, rate limiter |
| `config.js` | Rate limit + ping tier constants (static code config only) |
| `utils/db.js` | DB connection + bot-only table CREATEs (shared scan/identity tables are owned by the miner's `db.py`) · exports `mergeMembers`, `getWarbands`, `renameWarband`, `setMemberWarband` |
| `utils/botConfig.js` | DB-backed config store · `get(key)` reads DB → ENV → default · `set(key,val)` writes DB · `getAll()` for admin UI |
| `utils/scheduledMessages.js` | Timed auto-posts · add new messages to MESSAGES array here (legacy path · a new recurring post that needs no code-computed content is usually better as a panel-authored `text_job` instead, see below) |
| `utils/jobScheduler.js` | Unified job queue · `tick()` polls `scheduled_jobs` every 30s, dispatches by `type` (`script_job`, `text_job`, `remindme`, `recruitment_followup`) |
| `utils/jobTemplate.js` | Pure helpers for text jobs · `renderTemplate` (`{{var}}` substitution, currently a passthrough — no variables registered yet), `shouldFireToday` (days_of_week filter, checked before any lateness/log write), `computeLateness`, `buildMentions` (only function allowed to turn structured `mentions` into real Discord ping syntax — embeds never notify regardless of `allowedMentions`, so this is the actual ping guard) |
| `utils/afkExpiry.js` | Daily midnight UTC · clears expired AFK records, posts to inactivity channel |
| `utils/anniversaryCheck.js` | Daily at `ANNIVERSARY_TIME` UTC · posts guild anniversaries for active members (1/3/6 mo + yearly) |
| `utils/weeklySummary.js` | Monday 09:00 UTC · power growth summary embed |
| `utils/scanReminder.js` | Daily 20:00 UTC · pings authorized user to run /scan |
| `utils/birthdayCheck.js` | Daily at midnight · checks birthday table, posts embed |
| `utils/commandLogger.js` | Posts a Dyno-style audit embed for every slash command to `COMMAND_LOG_CHANNEL_ID` · uses cache.get (not fetch) |
| `utils/handlers/translationRoleHandler.js` | `guildMemberUpdate` handler · detects translation role gain (ID `1516271538217943131`) · DMs bilingual embed, then removes the role · fallback to general channel if DMs off |
| `utils/handlers/promoCodeHandler.js` | `messageCreate` handler · watches promo codes channel (`1229551249209430066`) · extracts codes (bold, `Code:` label, solo post, AFKJ prefix, serial codes) · INSERT OR IGNORE into `promo_codes` · exports `getRecentCodes(n)` for future on-join use |
| `utils/handlers/translationRelayHandler.js` | `messageCreate` handler · relays messages across a small fixed group of Discord channels (2-4), each with one configured language, translated via one Claude Haiku 4.5 call per message (JSON keyed by target language, `stripCodeFence()` strips Haiku's markdown-fence wrapping before `JSON.parse`) · posts via per-channel webhook so the relay appears as the original author (`User X (app)` badge) · loop guard is `message.author.bot` (covers our own relay webhooks + any other bot), checked first · replies use a quoted-text prefix (`truncateQuote()`, 100 chars + `…`) since webhooks cannot carry a native Discord reply reference (verified via live probe, not assumed) · on translation failure relays untranslated + reacts with the target channel's flag emoji (fallback for an existing flag-reaction translate bot) · `fitContent()` truncates the body (never the quote prefix) to stay under Discord's 2000-char limit · `enqueueRelay()` serializes processing per `relay_group` (in-memory Promise chain) so concurrent messages relay in arrival order · every relayed copy (incl. the source) gets a `translation_relay_messages` row sharing one `relay_group_message_id`, used to resolve reply quoting |
| `utils/jobLog.js` | Shared helper · scheduled jobs call `logJobRun(name, late)` to record every run in `scheduler_log` (no dedup — see below) · also owns 90-day log retention (`pruneOldLogs()`, runs at most once per calendar day) |
| `admin/server.js` | Express admin panel server (binds 127.0.0.1:3001) · PM2 process `meerbot-admin` · all `/api/*` gated by `auth.js` · serves the Vite build from `admin/dist/` (static + `*` SPA fallback) · no longer serves `/daisyui.css` or `/shared` (bundled by Vite now) |
| `admin/auth.js` | Admin panel auth/RBAC · Discord OAuth2 login, session, three tiers (read/manage/local), CSRF, audit · `OPERATIONS` registry maps each editable action to a tab + default tier (override via `panel_op_access`) · `panel_roles` = role->tier · new tabs add an `OPERATIONS` entry so they appear in the Access tab automatically |
| `admin/REMOTE_ACCESS.md` | How to expose the panel via Cloudflare Tunnel (`admin.meerbot.dev`) + OAuth setup · for going beyond localhost |
| `admin/` Vite app | Vite + Tailwind v4 + DaisyUI v5 build (mirrors `stats/`) · own `package.json` + `vite.config.mjs` (`root: src`, `outDir: ../dist`, `publicDir: ../public`) · build with `npm run build --prefix admin` (or root `npm run build`) · `admin/public/` is now image-only (publicDir); old inline `index.html`/`style.css`/`theme-demo.html` deleted in the migration |
| `admin/src/index.html` | Admin UI markup · **Commands** tab (command/event channel settings · the old "Channels" tab, renamed; job-owned channels are NOT here) + thresholds + **Members** tab (rename/link/merge/approve/warband) + **Warbands** tab (add/rename/archive · per-warband guild assignment, leader role, member role · a Guild Override Roles table for transfer-approval-bypass roles per guild) + **Server Structure** tab (category > channel > role permission tree, read-only + a "Refresh from Discord" button · local tier) + **Access** tab (local-only · per-op tiers, role->tier, audit log) + **Scheduled Jobs** tab (collapsible tiles, one per job — system `script_job` or panel-authored `text_job` — each job-owned channel renders as a "Posts to" select in its expanded card · `JOB_CHANNEL_KEY` map · a "Create Job" form at the top makes new text jobs with no code/deploy) + **Translation Relay** tab (add/remove channels in the relay, each with a language + flag emoji · GET response allowlists safe fields only, webhook credentials never reach the frontend) + **Permissions** tab (mount points for the shared chip-picker widget, populated by `permissions.js`) · login overlay + tier-gated controls · responsive ≤768px: hamburger drawer nav (header utilities relocate into it via matchMedia), Members table reflows to cards, other tables scroll · keeps inline FOUC theme-init `<script>` in `<head>` + `<script type=module src=./main.js>` |
| `admin/src/main.js` | Admin entry point · imports `../../shared/theme.css` + `./style.css` + all tab modules · AUTH/CSRF fetch override, `applyAccess`/`lockTiers`, theme system, config-tab rendering, bootstrap · assigns all HTML `onclick` handlers to `window.*` · fetch override skips the global "Client Errors" panel for 400-status `/api/*` responses (those surface as inline field errors instead, see `jobs.js`) |
| `admin/src/chipPicker.js` | Shared dropdown+chip-collection widget · `createChipPicker({ options, initial, placeholder })` returns `{ el, getSelected() }` · used by the Scheduled Jobs mentions picker and the Permissions tab's role/channel pickers so neither lists every option as a standing chip |
| `admin/src/*.js` | Tab modules split from the old inline script: `jobs.js` `reactions.js` `members.js` `seasons.js` `permissions.js` `access.js` `serverStructure.js` `translationRelay.js` `chipPicker.js` · shared mutable state in `state.js` (allConfig/channelList/roleList/COMMAND_SUBS) · `utils.js` = `escHtml`/`utcToLocal` |
| `admin/src/serverStructure.js` | Server Structure tab · fetches `/api/server-structure` (reads `data/discord-structure.json`, written by `scripts/show-server-structure.js`) · "Refresh from Discord" button hits `POST /api/server-structure/refresh` (re-runs the script) · per channel: `synced` via discord.js `permissionsLocked` (deep-compares overwrites vs. parent category, NOT "zero overwrites" -- a synced channel under a category WITH overwrites still carries them copied down) · `everyoneCanView` via `permissionsFor(everyone)` (fully resolved chain: channel > category > base, not just the channel's own @everyone overwrite) |
| `admin/src/style.css` | Tailwind v4 + DaisyUI v5 entry (`@import "tailwindcss"; @plugin "daisyui" { themes: false; }`) + all admin layout overrides · uses `var(--border-color)` (our border-color var -- NOT DaisyUI's `--border` which is a width) |
| `shared/theme.css` | `@import` index for all 7 per-theme files + `:root` block (hover-bg, rarity vars, radius, Discord/warband vars) + `[data-theme="autumn"]` light-mode overrides + `.theme-picker` CSS · adding a new theme = new file + import + entry in `shared/themes.js` + FOUC map in `admin/src/index.html` |
| `shared/themes/*.css` | One file per palette (caramellatte/autumn/fantasy/abyss/ocean/synthwave/aqua) · each is a single `@plugin "daisyui/theme"` block with ALL DaisyUI `--color-*` vars incl. all `-content` pairs -- paste from DaisyUI generator as-is · do NOT define `--border-color` or `--card-shadow` here (removed) · borders use `var(--color-base-300)` directly |
| `shared/themes.js` | Theme registry -- `THEMES` array (value/label/mode) + `themeMode(value)` helper · imported by both sites for dropdown and mode lookup |
| `stats/src/style.css` | Tailwind v4 + DaisyUI v5 entry · `@import "tailwindcss"; @plugin "daisyui" { themes: false; }` · layout + component overrides |
| `stats/src/index.html` | Public stats UI · DaisyUI component classes (`btn`, `badge`, `table`, `stat`, `card`) · Theme Preview tab shows all vars/components in active theme |
| `ecosystem.config.js` | PM2 multi-process config · defines `meerbot` + `meerbot-admin` |

## Slash Commands
| Command | Notes |
|---|---|
| `/ping` | Latency check with tiered quips · tiers in config.js |
| `/scan` | Runs Python scraper, posts results · then posts inactivity alert (active members only, AFK excluded) · authorized user only |
| `/sa-manual` | Submit a Supreme Arena screenshot (any resolution/aspect ratio, e.g. off-server members' own phone captures) for parsing · calls `manual_scan.py` in the miner repo · replies ephemeral · unmatched names ping crysallis (member id 6) in `COMMAND_LOG_CHANNEL_ID` with the image attached, never auto-created as members · no code-level permission gate, configure via admin Permissions tab |
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
| `/clashfronts signedup` | List members who signed up for Clashfronts, with selected/unselected status · ephemeral |
| `/clashfronts notsigned` | Active, non-AFK members not yet in `clashfronts_signups` · ephemeral |
| `/clashfronts remind` | Posts to `CLASHFRONTS_REMINDER_CHANNEL_ID`, `@mention`s every not-signed-up linked member (chunked in batches of 50 for Discord's content/mention limits), lists unlinked members separately · no code-level permission gate |

## Database Tables (key ones)

Schema ownership: the miner (`AFKDataMining/src/db.py`) owns the shared scan/identity tables (members, snapshots, member_snapshots, name_corrections, member_name_history); the bot owns everything else, including `guilds`/`warbands` (Discord role/membership management is a bot concern, even though the miner still reads `warbands` to resolve OCR'd names during scanning). CREATE statements always reflect the current shape · schema changes are ALTERed once against guild.db then folded into the owner's CREATE, no migration trail on startup.
- `members` · ingame_name (canonical, UNIQUE), discord_id, first_seen, `active` (latest-scan-only · 1 iff read in the most recent scan, else 0 · re-found = auto-reactivated), `last_scanned_at` (when last actually read by a scan), `pending` (scanner couldn't match read → awaiting /review), `warband_id` (current warband · synced from scan, manually overridable)
- `guilds` · top-level guild (RKF RiffRaff, RKF Frop) · id, name UNIQUE, `override_role_ids` (JSON array of Discord role IDs that bypass transfer approval for this guild, e.g. Riff/Raff)
- `warbands` · sub-unit within a guild (id, name UNIQUE, sort_order, archived, `guild_id` FK, `leader_role_id` · must approve transfers into/out of this warband, `member_role_id` · granted/removed on transfer) · rename here propagates everywhere
- `snapshots` · one row per scan run
- `member_snapshots` · power/activeness per member per snapshot
- `member_afk` · active AFK records · return_date is YYYY-MM-DD
- `scheduled_jobs` · unified job queue · id, type (`script_job`/`text_job`/`remindme`/`recruitment_followup`), fire_at, recurrence (`daily:N`/`weekly:N`), enabled
- `text_jobs` · sub-table for type='text_job', FK `job_id` → scheduled_jobs · name, channel_id, title, body, mentions (JSON array), days_of_week (comma-separated ISO 1-7, NULL = every day), log_name (UNIQUE) · fully panel-authored, no code file needed
- `scheduler_log` · one row per job execution, no uniqueness constraint · every fire logs, including an accidental same-day double-fire — that's deliberate, so duplicates are visible instead of hidden · pruned to 90 days by `jobLog.js`
- `name_corrections` · OCR correction map
- `bot_config` · key/value admin overrides · precedence: DB > ENV > hardcoded default
- `wishlist` · id, item, priority (high/medium/low), submitted_by (Discord user ID), submitted_at
- `ally_seasons` · id, name UNIQUE, active (0/1) · multiple can be inactive; seasons prepped before going active
- `ally_servers` · id, server_number, season_id · UNIQUE(server_number, season_id) · cascades on season delete
- `recruitment` · id, name, power, server_id, dr_rank, sup_arena_rank, lab_rank, dual_rank, interest, response, status (scouting/invited/joined/declined · default scouting), contacted_at, created_by, created_at
- `recruitment_followups` · id, job_id (→ scheduled_jobs), user_id, recruitment_id, channel_id · 2-day follow-up reminder
- `panel_roles` · role_id (PK), tier (read/manage/local) · maps Discord roles to admin-panel access tiers · seeded Riff/Raff→manage, RiffRaffians→read
- `panel_audit` · id, discord_id, action, target, at, `site` (default `admin`) · one row per successful admin-panel mutation (actor = Discord ID, or `local`) · shared with the stats site (`site='stats'`), which only ever writes a `LOGIN` row (no mutations to audit there) · `admin/auth.js` `recentAudit(limit, site='admin')` filters by site
- `panel_op_access` · op_key (PK), tier · per-operation tier override (set via the Access tab) · absent = use the code default in `auth.js` `OPERATIONS`
- `panel_presence` · PK (`site`, `discord_id`) · site defaults `admin` · name, avatar, last_seen · heartbeat for "who's actively viewing" each site independently (same Discord user can show present on both at once, composite key prevents collision) · each page polls its own `GET /api/presence` every 45s, active = seen within 2 min · header shows other active viewers as a hover-fanning avatar stack · logins also write a `LOGIN` row to `panel_audit` tagged with that site
- `sessions` · auto-created/managed by `better-sqlite3-session-store` for admin-panel logins
- `promo_codes` · code (UNIQUE), posted_at (ISO datetime), message_id · auto-populated by `promoCodeHandler` on every new message in the promo codes channel · seeded via `scripts/backfill-promo-codes.js` · use `getRecentCodes(n)` from the handler for the planned on-join welcome feature
- `translation_relay_channels` · id, channel_id (UNIQUE), language, flag_emoji, relay_group (default `'default'` · schema supports multiple independent relay groups, v1 only uses one), webhook_id/webhook_token (cached per-channel webhook creds · **never** exposed via `GET /api/translation-relay`, which allowlists only id/channel_id/language/flag_emoji — the webhook token is a non-expiring bearer credential) · admin-panel managed via the Translation Relay tab
- `translation_relay_messages` · one row per relayed copy of a message, INCLUDING the source · id, relay_group_message_id (shared across every copy of the same logical message — the source row's own `id`), channel_id, message_id (UNIQUE), author_id, author_display_name, language, text · used to resolve reply-quoting (look up what a reply references, then find that logical message's copy in the replying channel's own language)
- `translation_usage` · id, message_id, input_tokens, output_tokens, target_count · one row per successful Claude translation call (not logged on failure) · exists so real per-message cost can be measured after a trial period instead of estimated

## Scheduled Messages
Two paths exist:

**Legacy code path** — `utils/scheduledMessages.js` MESSAGES array. Each entry has `name` (unique key used for scheduler_log), `channelEnv`, `utcHour/utcMinute`, `maxLateMinutes`. Use only when the post needs code-computed content (DB pulls, custom math) that can't be expressed as static text + variables.

**Panel-authored path (preferred for plain recurring text)** — a `text_job` row, created and fully edited from the admin panel's Scheduled Jobs tab: name, fire date/time, repeat interval, day-of-week filter, channel, title, body, mentions. No code file or deploy. This is how the Daily Reset weekday/weekend split was built — `dailyReset.js` was retired; the weekday (crest-earning) and weekend (boss-attack) reminders are now two independent text jobs with different `days_of_week` and body text.

Both paths share the same lateness model: `MAX_LATE_MINUTES` = 120 (skip sending entirely if the bot was down longer than this), and a global `LATE_WARNING_MINUTES` threshold in `bot_config` (default 30 min, editable via admin panel) that adds a "late" flag/footer without skipping the send.

## Environment Notes
- Node.js v21.7.1 · technically outside better-sqlite3's supported range (20/22/24+) but works fine · don't suggest a Node upgrade just because of the EBADENGINE warning
- `ADMIN_PORT` env var · port for admin panel server (default `3001`)
- Admin panel remote access (optional · only when exposed past localhost): `ADMIN_PUBLIC_HOST`, `ADMIN_OAUTH_REDIRECT`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `SESSION_SECRET` · full setup in `admin/REMOTE_ACCESS.md`. Local browser to 127.0.0.1 is always the `local` tier (no login); remote requires Discord OAuth2 and a Riff/Raff/RiffRaffian role.
- Channel IDs and timing values are now DB-backed via `bot_config` · env vars still work as fallbacks but prefer editing via admin panel
- `GENERAL_CHANNEL_ID` env var · general channel for scheduled messages (1229548159081123893)
- `COMMAND_LOG_CHANNEL_ID` env var · bot-chatter channel for command audit log (1343099233045184594)
- `ANNIVERSARY_CHANNEL_ID` env var · riffraff guild channel for anniversary posts (1303421884687192174)
- `ANNIVERSARY_TIME` env var · `HH:MM` UTC for anniversary post time (default `18:00` = 2pm EDT / 1pm EST)
- `ANTHROPIC_API_KEY` · required by the **bot process itself** now, not just `/newsletter generate` · `translationRelayHandler.js` makes one Claude Haiku 4.5 call per message posted in a configured relay channel

## Discord Roles Reference

Full role list (with IDs, member counts, hoist/managed flags) lives at `data/discord-roles.json`.
Refresh with `node scripts/list-roles.js` whenever roles change.
Local-only (gitignored) · the repo is public, server layout stays out of it.

Key roles for code references:

| ID | Name | Purpose |
|---|---|---|
| `1229572649651404830` | Riff | Top leader |
| `1229554049788018808` | Raff | Co-leaders |
| `1523580372208717964` | RKF RiffRaff (Guild) | Top-level guild role · `roster.js` `GUILDS.riffraff.id` (single source, imported by `stats/auth.js` + `scripts/audit-guild-roles.js`) |
| `1533951415633051688` | RKF Frop (Guild) | Top-level guild role · `roster.js` `GUILDS.frop.id` |
| `1401783863960666143` | RiffRaff (Warband) | Sub-unit within RKF RiffRaff |
| `1434417743616147557` | Kingdom (Warband) | Sub-unit within RKF RiffRaff |
| `1509752237193429104` | Sobaquitos (Warband) | Sub-unit within RKF RiffRaff |
| `1482484067965599846` | Penguins | Sub-unit within RKF Frop |
| `1299596817402695680` | Frog | Sub-unit within RKF Frop |
| `1330742760306638889` | Who Dis? | Stripped automatically on `/roster add` (`roster.js` `WHO_DIS_ROLE_ID`) |
| `1502845579661672478` | OG RiffRaff | Auto-granted at 2-year anniversary (`anniversaryCheck.js` `OG_ROLE_ID`) |
| `1403623545984127036` | Homestead | Pinged by `/invasion` (`invasion.js` `HOMESTEAD_ROLE_ID`) |
| `1269053193996996709` | Senior | Tenure tier |
| `1269053550156058634` | Junior | Tenure tier |
| `1269053789239771187` | Newbie | Tenure tier |
| `1269052266682519582` | AFK Forever | Inactive members |
| `1516271538217943131` | Translation | One-shot trigger · bot DMs instructions then removes it |

Any Discord role ID hardcoded in a `.js` file (as opposed to DB-backed via `guilds.override_role_ids`/`warbands.leader_role_id`/`warbands.member_role_id`/`command_permissions`) should be in this table. `roster.js`'s `GUILDS` map is exported and is the one place to import from rather than re-hardcoding the RiffRaff/Frop guild IDs elsewhere.

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
- `/scan` pings crysallis (member id 6) directly if a Clashfronts scan leaves `REVIEW_NAMES` unresolved — higher stakes than other modes' unmatched names, since an unresolved signed-up member is silently absent from `clashfronts_signups` and `/clashfronts remind` would otherwise publicly ping someone who already signed up. Not persisted state — a scan-time check in `scan.js`'s execFile callback, gated on `modeFlags.includes("--clashfronts")`, same reviewNames already parsed for the general review note
- `enforcePermissions` fails closed on DB error · returns false + "temporarily unavailable" message · never fails open
- Translation role (`1516271538217943131`) is a one-shot trigger · bot DMs the member then removes the role immediately · not a persistent role
- Discord webhooks cannot send native replies · verified via a live probe (not assumed): `discord.js`'s `WebhookMessageCreateOptions.reply` throws, and a raw REST call with `message_reference` in the webhook-execute body is silently accepted (200 OK) but never attaches as a visible reply — no arrow, no jump link, a true no-op on that endpoint · `translationRelayHandler.js`'s reply handling uses a quoted-text prefix instead, by design, not as a fallback-of-convenience
- Translation relay loop guard is `message.author.bot`, not a webhookId-against-table lookup · functionally equivalent (Discord sets `bot: true` on every webhook-authored message in the gateway payload) and simpler · confirmed airtight in both code review and live multi-message testing
- Admin panel `local` tier is granted by request ORIGIN, not by any role · a request is local iff Host is loopback AND no Cloudflare headers (`cf-connecting-ip`/`cf-ray`) · cloudflared also connects from 127.0.0.1, so the Host (not remoteAddress) is the real discriminator · do NOT "simplify" the Host guard or the local check to just an IP test, it would either lock out the local PC or leak reserved ops to the tunnel
- Admin panel server-side authorization (`admin/auth.js` `authorize`) is the real enforcement · the frontend `lockTiers()` only DISABLES controls it never hides them (read = all edits disabled except `.view-ok` filters + tab nav; manage = `.needs-local` controls disabled; local = nothing) · a MutationObserver re-runs `lockTiers()` after every dynamic re-render · every `/api/*` mutation still re-checks tier + CSRF and fails closed
- Admin panel access is data-driven: `OPERATIONS` registry (code defaults, grouped by tab) + `panel_op_access` (UI overrides) decide each action's tier · `/api/access*` is hardwired local-only and non-overridable (no remote lockout) · a role can be granted `read`/`manage` only, never `local` (local = origin), and a remote session is clamped to `manage` even if a role is mis-mapped · default op tiers: restart/refresh/scan-modes/scan-auth-user = local, everything else editable = manage, all GETs = read · CONVENTION: every new admin tab registers its mutations in `OPERATIONS` so they show up in the Access tab
- Theme system: DaisyUI v5 + Tailwind v4 · BOTH sites have a full Vite build pipeline · 7 themes: caramellatte (dark, default), autumn (light), fantasy, abyss, ocean, synthwave, aqua · theme files are clean DaisyUI generator dumps -- paste any new theme straight in, no manual var mapping needed · admin CSP keeps `'unsafe-inline'` in scriptSrc only for the FOUC theme-init `<script>` in `<head>`
- DaisyUI base var convention: `base-100`=lightest/raised cards+header+inputs · `base-200`=page background (body) · `base-300`=borders/dividers ONLY, never a fill · always pair surface+content: primary+primary-content, base-100+base-content etc. · `--border-color` custom var REMOVED -- use `var(--color-base-300)` directly
- Adding a new theme: create `shared/themes/X.css` with `@plugin "daisyui/theme"` block (paste DaisyUI generator output, keep `--radius-*` `--size-*` `--border` `--depth` `--noise`, strip `--border-color`/`--card-shadow` if pasted from old theme) · import in `shared/theme.css` · add entry to `shared/themes.js` THEMES array · add to FOUC `THEME_MODES` map in `admin/src/index.html` · if light theme add `[data-theme="X"]` override in `theme.css` for `--hover-bg`, `--hard`, `--epic`, `--common`
- `cssVarRgba()` in stats JS handles both hex and OKLCH via `color-mix` fallback (ec7d0ef) · Canvas 2D supports `color-mix` in Chrome 111+ / FF 113+ / Safari 16.2+

## Roster Transfer Approval (2026-07)
`/roster transfer` moves a member between **warbands**, not guilds (guild is now the
top-level container — RKF RiffRaff merged Riffraff/Kingdom/Sobaquitos into one 90-member
guild with those as warbands inside it; RKF Frop is a separate, second guild with its own
warbands). `add`/`remove` stay guild-level, unchanged.

A transfer needs sign-off from whichever side (source or destination warband) did **not**
initiate it, unless the initiator holds a guild-level override role (`guilds.override_role_ids`
— Riff/Raff for RKF RiffRaff, Queen of the Frogs for RKF Frop) or leads both warbands
themselves (no one else would have standing to approve). See `resolveApprover()` in
`utils/transferApproval.js` for the full precedence order.

Approval only changes Discord roles — `guild.db`'s `members.warband_id` is left for the next
mining scan to resolve via OCR, since the in-game move is a separate human action that may not
happen at the same time as the Discord-side approval.

This is the bot's first button-interaction flow (`utils/handlers/transferButtonHandler.js`,
new `interaction.isButton()` branch in `index.js`). Buttons are clickable from either the
channel post (`the-not-so-round-table`, configurable via `TRANSFER_APPROVAL_CHANNEL_ID`) or a
DM — a DM interaction has no `interaction.guild`, so the handler resolves the bot's one managed
guild explicitly via `GUILD_ID` rather than relying on interaction context. Authorization checks
`transfer_approval_eligibility` (who was recorded eligible at request time) instead of
re-deriving role membership at click time — found live-testing-adjacent during build: the
vacant-leader-role fallback can make several different guild-override-role holders all eligible,
but only one role id is stored on `transfer_approvals.approving_role_id`, so a live role
re-check would incorrectly reject some of the people actually DM'd. `interaction.deferUpdate()`
fires immediately after the eligibility/status gates, before any role edits — `applyTransferRoles()`
plus several member/user REST fetches can exceed Discord's 3s ack deadline.

`guilds`/`warbands` schema ownership moved from the miner to the bot as part of this feature
(Discord role/membership management is a bot concern) — see Database Tables above and the
miner's own CLAUDE.md.
