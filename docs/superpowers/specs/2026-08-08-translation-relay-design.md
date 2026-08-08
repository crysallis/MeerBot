# Translation Relay Design

## Overview

A small fixed group of Discord channels (2-4), each assigned one language, stay in sync as a
single translated conversation. A message posted in one channel is relayed into every other
channel in the group, translated into that channel's language, and posted via webhook so it
appears to come from the original author (`User X (app)` badge) rather than the bot. Replies to
a relayed message fan out the same way, with quoted context so the reply's target is legible
even though webhook messages can't carry a real Discord reply reference (verified empirically,
see Constraints below).

Inspired by the class of "translation relay" bots like itranslator.app; no existing MeerBot
prior art beyond `promoCodeHandler.js`'s `messageCreate`-watches-a-channel pattern.

## Constraints (verified, not assumed)

- **Webhooks cannot send native replies.** Confirmed via a live probe against the test bot on
  2026-08-08: `discord.js`'s `WebhookMessageCreateOptions.reply` throws (its resolver assumes a
  channel-message context webhooks don't have); a raw REST call with `message_reference` in the
  webhook-execute body is silently accepted by Discord (200 OK) but does **not** attach as a
  visible reply -- no reply arrow, no jump link. `discord-api-types` doesn't declare the field on
  `RESTPostAPIWebhookWithTokenJSONBody` either, consistent with this. Relayed replies use a
  quoted-text prefix instead (see Reply Handling).
- Webhook-posted messages fire a normal `messageCreate` event with `message.webhookId` set --
  the relay handler MUST skip any message whose `webhookId` matches one of its own relay
  webhooks, or it will relay its own relayed copies forever.
- `ANTHROPIC_API_KEY` must be present in the test bot's `.env` (currently missing -- copy the
  value from the real bot's `.env`) before this can be tested end-to-end. `/newsletter generate`
  is also silently broken in the test bot for the same reason; fixing this env var fixes both.

## Scope (v1)

**In scope:**
- Text-only relay across a single fixed relay group of 2-4 channels
- Each channel has one configured language (no per-message language detection)
- Replies relay with quoted-context text (not native Discord replies)
- Loop prevention (never re-relay a relay)
- Graceful degradation on translation failure (relay untranslated + flag-react, see below)
- Per-message Claude usage logging (token counts) so real cost is measurable after ~1 week
- Admin panel tab to configure relay channels/languages

**Explicitly deferred (not forgotten, just not v1):**
- Editing a source message updating its relayed copies
- Deleting a source message deleting its relayed copies
- Attachments/images being relayed
- Auto language detection
- Multiple independent relay groups running concurrently (schema allows for it via
  `relay_group`, but v1 admin UI and handler only need to support configuring one)

## Data Model

Two new bot-owned tables in `utils/db.js`, following the existing CREATE-statements-reflect-
current-shape convention (no migration trail).

```sql
CREATE TABLE IF NOT EXISTS translation_relay_channels (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id    TEXT NOT NULL UNIQUE,
  language      TEXT NOT NULL,       -- e.g. 'English', 'Spanish' -- human-readable, used in the Claude prompt directly
  flag_emoji    TEXT NOT NULL,       -- e.g. '🇺🇸' -- used for the failure-fallback reaction
  relay_group   TEXT NOT NULL DEFAULT 'default',
  webhook_id    TEXT,
  webhook_token TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_trc_group ON translation_relay_channels(relay_group);

-- One row per relayed copy of a message, INCLUDING the original (channel_id = source channel,
-- message_id = the original message's own id). relay_group_message_id is shared across every
-- copy of the same logical message -- it's just the `id` of that message's first-inserted row,
-- looked up via the row for whichever message a reply references.
CREATE TABLE IF NOT EXISTS translation_relay_messages (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  relay_group_message_id INTEGER NOT NULL,
  channel_id            TEXT NOT NULL,
  message_id            TEXT NOT NULL UNIQUE,
  author_id             TEXT NOT NULL,
  author_display_name   TEXT NOT NULL,
  language              TEXT NOT NULL,   -- this copy's language (source or target)
  text                  TEXT NOT NULL,   -- this copy's text (original or translated)
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_trm_group_msg ON translation_relay_messages(relay_group_message_id);
CREATE INDEX IF NOT EXISTS idx_trm_message ON translation_relay_messages(message_id);

CREATE TABLE IF NOT EXISTS translation_usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id    TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  target_count  INTEGER NOT NULL,  -- how many languages were translated to in this call
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## Message Flow

### New message in a relay channel

1. `messageCreate` fires. Bail immediately if:
   - `message.webhookId` is set AND matches a `webhook_id` in `translation_relay_channels`
     (loop guard -- our own relayed copies, checked first before any other work)
   - `message.author.bot` is true (covers every other bot/webhook posting in a relay channel,
     including our own relay webhook as a redundant second guard -- none of these are relayed)
   - `message.channelId` is not in `translation_relay_channels` (not a relay channel at all)
   - `message.content` is empty after trim (nothing to translate)
2. Look up the source channel's row (language) and every other channel in the same
   `relay_group`.
3. Insert a `translation_relay_messages` row for the **source** message itself (channel_id =
   source, message_id = original id, language = source language, text = original text). This
   row's own `id` becomes the `relay_group_message_id` shared by every translated copy created
   in step 6, and is what step 4 (on a *future* reply) will find via `message_id` lookup.
4. If `message.reference` is set, look up the referenced message's row in
   `translation_relay_messages` by `message_id` to get its `relay_group_message_id` and that
   copy's text (for the quoted-context prefix, per target channel/language -- see Reply
   Handling). If the referenced message isn't found (e.g. it predates the relay or was never a
   relay participant), treat this as a non-reply post.
5. Call Claude Haiku 4.5 once, prompted to return a JSON object translating the message into
   every target channel's language in a single call (see Translation Call below).
6. **On success:** for each target channel, resolve/create its webhook (see Webhook Lifecycle),
   post the translated text (prefixed with quoted reply-context if step 4 found one) using the
   source author's current display name + avatar. Insert one `translation_relay_messages` row
   per posted copy, all sharing the `relay_group_message_id` from step 3. Insert one
   `translation_usage` row for the whole call.
7. **On failure** (Claude API error, or response isn't valid parseable JSON matching every
   expected target language key): for each target channel, resolve/create its webhook and post
   the **original, untranslated** text (still with quoted-context prefix if applicable, using
   the original text verbatim since there's no translation to quote), then react to that
   relayed copy with the target channel's `flag_emoji` so an existing flag-reaction translate
   bot can pick it up. Still insert one `translation_relay_messages` row per target channel
   (with `language` = the *target* channel's language even though the text is untranslated --
   this keeps future reply lookups consistent) so replies to a failed-translation copy still
   work. Log the failure with `console.error`. No `translation_usage` row (no successful API
   call to log).

### Reply Handling

Quoted-context prefix format, prepended to the (translated or fallback) text before posting:

```
> {quoted text, truncated to 100 chars with a trailing … if longer}
{translated reply text}
```

The quoted text used is **that target channel's own language version** of the referenced
message -- i.e. when relaying a reply into Channel A (Spanish), quote the Spanish copy of what's
being replied to, not the original English. This is why every relayed copy (not just the
original) gets its own `translation_relay_messages` row in steps 3/6/7 above: the quote source
for channel A is looked up as the row where `relay_group_message_id` matches AND `channel_id` =
Channel A.

If the reply-target lookup (step 4) finds no matching row for a target channel (shouldn't
normally happen if the original relayed successfully, but guards a partial-failure edge case),
fall back to no quote prefix for that channel only -- never block relaying the reply itself.

## Translation Call

One `anthropic.messages.create` call per relayed source message (not per target language),
using `claude-haiku-4-5` (cheapest current tier, per the cost-later-not-now decision), following
the existing SDK usage pattern in `slash-commands/newsletter.js` (`new Anthropic()` reads
`ANTHROPIC_API_KEY` from env automatically).

```javascript
const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 1024,
    system: [
        'You are a chat relay bot, translating a casual Discord message for a gaming guild based on AFK Journey.',
        'Preserve tone, slang, and emotes/emoji as-is where they don\'t need translation.',
        'Keep Discord mention syntax (<@id>, <#id>) and custom emoji syntax (<:name:id>) completely unchanged.',
        'Output ONLY a JSON object mapping each requested language name to its translation, no other text.',
    ].join(' '),
    messages: [{
        role: 'user',
        content: `Source language: ${sourceLanguage}\nTarget languages: ${targetLanguages.join(', ')}\n\nMessage:\n${message.content}`,
    }],
});
const parsed = JSON.parse(response.content[0].text.trim());
// validate: parsed must have a string value for every targetLanguage, else treat as failure
```

Token usage for the `translation_usage` row comes from `response.usage.input_tokens` /
`response.usage.output_tokens` (standard Anthropic SDK response shape, same as available in the
newsletter call).

## Webhook Lifecycle

A relay channel's webhook is created lazily and cached in `translation_relay_channels.webhook_id`
/ `webhook_token`:

```javascript
async function getOrCreateWebhook(channelRow, channel) {
    if (channelRow.webhook_id && channelRow.webhook_token) {
        return new WebhookClient({ id: channelRow.webhook_id, token: channelRow.webhook_token });
    }
    const webhook = await channel.createWebhook({ name: 'Translation Relay' });
    db.prepare('UPDATE translation_relay_channels SET webhook_id = ?, webhook_token = ? WHERE id = ?')
        .run(webhook.id, webhook.token, channelRow.id);
    return webhook;
}
```

If a send fails with an error indicating the webhook no longer exists (deleted from Discord's
side, e.g. code `10015 Unknown Webhook`), clear the cached `webhook_id`/`webhook_token` (set to
NULL) and retry once by creating a fresh one. Any other send error is logged and that channel's
relay for this message is skipped (other target channels still proceed independently -- one
channel's failure shouldn't block the others).

Posting via webhook uses `username` and `avatarURL` overrides set to the source message
author's current display name and avatar (`message.member?.displayName ?? message.author.username`,
`message.author.displayAvatarURL()`), giving the `User X (app)` badge look.

## Admin Panel

New "Translation Relay" tab (`admin/src/translationRelay.js`, mirroring the Scheduled Jobs tab's
per-item card pattern):

- List of configured relay channels: channel (dropdown, from `channelList` like other tabs),
  language name, flag emoji, relay group (defaults to `'default'`, hidden/advanced field since
  v1 only needs one group in practice).
- Add / remove a channel from the relay.
- No message/activity log view in v1 -- `pm2 logs` is sufficient for now given this is new and
  will need close watching anyway.

New `admin/server.js` routes: `GET /api/translation-relay`, `POST /api/translation-relay`
(add), `DELETE /api/translation-relay/:id` (remove) -- same shape as existing simple CRUD tabs
(e.g. `ally_seasons`).

New `OPERATIONS` entries in `admin/auth.js` for the add/remove mutations, tier `manage` (matches
the tier of comparable config mutations like warband/season edits -- not `local`, since this
isn't a restart/refresh-class operation).

## Testing Plan

Build and test entirely in the `meerbot-test` process / test guild first (per the existing
test-bot workflow). Manual test matrix once implemented:
1. Post in Channel A -> confirm translated copies appear in B (and C/D if configured) with the
   correct author name/avatar via webhook.
2. Reply to a relayed copy in Channel B -> confirm the reply relays to A (and others) with
   correct quoted context in each channel's own language.
3. Post as the relay webhook itself is never re-relayed (loop guard) -- covered implicitly by
   every test above not causing runaway duplicate posts.
4. Temporarily break `ANTHROPIC_API_KEY` (or mock a Claude failure) -> confirm untranslated
   relay + correct flag-emoji reactions per target channel.
5. Confirm `translation_usage` rows accumulate with plausible token counts.

## Open Items for the Implementation Plan

- Exact list of test-server channel IDs + languages to configure for the initial test relay
  group (2 channels minimum to prove the loop).
- `ANTHROPIC_API_KEY` needs adding to `DiscordBotAfkJ-test/.env` before any live testing.