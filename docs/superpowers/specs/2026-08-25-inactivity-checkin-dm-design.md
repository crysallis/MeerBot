# Inactivity Check-in DM Design

**Goal:** A day-4 (one day past the existing 3-day inactivity alert) proactive DM
check-in to inactive members, capturing their response (a reply or one of four
reaction options) and relaying it back to a dedicated Discord channel for
leadership.

**Architecture:** Piggybacks on the existing `/scan`-triggered flow in
`scan.js`, alongside `postInactivityAlert()`. A new `member_checkin_dms` table
tracks one row per check-in sent, keyed to a specific absence streak so a
member who returns to activity and later goes inactive again gets a fresh
DM rather than being permanently excluded. Response capture spans two Discord
event types (a DM reply and a reaction on the DM message), both owned by a
new handler that takes priority over `askHandler.js`'s existing DM flow for
exactly the member's first DM after a pending check-in.

**Tech Stack:** discord.js v14, better-sqlite3, existing `botConfig` DB-backed
channel config pattern.

## Global Constraints

- No em dashes anywhere in code, comments, docs, commit messages, or any
  Discord-facing text the bot sends · use `·` or `...` instead.
- New channel config (`CHECKIN_RELAY_CHANNEL_ID`) follows the established
  `botConfig.js` `CONFIG_META` pattern: DB > ENV > hardcoded default, default
  `''`, no hardcoded channel ID anywhere · admin-panel-configured only, same
  as `RECRUITMENT_REMINDER_CHANNEL_ID`.
- Schema changes: ALTER `guild.db` once, then fold into the `CREATE TABLE IF
  NOT EXISTS` in `utils/db.js` · no migration trail replayed on load.
- `askHandler.js`'s system prompt is grounded in `docs/bot-guide.md`, a short
  model-facing doc written for members, not developers (see project memory
  on why README/ARCHITECTURE produced documentation-styled DM answers) · the
  check-in flow's "only your first message is relayed" rule gets added there,
  in that same short, conversational style.
- `CLAUDE.md` (project) must be updated as part of "done" for this feature.

---

## Data Model

### New table: `member_checkin_dms`

```sql
CREATE TABLE IF NOT EXISTS member_checkin_dms (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id            INTEGER NOT NULL REFERENCES members(id),
    discord_id           TEXT NOT NULL,
    dm_message_id        TEXT,
    sent_at              TEXT NOT NULL,
    days_inactive_at_send INTEGER NOT NULL,
    status               TEXT NOT NULL DEFAULT 'pending',
        -- 'pending' | 'responded_text' | 'responded_reaction' | 'dm_failed'
    response_text        TEXT,
    response_emoji       TEXT,
    responded_at         TEXT
);
```

- `dm_message_id` is how a reaction on the DM gets matched back to the right
  row (the message lives in a DM channel, not a guild channel, so this is the
  only handle available). `NULL` only in the `dm_failed` case, where no
  message was ever sent.
- `status='pending'` rows are exactly what both the eligibility check and the
  reaction/reply handlers query against. Exactly one `pending` row should ever
  exist per member at a time (enforced in code, not a DB constraint, since a
  double-send would need to be a bug elsewhere to happen at all).
- No `UNIQUE` constraint on `member_id` · a member can have many rows over
  time (one per absence streak), which is exactly the history this table is
  for.

### Eligibility query (who gets DMed this scan)

A member is eligible for a new check-in DM when:
1. `member_snapshots` (latest) shows `last_active` matching `/^(\d+)d ago$/i`
   with days >= 4 (one more day than the existing 3-day alert's threshold).
2. No active `member_afk` row (same exclusion as `postInactivityAlert`).
3. Their most recent `member_checkin_dms` row, if any, satisfies "this is a
   new absence" · defined as: the member has a `member_snapshots` row with
   `last_active` NOT matching the `Nd ago` pattern (i.e. read as active, "X
   ago" where X < 1 day, or "Online") from a snapshot **after** that most
   recent check-in row's `sent_at`. If no prior check-in row exists at all,
   they're trivially eligible.

This reuses `member_snapshots` (already populated by every `/scan`) rather
than adding new activity-tracking state · the "were they seen active again"
signal already exists.

## Trigger Flow

New function `sendInactivityCheckins(client)` in `scan.js`, called after
`postInactivityAlert(client)` in the same post-scan block.

1. Run the eligibility query above.
2. For each eligible member with a linked `discord_id`:
   a. Attempt `user.send({ content: CHECKIN_MESSAGE, ... })` (via
      `client.users.fetch(discord_id)` then `.send()`).
   b. On success: insert a `member_checkin_dms` row with `status='pending'`,
      `dm_message_id` set to the sent message's id.
   c. On failure (DMs closed, user left the server, etc.): insert a row with
      `status='dm_failed'`, no `dm_message_id`, and post a note to
      `CHECKIN_RELAY_CHANNEL_ID` (see Relay Posts below).
   d. React to the sent DM message with all four option emoji (👍 🔽 💤 👋)
      up front, matching the pattern other bot flows use to make reacting
      require no typing at all.
3. A member with no linked `discord_id` is skipped entirely (silently) ·
   there's no way to DM them, and this isn't a new gap (the existing 3-day
   alert already shows unlinked members by in-game name only).

### DM content

```
Hey! Just checking in... haven't seen you active in AFK Journey in a few
days and wanted to make sure everything's okay. No pressure at all, just
curious how you're doing and if there's anything the guild can help with.

You can reply here with anything, or just react to this message:
👍 still playing, just been busy... I'll be back
🔽 I want to keep playing but move to a less active guild
💤 taking a bit of a break, not sure yet
👋 I'm done playing for now

Either way, thanks for being part of RKF RiffRaff!
```

## Response Capture

### New handler: `utils/handlers/checkinResponseHandler.js`

Two exported functions, wired into `index.js` alongside the existing
`messageCreate`/`messageReactionAdd` dispatch:

**`handleCheckinReaction(reaction, user)`** (on `messageReactionAdd`, checked
before/alongside `gloryctaReactionGuard`'s handling since they're on
different message types and won't collide):
1. Guard: `user.bot` → return (loop guard, matches every other reaction
   handler in this codebase).
2. Look up a `pending` `member_checkin_dms` row where `dm_message_id` matches
   `reaction.message.id`. No match → return (not a check-in message).
3. Guard: the reacting emoji must be one of the four option emoji · a random
   other reaction on the same message is ignored, not treated as a response
   (mirrors `gloryctaReactionGuard`'s "strip anything that isn't a valid
   option" philosophy, except here the invalid reaction is simply not acted
   on rather than stripped · stripping a DM reaction isn't meaningfully
   different from ignoring it, and stripping requires an extra API call for
   no real benefit).
4. Update the row: `status='responded_reaction'`, `response_emoji`,
   `responded_at`.
5. Post to the relay channel (see below).
6. Send a short DM confirmation: "Thanks, got it! Passed that along to the
   team."

**`handleCheckinDMReply(message)`** (on `messageCreate`, checked in the DM
branch of `index.js` BEFORE `askHandler.js`'s handling · same file
`askHandler.js` already lives in guards on `message.guild === null`):
1. Look up a `pending` `member_checkin_dms` row for `message.author.id`. No
   match → fall through to `askHandler.js` unchanged (this is the normal
   case for the vast majority of DMs the bot receives).
2. Update the row: `status='responded_text'`, `response_text =
   message.content`, `responded_at`.
3. Post to the relay channel (see below).
4. Send the same short confirmation DM as the reaction path. This handler
   only ever sees the one message that closes the check-in, so it has
   nothing to say about "only your first message counts" · that note is
   `askHandler.js`'s job, triggered on a SUBSEQUENT DM if the member keeps
   talking (see the askHandler.js addition below).
5. Return (does NOT fall through to `askHandler.js` for this specific
   message · their check-in reply is not treated as a question to answer).

### `askHandler.js` addition

After a member's check-in has moved to `responded_*`, their next DM (if any)
resumes normal `askHandler.js` behavior with one addition: `askCapabilities.js`
or the system prompt gains a short, conversational note (added to
`bot-guide.md`, not hardcoded into the prompt-building code, matching how
every other capability is taught to the model) explaining: if a member's most
recent `member_checkin_dms` row is `responded_*` and `responded_at` was very
recent (same DM session, informally · no strict time window needed since this
is guidance text for the model to use its judgment with, not a hard gate),
and they're clearly continuing to talk about the same thing, the model should
gently mention that only their first message went to the team, and if they
want to share more they're welcome to post in the main server.

This is deliberately soft guidance for the model, not a hard-coded second
message-content check · over-engineering an exact "is this a continuation"
detector isn't worth it for what's fundamentally a courtesy note.

## Relay Posts

New channel config `CHECKIN_RELAY_CHANNEL_ID` (`botConfig.js` `CONFIG_META`,
`category: 'channels'`, `default: ''`), separate from
`INACTIVITY_ALERT_CHANNEL_ID`.

**Text reply post** (embed, matching existing bot embed conventions via
`pickColor()`):
- Title: "💬 {member} responded to a check-in"
- Description: the quoted reply text
- Footer: "Inactive {days_inactive_at_send}+ days when checked in"

**Reaction post** (same embed shape):
- Title: "💬 {member} responded to a check-in"
- Description: the matched emoji's meaning text (e.g. "👍 Still playing, just
  been busy... will be back")
- Footer: same as above

**DM-failed post** (same embed shape, posted immediately at send time, not on
response):
- Title: "⚠️ Couldn't reach {member} for a check-in"
- Description: "DMs may be closed · consider reaching out another way."
- Footer: "Inactive {days_inactive_at_send}+ days"

All four reaction meanings, spelled out once as a shared constant (used by
both the DM content and the relay post's description), not duplicated:

```js
const CHECKIN_REACTIONS = {
    '👍': 'Still playing, just been busy... will be back',
    '🔽': 'Wants to keep playing but move to a less active guild',
    '💤': 'Taking a bit of a break, not sure yet',
    '👋': "Done playing for now",
};
```

## Error Handling

- A scan-time failure sending one member's DM must never block the rest ·
  wrap each member's send in its own try/catch, matching `run_modes()`'s
  per-mode isolation pattern on the miner side.
- If the relay channel itself isn't configured (`CHECKIN_RELAY_CHANNEL_ID`
  empty), the response is still captured and the row still updated · the
  relay post is skipped with a console log, not a thrown error (mirrors
  `postInactivityAlert`'s `if (!INACTIVITY_CHANNEL) return` early-out
  philosophy, except here the underlying capture must still happen since
  the row update matters for future eligibility, unlike the read-only
  alert post).
- A reaction or reply arriving for a `member_checkin_dms` row that's already
  moved past `pending` (a race: they reacted and replied within the same
  second) is a no-op on the second event · the row lookup in both handlers
  filters on `status='pending'`, so the second event simply finds no match
  and is silently ignored, which is the "whichever comes first wins" rule
  implemented for free.

## Testing Plan

No pytest-equivalent test suite exists for Discord-interaction code in this
repo (see `utils/permissions.test.js` for the one precedent · targeted
regression tests exist for pure logic, not full Discord event flows). This
feature is verified live, same convention as `translationRelayHandler.js` and
`transferButtonHandler.js`:

- Live-test on the `meerbot-test` bot + test server (per project convention
  for anything touching multiple channels/DM flows, not the "test in
  bot-chatter on the real bot" path reserved for small single-channel
  changes) · a fake test member's `member_snapshots` row manually set to
  4+ days inactive to trigger eligibility without waiting for a real absence.
- Verify: DM sends and shows the 4 pre-reacted emoji · a text reply relays
  correctly and confirms · a reaction relays correctly and confirms ·
  reacting THEN replying only relays the reaction (reply is ignored, still
  gets normal `askHandler.js` treatment since the row is no longer pending) ·
  a second `/scan` while still `responded_*` (no new activity) does NOT
  re-DM · manually flipping the test member's `last_active` to "Online" then
  back to 5+ days DOES trigger a fresh DM (new-absence rule).
- `member_checkin_dms.dm_failed` path: hard to trigger live without an
  actual closed-DM test account · verify via direct unit test of the
  eligibility/status-transition SQL logic instead if a live DM-closed
  account isn't available, or accept as a lower-confidence path pending a
  live occurrence.
