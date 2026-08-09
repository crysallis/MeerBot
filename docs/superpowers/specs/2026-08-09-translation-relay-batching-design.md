# Translation Relay: Message Batching Design

## Overview

Addendum to `2026-08-08-translation-relay-design.md` (shipped, merged to `main`). Addresses a
conversational-feel gap in the shipped v1: every message triggers its own independent
translate-and-relay call immediately, so a burst of quick messages from one person ("Hi" / "how
are you" / "what are you up to") becomes three separate translated posts, each with independent
API latency, which can interleave awkwardly with anyone else typing at the same time.

This adds message batching: consecutive messages from the same author, in the same relay group,
within a short rolling window, are combined into a single translation call and a single relayed
post (one line per original message) instead of one relay per message.

## Core Rule

A relay group has **at most one open batch at a time** -- a "current speaker" slot that passes
to whoever posts next:

- A new message from the **same author** as the currently open batch joins that batch (appended
  as a new line) and resets the batch's timeout.
- A new message from a **different author** (or no batch currently open) **flushes** the
  currently open batch immediately (if one exists), then starts a fresh batch for the new
  author containing just this message.
- A batch with no interruption flushes on its own after a configurable timeout (see Configuration
  below).
- **A reply message never joins an open batch, from any author, including the batch's own
  author.** Encountering a reply first flushes whatever batch is currently open (even if it
  belongs to the same author as the reply), then the reply starts a new batch of its own (which
  can still accumulate further non-reply messages after it, following the normal rules). If
  further plain (non-reply) messages join a reply-led batch before it flushes, the **whole**
  combined post is treated as carrying that reply's quote-context -- there is no per-line reply
  tracking within a batch. This matches Discord's own UX, where a reply targets the whole
  rendered message regardless of how many lines it contains, and avoids adding a tracking
  mechanism this feature doesn't otherwise need.

"Flush" means: join the batch's accumulated message texts with newlines, run them through one
Claude translation call as a single multi-line block, post the combined translated result to
every target channel as one webhook message (one line per original), and record the DB rows
needed for reply-quoting.

This means, restated with the earlier walkthrough example: Person A posts "Hi" (opens a batch),
then "how are you" (joins A's batch, timer resets). Person B then posts "Hi" in either channel of
the relay group. B's arrival immediately flushes A's open batch (posting A's "Hi" / "how are
you" combined right then, without waiting for A's own timeout), and B's message starts its own
new batch. **Every batch, including B's, still waits out its own full configured timeout before
relaying** (or is itself flushed early by a third person's message) -- there is no "relay
immediately if nobody follows up" fast path. A lone message with nobody else talking still waits
the full window before it relays; this is an accepted latency tradeoff in exchange for the
batching/conversational feel, confirmed explicitly rather than assumed.

## Scope

The interrupt-on-other-author rule is **relay-group-wide, not per-channel** -- a message posted
in the Spanish channel of a relay group will flush an open batch that's accumulating in that same
group's English channel, because the feature's premise is that all configured channels are one
shared conversation, not independent per-channel threads that happen to translate into each
other.

## Combined Post Format

One webhook message, one line per original message in the batch, each translated independently
within the single Claude call (see Translation Call below) -- e.g. a 3-message batch produces:

```
Hola
¿Cómo estás?
¿Qué haces?
```

Not three separate webhook posts -- a single post whose content has newlines, matching how a
person typing multiple quick lines reads in a normal chat client.

## Reply-Context Quoting for Batched Messages

When a reply relays (to any target channel, including as the *source* of a NEW batch per the
Core Rule above), the quoted-context prefix uses **only the last line of whatever batch is being
quoted**, not the full combined block. This matches the existing single-message quoting UX (short,
scannable quotes) and requires no change to the existing `truncateQuote()`/quote-lookup logic --
only a change to *what gets stored* as a batch's quotable text (see Data Model below).

## Data Model Changes

`translation_relay_messages` currently stores one row per relayed copy of one original message,
1:1. Batching changes this to: one row per relayed copy of one **batch** (which may represent
1 or more original messages), still one row per channel per batch, still sharing one
`relay_group_message_id` the same way it does today.

Two new columns on `translation_relay_messages`:

```sql
-- Run once, folded into the existing CREATE TABLE (no migration trail, per project convention):
ALTER TABLE translation_relay_messages ADD COLUMN batch_message_ids TEXT NOT NULL DEFAULT '[]';
-- JSON array of the original Discord message IDs that made up this batch, in order. A
-- single-message batch (the common case when nobody else is actively chatting) is just a
-- 1-element array -- this column doesn't change behavior for unbatched messages, it just always
-- exists so batched and unbatched rows have the same shape.
```

The existing `text` column's meaning for a batched row is the **full combined text** (newline-
joined, translated) that was actually posted -- needed to display/log what went out. A **separate**
new column holds the last-line-only quotable text:

```sql
ALTER TABLE translation_relay_messages ADD COLUMN last_line_text TEXT NOT NULL DEFAULT '';
```

Reply-context lookup (`getRelayMessagesByGroupId` → quote source) now reads `last_line_text`
**falling back to `text` when `last_line_text` is empty** when building the quote prefix. This
fallback is required, not optional: rows created before this change (including the rows already
live in `guild.test.db` from v1 testing) get `last_line_text = ''` from the column's `DEFAULT ''`
-- without the fallback, a reply to any pre-batching-era message would quote an empty string
instead of degrading to the full text like it does today. `text` remains what gets
logged/displayed as the full record of what was sent.

No schema change needed for `translation_relay_channels` or `translation_usage` -- a batch's
Claude call still produces one `translation_usage` row (now representing N original messages'
worth of translation in one call, `target_count` unchanged in meaning).

## In-Memory Batch State

Batch state (which author's batch is open, its accumulated messages, its timer handle) is
**in-memory only**, scoped per relay group, living inside `translationRelayHandler.js` (not
persisted to the DB -- if the bot restarts mid-batch, the open batch is simply lost, which is an
acceptable, low-stakes edge case: at most one in-flight batch's messages fail to relay, and
they're still visible in their original channel to anyone reading it directly).

```javascript
// relay_group -> { authorId, channelId, messages: [{messageId, authorDisplayName, authorAvatarURL, text}], timeoutHandle }
const openBatches = new Map();
```

**Race requirement (not deferred to the implementation plan -- this is a correctness rule, not
an implementation detail):** a flush -- whether triggered by the timeout firing or by an
interrupting message's arrival -- MUST synchronously `clearTimeout(...)` and
`openBatches.delete(relayGroup)` (or replace the entry with the new batch, for the interrupt
case) as the very first thing it does, before any `await`. Node is single-threaded, but only if
the map entry is claimed/cleared before yielding to the event loop does a timer-firing-at-the-
same-moment-as-an-interrupting-message race stay impossible. If any `await` happens before the
entry is cleared, both code paths can observe the same open batch and both flush it -- producing
two identical relayed posts and two DB rows for the same original messages.

## Configuration

The batch timeout is admin-configurable, capped at 15 seconds. It is a conversation-wide setting,
not a per-channel one -- v1 has exactly one relay group, so this uses the project's existing
`bot_config` key/value store (DB > ENV > hardcoded-default precedence, per `utils/botConfig.js`)
rather than adding a new column to `translation_relay_channels`, which would leave unanswered
what happens when two channels in the same group disagree:

```javascript
// key: 'translation_relay_batch_timeout_seconds', default: 10, admin-editable, hard max 15
// enforced in both the admin form and the server-side handler that reads/writes it
const timeoutSeconds = Math.min(15, botConfig.getInt('translation_relay_batch_timeout_seconds', 10));
```

Admin panel: add this as a numeric field (seconds, 1-15) on the Translation Relay tab, alongside
the channel list -- a conversation-level setting, not per-row.

If a second relay group is ever added in a future version, this single key would need to become
per-group at that point -- out of scope for v1, called out here so the choice isn't silently
load-bearing on "only one group ever."

## Translation Call Changes

**Response contract change (deliberate, not deferred):** each target language's value becomes an
**array of strings, one per input line**, instead of a single string. This makes line-count
integrity checkable rather than assumed -- the shipped v1 already learned the hard way (via live
testing, not review) that Haiku doesn't reliably follow "output ONLY X" instructions, so this
design does not repeat that mistake by trusting a free-form multi-line string to preserve line
count and order. After parsing, the handler validates `parsed[lang].length ===
batch.messages.length` for every target language; a mismatch (wrong count, or the old single-
string shape) is treated exactly like a parse failure and routes to the existing untranslated-
relay-plus-flag-emoji fallback path, unchanged from v1.

```javascript
// System prompt addition for the batched case:
'Output ONLY a JSON object mapping each requested language name to an ARRAY of translated
strings, one array entry per input line, in the same order -- never a single string.'

// Example request (2-message batch, one target language):
// Message:
// Hi
// how are you
//
// Expected response shape:
// { "Spanish": ["Hola", "¿Cómo estás?"] }
```

A single-message batch (the common case for anyone chatting at a normal, spaced-out pace) uses
this same array-of-length-1 shape -- `{ "Spanish": ["Hola"] }` -- rather than a special-cased
single-string path. One request/response shape for both cases, always validated the same way,
is simpler and safer than branching between "sometimes a string, sometimes an array."

## What Does Not Change

- Loop guard, webhook lifecycle, translation-failure fallback (untranslated relay + flag-emoji
  reaction), the 2000-char truncation guard, and the per-relay-group ordering queue
  (`enqueueRelay`) from the shipped v1 all continue to apply -- batching sits in front of the
  existing translate-and-post flow, it doesn't replace any of it. A flush is just a call into
  that same existing flow, fed a (possibly multi-line) combined message instead of always a
  single one.
- Admin UI's existing channel list/add/remove behavior is unchanged aside from the new optional
  timeout field.

## Open Items for the Implementation Plan

- Exact wording/placement of the new timeout field in the admin form.
- Both flush paths (timeout firing, new-message interrupt) must funnel through the existing
  `enqueueRelay` per-relay-group serialization, not just the race-safety rule above -- confirm
  in the plan that a timer-fired flush enqueues onto the same Promise chain a normal message
  would, so the two mechanisms (race-safety via synchronous state-clearing, ordering via the
  existing queue) compose correctly rather than one silently bypassing the other.
