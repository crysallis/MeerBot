# Configurable auto-delete for command replies & reaction-rule responses

Status: approved, not yet planned/implemented
Date: 2026-09-03

## Problem

`/guild` (all subcommands except `power`) and `/member` currently call a shared
`utils/autoDelete.js` helper that hardcodes `interaction.deleteReply()` 30 seconds after
every reply. This is invisible, undocumented behavior baked into two command files with no
toggle — Daniel noticed `/guild status` disappearing and had no way to know why or turn it
off. Every other slash command (22 files, 183 total `.reply()`/`.editReply()` call sites)
and every admin-panel-authored `message_reactions` rule post permanently, with no
auto-delete option at all.

Goal: make auto-delete a deliberate, admin-panel-configurable choice per command/subcommand
and per reaction rule, instead of a hardcoded surprise baked into two files.

## Scope

In scope:
- Slash command replies (all 24 command files), keyed by command + optional subcommand,
  matching the granularity `command_permissions` already uses.
- `message_reactions` rule responses of type `reply` or `message` only (`emoji` and `dm`
  have no persisted "message to delete" concept and are excluded).
- One global delay (`bot_config.auto_delete_seconds`, default 30), not a per-item delay.
- Admin panel UI to toggle auto-delete per command/subcommand and per reaction rule.

Out of scope:
- Per-item custom delay (explicitly deferred — one shared delay for everything that has
  auto-delete on).
- Ephemeral replies (Discord already scopes these to the invoking user; they are never
  auto-deleted by this feature and the dispatcher skips them entirely).
- Scheduled `text_job` / `scheduledMessages.js` posts (a different posting path, not
  addressed here).

## Data model

New table, mirroring `command_permissions`' shape and precedence style:

```sql
CREATE TABLE IF NOT EXISTS auto_delete_rules (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  scope            TEXT NOT NULL CHECK(scope IN ('command', 'reaction_rule')),
  command          TEXT,     -- required when scope='command', e.g. 'guild'
  subcommand       TEXT,     -- optional when scope='command'; NULL = whole command
  reaction_rule_id INTEGER,  -- required when scope='reaction_rule', FK -> message_reactions.id
  enabled          INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(scope, command, subcommand, reaction_rule_id),
  FOREIGN KEY (reaction_rule_id) REFERENCES message_reactions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_adr_lookup ON auto_delete_rules(scope, command, subcommand);
```

A row's mere existence with `enabled=1` turns auto-delete ON for that command/subcommand or
reaction rule. No row = default OFF (opt-in default, confirmed with Daniel — this preserves
current behavior for the 22 commands and all reaction rules that post permanently today).
`enabled=0` rows are not strictly needed given rows are opt-in-only, but the column is kept
for a straightforward panel "turn off without deleting the row" toggle rather than
add/delete churn.

Precedence for `scope='command'` lookups: a `(command, subcommand)` exact-match row wins;
otherwise fall back to a `(command, subcommand=NULL)` whole-command row; otherwise OFF. This
mirrors `enforcePermissions`' existing subcommand-vs-whole-command precedence.

New `bot_config` key: `AUTO_DELETE_SECONDS` (default `30`, category `thresholds`), added as a
`CONFIG_META` entry in `utils/botConfig.js` so it shows on the existing generic Config tab
automatically, same as `INACTIVITY_DAYS`/`LATE_WARNING_MINUTES`. Read via the existing
`botConfig.get()` DB > ENV > default precedence.

## Mechanism — slash commands

Remove the two manual `autoDelete()` call sites from `guild.js` and `member.js` entirely
(both the shared end-of-`execute()` calls and `unlinked`'s explicit call). Delete
`utils/autoDelete.js`'s old fixed-30s-only version and replace it with a DB-aware helper.

Hook into `index.js`'s existing single dispatch chokepoint, right after
`await cmd.execute(interaction)` succeeds (not in the catch branch — an error reply should
not auto-delete):

```js
await cmd.execute(interaction);
await maybeAutoDelete(interaction, cmd.name, interaction.options.getSubcommand(false));
```

`maybeAutoDelete`:

1. Skip immediately if the interaction never replied at all (`!interaction.replied && !interaction.deferred`) — e.g. an autocomplete-only path or a thrown error before any reply.
2. Look up the enabled rule via the precedence above.
3. If enabled, `setTimeout(() => interaction.deleteReply().catch(() => {}), autoDeleteSeconds * 1000)`.

No ephemeral check is needed before scheduling: `deleteReply()` on an ephemeral reply is a
harmless no-op/throw absorbed by the same `.catch(() => {})` every other failure path already
uses (Discord does not expose a reliable way to introspect an already-sent reply's ephemeral
flag via `fetchReply()` after the fact — it can return null/throw for ephemeral messages — so
detecting it defensively isn't worth the complexity). Ephemeral messages are visible only to
the invoking user and are unaffected either way, so scheduling a no-op delete against one
changes nothing observable.

This requires zero changes to any command file's internals beyond the two removals above —
every command already funnels through this one call site, so the 183 individual reply call
sites are untouched.

## Mechanism — reaction rules

In `utils/messageReactions.js`, after `await message.reply(payload)` or
`await channel.send(payload)` returns their `Message`, look up
`(scope='reaction_rule', reaction_rule_id=rule.id)`. If enabled, schedule
`sentMessage.delete().catch(() => {})` after the same global `auto_delete_seconds`. The
`emoji` and `dm` branches are untouched — not eligible for this feature.

## Admin panel

**Slash commands**: extend the existing Permissions tab's command/subcommand row concept
(`admin/src/permissions.js`'s `perm-command`/`perm-subcommand` dropdowns already enumerate
`state.COMMAND_SUBS`) with a parallel small section — reuse the same two dropdowns, add a
single "Auto-delete replies" checkbox, Save writes one row via a new endpoint. Not merged
into the existing role/channel permission rows since this is a different rule table and a
different `OPERATIONS` tier concern.

New REST endpoints in `admin/server.js`, following the existing `/api/permissions` pattern:
- `GET /api/auto-delete?scope=command|reaction_rule` — list rules
- `POST /api/auto-delete` — upsert one rule (`scope`, `command`, `subcommand`, `reaction_rule_id`, `enabled`)
- `DELETE /api/auto-delete/:id` — remove a rule

**Reaction rules**: add an "Auto-delete" checkbox to each rule's row in the admin panel's
existing message-reactions management UI, writing through the same endpoints with
`scope='reaction_rule'`.

**Access control**: register both new mutation endpoints in `admin/auth.js`'s `OPERATIONS`
registry (default tier: `manage`, matching other per-feature toggles) so the Access tab and
tier gating cover them automatically, per the project's standing convention.

## Error handling

- `deleteReply()` / `message.delete()` failures (message already deleted by a human,
  permissions changed, channel deleted) are swallowed via `.catch(() => {})` — matching the
  existing `autoDelete.js` behavior. A failed delete is not worth surfacing anywhere; it is
  not a functional regression if the message is already gone.
- An error reply (the `catch` branch in `index.js`'s command dispatch) is never
  auto-deleted, regardless of configured rules — a user should not lose the only visible
  explanation of why their command failed.
- If `auto_delete_seconds` is missing/invalid in `bot_config`, fall back to the hardcoded
  default of 30, same precedence pattern used elsewhere in `botConfig.js`.

## Testing

- Unit tests for the new lookup/precedence helper (exact subcommand match wins over
  whole-command match wins over no rule), mirroring the existing
  `utils/permissions.test.js` structure.
- Manual live verification: toggle auto-delete on for `/guild status` via the admin panel,
  confirm it deletes after the configured delay; toggle it off, confirm it now posts
  permanently; verify a `/guild power` reply (no rule) still posts permanently by default;
  verify one `message_reactions` `reply`-type rule with auto-delete on actually deletes its
  reply.
