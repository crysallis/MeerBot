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
| `utils/db.js` | DB connection + bot-only table CREATEs (shared scan/identity tables are owned by the miner's `db.py`) · exports `mergeMembers` (also reactivates the kept row — `active = 1` unconditionally, since matching an existing member means they're current), `getWarbands`, `renameWarband`, `setMemberWarband` |
| `utils/botConfig.js` | DB-backed config store · `get(key)` reads DB → ENV → default · `set(key,val)` writes DB · `getAll()` for admin UI |
| `utils/scheduledMessages.js` | Timed auto-posts · add new messages to MESSAGES array here (legacy path · a new recurring post that needs no code-computed content is usually better as a panel-authored `text_job` instead, see below) |
| `utils/jobScheduler.js` | Unified job queue · `tick()` polls `scheduled_jobs` every 30s, dispatches by `type` (`script_job`, `text_job`, `remindme`, `recruitment_followup`, `glorycta_tally`) · `handleGloryctaTally` resolves reactors to in-game names, posts results, unpins, strips the poll's Cancel Vote button, deletes its own `glorycta_polls` row in a `finally` (cleanup runs even if the Discord fetch/post throws) · no lateness gate on this or any one-shot job type — a late fire is still correct, unlike recurring `text_job`/`script_job` |
| `utils/jobTemplate.js` | Pure helpers for text jobs · `renderTemplate` (`{{var}}` substitution, currently a passthrough — no variables registered yet), `shouldFireToday` (days_of_week filter, checked before any lateness/log write), `computeLateness`, `buildMentions` (only function allowed to turn structured `mentions` into real Discord ping syntax — embeds never notify regardless of `allowedMentions`, so this is the actual ping guard) |
| `utils/afkExpiry.js` | Daily midnight UTC · clears expired AFK records, posts to inactivity channel |
| `utils/anniversaryCheck.js` | Daily at `ANNIVERSARY_TIME` UTC · posts guild anniversaries for active members (1/3/6 mo + yearly) |
| `utils/weeklySummary.js` | Monday 09:00 UTC · power growth summary embed |
| `utils/scanReminder.js` | Daily 20:00 UTC · pings authorized user to run /scan |
| `utils/birthdayCheck.js` | Daily at midnight · checks birthday table, posts embed |
| `utils/commandLogger.js` | Posts a Dyno-style audit embed for every slash command to `COMMAND_LOG_CHANNEL_ID` · uses cache.get (not fetch) |
| `utils/handlers/translationRoleHandler.js` | `guildMemberUpdate` handler · detects translation role gain (ID `1516271538217943131`) · DMs bilingual embed, then removes the role · fallback to general channel if DMs off |
| `utils/handlers/promoCodeHandler.js` | `messageCreate` handler · watches promo codes channel (`1229551249209430066`) · extracts codes (bold, `Code:` label, solo post, AFKJ prefix, serial codes) · INSERT OR IGNORE into `promo_codes` · exports `getRecentCodes(n)` for future on-join use |
| `utils/handlers/translationRelayHandler.js` | `messageCreate` handler · relays messages across a small fixed group of Discord channels (2-4), each with one configured language · messages BATCH by author within a relay group before translating: a same-author, non-reply message joins the open batch for that author+channel; a different author's message or ANY reply flushes whatever's open immediately and starts a fresh batch; a same-author message from a DIFFERENT source channel also flushes (else the combined batch would be translated/routed using the first message's channel/language) · every open batch waits its full configured timeout (`translation_relay_batch_timeout_seconds`, admin-panel editable) before flushing, unless force-flushed early by one of the above · one Claude Haiku 4.5 call per BATCH (not per message) — response is now a JSON object keyed by target language, each value an ARRAY of translated lines (one per batched message, in order), not a single string (`stripCodeFence()` strips Haiku's markdown-fence wrapping before `JSON.parse`) · posts via per-channel webhook so the relay appears as the original author (`User X (app)` badge) · loop guard is `message.author.bot` (covers our own relay webhooks + any other bot), checked first · replies use a quoted-text prefix (`truncateQuote()`, 100 chars + `…`) since webhooks cannot carry a native Discord reply reference (verified via live probe, not assumed) · on translation failure relays untranslated + reacts with the target channel's flag emoji (fallback for an existing flag-reaction translate bot) · `fitContent()` truncates the body (never the quote prefix) to stay under Discord's 2000-char limit · `enqueueRelay()` serializes processing per `relay_group` (in-memory Promise chain) so concurrent batches relay in arrival order · every relayed copy of a batch (incl. the source) gets a `translation_relay_messages` row sharing one `relay_group_message_id`, used to resolve reply quoting · **attachments**: `message.attachments` passed straight into the webhook `files` payload on send · attachments are NOT persisted anywhere (only live on the in-memory batch entry, read once at send time) and `resyncRelayGroup` (edit/delete sync) has no attachment data at all, so editing/deleting a line with an image re-flows the text but cannot re-attach or explicitly retain the image · confirmed via live test (2026-08-09) that Discord's `editMessage` without a `files` key DOES leave an existing attachment alone (discord.js's docstring was correct; a linked discord-api-docs issue #5170 claiming v10 clears attachments regardless did not reproduce here) · no re-hosting, DB storage, or size handling beyond Discord's own enforcement — persisted per-message attachment metadata is a follow-up task, not shipped in this wave · **reaction sync** (`handleTranslationReactionSync`, wired to `messageReactionAdd`/`Remove`): mirrors a reaction bidirectionally across all copies of a relay group via the bot's own client — webhooks have no react method, so this always goes through the bot account, not a reproduction of the real per-user reaction; loop-guarded on `user.id === client.user.id` · **edit/delete sync** (`handleTranslationEditSync`/`handleTranslationDeleteSync`, wired to `messageUpdate`/`messageDelete`): re-translates and edits (or deletes) every relayed copy when the SOURCE message changes, using `batch_message_ids`' per-message `{messageId,text}[]` shape (see schema entry below) to rebuild the batch minus/with the changed line · both handlers only ever act on a batch's ANCHOR (first) message — `row.message_id` is always `messages[0].messageId`, so editing/deleting a non-first line of an already-relayed batch is a **known, documented no-op**, not a bug (ruled a safety improvement over silent corruption, not a regression, by two independent re-reviewers) · confirmed live (2026-08-09): after the anchor is deleted (survivors re-flow the relayed copy per the above), the remaining lines stay permanently un-editable/undeletable too — the row's `message_id` never repoints to a new anchor, so this isn't a one-off edge case but a durable state a batch can land in · accepted as low-priority (deletes are rare); non-anchor edit/delete support would need its own small task (a source-row-only DB lookup, e.g. `AND id = relay_group_message_id`, not a guard relaxation — this exact lookup path has caused 3 of this feature's 4 serious bugs, see project memory) rather than a quick patch to this branch · `row.id !== row.relay_group_message_id` guards both handlers against ever acting on a relayed COPY row instead of the source (copies aren't directly editable via Discord anyway — webhook-token-only — but the guard closes the same class of gap symmetrically) · shared `resyncRelayGroup()` rebuilds the quote-prefix (if the edited/deleted message was itself a reply) and applies `fitContent()` before every webhook edit, matching the original send path · edit/delete work is routed through `enqueueRelay()` keyed by the row's actual `relay_group` string (derived via `db.getRelayChannelByChannelId(row.channel_id).relay_group`, NOT the numeric `relay_group_message_id`) so an edit and a delete on the same batch can't interleave |
| `utils/jobLog.js` | Shared helper · scheduled jobs call `logJobRun(name, late)` to record every run in `scheduler_log` (no dedup — see below) · also owns 90-day log retention (`pruneOldLogs()`, runs at most once per calendar day) |
| `slash-commands/glory.js` | `/glory cta`/`confirm`/`count` · single file, three subcommands, share the `glorycta_polls` table (see Database Tables) · `cta` picks 2 random emoji from `utils/glorycta.js`'s `EMOJI_POOL`, posts a pinned timed vote with a Cancel Vote button, one-shot `scheduled_jobs` tally job · `confirm` posts an untimed fixed ✅/❌/🤔 availability check, no timer/tally, row never auto-cleaned · `count` parses a pasted message link and tallies live reactions on either kind, posting results in that post's own channel — votes are never persisted to the DB, only read live off Discord's own reaction state |
| `utils/glorycta.js` | Pure helpers for `/glory` · `pickPollEmoji()` (2 distinct random emoji from a 40-entry pool, excludes flags + skin-tone modifiers, never fixed/admin-set) · `nextOccurrenceUtc(hhmm, fromDate)` (next UTC instant matching that clock time, rolls to tomorrow independently per call) |
| `utils/handlers/gloryctaReactionGuard.js` | `messageReactionAdd` handler · strips any reaction on a tracked `glorycta_polls` message that isn't one of its own valid emoji, silently, no DM · `stripVariationSelectors()` normalizes VS15/VS16 before comparing (Discord's gateway doesn't guarantee echoing them consistently; a naive `===` risks false-negative-deleting a *legitimate* vote) · on `kind='confirm'` posts only, reacting with a second valid emoji swaps the vote (old one auto-removed) — `cta` is exempt since holding both its emoji is a real "either time works" signal |
| `utils/handlers/gloryctaCancelButtonHandler.js` | Handles `custom_id` prefix `glorycta_cancel:` on `index.js`'s shared `isButton()` branch (chained after `transferButtonHandler`) · re-checks `enforcePermissions(interaction, 'glory', 'cta')`, same gate as the command · deletes the message + `scheduled_jobs` row + `glorycta_polls` row |
| `utils/handlers/askHandler.js` | Not a slash command · `messageCreate` handler, DM-only (`message.guild === null`, requires `GatewayIntentBits.DirectMessages` — see Environment Notes), answers plain-language questions about what the bot can do · system prompt = `help.js`'s `COMMANDS` + `docs/bot-guide.md` (short model-facing doc, NOT README/ARCHITECTURE — those produced documentation-styled answers, see project memory) + a personalized capability summary from `askCapabilities.js` · one Claude Haiku call per DM, last 3 answered exchanges kept as conversation history (same in-memory `Map` and rolling-hour window as the 10/hour/user rate limit — `isRateLimited()` counts every attempt, `recordExchange()` fills in the in-flight entry once answered) · logs token usage to `claude_usage` (`feature='ask'`) · falls back to a static `/help` pointer on any failure |
| `utils/handlers/askCapabilities.js` | Pure helper for `askHandler.js` · `buildCapabilitySummary(member, commands)` reads `command_permissions` directly (via `permissions.js`'s exported `pickRows`, same precedence `enforcePermissions` uses) to describe what a specific member can run and where — read-only, never calls `enforcePermissions` itself |
| `admin/server.js` | Express admin panel server (binds 127.0.0.1:3001) · PM2 process `meerbot-admin` · all `/api/*` gated by `auth.js` · serves the Vite build from `admin/dist/` (static + `*` SPA fallback) · no longer serves `/daisyui.css` or `/shared` (bundled by Vite now) |
| `admin/auth.js` | Admin panel auth/RBAC · Discord OAuth2 login, session, three tiers (read/manage/local), CSRF, audit · `OPERATIONS` registry maps each editable action to a tab + default tier (override via `panel_op_access`) · `panel_roles` = role->tier · new tabs add an `OPERATIONS` entry so they appear in the Access tab automatically |
| `admin/REMOTE_ACCESS.md` | How to expose the panel via Cloudflare Tunnel (`admin.meerbot.dev`) + OAuth setup · for going beyond localhost |
| `admin/` Vite app | Vite + Tailwind v4 + DaisyUI v5 build (mirrors `stats/`) · own `package.json` + `vite.config.mjs` (`root: src`, `outDir: ../dist`, `publicDir: ../public`) · build with `npm run build --prefix admin` (or root `npm run build`) · `admin/public/` is now image-only (publicDir); old inline `index.html`/`style.css`/`theme-demo.html` deleted in the migration |
| `admin/src/index.html` | Admin UI markup · **Commands** tab (command/event channel settings · the old "Channels" tab, renamed; job-owned channels are NOT here) + thresholds + **Members** tab (rename/link/merge/approve/warband) + **Warbands** tab (add/rename/archive · per-warband guild assignment, leader role, member role · a Guild Override Roles table for transfer-approval-bypass roles per guild) + **Server Structure** tab (category > channel > role permission tree, read-only + a "Refresh from Discord" button · local tier) + **Access** tab (local-only · per-op tiers, role->tier, audit log) + **Scheduled Jobs** tab (collapsible tiles, one per job — system `script_job` or panel-authored `text_job` — each job-owned channel renders as a "Posts to" select in its expanded card · `JOB_CHANNEL_KEY` map · monthly recurrence with day-of-month set to "Last day of month" reveals a Before/On offset row (N days before the last day) · a "Create Job" form at the top makes new text jobs with no code/deploy) + **Translation Relay** tab (add/remove channels in the relay, each with a language + flag emoji, plus a batch-timeout field (`translation_relay_batch_timeout_seconds`, 1-15s) controlling how long a same-author batch waits before flushing · GET response allowlists safe fields only, webhook credentials never reach the frontend) + **Permissions** tab (mount points for the shared chip-picker widget, populated by `permissions.js`) · login overlay + tier-gated controls · responsive ≤768px: hamburger drawer nav (header utilities relocate into it via matchMedia), Members table reflows to cards, other tables scroll · keeps inline FOUC theme-init `<script>` in `<head>` + `<script type=module src=./main.js>` |
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
| `/glory cta time1: time2: duration:` | Clash of Glory battle-time vote · two UTC HH:MM options, 2 distinct random emoji per run from `utils/glorycta.js`'s 40-entry `EMOJI_POOL` (never fixed/admin-set) · `<t:UNIX:t>` Local + UTC per option, independent "next occurrence" rollover · non-pool reactions silently stripped, both-emoji counts in both tally columns · one-shot `scheduled_jobs` tally job auto-posts results + unpins + strips its own Cancel Vote button after `duration` hours · post/react/pin/DB-write failures clean up the partial message + job row so nothing orphans |
| `/glory confirm time:` | Untimed yes/no/maybe (✅/❌/🤔, fixed not randomized) availability check for a decided UTC time (Local + UTC shown, same as `cta`) · one vote per person (reacting with a different option swaps it, doesn't stack) · no timer, no auto-tally, `glorycta_polls` row never auto-cleaned |
| `/glory count message:` | Tally live reactions on a `/glory cta` or `/glory confirm` post via a pasted Discord message link · posts results in that post's own channel · votes are never persisted to the DB, only read live off the Discord message's own reactions |

## Database Tables (key ones)

Schema ownership: the miner (`AFKDataMining/src/db.py`) owns the shared scan/identity tables (members, snapshots, member_snapshots, name_corrections, member_name_history); the bot owns everything else, including `guilds`/`warbands` (Discord role/membership management is a bot concern, even though the miner still reads `warbands` to resolve OCR'd names during scanning). CREATE statements always reflect the current shape · schema changes are ALTERed once against guild.db then folded into the owner's CREATE, no migration trail on startup.
- `members` · ingame_name (canonical, UNIQUE), discord_id, first_seen, `active` (latest-scan-only · 1 iff read in the most recent scan, else 0 · re-found = auto-reactivated), `last_scanned_at` (when last actually read by a scan), `pending` (scanner couldn't match read → awaiting /review), `warband_id` (current warband · synced from scan, manually overridable)
- `guilds` · top-level guild (RKF RiffRaff, RKF Frop) · id, name UNIQUE, `override_role_ids` (JSON array of Discord role IDs that bypass transfer approval for this guild, e.g. Riff/Raff)
- `warbands` · sub-unit within a guild (id, name UNIQUE, sort_order, archived, `guild_id` FK, `leader_role_id` · must approve transfers into/out of this warband, `member_role_id` · granted/removed on transfer) · rename here propagates everywhere
- `snapshots` · one row per scan run
- `member_snapshots` · power/activeness per member per snapshot
- `member_afk` · active AFK records · return_date is YYYY-MM-DD
- `scheduled_jobs` · unified job queue · id, type (`script_job`/`text_job`/`remindme`/`recruitment_followup`/`glorycta_tally`), fire_at, recurrence (`daily:N`/`weekly:N`), enabled, `last_day_offset` (nullable, meaningful only when `day_of_month=-1`: N = fire N days before the last day of the month; NULL/0 = on the last day)
- `text_jobs` · sub-table for type='text_job', FK `job_id` → scheduled_jobs · name, channel_id, title, body, mentions (JSON array), days_of_week (comma-separated ISO 1-7, NULL = every day), log_name (UNIQUE) · fully panel-authored, no code file needed
- `glorycta_polls` · one row per open `/glory cta` or `/glory confirm` post · `kind` (`cta`/`confirm`), `job_id` (nullable FK → scheduled_jobs, ON DELETE CASCADE · set for cta's one-shot tally job, NULL for confirm which has no timer), `message_id` (UNIQUE, the lookup key for the reaction guard + `/glory count`), `channel_id`, `emoji_a`/`emoji_b`/`emoji_c` (emoji_c nullable, only used by confirm's third "maybe" option), `label_a`/`label_b`/`label_c`, `fire_at_a`/`fire_at_b` (nullable, cta only) · confirm rows are never auto-deleted (no cleanup mechanism, accumulates by design); cta rows are deleted by the tally handler once it fires · required a one-time SQLite table-rebuild migration (2026-08-14) since `job_id` was originally `NOT NULL` and `ADD COLUMN` can't relax that
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
- `translation_relay_messages` · one row per relayed copy of a BATCH, INCLUDING the source (not one row per message — a batch of several same-author messages collapses to a single row per channel) · id, relay_group_message_id (shared across every copy of the same logical batch — the source row's own `id`, so `row.id === row.relay_group_message_id` is the source-vs-copy discriminator used by edit/delete sync), channel_id, message_id (UNIQUE · the batch's first/ANCHOR message id for the source row, the sent webhook message id for target rows), author_id, author_display_name, language, text (all batched lines joined, never includes a reply's quote-prefix — that's send-time-only, added by `processTranslationRelay`/`resyncRelayGroup` on top of the stored text), `batch_message_ids` (`{messageId, text}[]` as of the attachments/edit/delete-sync feature — was a flat `string[]` of message ids only before; the richer shape lets edit/delete sync resolve and rebuild one line of a multi-message batch precisely, not just quote-lookup any line · a startup migration (`runRelayMessageMigration()` in `db.js`) rewrites any row still in the old flat shape in place, safe to run every startup · `getRelayMessageByMessageId`'s `json_each`/`json_extract` scan over this column only touches object-shaped entries (`value LIKE '{%'` guard) so one still-legacy row can't break lookups for every other row), `last_line_text` (just the final batched line, translated for that row's language · used for reply-quote prefixes so a multi-line batch quotes only its last line, not the whole batch) · used to resolve reply-quoting (look up what a reply references, then find that logical batch's copy in the replying channel's own language)
- `claude_usage` · id, feature (`'translation'` | `'ask'`), ref_id (feature-specific — source message_id for translation batches, asking user's Discord id for ask DMs), input_tokens, output_tokens, target_count (nullable, translation-only — languages in that batch), created_at · one row per successful Claude API call across every feature that makes one, not logged on failure · was two separate tables (`translation_usage`, `ask_usage`) until 2026-08-15, consolidated into one so total or per-feature cost is a single query instead of unioning by hand — one-time guarded migration in `db.js` copied old rows across and dropped both old tables

## Scheduled Messages
Two paths exist:

**Legacy code path** — `utils/scheduledMessages.js` MESSAGES array. Each entry has `name` (unique key used for scheduler_log), `channelEnv`, `utcHour/utcMinute`, `maxLateMinutes`. Use only when the post needs code-computed content (DB pulls, custom math) that can't be expressed as static text + variables.

**Panel-authored path (preferred for plain recurring text)** — a `text_job` row, created and fully edited from the admin panel's Scheduled Jobs tab: name, fire date/time, repeat interval, day-of-week filter, channel, title, body, mentions. No code file or deploy. This is how the Daily Reset weekday/weekend split was built — `dailyReset.js` was retired; the weekday (crest-earning) and weekend (boss-attack) reminders are now two independent text jobs with different `days_of_week` and body text.

Both paths share the same lateness model: `MAX_LATE_MINUTES` = 120 (skip sending entirely if the bot was down longer than this), and a global `LATE_WARNING_MINUTES` threshold in `bot_config` (default 30 min, editable via admin panel) that adds a "late" flag/footer without skipping the send.

## Environment Notes
- Node.js 24.19.0 LTS · upgraded 2026-08-08 from Node 21.7.1 (EOL) · within better-sqlite3's supported range (20/22/24+)
- No nvm/version-manager rollback path currently exists on this machine · nvm-windows was attempted during the upgrade but caused an incident (it removed the existing Node install, and the reinstall step went unapproved due to a hidden installer window), so Node 24 was installed directly via the official nodejs.org .msi installer instead and nvm-windows was abandoned · a future clean nvm-windows install would need to start from a state where Node is NOT already installed via a separate MSI, to avoid it trying to migrate/remove an existing install
- `ADMIN_PORT` env var · port for admin panel server (default `3001`)
- Admin panel remote access (optional · only when exposed past localhost): `ADMIN_PUBLIC_HOST`, `ADMIN_OAUTH_REDIRECT`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `SESSION_SECRET` · full setup in `admin/REMOTE_ACCESS.md`. Local browser to 127.0.0.1 is always the `local` tier (no login); remote requires Discord OAuth2 and a Riff/Raff/RiffRaffian role.
- Channel IDs and timing values are now DB-backed via `bot_config` · env vars still work as fallbacks but prefer editing via admin panel
- `GENERAL_CHANNEL_ID` env var · general channel for scheduled messages (1229548159081123893)
- `COMMAND_LOG_CHANNEL_ID` env var · bot-chatter channel for command audit log (1343099233045184594)
- `ANNIVERSARY_CHANNEL_ID` env var · riffraff guild channel for anniversary posts (1303421884687192174)
- `ANNIVERSARY_TIME` env var · `HH:MM` UTC for anniversary post time (default `18:00` = 2pm EDT / 1pm EST)
- `ANTHROPIC_API_KEY` · required by the **bot process itself** now, not just `/newsletter generate` · `translationRelayHandler.js` makes one Claude Haiku 4.5 call per BATCH of messages posted in a configured relay channel (not per message — see the Key Files entry)

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
| `INACTIVITY_ALERT_CHANNEL_ID` | *(set via admin panel)* | — |
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
- `GatewayIntentBits.GuildMessageReactions` + `partials: [Partials.Message, Partials.Reaction]` are enabled · required for translation relay's reaction sync (`messageReactionAdd`/`Remove` events don't fire at all without the intent, and reactions on uncached messages arrive partial without `Partials.Reaction`) · edit sync's `messageUpdate` listener also fetches a partial `newMessage` before reading its content, and explicitly skips (does not re-translate) when `oldMessage` itself is partial — its content can't be compared reliably, so treating that case as a real edit risks a spurious, billed Claude re-translation on a no-op embed-load update
- `GatewayIntentBits.DirectMessages` + `Partials.Channel` are enabled (not privileged, no Dev Portal toggle) · required for `askHandler.js` — `GuildMessages` does NOT cover DMs, they're a separate intent · without it a DM to the bot produces zero error anywhere, `messageCreate` simply never fires for that message · nothing needed this before `askHandler.js` since `transferButtonHandler.js`'s DM flow is button interactions (`INTERACTION_CREATE`), a different gateway event
- Both slash command interactions and autocomplete drop silently if `interaction.guildId !== GUILD_ID` (foreign guild guard in index.js)
- `/scan` pings crysallis (member id 6) directly if a Clashfronts scan leaves `REVIEW_NAMES` unresolved — higher stakes than other modes' unmatched names, since an unresolved signed-up member is silently absent from `clashfronts_signups` and `/clashfronts remind` would otherwise publicly ping someone who already signed up. Not persisted state — a scan-time check in `scan.js`'s execFile callback, gated on `modeFlags.includes("--clashfronts")`, same reviewNames already parsed for the general review note
- `enforcePermissions` fails closed on DB error · returns false + "temporarily unavailable" message · never fails open
- `enforcePermissions` treats a `command_permissions` row saved with `subcommand=NULL` (the admin panel's "whole command" option) as applying to every subcommand that has no more specific rule of its own · precedence decided independently per constraint type (role, channel), never once for the whole lookup — a subcommand-specific role rule must not silently suppress a command-wide channel rule, or vice versa · fixed 2026-08-14 (e4edaac): the lookup previously matched `subcommand` exactly only, so every command-wide rule anyone had ever saved via the admin panel was a silent no-op for all 13 multi-subcommand commands (`guild`/`glory`/`afk`/`anniversary`/`note`/`review`/`roster`/`remindme`/`recruitment`/`season`/`wishlist`/`newsletter`/`birthday`) — discovered live when `/guild power` ran successfully in a channel not on `/guild`'s configured allowlist · regression-tested in `utils/permissions.test.js`
- Translation role (`1516271538217943131`) is a one-shot trigger · bot DMs the member then removes the role immediately · not a persistent role
- Discord webhooks cannot send native replies · verified via a live probe (not assumed): `discord.js`'s `WebhookMessageCreateOptions.reply` throws, and a raw REST call with `message_reference` in the webhook-execute body is silently accepted (200 OK) but never attaches as a visible reply — no arrow, no jump link, a true no-op on that endpoint · `translationRelayHandler.js`'s reply handling uses a quoted-text prefix instead, by design, not as a fallback-of-convenience
- Translation relay loop guard is `message.author.bot`, not a webhookId-against-table lookup · functionally equivalent (Discord sets `bot: true` on every webhook-authored message in the gateway payload) and simpler · confirmed airtight in both code review and live multi-message testing
- `translation_relay_batch_timeout_seconds` is stored via `botConfig` (default 10, max 15, seconds) but is deliberately NOT registered in `botConfig.js`'s `CONFIG_META` — this keeps it off the generic admin Config tab; it's only editable from the dedicated Translation Relay tab. Do not "fix" this by adding it to `CONFIG_META`.
- Admin panel `local` tier is granted by request ORIGIN, not by any role · a request is local iff Host is loopback AND no Cloudflare headers (`cf-connecting-ip`/`cf-ray`) · cloudflared also connects from 127.0.0.1, so the Host (not remoteAddress) is the real discriminator · do NOT "simplify" the Host guard or the local check to just an IP test, it would either lock out the local PC or leak reserved ops to the tunnel
- Admin panel server-side authorization (`admin/auth.js` `authorize`) is the real enforcement · the frontend `lockTiers()` only DISABLES controls it never hides them (read = all edits disabled except `.view-ok` filters + tab nav; manage = `.needs-local` controls disabled; local = nothing) · a MutationObserver re-runs `lockTiers()` after every dynamic re-render · every `/api/*` mutation still re-checks tier + CSRF and fails closed
- Admin panel access is data-driven: `OPERATIONS` registry (code defaults, grouped by tab) + `panel_op_access` (UI overrides) decide each action's tier · `/api/access*` is hardwired local-only and non-overridable (no remote lockout) · a role can be granted `read`/`manage` only, never `local` (local = origin), and a remote session is clamped to `manage` even if a role is mis-mapped · default op tiers: restart/refresh/scan-modes/scan-auth-user = local, everything else editable = manage, all GETs = read · CONVENTION: every new admin tab registers its mutations in `OPERATIONS` so they show up in the Access tab
- Theme system: DaisyUI v5 + Tailwind v4 · BOTH sites have a full Vite build pipeline · 7 themes: caramellatte (dark, default), autumn (light), fantasy, abyss, ocean, synthwave, aqua · theme files are clean DaisyUI generator dumps -- paste any new theme straight in, no manual var mapping needed · admin CSP keeps `'unsafe-inline'` in scriptSrc only for the FOUC theme-init `<script>` in `<head>`
- DaisyUI base var convention: `base-100`=lightest/raised cards+header+inputs · `base-200`=page background (body) · `base-300`=borders/dividers ONLY, never a fill · always pair surface+content: primary+primary-content, base-100+base-content etc. · `--border-color` custom var REMOVED -- use `var(--color-base-300)` directly
- Adding a new theme: create `shared/themes/X.css` with `@plugin "daisyui/theme"` block (paste DaisyUI generator output, keep `--radius-*` `--size-*` `--border` `--depth` `--noise`, strip `--border-color`/`--card-shadow` if pasted from old theme) · import in `shared/theme.css` · add entry to `shared/themes.js` THEMES array · add to FOUC `THEME_MODES` map in `admin/src/index.html` · if light theme add `[data-theme="X"]` override in `theme.css` for `--hover-bg`, `--hard`, `--epic`, `--common`
- `cssVarRgba()` in stats JS handles both hex and OKLCH via `color-mix` fallback (ec7d0ef) · Canvas 2D supports `color-mix` in Chrome 111+ / FF 113+ / Safari 16.2+
- `askHandler.js`'s system prompt is grounded in `docs/bot-guide.md`, not README.md/ARCHITECTURE.md — those were tried first and produced documentation-styled DM answers (bold section banners, "Usage"/"How it works" headers, heavy bullets, emoji) because the model pattern-matched the markdown-heavy style of docs written for developers setting up the bot, not members using it. A vague "keep it conversational" prompt instruction wasn't enough to override that on its own — fixing it took both explicit negative formatting instructions AND swapping the actual source content for a short doc purpose-written to be read by the model. General lesson: what an LLM is grounded in biases output *style*, not just content, even with separate tone instructions in the same prompt

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
