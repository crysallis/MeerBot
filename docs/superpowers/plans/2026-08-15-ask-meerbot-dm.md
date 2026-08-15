# Ask MeerBot (DM Q&A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Members DM MeerBot plain-language questions ("how do I do the cta", "can I run /season here") and get an answer grounded in the bot's real command list and docs, personalized to what that specific member can/can't do.

**Architecture:** A new `messageCreate` handler, `utils/handlers/askHandler.js`, fires only on DMs from real (non-bot) users. It resolves the asker's guild roles, builds a personalized capability summary from `command_permissions`, assembles a system prompt from `help.js`'s command list + `README.md` + `ARCHITECTURE.md`, and makes one Claude Haiku call (same `@anthropic-ai/sdk` client pattern as `translationRelayHandler.js`). A small in-memory per-user rate limiter (10/hour) gates the Claude call.

**Tech Stack:** discord.js v14 (`messageCreate`, DM detection via `message.guild === null`), `@anthropic-ai/sdk` (already a dependency), better-sqlite3 (`command_permissions` reads via existing `db.js`).

## Global Constraints

- Model: `claude-haiku-4-5` (matches `translationRelayHandler.js` — do not use a different model).
- Rate limit: 10 questions per hour, per Discord user ID, in-memory sliding window.
- Knowledge sources in the system prompt: `help.js`'s command list, full `README.md`, full `ARCHITECTURE.md`. **`CLAUDE.md` must never be read or included** — this is a hard requirement from the approved design (`docs/superpowers/specs/2026-08-15-ask-meerbot-dm-design.md`), not a stylistic default.
- The handler must never call `enforcePermissions` (that gates command execution, not this feature) — it only *reads* `command_permissions` rows to describe what's true, via the shared `pickRows` precedence helper.
- DM-only trigger: no @mention handling, no slash command. `message.guild === null` is the DM check (discord.js sets `guild` to `null` for DM channel messages).
- Must not respond to bot messages (loop guard, same convention as `translationRelayHandler.js`'s `message.author.bot` check).
- On any Claude API failure, reply with a static fallback pointing to `/help` — never leave the DM unanswered and never let the error propagate unhandled (this handler is invoked fire-and-forget from `messageCreate`, same as the existing handlers there).

---

### Task 1: Export `COMMANDS` from help.js and `pickRows` from permissions.js

**Files:**
- Modify: `slash-commands/help.js`
- Modify: `utils/permissions.js`
- Test: `utils/handlers/askHandler.test.js` (created in this task, extended in Task 3)

**Interfaces:**
- Produces: `slash-commands/help.js` exports `COMMANDS` (the existing object, unchanged in shape) in addition to its current `{ autocomplete, data, execute }`.
- Produces: `utils/permissions.js` exports `pickRows` (the existing function, unchanged) in addition to its current `{ PERMS, getPerm, enforce, enforcePermissions }`.

Both objects/functions already exist and are fully built — this task only adds them to each file's `module.exports`. No behavior change to either file's existing exports.

- [ ] **Step 1: Add `COMMANDS` to help.js's exports**

In `slash-commands/help.js`, change the `module.exports` block (currently ends the file) from:

```js
module.exports = {
    async autocomplete(interaction) {
```

to:

```js
module.exports = {
    COMMANDS,
    async autocomplete(interaction) {
```

(`COMMANDS` is already defined at the top of the file via `const COMMANDS = { ... }` — this just adds the existing binding to the exports object literal.)

- [ ] **Step 2: Add `pickRows` to permissions.js's exports**

In `utils/permissions.js`, change:

```js
module.exports = { PERMS, getPerm, enforce, enforcePermissions };
```

to:

```js
module.exports = { PERMS, getPerm, enforce, enforcePermissions, pickRows };
```

- [ ] **Step 3: Write a smoke test confirming both exports**

Create `utils/handlers/askHandler.test.js`:

```js
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');

test('help.js exports COMMANDS with expected shape', () => {
    const { COMMANDS } = require('../../slash-commands/help.js');
    assert.equal(typeof COMMANDS, 'object');
    assert.ok(COMMANDS.glory, 'expected a glory entry in COMMANDS');
    assert.equal(typeof COMMANDS.glory.description, 'string');
    assert.ok(Array.isArray(COMMANDS.glory.subcommands));
});

test('permissions.js exports pickRows', () => {
    const { pickRows } = require('../permissions');
    assert.equal(typeof pickRows, 'function');
    const rows = [{ subcommand: 'power', value_id: 'a' }, { subcommand: null, value_id: 'b' }];
    assert.deepEqual(pickRows(rows, 'power'), [{ subcommand: 'power', value_id: 'a' }]);
    assert.deepEqual(pickRows(rows, 'top'), [{ subcommand: null, value_id: 'b' }]);
});
```

- [ ] **Step 4: Run the test**

Run: `node --test utils/handlers/askHandler.test.js`
Expected: 2 passing tests.

- [ ] **Step 5: Commit**

```bash
git add slash-commands/help.js utils/permissions.js utils/handlers/askHandler.test.js
git commit -m "feat: export COMMANDS and pickRows for reuse by the ask handler"
```

---

### Task 2: Capability summary builder

**Files:**
- Create: `utils/handlers/askCapabilities.js`
- Test: `utils/handlers/askCapabilities.test.js`

**Interfaces:**
- Consumes: `slash-commands/help.js`'s `COMMANDS` (Task 1), `utils/permissions.js`'s `pickRows` and `getPerm` (Task 1 + existing export), `utils/db.js`'s `db.prepare` (existing, already used by `permissions.js` the same way).
- Produces: `buildCapabilitySummary(member)` — `member` is a discord.js `GuildMember` (has `.roles.cache`, a `Collection` of role IDs → Role objects, and `.permissions` for the `admin` check). Returns a plain multi-line string describing, per command, whether this member can run it and where. Used by Task 3's system-prompt assembly.

This is pure logic (no Discord API calls beyond reading properties already on the passed-in `member` object, no network I/O) — keep it in its own file so it's testable without mocking Discord's gateway.

- [ ] **Step 1: Write the failing test**

Create `utils/handlers/askCapabilities.test.js`:

```js
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { buildCapabilitySummary } = require('./askCapabilities');

const CMD = 'test_ask_cmd';

function insertRule({ subcommand = null, type, valueId }) {
    db.prepare(`INSERT INTO command_permissions (command, subcommand, type, value_id)
        VALUES (?, ?, ?, ?)`).run(CMD, subcommand, type, valueId);
}
function clearRules() {
    db.prepare('DELETE FROM command_permissions WHERE command = ?').run(CMD);
}
test.afterEach(() => clearRules());

function fakeMember({ roleIds = [], isAdmin = false } = {}) {
    return {
        roles: { cache: new Map(roleIds.map(id => [id, { id }])) },
        permissions: { has: () => isAdmin },
    };
}

test('buildCapabilitySummary notes a command-wide role restriction the member does not have', () => {
    insertRule({ subcommand: null, type: 'role', valueId: 'role-riff' });
    const summary = buildCapabilitySummary(fakeMember({ roleIds: [] }), { [CMD]: { description: 'Test command', subcommands: [{ name: `/${CMD}`, desc: 'does a thing' }] } });
    assert.match(summary, new RegExp(`${CMD}[\\s\\S]*(cannot|can't|no)`, 'i'));
});

test('buildCapabilitySummary notes a command-wide role restriction the member DOES have', () => {
    insertRule({ subcommand: null, type: 'role', valueId: 'role-riff' });
    const summary = buildCapabilitySummary(fakeMember({ roleIds: ['role-riff'] }), { [CMD]: { description: 'Test command', subcommands: [{ name: `/${CMD}`, desc: 'does a thing' }] } });
    assert.match(summary, new RegExp(`${CMD}[\\s\\S]*(can|yes)`, 'i'));
});

test('buildCapabilitySummary lists allowed channels for a channel-restricted command', () => {
    insertRule({ subcommand: null, type: 'channel', valueId: 'chan-leader' });
    const summary = buildCapabilitySummary(fakeMember({ roleIds: [] }), { [CMD]: { description: 'Test command', subcommands: [{ name: `/${CMD}`, desc: 'does a thing' }] } });
    assert.match(summary, /chan-leader/);
});

test('buildCapabilitySummary marks an unrestricted command as usable everywhere', () => {
    const summary = buildCapabilitySummary(fakeMember({ roleIds: [] }), { [CMD]: { description: 'Test command', subcommands: [{ name: `/${CMD}`, desc: 'does a thing' }] } });
    assert.match(summary, new RegExp(`${CMD}[\\s\\S]*(can|yes)`, 'i'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test utils/handlers/askCapabilities.test.js`
Expected: FAIL — `Cannot find module './askCapabilities'`

- [ ] **Step 3: Write the implementation**

Create `utils/handlers/askCapabilities.js`:

```js
const db = require('../db');
const { pickRows } = require('../permissions');

// Per command, describe whether this member can run it and (if restricted)
// where. Read-only against command_permissions — mirrors the precedence
// enforcePermissions itself uses (pickRows: specific-if-any-else-general,
// decided independently per type) but never calls enforcePermissions, since
// this is describing capability, not gating execution.
function describeCommand(command, memberRoleIds) {
    const allRoleRows = db.prepare(
        `SELECT subcommand, value_id FROM command_permissions WHERE command = ? AND type = 'role'`
    ).all(command);
    const allChannelRows = db.prepare(
        `SELECT subcommand, value_id FROM command_permissions WHERE command = ? AND type = 'channel'`
    ).all(command);

    const roleRows = pickRows(allRoleRows, null);
    const channelRows = pickRows(allChannelRows, null);

    const lines = [];

    if (roleRows.length === 0) {
        lines.push('no role restriction');
    } else {
        const hasRole = roleRows.some(r => memberRoleIds.has(r.value_id));
        lines.push(hasRole
            ? 'you CAN use this (you hold a required role)'
            : "you CANNOT use this (requires a role you don't have)");
    }

    if (channelRows.length > 0) {
        lines.push(`only usable in these channel IDs: ${channelRows.map(r => r.value_id).join(', ')}`);
    } else {
        lines.push('usable in any channel');
    }

    return lines.join('; ');
}

function buildCapabilitySummary(member, commands) {
    const memberRoleIds = new Set(member.roles.cache.keys());
    const out = [];
    for (const [name, info] of Object.entries(commands)) {
        out.push(`/${name}: ${describeCommand(name, memberRoleIds)}`);
    }
    return out.join('\n');
}

module.exports = { buildCapabilitySummary };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test utils/handlers/askCapabilities.test.js`
Expected: 4 passing tests.

- [ ] **Step 5: Commit**

```bash
git add utils/handlers/askCapabilities.js utils/handlers/askCapabilities.test.js
git commit -m "feat: build per-member command capability summary for ask handler"
```

---

### Task 3: System prompt assembly + Claude call + rate limiter

**Files:**
- Create: `utils/handlers/askHandler.js`
- Modify: `utils/handlers/askHandler.test.js` (from Task 1 — add tests here)

**Interfaces:**
- Consumes: `slash-commands/help.js`'s `COMMANDS` (Task 1), `utils/handlers/askCapabilities.js`'s `buildCapabilitySummary` (Task 2), `@anthropic-ai/sdk` (existing dependency).
- Produces: `handleAsk(message, client)` — async function, takes a discord.js `Message` and the `Client`. Called from `index.js`'s `messageCreate` listener (wired in Task 4). Returns nothing meaningful; all Discord side effects (the reply) happen inside.
- Produces: `isRateLimited(userId)` (exported for testing) — pure function over an in-memory `Map`.

This task owns reading `README.md`/`ARCHITECTURE.md` from disk once at module load (not per-message — they're static files, no reason to hit the filesystem on every DM), assembling the system prompt, checking the rate limit, and making the Claude call.

- [ ] **Step 1: Write the failing tests**

Add to `utils/handlers/askHandler.test.js` (append after the Task 1 tests):

```js
const { isRateLimited } = require('./askHandler');

test('isRateLimited allows the first 10 questions in an hour then blocks the 11th', () => {
    const userId = `test-user-${Date.now()}`;
    for (let i = 0; i < 10; i++) {
        assert.equal(isRateLimited(userId), false, `question ${i + 1} should be allowed`);
    }
    assert.equal(isRateLimited(userId), true, 'the 11th question within the hour should be blocked');
});

test('isRateLimited tracks separate users independently', () => {
    const userA = `test-user-a-${Date.now()}`;
    const userB = `test-user-b-${Date.now()}`;
    for (let i = 0; i < 10; i++) isRateLimited(userA);
    assert.equal(isRateLimited(userA), true, 'userA should now be blocked');
    assert.equal(isRateLimited(userB), false, 'userB should be unaffected by userA\'s usage');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test utils/handlers/askHandler.test.js`
Expected: FAIL — `isRateLimited` is not exported (module doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `utils/handlers/askHandler.js`:

```js
const fs = require('fs');
const path = require('path');
const { MessageFlags } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');
const { COMMANDS } = require('../../slash-commands/help.js');
const { buildCapabilitySummary } = require('./askCapabilities');

const anthropic = new Anthropic();

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const rateLimitLog = new Map(); // userId -> timestamp[]

const README = fs.readFileSync(path.join(__dirname, '..', '..', 'README.md'), 'utf8');
const ARCHITECTURE = fs.readFileSync(path.join(__dirname, '..', '..', 'ARCHITECTURE.md'), 'utf8');

const COMMANDS_TEXT = Object.entries(COMMANDS).map(([name, info]) => {
    const subs = info.subcommands.map(s => `  - ${s.name} — ${s.desc}`).join('\n');
    return `/${name} — ${info.description}\n${subs}`;
}).join('\n\n');

function isRateLimited(userId) {
    const now = Date.now();
    const timestamps = (rateLimitLog.get(userId) || []).filter(t => t > now - RATE_LIMIT_WINDOW_MS);
    if (timestamps.length >= RATE_LIMIT_MAX) {
        rateLimitLog.set(userId, timestamps);
        return true;
    }
    timestamps.push(now);
    rateLimitLog.set(userId, timestamps);
    return false;
}

async function handleAsk(message, client) {
    if (message.author.bot) return;
    if (message.guild !== null) return; // DM only

    if (isRateLimited(message.author.id)) {
        await message.reply("You've hit the limit of 10 questions per hour — try again later.").catch(() => {});
        return;
    }

    try {
        const guild = client.guilds.cache.get(process.env.GUILD_ID);
        const member = guild ? await guild.members.fetch(message.author.id).catch(() => null) : null;

        const capabilitySummary = member
            ? buildCapabilitySummary(member, COMMANDS)
            : 'Unable to determine this user\'s roles — answer generally, without personalized yes/no permission claims.';

        const system = [
            'You are MeerBot, a Discord bot for an AFK Journey guild called RiffRaff. A guild member has DMed you asking what you can do or how to do something.',
            'Answer ONLY using the command list, README, and capability summary below. Do not invent commands, features, or behavior not described in this context.',
            'Give the exact slash command syntax when relevant (e.g. `/glory cta time1: time2: duration:`).',
            'The capability summary below reflects THIS SPECIFIC user\'s real permissions — use it to give a direct yes/no answer when they ask if they can do something, including which channel if restricted.',
            'Keep answers short and conversational, a few sentences at most unless they ask for a full list.',
            'If asked something unrelated to the bot or the guild, politely say you can only help with MeerBot questions.',
            '--- COMMAND LIST ---',
            COMMANDS_TEXT,
            '--- README ---',
            README,
            '--- ARCHITECTURE (internal detail — only surface what\'s relevant to the question) ---',
            ARCHITECTURE,
            '--- THIS USER\'S CAPABILITIES ---',
            capabilitySummary,
        ].join('\n\n');

        const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5',
            max_tokens: 1024,
            system,
            messages: [{ role: 'user', content: message.content }],
        });

        const text = response.content?.[0]?.text?.trim();
        await message.reply(text || "I couldn't come up with an answer to that — try `/help` for the full command list.");
    } catch (err) {
        console.error('[AskHandler] Failed to answer DM question:', err);
        await message.reply("Something went wrong answering that — try `/help` for the full command list.").catch(() => {});
    }
}

module.exports = { handleAsk, isRateLimited };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test utils/handlers/askHandler.test.js`
Expected: all tests passing (2 from Task 1 + 2 new).

- [ ] **Step 5: Commit**

```bash
git add utils/handlers/askHandler.js utils/handlers/askHandler.test.js
git commit -m "feat: add DM Q&A handler grounded in help.js/README/ARCHITECTURE"
```

---

### Task 4: Wire into index.js

**Files:**
- Modify: `index.js`

**Interfaces:**
- Consumes: `utils/handlers/askHandler.js`'s `handleAsk` (Task 3).

- [ ] **Step 1: Add the require**

In `index.js`, add alongside the other handler requires (after the `gloryctaCancelButtonHandler` require, before `const { rateLimit } = require('./config');`):

```js
const { handleAsk } = require('./utils/handlers/askHandler');
```

- [ ] **Step 2: Wire into the messageCreate listener**

Change:

```js
client.on('messageCreate', message => {
  handleMessage(message, client);
  handlePromoCode(message);
  handleTranslationRelay(message, client).catch(err => console.error('[TranslationRelay] Unhandled error:', err));
});
```

to:

```js
client.on('messageCreate', message => {
  handleMessage(message, client);
  handlePromoCode(message);
  handleTranslationRelay(message, client).catch(err => console.error('[TranslationRelay] Unhandled error:', err));
  handleAsk(message, client).catch(err => console.error('[AskHandler] Unhandled error:', err));
});
```

- [ ] **Step 3: Manual smoke test**

This can't be unit-tested (needs a live Discord DM). Start the bot locally or ask Daniel to DM the real bot after deploy, and confirm:
- A DM like "how do I vote on clash of glory times" gets a relevant answer mentioning `/glory cta`.
- A DM like "can I run /season" gets a yes/no answer (not a generic "I don't know").
- Sending 11 questions within an hour gets the rate-limit message on the 11th.

Do not mark this task complete until this manual check has actually been run once against a real DM.

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat: wire ask handler into messageCreate dispatch"
```

---

### Task 5: Docs sync

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `CLAUDE.md`

Per the project's own standing convention (`feedback-docs-sync-on-commit.md`), every behavior-changing feature updates all three. Keep each addition proportional — this is one new handler, not a new subsystem.

- [ ] **Step 1: Add a README mention**

Add a short paragraph near the top-level feature list (find the section listing what the bot does — mirror the existing tone) noting: DM the bot directly with a question like "how do I vote on Clash of Glory times" for a personalized answer about what you can do.

- [ ] **Step 2: Add an ARCHITECTURE entry**

Add a new subsection (mirror the style of the existing `glory.js` / `gloryctaReactionGuard.js` section) describing `askHandler.js` + `askCapabilities.js`: DM-triggered, Claude Haiku call grounded in `help.js` + README + ARCHITECTURE (never CLAUDE.md), personalized capability summary built by reading `command_permissions` directly (not via `enforcePermissions`), 10/hour per-user rate limit.

- [ ] **Step 3: Update CLAUDE.md**

Add two rows to the Key Files table:
- `utils/handlers/askHandler.js` — DM Q&A handler, assembles system prompt from help.js COMMANDS + README + ARCHITECTURE (never CLAUDE.md — see design doc), personalized capability summary, one Claude Haiku call per DM, 10/hour/user rate limit
- `utils/handlers/askCapabilities.js` — pure helper, builds per-member "what can you run and where" summary from `command_permissions` (read-only, same precedence as `enforcePermissions` via shared `pickRows`)

- [ ] **Step 4: Commit**

```bash
git add README.md ARCHITECTURE.md CLAUDE.md
git commit -m "docs: sync README/ARCHITECTURE/CLAUDE.md for Ask MeerBot DM handler"
```
