# Guild Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One script (`node scripts/onboard-guild.js`) creates a new guild's Discord role, leader role, category and five channels, grants the new guild role shared-category access, and records every id in `guild.db`, while `/roster` and the server-wide copy read guild data from the database instead of code.

**Architecture:** Pure modules (model, discovery, entries) hold the decisions and are unit-tested on plain data. `utils/guildOnboarding.js` orchestrates against a thin Discord adapter interface, so the dry run and the real run share one code path and tests use a fake adapter. `utils/guildRegistry.js` owns the new `guilds` columns, a `guild_channels` table and their helpers, each taking a db handle first (tested on in-memory SQLite).

**Tech Stack:** Node 24, discord.js v14, better-sqlite3, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-09-guild-onboarding-design.md`

## Global Constraints

- No em dashes anywhere (code, copy, docs). Use `·` or `...`. No unnecessary code comments.
- Role names use `RKF`, not the `RFK` typo on the existing roles: `RKF <Name> (Guild)`.
- Category name `⚔️🏰⋮RKF <Name>⋮🏰⚔️`. Channels, in order, for guild `bulls` with emoji `E`: `╠⋮ㆍbullsㆍE`, `╠⋮🏰battleㆍdrillsㆍbulls`, `╠⋮🐦‍🔥guildㆍduelㆍbulls`, `╠⋮🗺️clashㆍofㆍglory`, `﴾ㆍclashfrontsㆍbulls` (copy the exact characters from the existing Frop channels; the fire-bird contains a zero-width joiner).
- No warband roles, no shared Warband Leader role, no scanning or stats for onboarded guilds. `stats/auth.js` access stays RiffRaff + Frop only.
- The onboarding model never reads any existing guild's Discord setup to decide what to create.
- The script is a dry run unless `--apply` is passed. After a successful `--apply` it refreshes `data/discord-structure.json` and `data/discord-roles.json` by running `scripts/show-server-structure.js` and `scripts/list-roles.js` as child processes; a refresh failure is a warning, not an undo.
- `command_permissions` is never touched by onboarding.
- Tests never read live `guilds`, `bot_config` or `command_permissions`: use in-memory DBs and plain fixtures.
- Gate every commit on `npm test` exit code 0. Update `CLAUDE.md`, `README.md`, `ARCHITECTURE.md` and `slash-commands/help.js` where behavior changes. Commit directly to `main`. Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

- Discovery with zero recorded guild roles must return nothing (a vacuous "every role has access" would grant the new role everywhere). Pinned in Task 3.
- Guild name whose slug is empty (`!!!`), longer than Discord's 100-character limit once decorated, or equal to an existing guild name ignoring case: refuse before any Discord call. Pinned in Tasks 2 and 6.
- Leader role name that matches a role already recorded as another guild's guild role or leader role (e.g. `Queen of the Frogs`): refuse rather than reuse. Pinned in Task 6.
- Re-run after a partial failure creates no duplicate role, category or channel, and an already complete guild is refused. Pinned in Task 6.
- Welcome post when a guild has neither `main_channel_id` nor a legacy config value: no post, no throw. Pinned in Task 4.

---

### Task 1: Guild registry (schema, helpers, startup seed)

**Files:**
- Create: `utils/guildRegistry.js`, `utils/guildRegistry.test.js`
- Modify: `utils/db.js` (after the `guilds` CREATE near line 31 and the seed block near line 59-72)

**Interfaces:**
- Produces (all take a better-sqlite3 handle `h` first):
  - `ensureGuildSchema(h): void` adds `guild_role_id`, `leader_role_id`, `category_id`, `main_channel_id` (TEXT, nullable) to `guilds` when missing, and creates `guild_channels (id INTEGER PK AUTOINCREMENT, guild_id INTEGER NOT NULL REFERENCES guilds(id), kind TEXT NOT NULL CHECK(kind IN ('channel','shared_grant')), key TEXT NOT NULL, discord_id TEXT NOT NULL, UNIQUE(guild_id, kind, discord_id))`. Safe to run every startup.
  - `createGuild(h, name): object` (INSERT OR IGNORE, returns the row)
  - `getGuildById(h, id): object|undefined`, `getGuildByName(h, name): object|undefined` (exact match)
  - `setGuildDiscordIds(h, guildId, ids: {guildRoleId?, leaderRoleId?, categoryId?, mainChannelId?}): void` (updates only keys present)
  - `addOverrideRole(h, guildId, roleId): void` (appends to `override_role_ids` JSON, no duplicate)
  - `addGuildChannel(h, guildId, kind, key, discordId): void` (INSERT OR IGNORE), `getGuildChannels(h, guildId): object[]`
  - `seedKnownGuilds(h): void` fills ONLY null columns for the two existing guilds: `RKF RiffRaff` role `1523580372208717964`, category `1510145205582692393`, main channel `1303421884687192174`; `RKF Frop` role `1533951415633051688`, leader `1303422881002426398`, category `1510143019951849492`, main channel `1482485945675550720`. Also adds Frop's leader to its `override_role_ids` if absent.

- [ ] **Step 1: Write the failing tests** in `utils/guildRegistry.test.js` (in-memory DB with the base `guilds` table `id, name UNIQUE, override_role_ids DEFAULT '[]'` created by the test). Tests: `ensureGuildSchema adds the four columns and is idempotent`; `createGuild is idempotent and returns the row`; `setGuildDiscordIds updates only the given keys`; `addOverrideRole appends once`; `addGuildChannel ignores a duplicate discord_id`; `seedKnownGuilds fills nulls and never overwrites an existing value` (pre-set Frop `category_id` to `'x'`, run seed, assert it stays `'x'` while `guild_role_id` is filled).
- [ ] **Step 2: Run** `node --test utils/guildRegistry.test.js`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the functions above in `utils/guildRegistry.js`. In `utils/db.js`, add the four columns to the `guilds` CREATE, then call `ensureGuildSchema(db)` after the CREATE and `seedKnownGuilds(db)` after the existing `SEED_GUILDS` loop.
- [ ] **Step 4: Run** the new test, then `npm test`. Expected: all pass, exit 0.
- [ ] **Step 5: Commit** `feat: guild registry columns, channel table, startup seed for existing guilds`.

---

### Task 2: Onboarding model

**Files:**
- Create: `utils/guildOnboardingModel.js`, `utils/guildOnboardingModel.test.js`

**Interfaces:**
- Produces:
  - `CHANNEL_KEYS: ['main','battledrills','guildduel','clashofglory','clashfronts']`
  - `MEMBER_PERMS`, `LEADER_PERMS`, `SHARED_PERMS`: each `{ allow: string[], deny: string[] }` of discord.js `PermissionFlagsBits` key names (values below)
  - `slugify(name: string): string` lowercase, strips everything except letters and digits (`'Red Bulls'` becomes `'redbulls'`)
  - `buildNames(name: string, emoji: string): { slug, guildRoleName, categoryName, channels: {key, name}[] }` or throws `Error` (message starts `Invalid guild name:`) when the slug is empty or any produced name exceeds 100 characters
  - `buildCategoryOverwrites({everyoneId, guildRoleId, leaderRoleId}): {id, allow, deny}[]` in order everyone, guild role, leader role

Permission values (a one-time snapshot of Frop's category, `Frog` for members, `Queen of the Frogs` for leader, Frop's Battle Modes overwrite for shared). Before writing them, run `node scripts/show-server-structure.js` and re-read those overwrites from the fresh `data/discord-structure.json`; the checked-in snapshot is from 2026-09-23. Use the fresh values if they differ.
- MEMBER allow: `AddReactions,Stream,ViewChannel,SendMessages,SendTTSMessages,EmbedLinks,AttachFiles,ReadMessageHistory,UseExternalEmojis,Connect,Speak,UseVAD,UseApplicationCommands,RequestToSpeak,CreatePublicThreads,UseExternalStickers,SendMessagesInThreads,UseEmbeddedActivities,UseSoundboard,UseExternalSounds,SendVoiceMessages`; deny: `CreateInstantInvite,ManageChannels,PrioritySpeaker,ManageMessages,MentionEveryone,MuteMembers,DeafenMembers,MoveMembers,ManageRoles,ManageWebhooks,ManageEvents,ManageThreads,CreatePrivateThreads,CreateEvents,SendPolls,UseExternalApps,PinMessages,BypassSlowmode`
- LEADER allow: `CreateInstantInvite,AddReactions,PrioritySpeaker,Stream,ViewChannel,SendMessages,SendTTSMessages,ManageMessages,EmbedLinks,AttachFiles,ReadMessageHistory,MentionEveryone,UseExternalEmojis,Connect,Speak,MuteMembers,DeafenMembers,MoveMembers,UseVAD,UseApplicationCommands,RequestToSpeak,ManageEvents,ManageThreads,CreatePublicThreads,CreatePrivateThreads,UseExternalStickers,SendMessagesInThreads,UseEmbeddedActivities,UseSoundboard,CreateEvents,UseExternalSounds,SendVoiceMessages,SendPolls,PinMessages,BypassSlowmode`; deny: `ManageChannels,ManageRoles,ManageWebhooks,UseExternalApps`
- SHARED allow: `AddReactions,Stream,ViewChannel,SendMessages,SendTTSMessages,EmbedLinks,AttachFiles,ReadMessageHistory,UseExternalEmojis,Connect,Speak,UseVAD,UseApplicationCommands,CreatePublicThreads,CreatePrivateThreads,UseExternalStickers,SendMessagesInThreads,UseEmbeddedActivities,UseSoundboard,UseExternalSounds,SendVoiceMessages,SendPolls,PinMessages`; deny: `CreateInstantInvite,ManageChannels,PrioritySpeaker,ManageMessages,MentionEveryone,MuteMembers,DeafenMembers,MoveMembers,ManageRoles,ManageWebhooks,RequestToSpeak,ManageEvents,ManageThreads,CreateEvents,UseExternalApps,BypassSlowmode`
- everyone overwrite: allow `[]`, deny `['ViewChannel','Connect']`

- [ ] **Step 1: Write the failing tests.** `buildNames('Bulls','🐂')` returns `guildRoleName === 'RKF Bulls (Guild)'`, `categoryName === '⚔️🏰⋮RKF Bulls⋮🏰⚔️'`, and a `channels` array whose names equal the five Global Constraints names with `bulls` and `🐂`; `slugify('Red Bulls') === 'redbulls'`; `buildNames('!!!','🐂')` throws `/Invalid guild name/`; `buildNames('a'.repeat(95),'🐂')` throws; `buildCategoryOverwrites` ids are in the order everyone, guild, leader and everyone's deny equals `['ViewChannel','Connect']`; every permission name in all three sets exists in `require('discord.js').PermissionFlagsBits`.
- [ ] **Step 2: Run** `node --test utils/guildOnboardingModel.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the exports above.
- [ ] **Step 4: Run** the test, then `npm test`. Expected: pass, exit 0.
- [ ] **Step 5: Commit** `feat: guild onboarding model (names, permission sets)`.

---

### Task 3: Shared-access discovery

**Files:**
- Create: `utils/guildOnboardingDiscovery.js`, `utils/guildOnboardingDiscovery.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `findSharedTargets(structure, guildRoleIds: string[], ownCategoryIds: string[]): {kind: 'category'|'channel', id: string, name: string}[]`. `structure` has the same shape as `data/discord-structure.json`: `{ categories: [{ id, name, overwrites: [{id, allow: string[], deny: string[]}], channels: [{ id, name, synced: boolean, overwrites: [...] }] }], uncategorised: [...] }`.

Rules: a category is shared when it is not in `ownCategoryIds` and every id in `guildRoleIds` has an overwrite on it with `ViewChannel` in `allow`; it is returned as `kind: 'category'`, and its channels with `synced: true` are covered by it (not returned). A channel with `synced: false` (or any channel outside a shared category, in a non-own category, or uncategorised) is returned as `kind: 'channel'` only when every guild role has `ViewChannel` allowed on it. Channels inside an own category are never returned. An empty `guildRoleIds` returns `[]`.

- [ ] **Step 1: Write the failing tests** with small fixtures: `finds a category every guild role can view` (two roles, one category granting both, one granting only one, one own category granting both; expect only the first); `does not return synced channels of a shared category`; `returns an unsynced channel that grants every guild role, under a non-shared category`; `ignores channels in an own category`; `returns nothing when guildRoleIds is empty` (a fixture where a category grants nothing to anyone must still not match); `a deny-only overwrite is not access`.
- [ ] **Step 2: Run** the test. Expected: FAIL.
- [ ] **Step 3: Implement** `findSharedTargets`.
- [ ] **Step 4: Run** the test, then `npm test`. Expected: pass, exit 0.
- [ ] **Step 5: Commit** `feat: discover shared categories by guild-role access`.

---

### Task 4: Roster reads guilds from the database

**Files:**
- Create: `utils/guildEntries.js`, `utils/guildEntries.test.js`
- Modify: `slash-commands/roster.js` (remove `GUILDS`, `GUILD_CHOICES`, `guildEntryForDbGuild`; lines 8-31, 41, 47, 57-63, 77-134, 230-239), `stats/auth.js` (lines 7, 13-16), `scripts/audit-guild-roles.js` (lines 22-28), `utils/botConfig.js` (keep the two `ROSTER_WELCOME_*` keys; they remain the fallback)
- Test: `slash-commands/roster.test.js`

**Interfaces:**
- Consumes: `getGuildById(h, id)` from Task 1 for `/roster`, `db.getGuilds()` rows (now carrying the new columns).
- Produces:
  - `entryFromRow(row, getConfig: (key) => string): {id: string, label: string, welcomeChannelId: string|null} | null` where `id = row.guild_role_id`, `label = row.name`, welcome = `row.main_channel_id`, else `getConfig(LEGACY_WELCOME_KEYS[row.name])`, else `null`; returns `null` when `row.guild_role_id` is null
  - `LEGACY_WELCOME_KEYS = {'RKF RiffRaff': 'ROSTER_WELCOME_RIFFRAFF_CHANNEL_ID', 'RKF Frop': 'ROSTER_WELCOME_FROP_CHANNEL_ID'}`
  - `formatGuildNames(rows: {name: string}[]): string` strips a leading `RKF `, joins as `A`, `A and B`, or `A, B and C`; `''` for none

- [ ] **Step 1: Write the failing tests.** `guildEntries.test.js`: `entryFromRow returns null without a guild role`; `entryFromRow prefers main_channel_id over the legacy config`; `entryFromRow falls back to the legacy key for RKF Frop`; `entryFromRow gives a null welcome channel when neither exists` (no throw); `formatGuildNames` for 0, 1, 2 and 3 names (`'RiffRaff, Frop and Bulls'`). `roster.test.js` (pattern from `slash-commands/guildduel.test.js`; start the file with `require('dotenv').config()` because requiring `roster.js` loads `utils/db.js`): `roster add and remove take an autocompleted guild option` (the option named `guild` in both subcommands has `autocomplete === true` and no `choices`).
- [ ] **Step 2: Run** both files. Expected: FAIL.
- [ ] **Step 3: Implement.** `entryFromRow` and `formatGuildNames` in `utils/guildEntries.js`. In `roster.js`: `autocomplete(interaction)` branches on `interaction.options.getFocused(true).name`: `guild` responds with `{name: row.name, value: String(row.id)}` for `db.getGuilds()` rows that have `guild_role_id`, filtered by the typed text; the existing warband branch is unchanged. `add`/`remove` resolve the option with `getGuildById(db, Number(value))` and `entryFromRow`; an unknown guild or one without a role replies ephemerally `That guild is not set up for roster roles.`. `applyTransferRoles` uses `entryFromRow` on `db.getGuilds().find(g => g.id === warband.guild_id)`. Remove the `GUILDS` export. In `stats/auth.js` replace the `GUILDS` import with the two literal role ids `1523580372208717964` and `1533951415633051688` (stats access is intentionally RiffRaff + Frop only). In `scripts/audit-guild-roles.js` read the guild role ids from `db.getGuilds()`.
- [ ] **Step 4: Run** the new tests, then `npm test` and `node --check` on `slash-commands/roster.js`, `stats/auth.js`, `scripts/audit-guild-roles.js`. Expected: pass, exit 0.
- [ ] **Step 5: Commit** `feat: /roster guild list and welcome channel come from the guilds table`. Note in the commit body that the `/roster` option schema changed (choices to autocomplete), so the bot needs a restart with `DEV_REGISTER=true`.

---

### Task 5: Onboarding orchestration

**Files:**
- Create: `utils/guildOnboarding.js`, `utils/guildOnboarding.test.js`

**Interfaces:**
- Consumes: Task 1 helpers, Task 2 `buildNames`/`buildCategoryOverwrites`/`SHARED_PERMS`/`CHANNEL_KEYS`, Task 3 `findSharedTargets`.
- Produces: `runOnboarding({ input, discord, h, apply, log }): Promise<{ ok: boolean, lines: string[], created: object, warnings: string[] }>` with `input = { name, leaderRoleName, emoji }`, `log: (line: string) => void`, and `discord` an adapter with these async methods:
  - `botCanManage(): boolean` (Manage Roles and Manage Channels)
  - `everyoneRoleId(): string`
  - `roleExists(id)`, `categoryExists(id)`: boolean
  - `lowestRoleAmong(ids: string[]): string|null` (the id with the lowest Discord position, null for an empty list)
  - `findRoleByName(name): {id}|null`, `findCategoryByName(name): {id}|null`, `findChannelInCategory(categoryId, name): {id}|null`
  - `createRole({ name, belowRoleId }): {id}` (`belowRoleId` null means just below the bot)
  - `createCategory({ name, overwrites }): {id}`, `createChannel({ name, categoryId }): {id}` (inherits the category's permissions)
  - `grantAccess({ targetId, roleId, perms }): void`
  - `snapshotStructure(): structure` (same shape as Task 3)

Behavior, in order, writing to the DB right after each step so a re-run resumes:
1. Refuse (return `ok: false`, no creation) when: `buildNames` throws; `getGuildByName` matches the name ignoring case and that guild is already complete (all four ids set and a `guild_channels` row for each of the four non-main keys); the leader role name matches a role id recorded as any guild's `guild_role_id` or `leader_role_id`; `botCanManage()` is false; an existing guild's recorded role or category no longer exists.
2. Guild row via `createGuild` (apply only). Guild role: recorded id if it still exists, else exact-name match, else create with `belowRoleId = await discord.lowestRoleAmong(recorded guild role ids)`. Leader role: same, reused by exact name (reported as reused), appended with `addOverrideRole`. Category with `buildCategoryOverwrites`, then the five channels via `findChannelInCategory` first. `setGuildDiscordIds` and `addGuildChannel` after each (the guild chat channel is stored as `mainChannelId`, which is what `/roster` uses for the welcome post; the other four go in `guild_channels` with their `CHANNEL_KEYS` key).
3. Shared grants: `findSharedTargets(await discord.snapshotStructure(), recorded guild role ids, recorded category ids)`, then `grantAccess({ targetId, roleId: newGuildRoleId, perms: SHARED_PERMS })` for each, recorded as `shared_grant` rows. Unsynced channel targets also go in `warnings`.
4. With `apply: false`, perform steps 1-3 as reads only: no `create*`/`grantAccess` call, no DB write, and `lines` describes every object and every shared target that would be made.

- [ ] **Step 1: Write the failing tests** with a fake adapter that records calls and a seeded in-memory DB (Task 1 schema, Frop and RiffRaff rows with role and category ids). Tests: `dry run makes no create or grant calls and writes nothing`; `apply creates role, leader role, category and five channels and records every id`; `apply grants the new guild role on every shared target found`; `re-run after the category was created creates only the missing channels`; `re-run of a complete guild is refused`; `a name equal to an existing guild ignoring case is refused before any adapter call`; `a leader role named like another guild's leader role is refused`; `missing bot permissions refuse before creating anything`; `an existing guild whose recorded role was deleted refuses`; `the leader role is appended to override_role_ids`.
- [ ] **Step 2: Run** `node --test utils/guildOnboarding.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `runOnboarding` as described.
- [ ] **Step 4: Run** the test, then `npm test`. Expected: pass, exit 0.
- [ ] **Step 5: Commit** `feat: guild onboarding orchestration with dry run and resume`.

---

### Task 6: Discord adapter and onboarding script

**Files:**
- Create: `utils/guildOnboardingDiscord.js`, `scripts/onboard-guild.js`
- Test: `utils/guildOnboardingDiscord.test.js`

**Interfaces:**
- Consumes: `runOnboarding` and the adapter contract from Task 5.
- Produces: `makeDiscordAdapter(guild: Guild): adapter`; `scripts/onboard-guild.js --name <Name> --leader-role <Name> --emoji <emoji> [--apply]`.

- [ ] **Step 1: Write the failing test** for the pure part only: `toStructure(guild)` (exported from the adapter module) maps `guild.channels.cache` to the Task 3 structure shape (category with `overwrites` as `{id, allow, deny}` permission-name arrays via `PermissionsBitField.toArray()`, child channels with `synced` from `channel.permissionsLocked`). Use a minimal fake guild built from discord.js `PermissionsBitField` values.
- [ ] **Step 2: Run** the test. Expected: FAIL.
- [ ] **Step 3: Implement** `makeDiscordAdapter` over discord.js v14: `guild.roles.create`/`setPosition`, `guild.channels.create` (category with `permissionOverwrites` built from permission names via `PermissionFlagsBits`; channels with only `parent`, so they inherit), `channel.permissionOverwrites.edit`/`create` for grants, `me.permissions.has` for `botCanManage`. In `scripts/onboard-guild.js`: parse the four flags (missing `--name`, `--leader-role` or `--emoji` prints usage and exits 1), load `.env` like `scripts/backfill-frop-guild-role.js`, log in with `Guilds` + `GuildMembers` intents, call `runOnboarding` with `apply` from `--apply`, print every line, destroy the client, and on `ok && apply` run `scripts/show-server-structure.js` then `scripts/list-roles.js` with `execFileSync(process.execPath, [file], { stdio: 'inherit' })`, each in its own try/catch that prints a warning. Exit code 1 when `ok` is false.
- [ ] **Step 4: Run** the adapter test, `npm test`, and `node --check scripts/onboard-guild.js`. Expected: pass, exit 0.
- [ ] **Step 5: Verify against the live server, read-only:** `node scripts/onboard-guild.js --name Bulls --leader-role "Test Leader" --emoji 🐂` (no `--apply`). Expected: a dry run listing the role names, category, five channels, and exactly one shared target, the Battle Modes category (its 11 channels covered by it), and nothing created. If the shared list differs, stop and report before going further.
- [ ] **Step 6: Commit** `feat: onboard-guild script and discord.js adapter`.

---

### Task 7: Server-wide copy and docs

**Files:**
- Modify: `utils/handlers/askHandler.js` (line 29 `NON_MEMBER_REPLY`, used at 166; system prompt lines 190 and 202), `slash-commands/help.js` (line 210 `/roster` description), `CLAUDE.md`, `README.md`, `ARCHITECTURE.md`
- Test: `utils/handlers/askHandler.test.js` (update only if it asserts the old text)

**Interfaces:**
- Consumes: `formatGuildNames` from Task 4, `db.getGuilds()`.
- Produces: `nonMemberReply(names: string): string` returning `` `MeerBot only answers questions for ${names} guild members. Sorry!` `` (the old constant used an em dash, which the project forbids).

- [ ] **Step 1: Write the failing test:** `nonMemberReply('RiffRaff, Frop and Bulls')` contains `RiffRaff, Frop and Bulls` and no em dash. Update any `askHandler.test.js` assertion that still expects the old constant.
- [ ] **Step 2: Run** `node --test utils/handlers/askHandler.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Replace the constant with `nonMemberReply` and call it with `formatGuildNames(db.getGuilds())`; change the system prompt's `a guild called RiffRaff` and `MeerBot and RiffRaff guild stuff` to use the same names string. Change the `/roster` description in `help.js` to `Manage guild membership roles.` (drops the names and the `RKR` typo). Document in `CLAUDE.md` (Key Files rows for `guildRegistry.js`, `guildOnboardingModel.js`, `guildOnboardingDiscovery.js`, `guildOnboarding.js`, `guildOnboardingDiscord.js`, `guildEntries.js`, `scripts/onboard-guild.js`; the `guilds` table's new columns and `guild_channels`; the `/roster` change), and add the onboarding script, its flags and the dry-run default to `README.md` and `ARCHITECTURE.md`.
- [ ] **Step 4: Run** `npm test`. Expected: pass, exit 0.
- [ ] **Step 5: Commit** `feat: server-wide copy reads guild names from the database; document guild onboarding`.

---

### Rollout (after all tasks, by the owner)

1. `pm2 restart meerbot --update-env` (the startup seed fills the new columns; `DEV_REGISTER=true` re-registers `/roster` with the autocomplete option). Confirm `/roster add` autocompletes both guilds and still adds the role and posts the welcome.
2. Optional rehearsal: run `node scripts/onboard-guild.js ... --apply` from the `DiscordBotAfkJ-test` checkout against the test server.
3. Real run: dry run, read the list, then add `--apply` for Bulls.
