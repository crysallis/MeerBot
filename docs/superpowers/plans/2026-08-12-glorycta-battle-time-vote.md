# Glorycta Battle-Time Vote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `/glorycta`, a slash command that posts a pinned two-option reaction vote for a Clash of Glory UTC battle time, enforces that only the poll's two (randomly-chosen) emoji can be used on it, and auto-tallies + auto-unpins when the vote closes.

**Architecture:** A new slash command (`slash-commands/glorycta.js`) creates the poll message, a DB row (`glorycta_polls`, migrated via `utils/db.js`'s CREATE-statement convention) tracking it, and a one-shot `scheduled_jobs` row (`type = 'glorycta_tally'`) that `utils/jobScheduler.js` already knows how to fire once and discard. A new `messageReactionAdd` listener wired in `index.js` strips any reaction that isn't one of the poll's two valid emoji, looked up by `message_id` against the tracking table. A small pure-function module (`utils/glorycta.js`) owns emoji-pool selection and the UTC-time-string → next-occurrence-timestamp math, so both pieces are independently unit-testable without touching Discord or the DB.

**Tech Stack:** discord.js v14, better-sqlite3, `utils/jobScheduler.js`'s existing one-shot job pattern, `node --test` for unit tests.

## Global Constraints

- Command: `/glorycta time1:<HH:MM> time2:<HH:MM> duration:<integer hours>` — both times are strict 24-hour UTC clock strings, validated `^([01]\d|2[0-3]):[0-5]\d$`.
- Gated via `enforcePermissions(interaction, 'glorycta')` — no code-hardcoded role check. The admin panel's Permissions tab auto-discovers `/glorycta` from the command file at request time (`admin/server.js`'s `/api/commands` scans `slash-commands/*.js`) — **no new registration step needed anywhere**, unlike the `OPERATIONS`/Access-tab system, which only governs admin-panel mutations, not slash commands.
- The two poll emoji are picked at random per invocation from Discord's standard emoji set, excluding flags and skin-tone modifier variants — never admin-specified, never fixed across runs.
- Any reaction added to an open poll message that isn't one of its two valid emoji is removed immediately, silently — no DM, no channel message, no exceptions.
- A voter reacting with both valid emoji is tallied under both time options.
- Tally posts as a new message in the same channel as the poll (not a DM, not a reply/thread), then the original poll message is unpinned.
- Follow existing file/module conventions exactly: `pickColor()` from `utils/colors.js` for embed color, `enforcePermissions` from `utils/permissions.js`, DB helpers exported as named properties on `module.exports` alongside the raw `db` object in `utils/db.js` (see `mergeMembers`, `getWarbands` etc. for the pattern).

---

## File Structure

- **Create:** `utils/glorycta.js` — pure helpers: `pickPollEmoji()` (returns `[emojiA, emojiB]`), `nextOccurrenceUtc(hhmm, fromDate)` (returns a `Date`), `EMOJI_POOL` (exported for testing).
- **Create:** `utils/glorycta.test.js` — unit tests for both helpers.
- **Modify:** `utils/db.js` — add `glorycda_polls` → actually `glorycta_polls` table (see Task 2 for exact DDL) plus DB accessor functions (`createGloryctaPoll`, `getGloryctaPollByMessageId`, `deleteGloryctaPoll`), exported the same way existing helpers are.
- **Create:** `slash-commands/glorycta.js` — the command itself: builds/validates input, posts the poll embed + reactions, pins it, inserts the DB row + the one-shot `scheduled_jobs` row.
- **Modify:** `utils/jobScheduler.js` — add `type === 'glorycta_tally'` handling to `tick()`'s dispatch, plus a `handleGloryctaTally(client, job)` function alongside the existing `handleRemindme`/`handleRecruitmentFollowup`.
- **Create:** `utils/handlers/gloryctaReactionGuard.js` — the `messageReactionAdd` enforcement handler.
- **Modify:** `index.js` — wire the new reaction guard into the existing `messageReactionAdd` listener block.

---

### Task 1: Emoji pool + time-math helpers (`utils/glorycta.js`)

**Files:**
- Create: `utils/glorycta.js`
- Test: `utils/glorycta.test.js`

**Interfaces:**
- Produces: `pickPollEmoji()` → `[string, string]` (two distinct emoji, never equal to each other). `nextOccurrenceUtc(hhmm: string, fromDate: Date)` → `Date` (the next UTC instant matching that `HH:MM`, today if not yet passed relative to `fromDate`, otherwise tomorrow). `EMOJI_POOL` → `string[]` (exported so the test file can assert against its contents/length without duplicating the literal array).
- Consumes: nothing (pure module, no DB/Discord imports).

- [ ] **Step 1: Write the failing tests**

```js
// utils/glorycta.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { pickPollEmoji, nextOccurrenceUtc, EMOJI_POOL } = require('./glorycta');

test('EMOJI_POOL has no flag emoji (regional indicator pairs)', () => {
  // Flags are built from two regional-indicator code points (U+1F1E6-U+1F1FF).
  // None of the pool entries should be exactly two such code points.
  const isFlag = s => /^[\u{1F1E6}-\u{1F1FF}]{2}$/u.test(s);
  assert.equal(EMOJI_POOL.some(isFlag), false);
});

test('EMOJI_POOL has no skin-tone modifier suffix', () => {
  const hasSkinTone = s => /[\u{1F3FB}-\u{1F3FF}]/u.test(s);
  assert.equal(EMOJI_POOL.some(hasSkinTone), false);
});

test('EMOJI_POOL has at least 20 distinct entries', () => {
  assert.ok(EMOJI_POOL.length >= 20);
  assert.equal(new Set(EMOJI_POOL).size, EMOJI_POOL.length);
});

test('pickPollEmoji returns two distinct emoji from the pool', () => {
  const [a, b] = pickPollEmoji();
  assert.notEqual(a, b);
  assert.ok(EMOJI_POOL.includes(a));
  assert.ok(EMOJI_POOL.includes(b));
});

test('pickPollEmoji varies across calls (not hardcoded)', () => {
  const seen = new Set();
  for (let i = 0; i < 30; i++) {
    const [a, b] = pickPollEmoji();
    seen.add(a);
    seen.add(b);
  }
  // With 30 draws from a pool of 20+, expect more than 2 distinct emoji to
  // have appeared -- guards against an accidental hardcoded fixed pair.
  assert.ok(seen.size > 2);
});

test('nextOccurrenceUtc: time later today rolls to today', () => {
  const from = new Date('2026-08-12T10:00:00Z');
  const result = nextOccurrenceUtc('14:00', from);
  assert.equal(result.toISOString(), '2026-08-12T14:00:00.000Z');
});

test('nextOccurrenceUtc: time already passed today rolls to tomorrow', () => {
  const from = new Date('2026-08-12T10:00:00Z');
  const result = nextOccurrenceUtc('06:00', from);
  assert.equal(result.toISOString(), '2026-08-13T06:00:00.000Z');
});

test('nextOccurrenceUtc: exact current time counts as passed, rolls to tomorrow', () => {
  const from = new Date('2026-08-12T10:00:00.000Z');
  const result = nextOccurrenceUtc('10:00', from);
  assert.equal(result.toISOString(), '2026-08-13T10:00:00.000Z');
});

test('nextOccurrenceUtc: two options can land on different calendar dates independently', () => {
  const from = new Date('2026-08-12T15:00:00Z');
  const early = nextOccurrenceUtc('06:00', from); // already passed -> tomorrow
  const late  = nextOccurrenceUtc('20:00', from); // still ahead -> today
  assert.equal(early.toISOString(), '2026-08-13T06:00:00.000Z');
  assert.equal(late.toISOString(), '2026-08-12T20:00:00.000Z');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test utils/glorycta.test.js`
Expected: FAIL — `Cannot find module './glorycta'`

- [ ] **Step 3: Write the implementation**

```js
// utils/glorycta.js

// Discord's standard emoji set minus flags (regional-indicator pairs, which would
// dominate the randomness and carry no in-domain meaning here) and skin-tone
// modifier variants (redundant repeats of the same base emoji). Deliberately NOT
// admin-configurable and NOT fixed -- pickPollEmoji() draws two fresh ones every
// call so voters can't develop a positional/emoji habit instead of reading the
// actual time labels.
const EMOJI_POOL = [
    '😀', '😂', '😍', '🤔', '😎', '🥳', '😴', '🤯', '🙃', '😇',
    '🐢', '🦋', '🐙', '🦊', '🐸', '🦉', '🐝', '🦁', '🐳', '🦄',
    '🍕', '🍔', '🍩', '🍎', '🍇', '🥑', '🍉', '🌮', '🍪', '🧁',
    '⚔️', '🛡️', '🏹', '🔥', '⭐', '🌙', '⚡', '💎', '🎯', '🚀',
];

function pickPollEmoji() {
    const a = EMOJI_POOL[Math.floor(Math.random() * EMOJI_POOL.length)];
    let b = a;
    while (b === a) {
        b = EMOJI_POOL[Math.floor(Math.random() * EMOJI_POOL.length)];
    }
    return [a, b];
}

// Clash of Glory times are same-day-recurring slots, not far-future dates -- resolve
// "06:00" to the next UTC instant matching that clock time. If it's already passed
// today (or is exactly now), roll to tomorrow. Evaluated independently per call: the
// caller is responsible for calling this once per time option, so the two options in
// a poll are never assumed to land on the same calendar date.
function nextOccurrenceUtc(hhmm, fromDate = new Date()) {
    const [hh, mm] = hhmm.split(':').map(Number);
    const candidate = new Date(Date.UTC(
        fromDate.getUTCFullYear(), fromDate.getUTCMonth(), fromDate.getUTCDate(), hh, mm, 0, 0
    ));
    if (candidate <= fromDate) {
        candidate.setUTCDate(candidate.getUTCDate() + 1);
    }
    return candidate;
}

module.exports = { pickPollEmoji, nextOccurrenceUtc, EMOJI_POOL };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test utils/glorycta.test.js`
Expected: PASS (all 9 tests)

- [ ] **Step 5: Commit**

```bash
git add utils/glorycta.js utils/glorycta.test.js
git commit -m "feat(glorycta): add emoji pool + UTC time-rollover helpers"
```

---

### Task 2: `glorycta_polls` table + DB accessors

**Files:**
- Modify: `utils/db.js`

**Interfaces:**
- Consumes: nothing new (uses the existing `db` connection already open in this file).
- Produces: `createGloryctaPoll({ jobId, messageId, channelId, emojiA, emojiB, labelA, labelB, fireAtA, fireAtB })` → inserts a row, returns nothing (mirrors `insertRelayMessage`'s void-return style is NOT followed here — follow `createTransferApproval`'s pattern instead, which returns the created row via a re-SELECT). `getGloryctaPollByMessageId(messageId)` → row or `undefined` (mirrors `getRelayChannelByChannelId`). `deleteGloryctaPoll(id)` → void (mirrors `removeRelayChannel`).

- [ ] **Step 1: Add the CREATE TABLE statement**

In `utils/db.js`, inside the existing `db.exec(\`...\`)` block (the one starting at line 26 / containing `guilds`/`warbands`), find the closing backtick of the **second** `db.exec` block — the large one that starts with `CREATE TABLE IF NOT EXISTS birthdays` (around line 74) and ends just before `translation_usage` (around line 367). Add this new table definition immediately after the `translation_usage` table's closing `);` and before the final closing backtick of that block:

```sql
  -- One row per open /glorycta poll, looked up by message_id from the
  -- messageReactionAdd guard on every reaction add (so this needs to stay a fast,
  -- indexed lookup -- UNIQUE gives that for free). Deleted once the tally job fires
  -- and completes; no historical poll archive is kept, matching this feature's
  -- disposable one-shot nature (nothing downstream queries past polls).
  CREATE TABLE IF NOT EXISTS glorycta_polls (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id     INTEGER NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL UNIQUE,
    channel_id TEXT NOT NULL,
    emoji_a    TEXT NOT NULL,
    emoji_b    TEXT NOT NULL,
    label_a    TEXT NOT NULL,
    label_b    TEXT NOT NULL,
    fire_at_a  TEXT NOT NULL,
    fire_at_b  TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
```

- [ ] **Step 2: Add the accessor functions**

In `utils/db.js`, immediately after the `deleteRelayMessagesByGroupId` function definition (around line 657, right before `module.exports = db;`), add:

```js
function createGloryctaPoll({ jobId, messageId, channelId, emojiA, emojiB, labelA, labelB, fireAtA, fireAtB }) {
    db.prepare(`INSERT INTO glorycta_polls
        (job_id, message_id, channel_id, emoji_a, emoji_b, label_a, label_b, fire_at_a, fire_at_b)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(jobId, messageId, channelId, emojiA, emojiB, labelA, labelB, fireAtA, fireAtB);
    return db.prepare('SELECT * FROM glorycta_polls WHERE message_id = ?').get(messageId);
}

function getGloryctaPollByMessageId(messageId) {
    return db.prepare('SELECT * FROM glorycta_polls WHERE message_id = ?').get(messageId);
}

function deleteGloryctaPoll(id) {
    db.prepare('DELETE FROM glorycta_polls WHERE id = ?').run(id);
}
```

- [ ] **Step 3: Export the new functions**

In `utils/db.js`, in the `module.exports.X = X` block at the bottom of the file, add after `module.exports.deleteRelayMessagesByGroupId = deleteRelayMessagesByGroupId;`:

```js
module.exports.createGloryctaPoll = createGloryctaPoll;
module.exports.getGloryctaPollByMessageId = getGloryctaPollByMessageId;
module.exports.deleteGloryctaPoll = deleteGloryctaPoll;
```

- [ ] **Step 4: Verify the table is created on load**

Run: `node -e "require('dotenv').config(); const db = require('./utils/db'); console.log(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='glorycta_polls'\").get());"`
Expected: prints `{ name: 'glorycta_polls' }` — confirms the CREATE ran without a syntax error and the table now exists in whichever DB `GUILD_DB_PATH`/the default path points to. **Run this from a shell where `node --version` reports v21.7.1** (see [[gotcha-pm2-daemon-stale-node-path]] equivalent note: better-sqlite3's native binary is version-locked) — if it doesn't, open a fresh terminal first.

- [ ] **Step 5: Commit**

```bash
git add utils/db.js
git commit -m "feat(glorycta): add glorycta_polls table + accessors"
```

---

### Task 3: `/glorycta` slash command

**Files:**
- Create: `slash-commands/glorycta.js`

**Interfaces:**
- Consumes: `pickPollEmoji`, `nextOccurrenceUtc` from `./utils/glorycta` (Task 1); `createGloryctaPoll` from `../utils/db` (Task 2); `enforcePermissions` from `../utils/permissions`; `pickColor` from `../utils/colors`.
- Produces: the `glorycta` command module (`{ data, execute }`), auto-loaded by `index.js`'s existing `slash-commands/*.js` directory scan — no changes to `index.js` needed for command registration itself.

- [ ] **Step 1: Write the command file**

```js
// slash-commands/glorycta.js
const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const db = require('../utils/db');
const { pickColor } = require('../utils/colors');
const { enforcePermissions } = require('../utils/permissions');
const { pickPollEmoji, nextOccurrenceUtc } = require('../utils/glorycta');

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('glorycta')
        .setDescription('Post a Clash of Glory battle-time vote')
        .addStringOption(opt =>
            opt.setName('time1')
                .setDescription('First UTC time option, HH:MM (e.g. 06:00)')
                .setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName('time2')
                .setDescription('Second UTC time option, HH:MM (e.g. 20:00)')
                .setRequired(true)
        )
        .addIntegerOption(opt =>
            opt.setName('duration')
                .setDescription('How many hours the vote stays open')
                .setRequired(true)
                .setMinValue(1)
        ),

    async execute(interaction) {
        if (!(await enforcePermissions(interaction, 'glorycta'))) return;

        const time1 = interaction.options.getString('time1');
        const time2 = interaction.options.getString('time2');
        const duration = interaction.options.getInteger('duration');

        if (!TIME_RE.test(time1) || !TIME_RE.test(time2)) {
            return interaction.reply({
                content: '❌ Times must be in 24-hour UTC `HH:MM` format, e.g. `06:00` or `20:00`.',
                flags: MessageFlags.Ephemeral,
            });
        }

        const now = new Date();
        const fireAtA = nextOccurrenceUtc(time1, now);
        const fireAtB = nextOccurrenceUtc(time2, now);
        const [emojiA, emojiB] = pickPollEmoji();

        const tsA = Math.floor(fireAtA.getTime() / 1000);
        const tsB = Math.floor(fireAtB.getTime() / 1000);

        const embed = new EmbedBuilder()
            .setColor(pickColor())
            .setTitle('⚔️ Clash of Glory · Call to Arms')
            .setDescription(
                'The horns sound, RiffRaff! Clash of Glory draws near, and the guild ' +
                'must stand united at a single hour. Two banners are raised below — ' +
                'react with the matching emoji to pledge your hour of battle. Vote for ' +
                'one, or both if either hour serves you. The call closes in ' +
                `**${duration} hour${duration === 1 ? '' : 's'}** — choose your glory.`
            )
            .addFields(
                { name: `${emojiA} Option A`, value: `Local: <t:${tsA}:t>\nUTC: ${time1}`, inline: true },
                { name: `${emojiB} Option B`, value: `Local: <t:${tsB}:t>\nUTC: ${time2}`, inline: true },
            );

        const message = await interaction.channel.send({ embeds: [embed] });
        await message.react(emojiA);
        await message.react(emojiB);
        await message.pin();

        const nowIso = now.toISOString();
        const tallyFireAt = new Date(now.getTime() + duration * 60 * 60 * 1000).toISOString();
        const jobResult = db.prepare(
            'INSERT INTO scheduled_jobs (type, fire_at, created_at) VALUES (?, ?, ?)'
        ).run('glorycta_tally', tallyFireAt, nowIso);

        db.createGloryctaPoll({
            jobId: jobResult.lastInsertRowid,
            messageId: message.id,
            channelId: message.channelId,
            emojiA, emojiB,
            labelA: time1, labelB: time2,
            fireAtA: fireAtA.toISOString(),
            fireAtB: fireAtB.toISOString(),
        });

        await interaction.reply({
            content: `⚔️ Call to arms posted. Vote closes in ${duration} hour${duration === 1 ? '' : 's'}.`,
            flags: MessageFlags.Ephemeral,
        });
    },
};
```

- [ ] **Step 2: Manual smoke test on meerbot-test**

Per [[project_test-bot-worktree]], this command needs a live Discord round-trip (embed rendering, pin, reactions) that can't be meaningfully unit-tested. In the `DiscordBotAfkJ-test` worktree: copy `slash-commands/glorycta.js` and `utils/glorycta.js` over (or merge this task's commit into the `test-bot` branch), run `pm2 restart meerbot-test`, then in the test Discord server run `/glorycta time1:06:00 time2:20:00 duration:1`. Confirm: the poll posts, is pinned, has exactly two reactions with two different emoji, and the embed shows both a `Local:` line (rendered in your own timezone) and a `UTC:` line matching what you typed.

- [ ] **Step 3: Commit**

```bash
git add slash-commands/glorycta.js
git commit -m "feat(glorycta): add /glorycta slash command"
```

---

### Task 4: Reaction enforcement guard

**Files:**
- Create: `utils/handlers/gloryctaReactionGuard.js`
- Modify: `index.js`

**Interfaces:**
- Consumes: `getGloryctaPollByMessageId` from `../utils/db` (Task 2).
- Produces: `handleGloryctaReactionGuard(reaction, user, client)` — async function, called from `index.js`'s `messageReactionAdd` listener.

- [ ] **Step 1: Write the handler**

```js
// utils/handlers/gloryctaReactionGuard.js
const db = require('../db');

// Enforces that only a glorycta poll's own two emoji can be reacted onto its message.
// Any other emoji is removed immediately and silently -- no DM, no channel message.
// Untracked messages (not an open glorycta poll, or the poll already closed) are a
// no-op: fail safe, never act on a message this handler can't positively identify.
async function handleGloryctaReactionGuard(reaction, user, client) {
    if (user.bot) return;

    if (reaction.partial) {
        try {
            await reaction.fetch();
        } catch (err) {
            console.error('[Glorycta] Failed to fetch partial reaction:', err.message);
            return;
        }
    }

    const poll = db.getGloryctaPollByMessageId(reaction.message.id);
    if (!poll) return;

    const emojiName = reaction.emoji.name;
    if (emojiName === poll.emoji_a || emojiName === poll.emoji_b) return;

    try {
        await reaction.users.remove(user.id);
    } catch (err) {
        console.error(`[Glorycta] Failed to remove invalid reaction from ${user.tag}:`, err.message);
    }
}

module.exports = { handleGloryctaReactionGuard };
```

- [ ] **Step 2: Wire it into `index.js`**

In `index.js`, add the import alongside the other handler imports (near line 10, after the `translationRelayHandler` require):

```js
const { handleGloryctaReactionGuard } = require('./utils/handlers/gloryctaReactionGuard');
```

Then extend the existing `messageReactionAdd` listener (around line 67) to also call the new guard. Change:

```js
client.on('messageReactionAdd', (reaction, user) => {
  handleTranslationReactionSync(reaction, user, client, true).catch(err => console.error('[TranslationRelay] Reaction sync (add) unhandled error:', err));
});
```

to:

```js
client.on('messageReactionAdd', (reaction, user) => {
  handleTranslationReactionSync(reaction, user, client, true).catch(err => console.error('[TranslationRelay] Reaction sync (add) unhandled error:', err));
  handleGloryctaReactionGuard(reaction, user, client).catch(err => console.error('[Glorycta] Reaction guard unhandled error:', err));
});
```

(The existing `GatewayIntentBits.GuildMessageReactions` intent and `Partials.Reaction` partial, both already enabled for translation relay's reaction sync, cover this handler too — no intent changes needed.)

- [ ] **Step 3: Manual smoke test on meerbot-test**

Using the poll created in Task 3's smoke test (or a fresh one), react to it with a third, unrelated emoji. Confirm the reaction disappears within a couple seconds and no DM or channel message appears. Then react with each of the poll's two valid emoji and confirm both persist normally.

- [ ] **Step 4: Commit**

```bash
git add utils/handlers/gloryctaReactionGuard.js index.js
git commit -m "feat(glorycta): enforce poll-only reactions via messageReactionAdd guard"
```

---

### Task 5: Tally job handler

**Files:**
- Modify: `utils/jobScheduler.js`

**Interfaces:**
- Consumes: `getGloryctaPollByMessageId`, `deleteGloryctaPoll` from `./db` (Task 2, already imported as `db` in this file); `pickColor` from `./colors` (already imported).
- Produces: `handleGloryctaTally(client, job)` — wired into `tick()`'s dispatch for `job.type === 'glorycta_tally'`.

- [ ] **Step 1: Add the handler function**

In `utils/jobScheduler.js`, immediately after the existing `handleRecruitmentFollowup` function (ends around line 174, right before `handleTextJob` starts), add:

```js
async function handleGloryctaTally(client, job) {
    const poll = db.prepare('SELECT * FROM glorycta_polls WHERE job_id = ?').get(job.id);
    if (!poll) {
        console.error(`[Glorycta] No poll row found for tally job ${job.id}`);
        return;
    }

    try {
        const channel = await client.channels.fetch(poll.channel_id);
        const message = await channel.messages.fetch(poll.message_id);

        const reactionA = message.reactions.cache.get(poll.emoji_a);
        const reactionB = message.reactions.cache.get(poll.emoji_b);
        const usersA = reactionA ? [...(await reactionA.users.fetch()).values()].filter(u => !u.bot) : [];
        const usersB = reactionB ? [...(await reactionB.users.fetch()).values()].filter(u => !u.bot) : [];

        const resolve = discordUser => {
            const member = db.prepare('SELECT ingame_name FROM members WHERE discord_id = ?').get(discordUser.id);
            return member ? `${discordUser.tag} (${member.ingame_name})` : discordUser.tag;
        };

        const linesA = usersA.length ? usersA.map(resolve).map(s => `· ${s}`).join('\n') : '*No votes*';
        const linesB = usersB.length ? usersB.map(resolve).map(s => `· ${s}`).join('\n') : '*No votes*';

        const embed = new EmbedBuilder()
            .setColor(pickColor())
            .setTitle('⚔️ Clash of Glory · Vote Results')
            .addFields(
                { name: `${poll.emoji_a} UTC ${poll.label_a} (${usersA.length})`, value: linesA.slice(0, 1024), inline: true },
                { name: `${poll.emoji_b} UTC ${poll.label_b} (${usersB.length})`, value: linesB.slice(0, 1024), inline: true },
            );

        await channel.send({ embeds: [embed] });
        await message.unpin().catch(err => console.error('[Glorycta] Failed to unpin poll message:', err.message));
    } catch (err) {
        console.error(`[Glorycta] Tally failed for poll ${poll.id} (message ${poll.message_id}):`, err.message);
    } finally {
        db.deleteGloryctaPoll(poll.id);
        logJobRun(`glorycta_${job.id}`);
    }
}
```

- [ ] **Step 2: Wire it into `tick()`'s dispatch**

In `utils/jobScheduler.js`, in the `tick()` function's `for (const job of due)` loop, add a new branch after the existing `else if (job.type === 'recruitment_followup')` block (around line 258):

```js
            } else if (job.type === 'glorycta_tally') {
                await handleGloryctaTally(client, job);
                db.prepare('DELETE FROM scheduled_jobs WHERE id = ?').run(job.id);
```

(Matches the existing `remindme`/`recruitment_followup` one-shot pattern: handle, then delete the `scheduled_jobs` row so it never fires again. `handleGloryctaTally` deletes its own `glorycta_polls` row internally via its `finally` block, same separation of concerns as `handleRecruitmentFollowup` not touching `scheduled_jobs` itself.)

- [ ] **Step 3: Manual smoke test on meerbot-test**

Create a `/glorycta ... duration:1` poll (1 hour is the minimum allowed by `setMinValue(1)` — for a faster manual test, temporarily edit the DB row's `fire_at` on `scheduled_jobs` down to a couple minutes out via a direct SQL update, then restore/delete after testing). Vote with 2+ test accounts (or one account voting both emoji). Wait for the job to fire (30s poll interval). Confirm: a tally message posts in the same channel listing both options with correct vote lists (Discord tag + in-game name where linked), and the original poll message becomes unpinned.

- [ ] **Step 4: Commit**

```bash
git add utils/jobScheduler.js
git commit -m "feat(glorycta): add tally job handler, wire into scheduler tick"
```

---

## Self-Review Notes

- **Spec coverage:** command shape ✓ (Task 3), emoji randomization + flag/skin-tone exclusion ✓ (Task 1), poll embed with Local/UTC fields ✓ (Task 3), call-to-arms copy ✓ (Task 3), silent-removal enforcement ✓ (Task 4), one-shot tally job pattern ✓ (Task 5), both-emoji-counts-in-both-columns tally ✓ (Task 5), unlinked-voter fallback to Discord tag ✓ (Task 5), auto-unpin on close ✓ (Task 5), `glorycta_polls` data model ✓ (Task 2), independent per-option date rollover ✓ (Task 1, tested explicitly).
- **Correction from the original spec doc:** the spec's Error Handling section mentioned adding a new `OPERATIONS` registry entry for `/glorycta` — this was based on conflating the admin-panel's `OPERATIONS`/Access-tab system (which only governs *admin-panel* mutations) with slash-command permissions (`command_permissions`, gated via `enforcePermissions`, auto-discovered by the Permissions tab's `/api/commands` endpoint scanning `slash-commands/*.js`). No `OPERATIONS` change is needed or included in this plan; `/glorycta` will appear in the Permissions tab automatically once `slash-commands/glorycta.js` exists.
- **Type/signature consistency:** `nextOccurrenceUtc(hhmm, fromDate)` used identically in Task 1's tests, Task 3's command, and implicitly relied on (not re-called) by Task 5's tally, which only reads the already-stored `fire_at_a`/`fire_at_b` off the `glorycta_polls` row rather than recomputing — no drift risk there. `getGloryctaPollByMessageId`/`deleteGloryctaPoll`/`createGloryctaPoll` signatures match between Task 2's definition and Tasks 3/4/5's usage.
- **Scope check:** single feature, five tightly-scoped tasks, each independently testable and committable. No decomposition into separate plans needed.
