# Transfer Approval Flow — Design

## Context

`/roster transfer` currently moves a member between warbands/guilds immediately — no
confirmation, no gating beyond the generic `command_permissions` check. This was flagged
as a gap back in 2026-06 (design discussed, never built): a warband leader could pull a
member out of another leader's warband, or push someone into another warband, with no
say from the other side.

Since that June discussion the guild/warband structure has solidified in-game: AFK Journey
merged what used to be three separate 30-member guilds (RiffRaff, Kingdom, Sobaquitos) into
one 90-member guild (RKF RiffRaff) containing those three as warbands. RKF Frop is a second,
separate guild (not scanned by the Data Miner — no ADB access to it) with its own warbands.
Leader roles for all of these now exist as real Discord roles, where in June they were still
TBD placeholders.

This spec designs the approval flow against that now-real structure: transfers need sign-off
from whichever side (source or destination) didn't initiate the request, unless the initiator
holds a guild-level override role (Riff/Raff for RKF RiffRaff, Queen of the Frogs for RKF Frop).

## Ownership boundary

Per project convention (miner = data extraction only, bot = everything Discord-related),
guild/warband structure and role wiring move to bot ownership as part of this work:

- The bot's `utils/db.js` becomes the sole author of `CREATE TABLE warbands` and a new
  `guilds` table (currently owned by the miner's `src/db.py`).
- The miner keeps its existing read-only queries against `warbands` (`_resolve_warband()`
  during OCR resolution) — same physical `guild.db` file, no access restriction, just a
  documentation/authorship change. Both repos already read/write the shared DB freely;
  this only changes who writes the `CREATE`/seed statements.
- CLAUDE.md in both repos needs updating to reflect the new ownership (miner's schema
  table drops the `warbands` row it currently documents; bot's docs gain it).

## Schema

### `guilds` (new, bot-owned)

```sql
CREATE TABLE guilds (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL UNIQUE,          -- 'RKF RiffRaff', 'RKF Frop'
  override_role_ids TEXT NOT NULL DEFAULT '[]'     -- JSON array of Discord role IDs
);
```

`override_role_ids` holds whichever roles can bypass approval entirely for moves touching
this guild (Riff + Raff for RKF RiffRaff; Queen of the Frogs for RKF Frop). Managed via the
admin panel, same pattern as `command_permissions` today — not hardcoded.

### `warbands` (existing table, ownership moves + new columns)

```sql
CREATE TABLE warbands (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL UNIQUE,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  archived       INTEGER NOT NULL DEFAULT 0,
  guild_id       INTEGER REFERENCES guilds(id),
  leader_role_id TEXT,                              -- who must approve moves into/out of this warband
  member_role_id TEXT                                -- role granted/removed on transfer
);
```

Moves from `src/db.py` (miner) into `utils/db.js` (bot) as part of this work, along with its
seeding logic (`SEED_WARBANDS`/`WARBAND_ALIASES`). Existing rows (RiffRaff, Kingdom,
Sobaquitos) get `guild_id`, `leader_role_id`, `member_role_id` backfilled once via a one-time
`ALTER` + `UPDATE` against `guild.db`, matching the "ALTER once, fold into CREATE" convention
already used for schema changes in this project.

### `transfer_approvals` (new, bot-owned)

```sql
CREATE TABLE transfer_approvals (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  transfer_id       TEXT NOT NULL UNIQUE,            -- crypto.randomUUID(), used in button custom_id
  member_id         INTEGER NOT NULL,                -- guild.db members.id
  from_warband_id   INTEGER REFERENCES warbands(id),
  to_warband_id     INTEGER NOT NULL REFERENCES warbands(id),
  direction         TEXT NOT NULL CHECK(direction IN ('pull', 'push')),
  requested_by      TEXT NOT NULL,                   -- Discord user id of initiator
  approving_role_id TEXT NOT NULL,                   -- role resolved as eligible to act (warband leader or guild override, on fallback)
  status            TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','approved','denied')),
  approver_user_id  TEXT,                             -- Discord user id of whoever acted; null while requested
  acted_at          TEXT,                             -- null while requested
  message_id        TEXT,                             -- the-not-so-round-table message id, edited on resolution
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
```

No `expires_at` — no auto-expiry; requests stay `requested` indefinitely until acted on.
`status` and the approver identity are deliberately separate fields (not one column serving
both purposes) so each name matches exactly what it holds.

## `/roster transfer` flow

1. `enforcePermissions(interaction, 'roster', 'transfer')` — unchanged, same gate as today.
2. Resolve current and destination warbands for the member. Determine `direction`:
   - Initiator's own leader/override role matches the **destination** → `pull`; approver
     side = **source** warband's `leader_role_id` (or source guild's override roles on
     fallback).
   - Initiator's own leader/override role matches the **source** → `push`; approver side =
     **destination** warband's `leader_role_id` (or destination guild's override roles on
     fallback).
3. **Override short-circuit**: if the initiator already holds an override role for the
   approving side, skip the request entirely and execute the transfer immediately (Discord
   roles only — see Approval Effects below).
4. **Fallback for a vacant leader role**: if `leader_role_id` currently has zero Discord
   members assigned, fall back to the parent guild's `override_role_ids` as the approving
   role instead, so a request is never created with nobody able to resolve it.
5. Otherwise: insert a `transfer_approvals` row (`status='requested'`), resolve
   `approving_role_id` to its current Discord members, and:
   - Post an embed in `the-not-so-round-table` (channel id `1434387291538718760`, exposed
     as a new `TRANSFER_APPROVAL_CHANNEL_ID` botConfig key defaulting to that id) with
     Approve/Deny buttons. The embed lists each currently eligible approver by plain
     display name (no `@mention` — avoids double-pinging since they're also DMed
     directly), so anyone reading the channel can see at a glance whether they're one of
     the people it's waiting on.
   - DM each eligible approver individually with the same embed + buttons.
   - Reply ephemerally to the initiator confirming the request was sent.

## Button interaction handler (new)

This is the bot's first button-interaction flow — `index.js`'s `interactionCreate` handler
currently only branches on autocomplete and chat-input commands; a new `interaction.isButton()`
branch is added, dispatching on `custom_id` prefix (`transfer_approve:<transfer_id>` /
`transfer_deny:<transfer_id>`).

- Look up the `transfer_approvals` row by `transfer_id`. If `status !== 'requested'`, reply
  ephemeral "already resolved" and leave the message as-is.
- Check the clicking user currently holds `approving_role_id`. If not, ephemeral
  permission-denied reply; the buttons remain live for other eligible approvers.
- **Approve**: update Discord roles — remove the member's current warband/guild
  `member_role_id`(s), add the destination's. Update `status='approved'`,
  `approver_user_id`, `acted_at`. Edit the channel embed (and each DM) to show the
  resolution and who approved it.
- **Deny**: same status/identity update with `status='denied'`, edit embed, no role changes.

## Approval effects — Discord only, not `guild.db`

On approval, only Discord roles change. `members.warband_id` (and any guild association)
is **not** written directly — it stays whatever the next mining scan resolves it to. The
in-game guild/warband move is a separate, human-driven action in AFK Journey itself and may
not happen at the same moment as the Discord-side approval, so writing `warband_id`
immediately could describe a member's Discord role without describing where they actually
are in-game yet. A future project may scan in-game membership and reconcile it against
Discord roles automatically; out of scope here.

## In scope: cross-guild transfers

Transfers between RKF RiffRaff and RKF Frop (not just warband-to-warband within one guild)
are included, since Discord role management isn't blocked by the miner's inability to scan
RKF Frop's roster — the approval/role-update mechanics are identical, just resolving against
a different guild's `override_role_ids` and its warbands' `leader_role_id`s.

## Out of scope

- Auto-reconciliation between in-game warband and Discord role (future work, noted above).
- Any change to `command_permissions`-gated access to `/roster transfer` itself — the
  override-role config here is a distinct concept (bypass approval) from that existing
  gate (can run the command at all) and is stored separately.

## Verification

- Manual test in a dev/staging Discord (or scoped test roles) covering:
  - Pull with approval required, approved by an eligible leader → roles update, embed +
    DMs reflect resolution.
  - Push with approval required, denied → roles unchanged, embed shows denial.
  - Initiator holding override role → immediate execution, no request row created.
  - Vacant warband leader role → falls back to guild override approvers.
  - Non-eligible user clicking a button → ephemeral rejection, request stays live.
  - Second eligible approver clicking after first resolution → "already resolved" reply.
- Confirm `guild.db`'s `members.warband_id` is untouched immediately after approval, and is
  updated only after the next scraper run resolves the member's warband via OCR.
