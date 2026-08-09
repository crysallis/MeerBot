# Translation Relay: Attachments, Reaction Sync, Edit/Delete Sync (v3)

**Goal:** Close three gaps left explicitly deferred from v1/v2: attachments are dropped
silently, reactions don't propagate across relayed copies, and editing or deleting an
original message never touches its already-relayed translations.

**Architecture:** Extend the existing per-batch relay pipeline (`translationRelayHandler.js`)
rather than redesigning it. The one structural change everything else depends on: source
batch rows must store text *per original message*, not just a joined blob, so an edit or
delete affecting one line of a multi-message batch can be resolved back to that line alone.
Attachments piggyback on the existing send/edit payload. Reactions and edit/delete become
three new Discord event listeners wired into `index.js` alongside the existing
`messageCreate` listener, each doing a lookup into `translation_relay_messages` by
`message_id` to find sibling copies via `relay_group_message_id`.

**Tech Stack:** Same as existing relay — discord.js v14, `better-sqlite3`, `@anthropic-ai/sdk`
(Claude Haiku 4.5), webhook-per-channel posting.

## Global Constraints

- Webhooks cannot react to messages (no such method on `WebhookClient` — verified against
  `discord.js` v14's `WebhookClient.prototype`) and cannot be edited/deleted by anyone but
  the bot holding the webhook token — both sync paths that touch reactions or edits/deletes
  on a *relayed copy* go through the bot's own client, never the webhook.
- Loop guard for reactions: skip any `messageReactionAdd`/`Remove` event where
  `user.id === client.user.id` — mirrors the existing `message.author.bot` guard on
  `messageCreate`. Accepted limitation (shared with the server's separate iTranslator bot):
  the synced reaction is one reaction from the bot's account, not a reproduction of the
  real per-user reaction count.
- Discord's webhook message edit/delete REST calls are the only way to mutate a relayed
  copy after it's posted — `WebhookClient.editMessage(messageId, payload)` /
  `WebhookClient.deleteMessage(messageId)`, both already available on the client used by
  `sendViaWebhook`.
- All new DB writes/reads stay inside `utils/db.js`, matching existing convention — no raw
  SQL in the handler.
- `translation_relay_messages.batch_message_ids` changes shape from `string[]` to
  `{messageId, text}[]`. This is a breaking shape change for that one column; existing rows
  (shipped as `string[]` or `'[]'`) are migrated in place at startup (see Task 1).

## Data Model Change

**Before:** `batch_message_ids: '["idA","idB","idC"]'` — just the original message IDs, no
way to recover which line came from which message once joined into `text`.

**After:** `batch_message_ids: '[{"messageId":"idA","text":"line one"},{"messageId":"idB","text":"line two"}]'`
— same column, richer shape. `text` (the joined blob) and `last_line_text` are both still
maintained exactly as today, for display and quote-prefix use; they're derived from this
array, not replaced by it.

This is what makes precise edit/delete possible: given an edited message's ID, find its
entry in the array, replace just that entry's `text`, rebuild `text`/`last_line_text` from
the updated array, and re-translate. Only target-channel (non-batch) rows are unaffected —
those already store one message per row.

## Feature 1: Attachments

Discord's `message.attachments` is a `Collection<string, Attachment>`, each with a stable
CDN `.url`. Pass these straight into the webhook payload's `files` array on both the
original `send` and any later `editMessage` call — no re-hosting, no DB storage, no size
inspection beyond what Discord's own webhook endpoint already enforces (payload/file size
limits apply identically to a webhook send as to a normal message send, so a message a user
could already post will already fit).

Batching interacts with attachments the same way it already interacts with text: each
message in a batch keeps its own attachments; when the batch flushes, all attachments from
all messages in the batch are concatenated into one `files` array on the single combined
webhook post, in message order.

Text-only messages carry no `files` key (existing behavior, unchanged). Attachment-only
messages (no text) relay with an empty `bodyText` and populated `files` — no placeholder
caption is added, per explicit decision (pass through unchanged, nothing invented).

## Feature 2: Reaction Sync (bidirectional)

New listeners in `index.js`:

```javascript
client.on('messageReactionAdd', (reaction, user) => handleTranslationReactionSync(reaction, user, client, true));
client.on('messageReactionRemove', (reaction, user) => handleTranslationReactionSync(reaction, user, client, false));
```

`handleTranslationReactionSync(reaction, user, client, isAdd)`:
1. Guard: `if (user.id === client.user.id) return;` — loop guard, see Global Constraints.
2. Guard: `if (reaction.partial) await reaction.fetch();` — Discord may deliver partial
   reaction objects for uncached messages; needed to read `reaction.emoji` reliably.
3. Look up the reacted-to message: `db.getRelayMessageByMessageId(reaction.message.id)`. If
   no row, return (not a relay message at all).
4. Fetch all sibling rows: `db.getRelayMessagesByGroupId(row.relay_group_message_id)`,
   excluding the row that was reacted to (already has the real reaction).
5. For each sibling row, fetch its channel + message via `client.channels.fetch` /
   `channel.messages.fetch`, then `message.react(reaction.emoji)` (add) or
   `message.reactions.resolve(reaction.emoji)?.users.remove(client.user.id)` (remove).
   Wrap each in try/catch — one channel's failure (deleted message, missing permission)
   must not block syncing to the others, matching the existing per-channel fault isolation
   in `processTranslationRelay`.
6. Custom emoji (`reaction.emoji.id` set) sync as-is via the same `.react()` call — valid
   because source and target channels are always in the same guild for this feature (no
   cross-guild emoji access problem to solve).

No new DB table — this is a live mirror, not a logged history. If the bot is offline when a
reaction is added, that reaction is simply never synced (matches the existing "no SIGTERM
flush handler" accepted-risk framing from the batching feature).

## Feature 3: Edit Sync

New listener:

```javascript
client.on('messageUpdate', (oldMessage, newMessage) => handleTranslationEditSync(newMessage, client));
```

`handleTranslationEditSync(message, client)`:
1. Guard: `if (message.author?.bot) return;` (same loop guard as `messageCreate`; also
   naturally skips embed-only updates from link unfurls, which Discord also fires as
   `messageUpdate` — those have no content change relevant here since the author is real
   but `newMessage.content` for a pure-embed-load update matches what's already stored, so
   re-translating is a harmless no-op, not a correctness risk).
2. Look up `db.getRelayMessageByMessageId(message.id)`. If no row, return — not a tracked
   relay message (or it's a target-channel copy someone impossibly edited; see Global
   Constraints).
3. No source-vs-target branch is needed here: target rows' `message_id` values are the
   bot's own webhook-posted IDs, and a real user's `messageUpdate` event can never carry one
   of those (per Global Constraints, only the webhook token can edit a webhook message) — so
   the lookup in step 2 only ever matches a source-channel row in practice.
4. Parse `batch_message_ids`, find the entry matching `message.id`, replace its `text` with
   `message.content.trim()`. Rebuild `combinedText` (join all entries' `text` with `\n`) and
   `lastLineText` (the last entry's `text`).
5. Update the source row in place (new `db.updateRelayMessageText(rowId, {text, batch_message_ids, last_line_text})`).
6. Re-run `callClaude` on the full rebuilt line array, same as initial send. On failure,
   log and return without editing target copies — leaves the stale (pre-edit) translation
   visible rather than erroring, matching the "relay untranslated on failure" precedent for
   new sends. (No flag-emoji reaction on edit failure — that reaction semantic is specific
   to first-send fallback, not re-applicable to an in-place edit.)
7. For each target-channel sibling row: rebuild `bodyText` (with quote-prefix fitting, same
   as `processTranslationRelay`), call `webhook.editMessage(row.message_id, { content })`.
   Update that row's `text`/`last_line_text` in DB to match. Files/attachments on the
   existing message are left as Discord already has them — `editMessage` without a `files`
   key does not clear existing attachments.
8. Wrap each target's edit in try/catch — one channel's failure must not block the others.

## Feature 4: Delete Sync

New listener:

```javascript
client.on('messageDelete', message => handleTranslationDeleteSync(message, client));
```

`handleTranslationDeleteSync(message, client)`:
1. Look up `db.getRelayMessageByMessageId(message.id)`. If no row, return.
2. Parse `batch_message_ids`, remove the entry matching `message.id`.
3. **If entries remain:** same rebuild-and-re-translate-and-edit path as edit sync (steps
   4-8 above) — the batch shrinks by one line, remaining lines re-flow into a fresh combined
   translation and each target copy is edited in place.
4. **If no entries remain:** for each row sharing this `relay_group_message_id` (source row
   included), `webhook.deleteMessage(row.message_id)` for target rows (try/catch per
   channel, fault-isolated), then `db.deleteRelayMessagesByGroupId(relayGroupMessageId)`
   removes all rows (source + targets) for this logical message.
5. If the deleted message was itself the target of open reply-quotes from later messages,
   those quotes remain as static text (already-sent, already-baked-into-content) — no
   retroactive quote invalidation. Out of scope; matches how a normal Discord reply-quote
   also survives the quoted message's deletion.

## Out of Scope (explicit)

- Editing or deleting a relayed *copy* directly (target-channel message) — confirmed
  impossible for edit (webhook-token-only), and deletion by a moderator with Manage
  Messages is treated as a deliberate moderation action needing no special bot handling.
- Reaction count fidelity — accepted platform limitation, shared with iTranslator.
- Retroactive quote-prefix updates when a quoted message is later edited or deleted.
- Attachment re-hosting, size validation beyond Discord's own enforcement, or file-type
  filtering.

## Testing

Per-function unit tests for the new DB helpers (`updateRelayMessageText`,
`deleteRelayMessagesByGroupId`, the migrated `batch_message_ids` shape) and for the
line-replace/rebuild logic in isolation (given a batch array and an edited message ID,
does it produce the right rebuilt text/last-line). Live Discord verification required for:
attachment passthrough (send + edit), bidirectional reaction sync including the
self-reaction loop guard, edit-sync on both a single message and a mid-batch line, and
delete-sync on both a whole single-message row and a mid-batch line — same live-testing
bar the batching feature (v2) held itself to, since this class of feature has already
proven to hide bugs that pass code review cleanly.
