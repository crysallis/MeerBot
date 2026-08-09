# Translation Relay Batching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the message-batching design described in
`docs/superpowers/specs/2026-08-09-translation-relay-batching-design.md` on top of the shipped
translation relay feature (`utils/handlers/translationRelayHandler.js`), and fix two pre-existing
admin-UI bugs on the Translation Relay tab discovered while planning this work.

**Architecture:** A per-relay-group in-memory batch (`openBatches` Map) accumulates consecutive
same-author messages. A different author's message, or any reply, force-flushes the currently
open batch before starting its own. Every batch waits its full configurable timeout (admin-set,
capped at 15s) before flushing on its own if uninterrupted. A flush runs the existing
translate-and-post flow (`processTranslationRelay`, extended to accept multiple messages)
against the batch's accumulated lines. Translation responses become arrays (one string per
input line) instead of single strings, so line-count/order integrity is checkable rather than
assumed.

**Tech Stack:** Same as the shipped feature — discord.js v14, `@anthropic-ai/sdk`,
better-sqlite3, Express admin routes, vanilla JS admin frontend.

## Global Constraints

- A relay group has at most one open batch at a time. A message from a different author, or any
  reply message (regardless of author), flushes the currently open batch immediately before
  starting/joining a new one. A reply always starts its own fresh batch (never joins an existing
  one, even from the same author).
- Every batch — including a single-message batch nobody follows up — waits its full configured
  timeout before flushing, unless force-flushed early by an interrupting message. There is no
  "relay immediately if uninterrupted" fast path. This was explicitly confirmed with the user
  after an earlier draft of the design implied otherwise.
- **Race requirement:** a flush (whether triggered by the timeout firing or by an interrupting
  message's arrival) MUST synchronously clear the batch's entry from `openBatches` (or replace
  it, for the interrupt case) as the very first thing it does, before any `await`. If any `await`
  happens before the entry is cleared/replaced, a timer firing at the same moment as an
  interrupting message can both flush the same batch, producing duplicate relayed posts and
  duplicate DB rows.
- Both flush paths (timeout firing, new-message interrupt) must enqueue their work through the
  existing `enqueueRelay` per-relay-group Promise-chain queue in
  `utils/handlers/translationRelayHandler.js`, the same way a normal (non-batched) message does
  today — a timer-fired flush must not bypass that ordering queue.
- Claude's response shape for each target language becomes an array of strings (one per input
  line in the batch), not a single string. After parsing, validate
  `parsed[lang].length === batch.messages.length` for every target language; treat a mismatch
  (wrong count, or a non-array value) exactly like a parse failure — route to the existing
  untranslated-relay-plus-flag-emoji fallback, unchanged from v1.
- The batch timeout setting is a single value (not per-channel), stored via `utils/botConfig.js`'s
  `get`/`set` under a dedicated key (`translation_relay_batch_timeout_seconds`), NOT registered
  in `botConfig.js`'s `CONFIG_META` (that would surface it on the generic Commands/Config tab,
  which the user explicitly did not want — it must live only on the dedicated Translation Relay
  tab). Default 10 seconds if unset. Hard max 15 seconds, enforced both client-side (admin form)
  and server-side (the route that sets it).
- `translation_relay_messages`'s reply-quote lookup must read the new `last_line_text` column but
  **fall back to the existing `text` column when `last_line_text` is empty** — required so
  replies to the rows already live in `guild.test.db` (and any future rows) from before this
  change don't quote an empty string.
- Fix two pre-existing bugs on the Translation Relay admin tab while touching that file: (1) the
  description paragraph uses `var(--color-neutral-content)` for muted text — wrong, per this
  project's known convention (`neutral-content` is a background+foreground pair, not a standalone
  muted-text color) — replace with the `.muted-note` class. (2) The channel/language/flag `<input>`
  elements have no `type="text"` attribute, so this project's CSS (`input[type=text] { ... }`,
  an attribute selector) never matches them — they render with no border/background and are hard
  to recognize as fields. Add `type="text"` to both.

---

### Task 1: Admin UI fixes + new batch-timeout field

**Files:**
- Modify: `admin/src/index.html` (fix `.muted-note`, add `type="text"`, add timeout input)
- Modify: `admin/src/translationRelay.js` (load/save the timeout value)
- Modify: `admin/server.js` (new GET/PUT routes for the timeout setting)
- Modify: `admin/auth.js` (OPERATIONS entry for the new PUT route)

**Interfaces:**
- Produces (consumed by Task 3, which reads the same setting from the bot process side):
  `GET /api/translation-relay/batch-timeout` → `{ seconds: number }`,
  `PUT /api/translation-relay/batch-timeout` → body `{ seconds: number }`, validates `1-15`
  inclusive, 400 on out-of-range or non-integer.

This task is independent of Tasks 2-3 (pure admin-panel work, doesn't touch the message handler)
and can be done first since it has no dependency on the batching logic itself.

- [ ] **Step 1: Fix the two existing bugs in `admin/src/index.html`**

Find the Translation Relay section (search for `id="section-translationrelay"`). Change:

```html
<p style="color:var(--color-neutral-content); font-size:12px; margin-bottom:12px">
```
to:
```html
<p class="muted-note" style="margin-bottom:12px">
```

Change the three input elements from:
```html
<select id="newRelayChannel" style="max-width:280px"></select>
<input id="newRelayLanguage" placeholder="Language (e.g. Spanish)" style="max-width:180px">
<input id="newRelayFlag" placeholder="Flag emoji (e.g. 🇪🇸)" style="max-width:100px">
```
to:
```html
<select id="newRelayChannel" style="max-width:280px"></select>
<input type="text" id="newRelayLanguage" placeholder="Language (e.g. Spanish)" style="max-width:180px">
<input type="text" id="newRelayFlag" placeholder="Flag emoji (e.g. 🇪🇸)" style="max-width:100px">
```

- [ ] **Step 2: Add the batch-timeout field to `admin/src/index.html`**

In the same section, add a labeled numeric input near the top (above or alongside the "add
channel" row) — following this project's existing inline-labeled-input pattern (see the
Scheduled Jobs or Seasons tab for a comparable "single setting" input if one exists, otherwise
this simple form is fine):

```html
<div style="margin-bottom:16px; display:flex; align-items:center; gap:8px">
  <label for="relayBatchTimeout" style="font-size:13px">Batch window (seconds, 1-15):</label>
  <input type="number" id="relayBatchTimeout" min="1" max="15" step="1" style="max-width:80px">
  <button id="saveRelayBatchTimeoutBtn" class="save-btn">Save</button>
  <span id="relayBatchTimeoutStatus" class="muted-note"></span>
</div>
```

- [ ] **Step 3: Add the two routes to `admin/server.js`**

Add near the existing `/api/translation-relay` routes:

```javascript
const botConfig = require('../utils/botConfig'); // add this require near the top if not already present -- check first, admin/server.js likely already requires it for the Config tab

const RELAY_BATCH_TIMEOUT_KEY = 'translation_relay_batch_timeout_seconds';
const RELAY_BATCH_TIMEOUT_DEFAULT = 10;
const RELAY_BATCH_TIMEOUT_MAX = 15;

// GET /api/translation-relay/batch-timeout
app.get('/api/translation-relay/batch-timeout', (req, res) => {
    const raw = botConfig.get(RELAY_BATCH_TIMEOUT_KEY, String(RELAY_BATCH_TIMEOUT_DEFAULT));
    res.json({ seconds: parseInt(raw, 10) || RELAY_BATCH_TIMEOUT_DEFAULT });
});

// PUT /api/translation-relay/batch-timeout
app.put('/api/translation-relay/batch-timeout', (req, res) => {
    const seconds = parseInt(req.body.seconds, 10);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > RELAY_BATCH_TIMEOUT_MAX) {
        return res.status(400).json({ error: `seconds must be an integer between 1 and ${RELAY_BATCH_TIMEOUT_MAX}` });
    }
    botConfig.set(RELAY_BATCH_TIMEOUT_KEY, String(seconds));
    res.json({ ok: true, seconds });
});
```

Check the top of `admin/server.js` for whether `botConfig` is already required (it almost
certainly is, since the existing `/api/config` routes use it) before adding a duplicate require.

- [ ] **Step 4: Add the OPERATIONS entry to `admin/auth.js`**

```javascript
{ key: 'translation-relay-batch-timeout', group: 'Translation Relay', label: 'Edit translation relay batch timeout', defaultTier: 'manage', match: r => /^\/api\/translation-relay\/batch-timeout/.test(r.path) },
```

Place it near the existing `translation-relay` entry.

- [ ] **Step 5: Wire the load/save in `admin/src/translationRelay.js`**

Add to the existing `loadTranslationRelay()` function (or a new function called alongside it —
match whichever is cleaner given the current file's structure) a fetch of the timeout on tab
load:

```javascript
async function loadBatchTimeout() {
    const { seconds } = await fetch('/api/translation-relay/batch-timeout').then(r => r.json());
    const input = document.getElementById('relayBatchTimeout');
    if (input) input.value = seconds;
}
```

Call `loadBatchTimeout()` alongside the existing channel-list load in `loadTranslationRelay()`.

Add a save handler, wired via `addEventListener` (CSP requirement — no inline `onclick`):

```javascript
async function saveBatchTimeout() {
    const input = document.getElementById('relayBatchTimeout');
    const status = document.getElementById('relayBatchTimeoutStatus');
    const seconds = parseInt(input.value, 10);
    const res = await fetch('/api/translation-relay/batch-timeout', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds }),
    });
    const body = await res.json();
    if (!res.ok) {
        status.textContent = body.error || 'Failed to save';
        return;
    }
    status.textContent = 'Saved.';
    setTimeout(() => { status.textContent = ''; }, 2000);
}
```

In `initTranslationRelay()` (the existing init function), add:
```javascript
document.getElementById('saveRelayBatchTimeoutBtn')?.addEventListener('click', saveBatchTimeout);
```

- [ ] **Step 6: Manual verification**

1. Rebuild: `npm run build --prefix admin`.
2. Verify against a throwaway `node admin/server.js` on a free port (NOT `pm2 restart
   meerbot-admin` — that process runs from the main repo checkout, not this worktree, and will
   not reflect these changes; this constraint was established during the original feature's
   Task 3/4 review).
3. Confirm the description paragraph text now uses normal muted styling, not the broken
   neutral-content look.
4. Confirm the channel/language/flag inputs now render with a visible border/background.
5. Confirm the batch-timeout field loads the current value (10, if unset), and saving a value
   like 15 persists (reload the page, confirm it shows 15). Confirm saving 16 or 0 is rejected
   with a visible error message, and saving a non-integer is also rejected.
6. Kill the throwaway server when done.

- [ ] **Step 7: Commit**

```bash
git add admin/src/index.html admin/src/translationRelay.js admin/server.js admin/auth.js
git commit -m "fix: translation relay tab styling + add batch-timeout setting"
```

---

### Task 2: Database schema changes

**Files:**
- Modify: `utils/db.js` (new columns, updated helper)
- Test: `utils/translationRelay.test.js` (extend existing tests)

**Interfaces:**
- Produces (consumed by Task 3):
  - `translation_relay_messages` gains two columns: `batch_message_ids TEXT NOT NULL DEFAULT
    '[]'` (JSON array of original Discord message IDs in the batch, in order) and
    `last_line_text TEXT NOT NULL DEFAULT ''` (the last original line's translated/original
    text, used for reply-quoting).
  - `db.insertRelayMessage(...)` gains two new optional fields in its params object:
    `batchMessageIds` (array, defaults to `[messageId]` if omitted — so existing single-message
    call sites need no changes) and `lastLineText` (string, defaults to `text` if omitted — same
    backward-compatibility reasoning).
  - The existing `getRelayMessagesByGroupId`-based quote lookup (used inside
    `translationRelayHandler.js`, not `db.js` itself) must read `last_line_text`, falling back to
    `text` when `last_line_text` is empty — this fallback logic belongs in Task 3's handler
    changes, not in `db.js`, since it's about how the quote prefix is built, not how data is
    stored/retrieved.

- [ ] **Step 1: Add the two ALTER TABLE statements to `utils/db.js`**

`translation_relay_messages` was created via `CREATE TABLE IF NOT EXISTS` inside the `db.exec`
block. Per this project's schema convention (CREATE statements reflect current shape, ALTERs run
once then folded in — see `utils/db.js`'s comment at the top of its `db.exec` block for the exact
wording of this convention), add the two new columns directly into the existing
`CREATE TABLE IF NOT EXISTS translation_relay_messages ( ... )` statement (find it — added in the
original feature, columns currently: `id, relay_group_message_id, channel_id, message_id,
author_id, author_display_name, language, text, created_at`):

```sql
CREATE TABLE IF NOT EXISTS translation_relay_messages (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  relay_group_message_id INTEGER NOT NULL,
  channel_id              TEXT NOT NULL,
  message_id               TEXT NOT NULL UNIQUE,
  author_id                TEXT NOT NULL,
  author_display_name      TEXT NOT NULL,
  language                 TEXT NOT NULL,
  text                     TEXT NOT NULL,
  batch_message_ids        TEXT NOT NULL DEFAULT '[]',
  last_line_text           TEXT NOT NULL DEFAULT '',
  created_at               TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Since this table already exists live (in both `guild.test.db` and the real production
`guild.db`, per the original feature's merge), `CREATE TABLE IF NOT EXISTS` alone will NOT add
the new columns to those existing tables — SQLite has no `ADD COLUMN IF NOT EXISTS`. Add the same
conditional-ALTER pattern already used elsewhere in `utils/db.js` for exactly this situation (see
the `warbandCols` handling near the top of the file, which checks `PRAGMA table_info(...)` before
running each `ALTER TABLE ... ADD COLUMN`):

```javascript
const relayMessageCols = new Set(db.prepare("PRAGMA table_info(translation_relay_messages)").all().map(c => c.name));
for (const [col, ddl] of [
    ['batch_message_ids', "ALTER TABLE translation_relay_messages ADD COLUMN batch_message_ids TEXT NOT NULL DEFAULT '[]'"],
    ['last_line_text', "ALTER TABLE translation_relay_messages ADD COLUMN last_line_text TEXT NOT NULL DEFAULT ''"],
]) {
    if (!relayMessageCols.has(col)) db.exec(ddl);
}
```

Place this block immediately after the `db.exec` call that contains the `CREATE TABLE IF NOT
EXISTS translation_relay_messages` statement (i.e. after the same `db.exec(\`...\`)` block that
was extended in the previous step finishes), matching where the existing `warbandCols` check is
positioned relative to its own table's creation.

- [ ] **Step 2: Update `insertRelayMessage` in `utils/db.js`**

Find the existing function:

```javascript
function insertRelayMessage({ relayGroupMessageId, channelId, messageId, authorId, authorDisplayName, language, text }) {
    const r = db.prepare(`INSERT INTO translation_relay_messages
        (relay_group_message_id, channel_id, message_id, author_id, author_display_name, language, text)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(relayGroupMessageId, channelId, messageId, authorId, authorDisplayName, language, text);
    return r.lastInsertRowid;
}
```

Replace with:

```javascript
function insertRelayMessage({ relayGroupMessageId, channelId, messageId, authorId, authorDisplayName, language, text, batchMessageIds, lastLineText }) {
    const r = db.prepare(`INSERT INTO translation_relay_messages
        (relay_group_message_id, channel_id, message_id, author_id, author_display_name, language, text, batch_message_ids, last_line_text)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(relayGroupMessageId, channelId, messageId, authorId, authorDisplayName, language, text,
             JSON.stringify(batchMessageIds ?? [messageId]), lastLineText ?? text);
    return r.lastInsertRowid;
}
```

This keeps every existing call site (in `translationRelayHandler.js`, not touched by this task)
working unchanged, since both new fields default sensibly when omitted.

- [ ] **Step 3: Extend `utils/translationRelay.test.js`**

Add these two tests, following the existing file's style (same `require`/setup pattern already
at the top of the file):

```javascript
test('insertRelayMessage defaults batch_message_ids to [messageId] and last_line_text to text when omitted', () => {
    db.insertRelayMessage({
        relayGroupMessageId: 0, channelId: 'test-ch-7', messageId: 'msg-batch-default-1',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'English', text: 'hello',
    });
    const row = db.prepare('SELECT batch_message_ids, last_line_text FROM translation_relay_messages WHERE message_id = ?').get('msg-batch-default-1');
    assert.deepEqual(JSON.parse(row.batch_message_ids), ['msg-batch-default-1']);
    assert.equal(row.last_line_text, 'hello');
    db.prepare('DELETE FROM translation_relay_messages WHERE message_id = ?').run('msg-batch-default-1');
});

test('insertRelayMessage stores explicit batch_message_ids and last_line_text when provided', () => {
    db.insertRelayMessage({
        relayGroupMessageId: 0, channelId: 'test-ch-8', messageId: 'msg-batch-explicit-1',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'English',
        text: 'hello\nhow are you', batchMessageIds: ['orig-1', 'orig-2'], lastLineText: 'how are you',
    });
    const row = db.prepare('SELECT batch_message_ids, last_line_text FROM translation_relay_messages WHERE message_id = ?').get('msg-batch-explicit-1');
    assert.deepEqual(JSON.parse(row.batch_message_ids), ['orig-1', 'orig-2']);
    assert.equal(row.last_line_text, 'how are you');
    db.prepare('DELETE FROM translation_relay_messages WHERE message_id = ?').run('msg-batch-explicit-1');
});
```

- [ ] **Step 4: Run the tests**

Run: `node --test utils/translationRelay.test.js`
Expected: all tests pass (6 existing + 2 new = 8).

- [ ] **Step 5: Commit**

```bash
git add utils/db.js utils/translationRelay.test.js
git commit -m "feat: add batch tracking columns to translation_relay_messages"
```

---

### Task 3: Batching logic in the message handler

**Files:**
- Modify: `utils/handlers/translationRelayHandler.js`
- Modify: `utils/handlers/translationRelayHandler.test.js`

**Interfaces:**
- Consumes: `db.insertRelayMessage` (Task 2, with `batchMessageIds`/`lastLineText`), the
  `GET /api/translation-relay/batch-timeout` shape from Task 1 is NOT consumed here — the bot
  process reads the setting directly via `botConfig.get`, not via the admin HTTP API (the admin
  routes exist so the browser can read/write it; the bot process is the actual reader/writer of
  `bot_config` under the hood, same as every other `botConfig`-backed setting in this codebase).
- Produces: nothing new consumed by later tasks (this is the last task; the admin UI from Task 1
  and the DB schema from Task 2 are both already in place).

- [ ] **Step 1: Add batch-timeout config reading**

Add near the top of `utils/handlers/translationRelayHandler.js`:

```javascript
const botConfig = require('../botConfig');

const BATCH_TIMEOUT_KEY = 'translation_relay_batch_timeout_seconds';
const BATCH_TIMEOUT_DEFAULT_SECONDS = 10;
const BATCH_TIMEOUT_MAX_SECONDS = 15;

function getBatchTimeoutMs() {
    const raw = parseInt(botConfig.get(BATCH_TIMEOUT_KEY, String(BATCH_TIMEOUT_DEFAULT_SECONDS)), 10);
    const seconds = Number.isInteger(raw) && raw >= 1 ? Math.min(raw, BATCH_TIMEOUT_MAX_SECONDS) : BATCH_TIMEOUT_DEFAULT_SECONDS;
    return seconds * 1000;
}
```

Read fresh on every batch start/reset (not cached at module load) so an admin-panel change takes
effect on the next new batch without a bot restart.

- [ ] **Step 2: Add the batch-state Map and flush logic**

Add below the existing `relayQueues` Map (keep both Maps, they serve different purposes — one is
per-relay-group ordering, the new one is per-relay-group open-batch tracking):

```javascript
// relay_group -> { authorId, sourceChannelRow, isReply, replyMessageId, messages: [{messageId, text}], authorDisplayName, authorAvatarURL, timeoutHandle }
const openBatches = new Map();

// Synchronously claims/clears a relay group's batch slot BEFORE any async work, per the
// race-safety requirement in the design doc: whichever of (timeout firing) or (interrupting
// message arriving) reaches this line first wins; the other finds the slot already gone.
function takeBatch(relayGroup) {
    const batch = openBatches.get(relayGroup);
    if (batch) {
        clearTimeout(batch.timeoutHandle);
        openBatches.delete(relayGroup);
    }
    return batch;
}

function flushBatch(relayGroup, client, batch) {
    if (!batch || batch.messages.length === 0) return;
    return enqueueRelay(relayGroup, () => processTranslationRelay(client, batch));
}
```

- [ ] **Step 3: Rewrite `handleTranslationRelay` to route through batching**

Replace the existing function:

```javascript
async function handleTranslationRelay(message, client) {
    if (message.author.bot) return; // loop guard: covers our own relay webhooks + any other bot
    const sourceChannelRow = db.getRelayChannelByChannelId(message.channelId);
    if (!sourceChannelRow) return;
    const text = (message.content || '').trim();
    if (!text) return;
    return enqueueRelay(sourceChannelRow.relay_group, () => processTranslationRelay(message, client, sourceChannelRow, text));
}
```

With:

```javascript
async function handleTranslationRelay(message, client) {
    if (message.author.bot) return; // loop guard: covers our own relay webhooks + any other bot
    const sourceChannelRow = db.getRelayChannelByChannelId(message.channelId);
    if (!sourceChannelRow) return;
    const text = (message.content || '').trim();
    if (!text) return;

    const relayGroup = sourceChannelRow.relay_group;
    const isReply = !!message.reference?.messageId;
    const existing = openBatches.get(relayGroup);

    // A reply always flushes whatever is open (even same-author) and starts its own batch.
    // A different author's message flushes whatever is open and starts a new batch.
    // A same-author, non-reply message joins the existing batch.
    const shouldFlushExisting = existing && (isReply || existing.authorId !== message.author.id);
    if (shouldFlushExisting) {
        const claimed = takeBatch(relayGroup);
        flushBatch(relayGroup, client, claimed);
    }

    const current = openBatches.get(relayGroup);
    const authorDisplayName = message.member?.displayName ?? message.author.username;
    const authorAvatarURL = message.author.displayAvatarURL();
    const entry = { messageId: message.id, text };

    if (current && !isReply && current.authorId === message.author.id) {
        current.messages.push(entry);
        clearTimeout(current.timeoutHandle);
        current.timeoutHandle = setTimeout(() => {
            const claimed = takeBatch(relayGroup);
            flushBatch(relayGroup, client, claimed);
        }, getBatchTimeoutMs());
        return;
    }

    const newBatch = {
        authorId: message.author.id,
        sourceChannelRow,
        isReply,
        replyMessageId: isReply ? message.reference.messageId : null,
        messages: [entry],
        authorDisplayName,
        authorAvatarURL,
        timeoutHandle: null,
    };
    newBatch.timeoutHandle = setTimeout(() => {
        const claimed = takeBatch(relayGroup);
        flushBatch(relayGroup, client, claimed);
    }, getBatchTimeoutMs());
    openBatches.set(relayGroup, newBatch);
}
```

- [ ] **Step 4: Rewrite `processTranslationRelay` to accept a batch instead of a single message**

Replace the existing `processTranslationRelay(message, client, sourceChannelRow, text)` (and its
callers already updated above to call it with `(client, batch)`) with a version operating on the
batch shape from Step 3. Key changes from the current version:

- The combined source text is `batch.messages.map(m => m.text).join('\n')`.
- `batchMessageIds` is `batch.messages.map(m => m.messageId)`.
- `lastLineText` for the SOURCE row is `batch.messages[batch.messages.length - 1].text`.
- The reply lookup uses `batch.replyMessageId` (only set if `batch.isReply`) instead of
  `message.reference?.messageId`.
- `callClaude` is called with the combined multi-line text; its per-language response is now an
  array (see Step 5 below) — `translations[targetRow.language]` becomes an array of translated
  lines, joined with `\n` to form the posted `bodyText`, but the LAST element of that array
  (not the joined string) is what becomes that target channel's `lastLineText` for its own
  relayed-copy row.
- On the untranslated-fallback path, the posted text is the combined original
  (`batch.messages.map(m => m.text).join('\n')`), and `lastLineText` for each target's relayed
  row is the last original line (`batch.messages[batch.messages.length - 1].text`).

```javascript
async function processTranslationRelay(client, batch) {
    const { sourceChannelRow, messages, authorDisplayName, authorAvatarURL, isReply, replyMessageId } = batch;
    const allChannels = db.getRelayChannels(sourceChannelRow.relay_group);
    const targetChannels = allChannels.filter(c => c.id !== sourceChannelRow.id);
    if (targetChannels.length === 0) return;

    const combinedText = messages.map(m => m.text).join('\n');
    const lastLine = messages[messages.length - 1].text;
    const batchMessageIds = messages.map(m => m.messageId);

    // Record the source batch's own row first -- its id becomes the shared
    // relay_group_message_id for every translated copy.
    const relayGroupMessageId = db.insertRelayMessage({
        relayGroupMessageId: 0,
        channelId: sourceChannelRow.channel_id,
        messageId: messages[0].messageId, // the batch's first message id anchors the row's own unique message_id
        authorId: batch.authorId,
        authorDisplayName,
        language: sourceChannelRow.language,
        text: combinedText,
        batchMessageIds,
        lastLineText: lastLine,
    });
    db.setRelayMessageGroupId(relayGroupMessageId, relayGroupMessageId);

    let replySource = null;
    if (isReply && replyMessageId) {
        const referenced = db.getRelayMessageByMessageId(replyMessageId);
        if (referenced) {
            replySource = db.getRelayMessagesByGroupId(referenced.relay_group_message_id);
        }
    }

    const targetLanguages = targetChannels.map(c => c.language);
    let translations = null;
    let usage = null;
    try {
        const result = await callClaude(sourceChannelRow.language, targetLanguages, messages.map(m => m.text));
        translations = result.translations;
        usage = result.usage;
    } catch (err) {
        console.error('[TranslationRelay] Claude translation failed:', err.message);
    }

    if (translations) {
        db.insertTranslationUsage({
            messageId: messages[0].messageId,
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            targetCount: targetLanguages.length,
        });
    }

    for (const targetRow of targetChannels) {
        const channel = await client.channels.fetch(targetRow.channel_id).catch(() => null);
        if (!channel) continue;

        let bodyLines, lastLineTranslated;
        if (translations) {
            bodyLines = translations[targetRow.language];
            lastLineTranslated = bodyLines[bodyLines.length - 1];
        } else {
            bodyLines = messages.map(m => m.text);
            lastLineTranslated = lastLine;
        }
        let bodyText = bodyLines.join('\n');

        let quotePrefix = '';
        if (replySource) {
            const quoteRow = replySource.find(r => r.channel_id === targetRow.channel_id);
            if (quoteRow) {
                const quoteText = quoteRow.last_line_text || quoteRow.text; // fallback for pre-batching rows
                quotePrefix = `> ${truncateQuote(quoteText)}\n`;
            }
        }
        bodyText = fitContent(quotePrefix, bodyText);

        const sent = await sendViaWebhook(targetRow, channel, {
            content: quotePrefix + bodyText,
            username: authorDisplayName,
            avatarURL: authorAvatarURL,
            allowedMentions: { parse: ['users'] },
        });
        if (!sent) continue;

        db.insertRelayMessage({
            relayGroupMessageId,
            channelId: targetRow.channel_id,
            messageId: sent.id,
            authorId: batch.authorId,
            authorDisplayName,
            language: targetRow.language,
            text: bodyText,
            batchMessageIds,
            lastLineText: lastLineTranslated,
        });

        if (!translations) {
            channel.messages.fetch(sent.id)
                .then(m => m.react(targetRow.flag_emoji))
                .catch(() => {});
        }
    }
}
```

- [ ] **Step 5: Update `callClaude` for the array response shape**

Replace the existing function:

```javascript
async function callClaude(sourceLanguage, targetLanguages, text) {
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
            content: `Source language: ${sourceLanguage}\nTarget languages: ${targetLanguages.join(', ')}\n\nMessage:\n${text}`,
        }],
    });
    const raw = response.content[0].text.trim();
    const parsed = JSON.parse(stripCodeFence(raw)); // throws on malformed JSON -- caller catches
    for (const lang of targetLanguages) {
        if (typeof parsed[lang] !== 'string') throw new Error(`Missing translation for ${lang}`);
    }
    return { translations: parsed, usage: response.usage };
}
```

With (note the changed signature: `lines` is now always an array, even for a single-message
"batch" of length 1 — one request/response shape for both cases, per the design doc):

```javascript
async function callClaude(sourceLanguage, targetLanguages, lines) {
    const numberedLines = lines.map((l, i) => `${i + 1}. ${l}`).join('\n');
    const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 1024,
        system: [
            'You are a chat relay bot, translating casual Discord messages for a gaming guild based on AFK Journey.',
            'Preserve tone, slang, and emotes/emoji as-is where they don\'t need translation.',
            'Keep Discord mention syntax (<@id>, <#id>) and custom emoji syntax (<:name:id>) completely unchanged.',
            'The message is a numbered list of one or more lines, all from the same person, sent in order.',
            'Output ONLY a JSON object mapping each requested language name to an ARRAY of translated strings,',
            'one array entry per input line, in the same order -- never a single string, even for one line.',
        ].join(' '),
        messages: [{
            role: 'user',
            content: `Source language: ${sourceLanguage}\nTarget languages: ${targetLanguages.join(', ')}\n\nMessage (${lines.length} line(s)):\n${numberedLines}`,
        }],
    });
    const raw = response.content[0].text.trim();
    const parsed = JSON.parse(stripCodeFence(raw)); // throws on malformed JSON -- caller catches
    for (const lang of targetLanguages) {
        if (!Array.isArray(parsed[lang]) || parsed[lang].length !== lines.length) {
            throw new Error(`Expected an array of ${lines.length} line(s) for ${lang}, got: ${JSON.stringify(parsed[lang])}`);
        }
        for (const line of parsed[lang]) {
            if (typeof line !== 'string') throw new Error(`Non-string entry in ${lang} translation array`);
        }
    }
    return { translations: parsed, usage: response.usage };
}
```

- [ ] **Step 6: Extend `utils/handlers/translationRelayHandler.test.js`**

Add tests for the pure, testable pieces of the new logic (matching this file's existing style —
no network/DB calls, `stripCodeFence`/`truncateQuote`-style unit tests). These exercise
`takeBatch` and `openBatches` directly, both exported in Step 7 below:

```javascript
test('takeBatch clears and returns the open batch for a relay group', () => {
    const { takeBatch, openBatches } = require('./translationRelayHandler');
    const fakeBatch = { authorId: 'user-1', messages: [{ messageId: 'm1', text: 'hi' }], timeoutHandle: setTimeout(() => {}, 100000) };
    openBatches.set('test-group-A', fakeBatch);

    const claimed = takeBatch('test-group-A');

    assert.equal(claimed, fakeBatch);
    assert.equal(openBatches.has('test-group-A'), false);
    clearTimeout(fakeBatch.timeoutHandle); // avoid leaving a dangling timer past the test
});

test('takeBatch returns undefined and is a no-op when no batch is open for that group', () => {
    const { takeBatch, openBatches } = require('./translationRelayHandler');
    assert.equal(openBatches.has('test-group-B'), false);

    const claimed = takeBatch('test-group-B');

    assert.equal(claimed, undefined);
    assert.equal(openBatches.has('test-group-B'), false);
});

test('takeBatch called twice in a row: second call returns undefined', () => {
    const { takeBatch, openBatches } = require('./translationRelayHandler');
    const fakeBatch = { authorId: 'user-1', messages: [{ messageId: 'm1', text: 'hi' }], timeoutHandle: setTimeout(() => {}, 100000) };
    openBatches.set('test-group-C', fakeBatch);

    const first = takeBatch('test-group-C');
    const second = takeBatch('test-group-C');

    assert.equal(first, fakeBatch);
    assert.equal(second, undefined);
    clearTimeout(fakeBatch.timeoutHandle);
});
```

- [ ] **Step 7: Update the module exports**

```javascript
module.exports = { handleTranslationRelay, stripCodeFence, truncateQuote, takeBatch, openBatches };
```

- [ ] **Step 8: Run the tests**

Run: `node --test utils/translationRelay.test.js utils/handlers/translationRelayHandler.test.js`
Expected: all tests pass (8 from Task 2 + existing 7 handler tests + 2 new = 17).

- [ ] **Step 9: Manual live smoke test in the test bot**

No automated test can cover the live Discord + Claude round-trip (matches this feature's
existing testing convention). Using the test-server channels already configured in
`translation_relay_channels` (per the shipped feature):

1. `pm2 restart meerbot-test` to pick up the change.
2. Set the batch timeout low for faster testing (e.g. via the admin UI from Task 1, or directly:
   `node -e "require('dotenv').config(); require('./utils/botConfig').set('translation_relay_batch_timeout_seconds', '5')"`
   run from the worktree root with `GUILD_DB_PATH` pointed at `guild.test.db`).
3. Post 2-3 quick messages in a row in one relay channel (same author, no more than ~2s apart).
   Confirm they arrive in the target channel as ONE combined post, multiple lines, after roughly
   the configured timeout from the last message.
4. Post a message in one channel, then IMMEDIATELY (before the timeout) post a message as a
   different author (or from a second test account/webhook if only one real account is
   available) in either channel of the group. Confirm the first author's batch flushes early
   (posts before the full timeout elapsed) and the second author's message starts its own batch.
5. Reply to any relayed message while a batch is accumulating from the SAME author as the reply.
   Confirm the reply flushes the open batch first (posts the accumulated batch), then the reply
   starts its own fresh batch/post with the correct quoted context (last line only, not the
   whole prior batch).
6. Confirm `pm2 logs meerbot-test --lines 30 --nostream` shows no unexpected errors throughout.
7. Restore the batch timeout to a normal value (10s) via the admin UI or the same `botConfig.set`
   approach as step 2.

- [ ] **Step 10: Commit**

```bash
git add utils/handlers/translationRelayHandler.js utils/handlers/translationRelayHandler.test.js
git commit -m "feat: batch consecutive same-author messages in translation relay"
```

---

## Final Verification

After all three tasks: run the full test suite (`node --test utils/translationRelay.test.js
utils/handlers/translationRelayHandler.test.js`), confirm the admin UI fixes are visually correct,
and confirm the full manual smoke test matrix from Task 3 Step 9 passes end-to-end in the test
bot before considering this ready to merge to `main`.
