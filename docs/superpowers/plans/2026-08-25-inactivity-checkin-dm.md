# Inactivity Check-in DM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A day-4 proactive DM check-in to inactive members, capturing their
response (a text reply or one of four reactions) and relaying it to a
dedicated Discord channel for leadership.

**Architecture:** Piggybacks on the existing `/scan`-triggered flow in
`scan.js`. A new `member_checkin_dms` table tracks one row per check-in,
keyed to a specific absence streak. Response capture spans a DM reply and a
reaction on the DM message, both owned by a new
`utils/handlers/checkinResponseHandler.js`. `askHandler.js` gets its own
early-return guard (checked synchronously before any async handler starts,
to close a real race in `index.js`'s fire-and-forget `messageCreate`
dispatch) so it never answers the message that closes a check-in.

**Tech Stack:** discord.js v14, better-sqlite3, existing `botConfig`
DB-backed channel config pattern.

**Spec:** `docs/superpowers/specs/2026-08-25-inactivity-checkin-dm-design.md`

## Global Constraints

- No em dashes anywhere in code, comments, docs, commit messages, or any
  Discord-facing text the bot sends · use `·` or `...` instead.
- `CHECKIN_RELAY_CHANNEL_ID` follows the `botConfig.js` `CONFIG_META`
  pattern: `category: 'channels'`, `default: ''`, admin-panel-configured
  only · no hardcoded channel ID anywhere in code.
- Schema changes: `CREATE TABLE IF NOT EXISTS` folded directly into
  `utils/db.js`'s existing schema block · no migration trail.
- `CLAUDE.md` (project) updated as part of "done."
- This repo has no test framework for Discord-interaction code · verified
  live on the REAL bot (Daniel's explicit call for this feature · normally
  multi-channel/DM flows use `meerbot-test`, but this feature has no
  private-preview equivalent regardless of which bot runs it, since it DMs
  real inactive members). Gated by `CHECKIN_TEST_MODE_DISCORD_ID` (see Task
  2) until verified, so the first live runs only ever reach one Discord
  account.

---

## File Structure

- **Modify `utils/db.js`**: add `member_checkin_dms` table (with two
  indexes), five new functions (`createCheckinDm`, `getPendingCheckinByMessageId`,
  `getPendingCheckinByDiscordId`, `resolveCheckinResponse`,
  `getMembersEligibleForCheckin`), and repoint `member_checkin_dms` rows in
  `mergeMembers` (a real gap found while planning: the function's own
  comment says its FK-referencing table list drifts and must be updated by
  hand for every new table, or the final `DELETE FROM members` throws an FK
  violation on merge).
- **Modify `utils/botConfig.js`**: add `CHECKIN_RELAY_CHANNEL_ID` to
  `CONFIG_META`.
- **Create `utils/checkinContent.js`**: pure constants (the DM message
  template, the four reaction-emoji-to-meaning map) shared by `scan.js`
  (sending) and `checkinResponseHandler.js` (relaying), so the meaning text
  is defined exactly once.
- **Modify `slash-commands/scan.js`**: add `sendInactivityCheckins(client)`,
  called after `postInactivityAlert(client)`.
- **Create `utils/handlers/checkinResponseHandler.js`**: owns
  `handleCheckinReaction` (reaction path) and `resolveCheckinReply` (the
  synchronous row-lookup-and-update half of the reply path, called directly
  from `index.js` before any async handler starts) plus
  `postCheckinRelayAndConfirm` (the async relay-post-and-confirm-DM half,
  safe to fire-and-forget after the synchronous part has already landed).
- **Modify `utils/handlers/askHandler.js`**: add an early-return guard at
  the top of `handleAsk` for a message that was already claimed by the
  check-in reply path, and inject a small per-user fact into the system
  prompt when their most recent check-in was just closed.
- **Modify `docs/bot-guide.md`**: teach the model about the check-in flow
  and the "only your first message" rule.
- **Modify `index.js`**: wire `resolveCheckinReply` (sync, first, in the
  `messageCreate` listener) and `handleCheckinReaction` (async, in
  `messageReactionAdd`, alongside the existing handlers there).

---

## Task 1: `member_checkin_dms` table + DB functions

**Files:**
- Modify: `utils/db.js:417-419` (insert new `CREATE TABLE` before the
  closing `` `); `` of the big `db.exec()` block that ends with
  `glorycta_polls`), then append the new functions near
  `getGloryctaPollByMessageId`/`deleteGloryctaPoll` (around line 843-845),
  then export them in the `module.exports.X = X` block (around line 883).
- Modify: `utils/db.js:564-625` (`mergeMembers`, inside its transaction) to
  repoint `member_checkin_dms` rows.
- Test: manual (`node -e` against a real `guild.db` copy or the test bot's
  `guild.test.db`, per repo convention · no pytest-equivalent here).

**Interfaces:**
- Produces: `db.createCheckinDm({memberId, discordId, dmMessageId, sentAt,
  daysInactiveAtSend, status})` → inserts a row, returns the inserted row's
  `id`. `status` is one of `'pending'` or `'dm_failed'` at creation time
  (the two `resolved_*` states only happen via `resolveCheckinResponse`
  later). `dmMessageId` is `null` for a `dm_failed` row.
- Produces: `db.getPendingCheckinByMessageId(messageId)` → the `pending`
  row matching `dm_message_id`, or `undefined`.
- Produces: `db.getPendingCheckinByDiscordId(discordId)` → the `pending`
  row for that Discord user, or `undefined`.
- Produces: `db.resolveCheckinResponse(id, {status, responseText,
  responseEmoji, respondedAt})` → updates one row from `pending` to
  `responded_text` or `responded_reaction`. Returns nothing.
- Produces: `db.getMembersEligibleForCheckin(inactivityDays)` → array of
  `{id, ingame_name, discord_id, days_inactive}` for members meeting the
  eligibility rule (see Step 3 below). `inactivityDays` is the day-4
  threshold, passed in rather than hardcoded so it can be config-driven
  later without touching this function's shape.
- Consumes: nothing from earlier tasks (this is the first task).

- [ ] **Step 1: Add the table + indexes**

In `utils/db.js`, find the `glorycta_polls` `CREATE TABLE` block (ends at
the closing `` `); `` for the big `db.exec()` call started earlier in the
file). Insert immediately before that closing `` `); ``:

```sql
  CREATE TABLE IF NOT EXISTS member_checkin_dms (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id             INTEGER NOT NULL REFERENCES members(id),
    discord_id            TEXT NOT NULL,
    dm_message_id         TEXT,
    sent_at               TEXT NOT NULL,
    days_inactive_at_send INTEGER NOT NULL,
    status                TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'responded_text', 'responded_reaction', 'dm_failed')),
    response_text         TEXT,
    response_emoji        TEXT,
    responded_at          TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_checkin_message ON member_checkin_dms(dm_message_id);
  CREATE INDEX IF NOT EXISTS idx_checkin_member_status ON member_checkin_dms(member_id, status);
```

- [ ] **Step 2: Verify the table creates cleanly**

Run: `node -e "require('dotenv').config(); require('./utils/db'); console.log('ok');"`
Expected: prints `ok` with no error. If `better-sqlite3` throws
`ERR_DLOPEN_FAILED` (a known Node-ABI mismatch in some terminal sessions on
this machine, see project memory), run `npm rebuild better-sqlite3` first,
or run this check via `pm2` restart of `meerbot-test` instead if rebuilding
isn't appropriate for this terminal.

- [ ] **Step 3: Write the DB functions**

Add near `getGloryctaPollByMessageId`/`deleteGloryctaPoll` (both use the
same one-line `db.prepare(...).get/run(...)` style):

```javascript
function createCheckinDm({ memberId, discordId, dmMessageId, sentAt, daysInactiveAtSend, status }) {
    const result = db.prepare(
        `INSERT INTO member_checkin_dms
         (member_id, discord_id, dm_message_id, sent_at, days_inactive_at_send, status)
         VALUES (?, ?, ?, ?, ?, ?)`
    ).run(memberId, discordId, dmMessageId, sentAt, daysInactiveAtSend, status);
    return result.lastInsertRowid;
}

function getPendingCheckinByMessageId(messageId) {
    return db.prepare(
        "SELECT * FROM member_checkin_dms WHERE dm_message_id = ? AND status = 'pending'"
    ).get(messageId);
}

function getPendingCheckinByDiscordId(discordId) {
    return db.prepare(
        "SELECT * FROM member_checkin_dms WHERE discord_id = ? AND status = 'pending'"
    ).get(discordId);
}

function resolveCheckinResponse(id, { status, responseText, responseEmoji, respondedAt }) {
    db.prepare(
        `UPDATE member_checkin_dms
         SET status = ?, response_text = ?, response_emoji = ?, responded_at = ?
         WHERE id = ?`
    ).run(status, responseText || null, responseEmoji || null, respondedAt, id);
}

// Eligible: 4+ days inactive per the latest snapshot, no active AFK record,
// and either never checked in before, or their most recent check-in row's
// sent_at predates a LATER snapshot showing them active again (a fresh
// absence). member_snapshots' last_active text format ("Nd ago" / "Online" /
// "Xm ago" / "Xh ago") is the same field postInactivityAlert already parses
// in scan.js -- this mirrors that regex rather than introducing a new one.
function getMembersEligibleForCheckin(inactivityDays) {
    const snapshot = db.prepare('SELECT id FROM snapshots ORDER BY id DESC LIMIT 1').get();
    if (!snapshot) return [];

    const rows = db.prepare(`
        SELECT ms.name, ms.last_active, m.id as member_id, m.discord_id
        FROM member_snapshots ms
        LEFT JOIN members m ON m.id = ms.member_id
        LEFT JOIN member_afk afk ON afk.member_id = ms.member_id
        WHERE ms.snapshot_id = ?
          AND m.active = 1
          AND afk.member_id IS NULL
    `).all(snapshot.id);

    const inactive = rows.filter(r => {
        const match = r.last_active && r.last_active.match(/^(\d+)d\s*ago$/i);
        return match && parseInt(match[1], 10) >= inactivityDays;
    });

    const eligible = [];
    for (const r of inactive) {
        const lastCheckin = db.prepare(
            'SELECT sent_at FROM member_checkin_dms WHERE member_id = ? ORDER BY id DESC LIMIT 1'
        ).get(r.member_id);

        if (!lastCheckin) {
            eligible.push(r);
            continue;
        }

        const activeSince = db.prepare(`
            SELECT 1
            FROM member_snapshots ms2
            JOIN snapshots s2 ON s2.id = ms2.snapshot_id
            WHERE ms2.member_id = ?
              AND s2.scraped_at > ?
              AND ms2.last_active NOT LIKE '%d ago'
            LIMIT 1
        `).get(r.member_id, lastCheckin.sent_at);

        if (activeSince) eligible.push(r);
    }

    return eligible.map(r => ({
        id: r.member_id,
        ingame_name: r.name,
        discord_id: r.discord_id,
        days_inactive: parseInt(r.last_active.match(/^(\d+)/)[1], 10),
    }));
}
```

- [ ] **Step 4: Export the new functions**

In the `module.exports.X = X` block near the end of the file, add after
`module.exports.deleteGloryctaPoll`:

```javascript
module.exports.createCheckinDm = createCheckinDm;
module.exports.getPendingCheckinByMessageId = getPendingCheckinByMessageId;
module.exports.getPendingCheckinByDiscordId = getPendingCheckinByDiscordId;
module.exports.resolveCheckinResponse = resolveCheckinResponse;
module.exports.getMembersEligibleForCheckin = getMembersEligibleForCheckin;
```

- [ ] **Step 5: Fix `mergeMembers`'s FK gap**

In `mergeMembers`'s transaction (`utils/db.js`), find the single-line
repoint calls (`member_snapshots`, `member_notes`, `member_name_history` ·
around line 560-562). Add immediately after:

```javascript
        db.prepare('UPDATE member_checkin_dms SET member_id = ? WHERE member_id = ?').run(keepId, dropId);
```

This table has no per-member uniqueness constraint (a member can have many
rows over time), so unlike `member_snapshots`'s collision-handling, a plain
repoint is correct here · both the keeper's and the dropped member's
check-in history become one merged history under `keepId`.

- [ ] **Step 6: Verify with a real merge**

Run against a throwaway copy of `guild.db` (never the live one):
```bash
node -e "
require('dotenv').config();
const db = require('./utils/db');
db.createCheckinDm({memberId: 2, discordId: 'test123', dmMessageId: 'm1', sentAt: new Date().toISOString(), daysInactiveAtSend: 4, status: 'pending'});
db.mergeMembers(1, 2);
const rows = db.prepare('SELECT * FROM member_checkin_dms WHERE member_id = 1').all();
console.log('repointed rows:', rows.length);
"
```
Expected: `repointed rows: 1`, no FK constraint error thrown by the merge's
own `DELETE FROM members WHERE id = 2`.

- [ ] **Step 7: Commit**

```bash
git add utils/db.js
git commit -m "$(cat <<'EOF'
Add member_checkin_dms table + eligibility/response DB functions

Fixes a real gap in mergeMembers: its own comment says the FK-referencing
table list drifts and must be updated by hand for each new table, or the
final DELETE FROM members throws a constraint error on merge.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Check-in content constants + admin-panel config

**Files:**
- Create: `utils/checkinContent.js`
- Modify: `utils/botConfig.js:11` (insert `CHECKIN_RELAY_CHANNEL_ID` right
  after `INACTIVITY_ALERT_CHANNEL_ID`) and `utils/botConfig.js:25` (insert
  `CHECKIN_TEST_MODE_DISCORD_ID` right after `SCAN_AUTHORIZED_USER`, same
  category)

**Interfaces:**
- Produces: `CHECKIN_MESSAGE` (string, the full DM template).
- Produces: `CHECKIN_REACTIONS` (object, `{emoji: meaningText}`, 4 entries).
- Consumes: nothing.

- [ ] **Step 1: Write the content module**

```javascript
// utils/checkinContent.js
const CHECKIN_REACTIONS = {
    '👍': 'Still playing, just been busy... will be back',
    '🔽': 'Wants to keep playing but move to a less active guild',
    '💤': 'Taking a bit of a break, not sure yet',
    '👋': 'Done playing for now',
};

const CHECKIN_MESSAGE = `Hey! Just checking in... haven't seen you active in AFK Journey in a few days and wanted to make sure everything's okay. No pressure at all, just curious how you're doing and if there's anything the guild can help with.

You can reply here with anything, or just react to this message:
👍 still playing, just been busy... I'll be back
🔽 I want to keep playing but move to a less active guild
💤 taking a bit of a break, not sure yet
👋 I'm done playing for now

Either way, thanks for being part of RKF RiffRaff!`;

module.exports = { CHECKIN_MESSAGE, CHECKIN_REACTIONS };
```

- [ ] **Step 2: Verify the module loads and the emoji keys match the message text**

```bash
node -e "
const { CHECKIN_MESSAGE, CHECKIN_REACTIONS } = require('./utils/checkinContent');
const emoji = Object.keys(CHECKIN_REACTIONS);
console.log('emoji count:', emoji.length);
for (const e of emoji) {
    console.log(e, CHECKIN_MESSAGE.includes(e) ? 'in message' : 'MISSING FROM MESSAGE');
}
"
```
Expected: `emoji count: 4`, all four print `in message`.

- [ ] **Step 3: Add the admin-panel config entries**

In `utils/botConfig.js`, right after the `INACTIVITY_ALERT_CHANNEL_ID` line:

```javascript
    CHECKIN_RELAY_CHANNEL_ID:    { label: 'Check-in Relay Channel',    description: 'Channel for day-4 check-in DM responses', category: 'channels',    default: '' },
```

And right after the `SCAN_AUTHORIZED_USER` line (same `permissions`
category, same shape as that existing single-user gate):

```javascript
    CHECKIN_TEST_MODE_DISCORD_ID: { label: 'Check-in Test Mode (Discord ID)', description: 'ROLLOUT SAFETY GATE: when set, check-in DMs go ONLY to this Discord ID, ignoring real eligibility. Clear once verified.', category: 'permissions', default: '' },
```

- [ ] **Step 4: Verify both are picked up by the config system**

```bash
node -e "
require('dotenv').config();
const botConfig = require('./utils/botConfig');
console.log('relay:', botConfig.get('CHECKIN_RELAY_CHANNEL_ID', '<empty>'));
console.log('test mode:', botConfig.get('CHECKIN_TEST_MODE_DISCORD_ID', '<empty>'));
"
```
Expected: both print `<empty>` (the default, since neither is configured
yet) with no error.

- [ ] **Step 5: Commit**

```bash
git add utils/checkinContent.js utils/botConfig.js
git commit -m "$(cat <<'EOF'
Add check-in DM content + relay/test-mode config

CHECKIN_TEST_MODE_DISCORD_ID is a rollout safety gate: this feature DMs
real inactive members directly, with no private-preview equivalent (unlike
a channel post that can be checked in bot-chatter first) -- setting it
restricts every check-in to one Discord account until cleared.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `sendInactivityCheckins` in scan.js

**Files:**
- Modify: `slash-commands/scan.js` (add the new function near
  `postInactivityAlert`, call it in the same place `postInactivityAlert` is
  called)

**Interfaces:**
- Consumes: `db.getMembersEligibleForCheckin(inactivityDays)`,
  `db.createCheckinDm(...)` (Task 1) · `CHECKIN_MESSAGE`,
  `CHECKIN_REACTIONS` (Task 2) · `botConfig.get('CHECKIN_RELAY_CHANNEL_ID')`.
- Produces: `sendInactivityCheckins(client)`, called from the existing
  post-scan block alongside `postInactivityAlert(client)`.

- [ ] **Step 1: Add the function**

In `slash-commands/scan.js`, add near `postInactivityAlert` (reuses
`INACTIVITY_DAYS` the same way that function already does, but adds 1 for
the day-4 threshold):

```javascript
const { CHECKIN_MESSAGE, CHECKIN_REACTIONS } = require("../utils/checkinContent");

async function sendInactivityCheckins(client) {
	const RELAY_CHANNEL = botConfig.get('CHECKIN_RELAY_CHANNEL_ID');
	const CHECKIN_DAYS = Number(botConfig.get('INACTIVITY_DAYS', '3')) + 1;

	let eligible = db.getMembersEligibleForCheckin(CHECKIN_DAYS);

	// Rollout safety gate: while this feature is being verified live, set
	// CHECKIN_TEST_MODE_DISCORD_ID (admin panel) to restrict every check-in
	// to ONLY that one Discord account, regardless of who's actually
	// eligible -- this is unsolicited DMs to real members with no private
	// preview equivalent (unlike a channel post you can check in bot-chatter
	// first), so real eligibility stays disabled until this is cleared.
	const testModeId = botConfig.get('CHECKIN_TEST_MODE_DISCORD_ID');
	if (testModeId) {
		eligible = eligible.filter(m => m.discord_id === testModeId);
		console.log(`[Checkin] TEST MODE active -- only DMing discord_id ${testModeId} (${eligible.length} match(es) in eligible list).`);
	}

	if (eligible.length === 0) return;

	const relayChannel = RELAY_CHANNEL
		? await client.channels.fetch(RELAY_CHANNEL).catch(() => null)
		: null;

	for (const member of eligible) {
		if (!member.discord_id) continue; // no way to DM an unlinked member

		try {
			const user = await client.users.fetch(member.discord_id);
			const dmMessage = await user.send(CHECKIN_MESSAGE);
			for (const emoji of Object.keys(CHECKIN_REACTIONS)) {
				await dmMessage.react(emoji).catch(() => {});
			}
			db.createCheckinDm({
				memberId: member.id,
				discordId: member.discord_id,
				dmMessageId: dmMessage.id,
				sentAt: new Date().toISOString(),
				daysInactiveAtSend: member.days_inactive,
				status: 'pending',
			});
		} catch (err) {
			console.error(`Check-in DM failed for ${member.ingame_name}:`, err.message);
			db.createCheckinDm({
				memberId: member.id,
				discordId: member.discord_id,
				dmMessageId: null,
				sentAt: new Date().toISOString(),
				daysInactiveAtSend: member.days_inactive,
				status: 'dm_failed',
			});
			if (relayChannel) {
				await relayChannel.send({
					embeds: [
						new EmbedBuilder()
							.setTitle(`⚠️ Couldn't reach ${member.ingame_name} for a check-in`)
							.setDescription("DMs may be closed... consider reaching out another way.")
							.setColor(pickColor())
							.setFooter({ text: `Inactive ${member.days_inactive}+ days` }),
					],
				}).catch(() => {});
			}
		}
	}
}
```

- [ ] **Step 2: Wire it into the post-scan block**

Find where `postInactivityAlert(interaction.client)` is called (end of the
`execFile` callback). Add right after it:

```javascript
			await sendInactivityCheckins(interaction.client);
```

- [ ] **Step 3: Export for the response handler to reuse later (not needed by this task, but the module needs to be requireable)**

No export needed · `sendInactivityCheckins` is only called internally
within `scan.js`. Skip this step (kept here to be explicit that it was
considered, not an oversight).

- [ ] **Step 4: Verify it doesn't crash with zero eligible members**

```bash
node -e "
require('dotenv').config();
const db = require('./utils/db');
// force zero results regardless of real DB state, for a pure smoke test
db.getMembersEligibleForCheckin = () => [];
const scanModule = require('./slash-commands/scan.js');
console.log('scan.js loaded and exports execute:', typeof scanModule.execute === 'function');
"
```
Expected: prints `scan.js loaded and exports execute: true`, no error
(confirms the new `require` and function don't break the module at load
time · the actual send path is verified live in Task 6).

- [ ] **Step 5: Commit**

```bash
git add slash-commands/scan.js
git commit -m "$(cat <<'EOF'
Add day-4 inactivity check-in DM to /scan's post-scan flow

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Response handler (reaction + reply)

**Files:**
- Create: `utils/handlers/checkinResponseHandler.js`

**Interfaces:**
- Consumes: `db.getPendingCheckinByMessageId`,
  `db.getPendingCheckinByDiscordId`, `db.resolveCheckinResponse` (Task 1) ·
  `CHECKIN_REACTIONS` (Task 2) · `stripVariationSelectors` (existing export
  from `gloryctaReactionGuard.js`).
- Produces: `handleCheckinReaction(reaction, user, client)` (async, full
  reaction-path handler, called from `index.js`'s `messageReactionAdd`).
- Produces: `resolveCheckinReply(message)` (SYNCHRONOUS, no `await` inside
  · looks up and updates the DB row only, returns the resolved row or
  `null`. Called directly, not awaited, from `index.js`'s `messageCreate`
  listener BEFORE any async handler starts, so the row's status is already
  updated by the time `askHandler.js`'s own guard checks it. This split
  exists because `index.js` fires `handleTranslationRelay`/`handleAsk` as
  unawaited promises back-to-back · a naive async check-in handler in that
  same list would race `askHandler.js`'s guard-check read against its own
  DB write, both starting at effectively the same instant).
- Produces: `postCheckinRelayAndConfirm(row, {user, embedTitle,
  embedDescription})` (async, the relay-post + confirmation-DM half ·
  `user` is a resolved discord.js `User` object, `embedTitle`/
  `embedDescription` are the caller-built relay embed content · safe to
  fire-and-forget since it only reads a row `resolveCheckinReply`/
  `handleCheckinReaction` already resolved, no race risk here).

- [ ] **Step 1: Write the handler**

```javascript
// utils/handlers/checkinResponseHandler.js
const { EmbedBuilder } = require('discord.js');
const db = require('../db');
const botConfig = require('../botConfig');
const { pickColor } = require('../colors');
const { CHECKIN_REACTIONS } = require('../checkinContent');
const { stripVariationSelectors } = require('./gloryctaReactionGuard');

const CONFIRMATION_TEXT = "Thanks, got it! Passed that along to the team.";

async function postCheckinRelayAndConfirm(row, { user, embedTitle, embedDescription }) {
    const RELAY_CHANNEL = botConfig.get('CHECKIN_RELAY_CHANNEL_ID');
    if (RELAY_CHANNEL) {
        const channel = await user.client.channels.fetch(RELAY_CHANNEL).catch(() => null);
        if (channel) {
            await channel.send({
                embeds: [
                    new EmbedBuilder()
                        .setTitle(embedTitle)
                        .setDescription(embedDescription)
                        .setColor(pickColor())
                        .setFooter({ text: `Inactive ${row.days_inactive_at_send}+ days when checked in` }),
                ],
            }).catch(err => console.error('[Checkin] Failed to post relay:', err.message));
        }
    }

    await user.send(CONFIRMATION_TEXT).catch(err => console.error('[Checkin] Failed to send confirmation DM:', err.message));
}

// Reaction path: matches this reaction's message against a pending
// check-in row, records the response, relays it, confirms. Ignores any
// reaction that isn't one of the 4 valid option emoji (mirrors
// gloryctaReactionGuard's fail-safe philosophy: never act on something it
// can't positively identify).
async function handleCheckinReaction(reaction, user, client) {
    if (user.bot) return;

    if (reaction.partial) {
        try {
            await reaction.fetch();
        } catch (err) {
            console.error('[Checkin] Failed to fetch partial reaction:', err.message);
            return;
        }
    }

    const row = db.getPendingCheckinByMessageId(reaction.message.id);
    if (!row) return;

    const emojiName = stripVariationSelectors(reaction.emoji.name);
    const validEmoji = Object.keys(CHECKIN_REACTIONS).map(stripVariationSelectors);
    if (!validEmoji.includes(emojiName)) return;

    const originalEmoji = Object.keys(CHECKIN_REACTIONS).find(
        e => stripVariationSelectors(e) === emojiName
    );

    db.resolveCheckinResponse(row.id, {
        status: 'responded_reaction',
        responseEmoji: originalEmoji,
        respondedAt: new Date().toISOString(),
    });

    const fetchedUser = await client.users.fetch(row.discord_id).catch(() => null);
    if (!fetchedUser) return;

    await postCheckinRelayAndConfirm(row, {
        user: fetchedUser,
        embedTitle: `💬 A member responded to a check-in`,
        embedDescription: `${originalEmoji} ${CHECKIN_REACTIONS[originalEmoji]}`,
    });
}

// Reply path, synchronous half: looks up and updates the row ONLY. Must run
// (and complete its DB write) before askHandler.js's own guard-check reads
// this same row -- see the Interfaces note above for why this can't just be
// another async call in index.js's fire-and-forget messageCreate list.
function resolveCheckinReply(message) {
    if (message.author.bot) return null;
    if (message.guild !== null) return null; // DM only

    const row = db.getPendingCheckinByDiscordId(message.author.id);
    if (!row) return null;

    db.resolveCheckinResponse(row.id, {
        status: 'responded_text',
        responseText: message.content,
        respondedAt: new Date().toISOString(),
    });

    return { ...row, status: 'responded_text', response_text: message.content };
}

module.exports = { handleCheckinReaction, resolveCheckinReply, postCheckinRelayAndConfirm };
```

- [ ] **Step 2: Verify the module loads and exports the right shape**

```bash
node -e "
require('dotenv').config();
const h = require('./utils/handlers/checkinResponseHandler');
console.log(typeof h.handleCheckinReaction, typeof h.resolveCheckinReply, typeof h.postCheckinRelayAndConfirm);
"
```
Expected: `function function function`

- [ ] **Step 3: Verify `resolveCheckinReply` against a manually-seeded pending row**

```bash
node -e "
require('dotenv').config();
const db = require('./utils/db');
const { resolveCheckinReply } = require('./utils/handlers/checkinResponseHandler');

db.createCheckinDm({memberId: 6, discordId: 'faketestid', dmMessageId: 'fakemsg1', sentAt: new Date().toISOString(), daysInactiveAtSend: 4, status: 'pending'});

const fakeMessage = { author: { bot: false, id: 'faketestid' }, guild: null, content: 'doing fine, just busy' };
const resolved = resolveCheckinReply(fakeMessage);
console.log('resolved:', resolved && resolved.status);

const row = db.getPendingCheckinByDiscordId('faketestid');
console.log('still pending after resolve (expect undefined):', row);
"
```
Expected: `resolved: responded_text`, then `still pending after resolve
(expect undefined): undefined`.

- [ ] **Step 4: Commit**

```bash
git add utils/handlers/checkinResponseHandler.js
git commit -m "$(cat <<'EOF'
Add check-in response handler (reaction + reply capture, relay, confirm)

resolveCheckinReply is deliberately synchronous, called before any async
handler starts in index.js's messageCreate listener -- handleTranslationRelay
and handleAsk are fired as unawaited promises back-to-back there, so an
async check-in handler in that same list would race askHandler.js's own
guard-check read against this handler's DB write.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: askHandler.js guard + system prompt addition

**Files:**
- Modify: `utils/handlers/askHandler.js:91-98` (add the guard right after
  the existing `message.guild !== null` check)
- Modify: `utils/handlers/askHandler.js:108-127` (system prompt array,
  inject a per-user fact when relevant)

**Interfaces:**
- Consumes: `db.getPendingCheckinByDiscordId` is NOT what's needed here
  (that only finds `pending` rows, and by the time `handleAsk` runs on the
  closing message, the row is already `responded_*`) · needs a new small
  query for "does this user have a check-in resolved very recently."
- Produces: nothing new exported · this task only changes `handleAsk`'s
  internal behavior.

- [ ] **Step 1: Add a "recently resolved" lookup to db.js**

Add to `utils/db.js` near the other check-in functions (Task 1's location):

```javascript
function getRecentlyResolvedCheckin(discordId, withinMs = 5 * 60 * 1000) {
    const row = db.prepare(
        `SELECT * FROM member_checkin_dms
         WHERE discord_id = ? AND status IN ('responded_text', 'responded_reaction')
         ORDER BY id DESC LIMIT 1`
    ).get(discordId);
    if (!row || !row.responded_at) return null;
    const age = Date.now() - new Date(row.responded_at).getTime();
    return age <= withinMs ? row : null;
}
```

Export it: `module.exports.getRecentlyResolvedCheckin = getRecentlyResolvedCheckin;`

- [ ] **Step 2: Add the early-return guard in `handleAsk`**

In `utils/handlers/askHandler.js`, right after the existing
`if (message.guild !== null) return;` line, add:

```javascript
    // The message that just closed a check-in (see checkinResponseHandler.js's
    // resolveCheckinReply, called synchronously before this handler starts) is
    // never a question to answer -- it already got its own confirmation DM.
    if (db.getRecentlyResolvedCheckin(message.author.id, 2000)) return;
```

The 2-second window (not the 5-minute default `getRecentlyResolvedCheckin`
otherwise uses) is deliberately tight here: this guard only needs to catch
the EXACT message that just closed the check-in (resolved within the last
couple seconds by `resolveCheckinReply`, which ran synchronously moments
earlier in the same event). A later, genuinely new question from the same
member minutes afterward must NOT be silently dropped.

- [ ] **Step 3: Inject the "just checked in" fact into the system prompt for follow-up messages**

In the `system` array construction, add a new line after the capability
summary line:

```javascript
        const recentCheckin = db.getRecentlyResolvedCheckin(message.author.id);
        const checkinNote = recentCheckin
            ? `This member just responded to a guild check-in DM a few minutes ago. If they seem to be continuing that same conversation, gently mention that only their first message was passed along to the team, and if they want to share more they're welcome to post in the main server.`
            : '';
```

Add `checkinNote` into the `system.join('\n\n')` array (insert it as one
more element, right after `capabilitySummary`'s line):

```javascript
            capabilitySummary,
            checkinNote,
```

(`checkinNote` as an empty string is harmless in the joined prompt · no
conditional needed for the common case where it doesn't apply.)

- [ ] **Step 4: Add the check-in note to bot-guide.md**

Read `docs/bot-guide.md` first to match its existing tone (short,
conversational, written for members not developers) before adding. Add a
short paragraph, in that same style, explaining: the bot sometimes sends a
check-in DM to members who've been away a few days; replying or reacting
passes their answer to the team; only their first message after the
check-in counts, so if they want to say more they should use the main
server.

- [ ] **Step 5: Verify the guard fires and a normal question still works**

```bash
node -e "
require('dotenv').config();
const db = require('./utils/db');
db.createCheckinDm({memberId: 6, discordId: 'faketestid2', dmMessageId: 'fm2', sentAt: new Date().toISOString(), daysInactiveAtSend: 4, status: 'responded_text'});
db.prepare(\"UPDATE member_checkin_dms SET responded_at = ? WHERE discord_id = 'faketestid2'\").run(new Date().toISOString());
console.log('recent (expect a row):', !!db.getRecentlyResolvedCheckin('faketestid2', 2000));
console.log('recent for unrelated user (expect null):', db.getRecentlyResolvedCheckin('someoneelse', 2000));
"
```
Expected: `recent (expect a row): true`, `recent for unrelated user (expect
null): null`.

- [ ] **Step 6: Commit**

```bash
git add utils/db.js utils/handlers/askHandler.js docs/bot-guide.md
git commit -m "$(cat <<'EOF'
Guard askHandler.js against answering a check-in-closing message

The message that closes a check-in already gets its own confirmation DM
from checkinResponseHandler.js -- askHandler.js must not also answer it as
a normal question. A separate, wider-window lookup adds a soft note to the
system prompt so the model can gently redirect a member who keeps talking
about the same thing in a later message.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Wire into index.js + live verification

**Files:**
- Modify: `index.js:14` (import), `index.js:71-81` (`messageCreate`/
  `messageReactionAdd` listeners)

**Interfaces:**
- Consumes: `resolveCheckinReply`, `handleCheckinReaction`,
  `postCheckinRelayAndConfirm` (Task 4).

- [ ] **Step 1: Import the handler**

In `index.js`, add near the other handler imports:

```javascript
const { handleCheckinReaction, resolveCheckinReply, postCheckinRelayAndConfirm } = require('./utils/handlers/checkinResponseHandler');
```

- [ ] **Step 2: Wire the synchronous reply-resolve call FIRST in messageCreate**

Replace the `messageCreate` listener body with:

```javascript
client.on('messageCreate', message => {
  const resolvedCheckin = resolveCheckinReply(message); // synchronous, must run before handleAsk
  handleMessage(message, client);
  handlePromoCode(message);
  handleTranslationRelay(message, client).catch(err => console.error('[TranslationRelay] Unhandled error:', err));
  handleAsk(message, client).catch(err => console.error('[AskHandler] Unhandled error:', err));
  if (resolvedCheckin) {
    client.users.fetch(message.author.id)
      .then(user => postCheckinRelayAndConfirm(resolvedCheckin, {
        user,
        embedTitle: `💬 A member responded to a check-in`,
        embedDescription: resolvedCheckin.response_text,
      }))
      .catch(err => console.error('[Checkin] Failed to post relay/confirm for reply:', err.message));
  }
});
```

- [ ] **Step 3: Wire the reaction handler**

In the `messageReactionAdd` listener, add alongside the existing handlers:

```javascript
client.on('messageReactionAdd', (reaction, user) => {
  handleTranslationReactionSync(reaction, user, client, true).catch(err => console.error('[TranslationRelay] Reaction sync (add) unhandled error:', err));
  handleGloryctaReactionGuard(reaction, user, client).catch(err => console.error('[Glorycta] Reaction guard unhandled error:', err));
  handleAskReport(reaction, user, client).catch(err => console.error('[AskHandler] Report handler unhandled error:', err));
  handleCheckinReaction(reaction, user, client).catch(err => console.error('[Checkin] Reaction handler unhandled error:', err));
});
```

- [ ] **Step 4: Verify index.js still loads cleanly**

```bash
node -e "
require('dotenv').config();
process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'placeholder-for-syntax-check';
try {
  require('./index.js');
} catch (err) {
  if (err.message.includes('token') || err.message.includes('login')) {
    console.log('loaded OK (login failure expected without a real client connection)');
  } else {
    throw err;
  }
}
" 2>&1 | tail -5
```
Expected: no `SyntaxError`/`ReferenceError`/module-not-found error · a
login-related failure (this doesn't actually connect to Discord) is fine
and expected.

- [ ] **Step 5: Deploy to the real bot (test-mode gated) and verify live**

This feature is verified on the REAL bot, not `meerbot-test` (Daniel's
explicit call · this feature has no private-preview equivalent regardless
of which bot runs it). Do NOT restart PM2 yourself · hand the restart
command to Daniel:

```bash
pm2 restart meerbot --update-env
pm2 logs meerbot --lines 20 --nostream
```

Before that restart: confirm `CHECKIN_TEST_MODE_DISCORD_ID` is set (admin
panel, Config tab) to Daniel's own Discord ID · this is the safety gate
from Task 3, and it must be active before the first `/scan` run touches
this code path. Do not proceed to `/scan` until this is confirmed set.

With the gate active, `/scan` (run by Daniel, same as any normal scan) will
only ever DM the one gated account, regardless of how many real members are
actually 4+ days inactive.

Verify, in order (all against the ONE gated account):

1. The check-in DM arrives with the 4 pre-reacted emoji already on it, and
   the message text/tone reads right (this is the main thing the gate
   exists to let Daniel confirm before it's real).
2. Reacting with 👍 → relay posts (in whatever channel
   `CHECKIN_RELAY_CHANNEL_ID` is set to) with the right meaning text, a
   confirmation DM arrives, the row moves to `responded_reaction`.
3. On that SAME message (still from step 2, row now `responded_reaction`),
   send a text reply → the reply must NOT relay again, must NOT get its own
   check-in confirmation, and DOES get a normal `askHandler.js` answer (the
   row lookup finds nothing `pending`, so `resolveCheckinReply` returns
   `null` and the guard in `handleAsk` doesn't fire) · confirms "whichever
   comes first wins."
4. Reset (new `pending` row via `db.createCheckinDm` run directly, matching
   the gated account's real `discord_id`/`member_id`), reply with text
   instead → relay posts with the quoted text, a confirmation DM arrives,
   the row moves to `responded_text`.
5. Send a SECOND message right after the text reply → `askHandler.js`
   answers normally this time (not swallowed by the guard), and if the
   message continues the same topic, the model's answer gently mentions
   the "only first message" rule (soft check, not a hard assertion · model
   output varies).
6. Run `/scan` again (same simulated 4+ day state, no new activity) →
   confirm NO second DM is sent to the gated account (de-dup working).
7. Manually flip the gated account's latest snapshot to `"Online"`, then a
   later one back to `"5d ago"`, run `/scan` again → confirm a FRESH
   check-in DM sends (new-absence rule working).

Only after all seven are confirmed correct should `CHECKIN_TEST_MODE_DISCORD_ID`
be cleared (admin panel) to open real eligibility · that clearing step is
Daniel's call, not something to do automatically as part of this task.

- [ ] **Step 6: Commit**

```bash
git add index.js
git commit -m "$(cat <<'EOF'
Wire check-in response handling into index.js's event listeners

resolveCheckinReply runs synchronously first in messageCreate, before
handleAsk starts -- see checkinResponseHandler.js's Interfaces note for
why. Verified live on the real bot (CHECKIN_TEST_MODE_DISCORD_ID gated to
one account): DM send, reaction capture, reply capture, askHandler.js
guard, de-dup, and fresh-absence re-trigger all confirmed working.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Documentation

**Files:**
- Modify: `CLAUDE.md` (project)

**Interfaces:**
- Consumes: nothing (pure documentation).

- [ ] **Step 1: Add the feature to the Key Files table**

Add rows for `utils/checkinContent.js` and
`utils/handlers/checkinResponseHandler.js`, matching the existing table's
style (one line each, cross-referencing the fuller explanation below).

- [ ] **Step 2: Add `member_checkin_dms` to the Database Tables section**

One line matching the existing table-description style, e.g.:

```
- `member_checkin_dms` · one row per day-4 inactivity check-in DM sent ·
  member_id, discord_id, dm_message_id (for matching a later reaction back
  to the row), sent_at, days_inactive_at_send, status
  (pending/responded_text/responded_reaction/dm_failed), response_text,
  response_emoji, responded_at · a member can have many rows over time (one
  per absence streak) · repointed (not collision-collapsed) by mergeMembers
```

- [ ] **Step 3: Add a short project-decisions note**

Under "Key Decisions Made," one entry describing the race-condition fix
(why `resolveCheckinReply` is synchronous and called before `handleAsk`
rather than as another async call in `index.js`'s fire-and-forget list) ·
this is the single most non-obvious thing about the implementation and is
exactly the kind of decision that CLAUDE.md exists to preserve.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: document the inactivity check-in DM feature

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
