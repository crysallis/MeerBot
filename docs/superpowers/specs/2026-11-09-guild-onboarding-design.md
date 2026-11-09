# Guild onboarding · one command to stand up a new guild's Discord footprint

## Why

The Discord server hosts several AFK Journey guilds (RKF RiffRaff, RKF Frop, soon Bulls). Only
RiffRaff is scanned in game (the miner needs a character in the guild, and there is none in the
others). Every other guild is purely a Discord-management container: a role, a leader role, a
category of channels. Today adding one means hand-creating roles and channels, then editing code
in several places (`roster.js` GUILDS map and choice list, per-guild welcome-channel config keys,
copy that names RiffRaff and Frop). Onboarding Bulls should be one run of one command with the
result recorded in the database, so nothing about a guild lives in code.

## Goals

- `onboard a guild` is a single operation that creates the Discord objects and records every id.
- Guild names, role ids, channel ids and the welcome channel are read from the database at use time.
- Adding the next guild after Bulls needs no code edit.
- The run is previewable (dry run) and safe to repeat after a partial failure.

## Non-goals

- No scanning, no stats, no in-game data for onboarded guilds. Stats-site access is unchanged:
  RiffRaff and Frop stay as they are, Bulls gets nothing.
- No warbands for onboarded guilds. (The warbands table and transfer flow keep working for
  RiffRaff exactly as today.)
- No offboarding or deletion flow in this project.
- No change to how RiffRaff-only features work (check-in DMs, anniversaries, newsletter, glory
  copy). They stay RiffRaff-specific because only RiffRaff has the data behind them.

## Anti-goals (a failure even if it technically works)

- A half-created guild (category with no role, role with no category) left behind by a mid-run
  failure, with no way to tell what exists.
- Hand-typed ids anywhere after onboarding. If a second place has to be told Bulls' role id, the
  design failed.
- Breaking the existing RiffRaff and Frop behavior (`/roster add`, welcome posts, transfer approval).

## What gets created (modelled on Frop, decided)

For a guild named `Bulls`:

- One category `⚔️🏰⋮RKF Bulls⋮🏰⚔️`.
- Five channels inside it, named like Frop's: guild chat `╠⋮ㆍbullsㆍ<emoji>`,
  `╠⋮🏰battleㆍdrillsㆍbulls`, `╠⋮🐦‍🔥guildㆍduelㆍbulls`, `╠⋮🗺️clashㆍofㆍglory`,
  `﴾ㆍclashfrontsㆍbulls`. All synced to the category.
- Two roles: `RKF Bulls (Guild)` and the leader role (name supplied by the user).
- The category's permission overwrites come from a fixed onboarding model: `@everyone` denied
  View Channel and Connect, the guild role granted the member permission set, the leader role
  granted the leader permission set. No warband roles, no shared Warband Leader role.

## The model is its own thing (decided)

The onboarding model is the definition of what a new guild looks like. It is kept in one module
(for example `utils/guildOnboardingModel.js`): the channel list and name patterns, the category
name pattern, and the two permission sets. Its starting values are a one-time snapshot of Frop's
category as it is today, taken when this is built. After that it is independent: the script never
reads Frop or any other existing guild to decide what to create, and later manual changes to Frop
(or to Bulls) do not change what the next guild gets. Extra channels or roles for a particular
guild are added by hand afterwards; onboarding only ever creates the model.

## Permissions outside the guild's own category (decided)

Some existing categories grant access through guild roles rather than to everyone. Today that is
the Battle Modes category (RiffRaff and Frop both have View Channel there; its 11 channels are
synced to the category, so one overwrite covers them). The run must find these and grant the new
guild role the same access.

- The places to grant are discovered by guild-role access, not by naming any one guild. Take the
  guild roles recorded in the `guilds` table (`guild_role_id`). A category or channel is "shared"
  when EVERY one of those roles has View Channel allowed on it, and it is not any guild's own
  category (`guilds.category_id`, and the channels inside it). Today that finds Battle Modes only.
  The new guild role is granted the access the model defines (View Channel plus the member
  permission set).
- Why every role and not any role: a place only one guild can see is that guild's own space, and a
  new guild should not inherit it. Requiring all existing guild roles means a category counts as
  shared only when it is already open to every guild.
- A shared channel that is NOT synced to its category is granted individually and reported.
- The dry run lists every category/channel that would be touched. The ids touched are recorded.
- Also in scope as data: `command_permissions` rows are role rules keyed by id. Today only
  `/guild seasongrowth` references a guild role (RiffRaff). Bulls gets none; the run does not
  touch `command_permissions`.

## Inputs

- `--name` guild name (`Bulls`). Drives role and category/channel names.
- `--leader-role` name of the leader role (unknown ahead of time per guild).
- `--emoji` the decorative emoji for the guild chat channel.
- `--apply` to actually do it. Without it, a dry run prints everything it would create and every
  overwrite it would add, and changes nothing (same convention as `scripts/backfill-frop-guild-role.js`).

## Data model

`guilds` (bot-owned) gains: `guild_role_id`, `leader_role_id`, `category_id`, `main_channel_id`.
A small table (builder's choice of exact shape) records the other created channels by key
(`battledrills`, `guildduel`, `clashofglory`, `clashfronts`) and the shared-access grants (which
existing category/channel ids got an overwrite for this guild's role), so a later offboarding or
audit can see exactly what the run touched.

Existing rows are backfilled once: RiffRaff and Frop get `guild_role_id` from the ids now hardcoded
in `roster.js`, and `category_id` from the server (the RKF RiffRaff and RKF Frop categories; needed
so discovery can tell a guild's own space from a shared one), Frop gets `leader_role_id` (Queen of the Frogs), and their welcome channel is taken
from the existing `ROSTER_WELCOME_*` config values. The leader role is also appended to
`override_role_ids` (the transfer-approval bypass list), as Frop's is.

Schema follows the project convention: ALTER once, then fold into the CREATE; no migration trail.

## Replacing hardcoded guild content

| Where | Change |
|---|---|
| `slash-commands/roster.js` `GUILDS`, `GUILD_CHOICES`, `guildEntryForDbGuild` | Read from `guilds`. `/roster add` and `/remove` guild option becomes autocomplete over the guilds table (static `addChoices` is baked in at registration). Keep `GUILDS` exported for `stats/auth.js` and `audit-guild-roles.js` until those are handled. |
| `ROSTER_WELCOME_*_CHANNEL_ID` config keys | Welcome post goes to the guild's `main_channel_id`. The two legacy config keys remain as a fallback for RiffRaff and Frop only. |
| `utils/handlers/askHandler.js` non-member reply and system prompt | Guild names listed from the guilds table instead of "RiffRaff/Frop". |
| `slash-commands/help.js` roster description | Built from the guilds table; also fixes the "RKR Frop" typo. |
| `stats/auth.js`, `admin/auth.js` role lists | Unchanged by decision. |
| `checkinContent`, anniversary, newsletter, glory copy | Unchanged, RiffRaff-only features. |

## Constraints

- The bot runs on Windows under PM2; the run is a Node script using the existing `.env` token, like
  `scripts/list-roles.js` and `scripts/show-server-structure.js`.
- New roles must sit below the bot's own role (already true for the existing guild roles, per the
  user). Place each new guild role directly under the lowest existing guild role recorded in the `guilds` table (a position the builder can read from Discord, not a hardcoded id).
- The bot needs Manage Roles and Manage Channels; the script checks this first and stops with a
  clear message if missing.
- Existing guild roles are named `RFK ...` in Discord (typo). New roles use `RKF`.
- After a successful `--apply`, `data/discord-structure.json` and `data/discord-roles.json` are
  stale, so the script refreshes both itself by running `scripts/show-server-structure.js` and
  `scripts/list-roles.js` as child processes (each is a standalone script that logs in, writes its
  file and exits, so they run after the onboarding script has closed its own client). Skipped on a
  dry run or a failed run. A refresh failure is reported as a warning and does not undo the run.

## Failure handling

- Preconditions checked up front: bot permissions, name not already in `guilds`, every existing
  guild's recorded role and category still exists in the server (discovery depends on them).
- Idempotent re-run: objects are matched by recorded id first, then by exact name; existing ones
  are reused, missing ones created. The DB row is written step by step so a re-run resumes.
- A reused leader role (exact name match) is allowed and reported as reused, not recreated.
- Any Discord API error stops the run and prints what was done and what remains.

## Decided by the user

- Model on Frop: category, five channels, guild role, leader role.
- Guild role name and leader role come from inputs; category and channel names derive from the
  guild name, styled like today's.
- No warbands. No stats access for Bulls. Roles are already below the bot.
- Existing guild-role-gated categories (Battle Modes) must grant the new guild role access.
- No `--like`: the onboarding model is the standard going forward, seeded from Frop's current
  values but never tied to Frop. Per-guild extras are added manually afterwards.

## My calls (not yet confirmed by the user beyond "all your calls are good")

- It is a script, not a slash command (sensitive admin op, run by the owner).
- "Shared" means every existing guild role has View Channel there (see Permissions section). The
  dry run lists what it found, so a wrong match is visible before `--apply`.
- Backfilled `main_channel_id` for RiffRaff and Frop comes from the existing `ROSTER_WELCOME_*`
  config value when one is set, otherwise stays empty and the legacy config fallback keeps working.
- Plain-text category and channel names with one supplied emoji, not the Cherokee-lookalike styling.
- The model has no warband roles and no shared Warband Leader role.
- Leader role is added to `override_role_ids`.
- Welcome channel is the guild chat channel, stored on the guild row.
- Copy tied to RiffRaff-only features is left alone; server-wide copy becomes DB-driven.
- The script refreshes the two local snapshot files itself after a successful run (user's request).
- Docs: `CLAUDE.md`, `README.md`, `ARCHITECTURE.md` updated with the new columns, script and `/roster` change.

## Left to the builder

- Exact table shape for the secondary channel and grant records.
- Whether `/roster` autocomplete caches the guilds list or reads per keystroke (small table, per-keystroke is fine).
- Test layout: pure functions (name derivation, overwrite mapping, discovery of shared grants) take
  plain data and are unit-tested; the Discord calls sit behind a thin layer that the dry run reuses.
  Tests must not read the live `guilds` table or `command_permissions` (use in-memory DBs and
  isolated keys).
