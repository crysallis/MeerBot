# Translation Relay: Attachments, Reaction Sync, Edit/Delete Sync (v3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the four features from `docs/superpowers/specs/2026-08-09-translation-relay-attachments-edit-delete-design.md`: attachment passthrough, bidirectional reaction sync, edit sync, and delete sync — all built on a schema change to `batch_message_ids` that stores per-message text, not just IDs.

**Architecture:** Task 1 lands the schema/DB-layer change everything else depends on (this is the load-bearing task — every other task's DB calls assume it). Task 2 adds attachments (independent, no schema dependency, can run any time after Task 1 lands cleanly since it touches the same handler file). Task 3 adds reaction sync (fully independent — new listener, no batch-shape dependency). Task 4 adds edit sync (depends on Task 1's per-message storage). Task 5 adds delete sync (depends on Task 1 and reuses Task 4's rebuild-and-re-translate helper).

**Tech Stack:** discord.js v14, `better-sqlite3`, `@anthropic-ai/sdk` (Claude Haiku 4.5), Node's built-in `node:test` + `node:assert`.

## Global Constraints

- `translation_relay_messages.batch_message_ids` changes shape from `["id1","id2"]` to `[{"messageId":"id1","text":"line one"},{"messageId":"id2","text":"line two"}]`. Existing rows must be migrated in place at startup (not left in the old shape).
- Webhooks cannot react to messages and cannot be edited/deleted by anyone but the bot's own webhook token — verified against `discord.js` v14's `WebhookClient.prototype` (only `send`, `fetchMessage`, `editMessage`, `sendSlackMessage`, `edit`, `delete`, `deleteMessage` exist — no react method).
- Reaction sync loop guard: skip any `messageReactionAdd`/`messageReactionRemove` event where `user.id === client.user.id`.
- Message-event loop guard (edit/delete): skip where `message.author?.bot` is true — same pattern as the existing `messageCreate` handler.
- All new DB reads/writes live in `utils/db.js`. No raw SQL in `translationRelayHandler.js`.
- Every per-channel/per-copy operation (webhook edit, webhook delete, reaction add/remove) must be wrapped in try/catch so one channel's failure never blocks the others — this fault-isolation pattern already exists in `processTranslationRelay`'s per-target loop and must be preserved in every new loop.
- New listeners are registered in `index.js` alongside the existing `messageCreate`/`guildMemberUpdate`/`interactionCreate` listeners (see `index.js:60-67`).
- Existing exports from `translationRelayHandler.js` (`handleTranslationRelay`, `stripCodeFence`, `truncateQuote`, `takeBatch`, `openBatches`) must remain unchanged in behavior — this plan only adds new exports, never modifies existing ones' signatures.

---

### Task 1: Schema migration — per-message batch storage + DB helpers

**Files:**
- Modify: `utils/db.js:326-395` (schema block + migration block + relay message functions)
- Modify: `utils/translationRelay.test.js` (update 2 existing tests that assume flat-string shape, add new tests)

**Interfaces:**
- Produces: `db.updateRelayMessageText(id, { text, batchMessageIds, lastLineText })` — updates one row's text fields in place.
- Produces: `db.deleteRelayMessagesByGroupId(relayGroupMessageId)` — deletes every row sharing that group id.
- Produces: `getRelayMessageByMessageId` now matches `batch_message_ids` entries by their `.messageId` field, not by raw string equality.
- Consumes: nothing new — this task only touches `utils/db.js` and its own test file.
- **Migration behavior:** at startup, any existing row whose `batch_message_ids` parses to an array of strings (old shape) is rewritten to an array of `{messageId, text}` objects, using that row's own `text` column split by `\n` if the array has more than one entry, or `[{messageId: batch_message_ids[0], text: row.text}]` if it has exactly one entry. Rows already in the new shape (or empty `'[]'`) are left untouched.

- [ ] **Step 1: Read the current schema and migration block for context**

Run: `sed -n '320,395p' utils/db.js` (or open the file) to see the exact current `CREATE TABLE`/`ALTER TABLE` blocks before editing. Do not skip this — the migration code you write in Step 3 must not collide with the existing `batch_message_ids`/`last_line_text` column-add migration already there from v2.

- [ ] **Step 2: Write the failing tests for the new shape**

Replace these two tests in `utils/translationRelay.test.js` (find them by their exact `test(...)` title strings):

```javascript
test('insertRelayMessage defaults batch_message_ids to [{messageId, text}] and last_line_text to text when omitted', () => {
    const groupId = db.insertRelayMessage({
        relayGroupMessageId: 0,
        channelId: 'chan-1',
        messageId: 'msg-solo',
        authorId: 'user-1',
        authorDisplayName: 'Tester',
        language: 'English',
        text: 'hello world',
    });
    db.setRelayMessageGroupId(groupId, groupId);
    const row = db.getRelayMessageByMessageId('msg-solo');
    assert.deepStrictEqual(JSON.parse(row.batch_message_ids), [{ messageId: 'msg-solo', text: 'hello world' }]);
    assert.strictEqual(row.last_line_text, 'hello world');
});

test('insertRelayMessage stores explicit batch_message_ids and last_line_text when provided', () => {
    const batchMessageIds = [
        { messageId: 'msg-a', text: 'line one' },
        { messageId: 'msg-b', text: 'line two' },
    ];
    const groupId = db.insertRelayMessage({
        relayGroupMessageId: 0,
        channelId: 'chan-1',
        messageId: 'msg-a',
        authorId: 'user-1',
        authorDisplayName: 'Tester',
        language: 'English',
        text: 'line one\nline two',
        batchMessageIds,
        lastLineText: 'line two',
    });
    db.setRelayMessageGroupId(groupId, groupId);
    const row = db.getRelayMessageByMessageId('msg-a');
    assert.deepStrictEqual(JSON.parse(row.batch_message_ids), batchMessageIds);
    assert.strictEqual(row.last_line_text, 'line two');
});

test('getRelayMessageByMessageId finds a row by a middle batch_message_ids entry, not just its own message_id', () => {
    const batchMessageIds = [
        { messageId: 'msg-x', text: 'first' },
        { messageId: 'msg-y', text: 'second' },
        { messageId: 'msg-z', text: 'third' },
    ];
    const groupId = db.insertRelayMessage({
        relayGroupMessageId: 0,
        channelId: 'chan-1',
        messageId: 'msg-x',
        authorId: 'user-1',
        authorDisplayName: 'Tester',
        language: 'English',
        text: 'first\nsecond\nthird',
        batchMessageIds,
        lastLineText: 'third',
    });
    db.setRelayMessageGroupId(groupId, groupId);
    const row = db.getRelayMessageByMessageId('msg-y');
    assert.ok(row, 'expected to find the row via a middle batch entry');
    assert.strictEqual(row.message_id, 'msg-x');
});
```

Add these new tests to the same file:

```javascript
test('updateRelayMessageText updates text, batch_message_ids, and last_line_text in place', () => {
    const groupId = db.insertRelayMessage({
        relayGroupMessageId: 0,
        channelId: 'chan-1',
        messageId: 'msg-edit-1',
        authorId: 'user-1',
        authorDisplayName: 'Tester',
        language: 'English',
        text: 'original text',
    });
    db.setRelayMessageGroupId(groupId, groupId);
    const row = db.getRelayMessageByMessageId('msg-edit-1');
    const newBatchMessageIds = [{ messageId: 'msg-edit-1', text: 'edited text' }];
    db.updateRelayMessageText(row.id, {
        text: 'edited text',
        batchMessageIds: newBatchMessageIds,
        lastLineText: 'edited text',
    });
    const updated = db.getRelayMessageByMessageId('msg-edit-1');
    assert.strictEqual(updated.text, 'edited text');
    assert.strictEqual(updated.last_line_text, 'edited text');
    assert.deepStrictEqual(JSON.parse(updated.batch_message_ids), newBatchMessageIds);
});

test('deleteRelayMessagesByGroupId removes every row sharing that group id', () => {
    const groupId = db.insertRelayMessage({
        relayGroupMessageId: 0,
        channelId: 'chan-1',
        messageId: 'msg-del-src',
        authorId: 'user-1',
        authorDisplayName: 'Tester',
        language: 'English',
        text: 'source text',
    });
    db.setRelayMessageGroupId(groupId, groupId);
    db.insertRelayMessage({
        relayGroupMessageId: groupId,
        channelId: 'chan-2',
        messageId: 'msg-del-copy',
        authorId: 'user-1',
        authorDisplayName: 'Tester',
        language: 'Spanish',
        text: 'texto fuente',
    });
    assert.strictEqual(db.getRelayMessagesByGroupId(groupId).length, 2);
    db.deleteRelayMessagesByGroupId(groupId);
    assert.strictEqual(db.getRelayMessagesByGroupId(groupId).length, 0);
});

test('startup migration rewrites old flat-string batch_message_ids into {messageId,text} shape', () => {
    // Simulate a pre-v3 row by inserting raw SQL bypassing insertRelayMessage's own serialization
    const rawDb = db.__testRawDb ?? db._db; // see Step 3 note on exposing the raw handle for this one test
    rawDb.prepare(`INSERT INTO translation_relay_messages
        (relay_group_message_id, channel_id, message_id, author_id, author_display_name, language, text, batch_message_ids, last_line_text)
        VALUES (999, 'chan-1', 'legacy-msg-1', 'user-1', 'Tester', 'English', 'legacy text', '["legacy-msg-1"]', 'legacy text')`).run();
    db.__runRelayMessageMigration(); // re-invoke the migration function directly, see Step 3
    const row = db.getRelayMessageByMessageId('legacy-msg-1');
    assert.deepStrictEqual(JSON.parse(row.batch_message_ids), [{ messageId: 'legacy-msg-1', text: 'legacy text' }]);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test utils/translationRelay.test.js`
Expected: the 3 rewritten tests FAIL (old code stores flat strings, `deepStrictEqual` against object-shaped arrays fails), the 3 new tests FAIL (`updateRelayMessageText`/`deleteRelayMessagesByGroupId`/`__runRelayMessageMigration` are not defined).

- [ ] **Step 4: Update `insertRelayMessage`'s default and `getRelayMessageByMessageId`'s lookup**

In `utils/db.js`, replace the `insertRelayMessage` function (currently at line 574) with:

```javascript
function insertRelayMessage({ relayGroupMessageId, channelId, messageId, authorId, authorDisplayName, language, text, batchMessageIds, lastLineText }) {
    const r = db.prepare(`INSERT INTO translation_relay_messages
        (relay_group_message_id, channel_id, message_id, author_id, author_display_name, language, text, batch_message_ids, last_line_text)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(relayGroupMessageId, channelId, messageId, authorId, authorDisplayName, language, text,
             JSON.stringify(batchMessageIds ?? [{ messageId, text }]), lastLineText ?? text);
    return r.lastInsertRowid;
}
```

Replace `getRelayMessageByMessageId` (currently at line 583) with:

```javascript
function getRelayMessageByMessageId(messageId) {
    return db.prepare(`
        SELECT * FROM translation_relay_messages
        WHERE message_id = ?
           OR EXISTS (
               SELECT 1 FROM json_each(batch_message_ids)
               WHERE json_extract(value, '$.messageId') = ?
           )
    `).get(messageId, messageId);
}
```

- [ ] **Step 5: Add `updateRelayMessageText` and `deleteRelayMessagesByGroupId`**

Add directly after `setRelayMessageGroupId` (currently ends at line 604):

```javascript
function updateRelayMessageText(id, { text, batchMessageIds, lastLineText }) {
    db.prepare('UPDATE translation_relay_messages SET text = ?, batch_message_ids = ?, last_line_text = ? WHERE id = ?')
        .run(text, JSON.stringify(batchMessageIds), lastLineText, id);
}

function deleteRelayMessagesByGroupId(relayGroupMessageId) {
    db.prepare('DELETE FROM translation_relay_messages WHERE relay_group_message_id = ?').run(relayGroupMessageId);
}
```

Add both to the module's exports (find where `getRelayMessageByMessageId` etc. are exported — this table's functions are exported via the object literal returned near the top of the relay section, or via `module.exports.x = x` lines near the bottom depending on the file's existing pattern; match whichever pattern the other relay functions already use).

- [ ] **Step 6: Add the startup migration function**

Directly after the existing `batch_message_ids`/`last_line_text` column-add migration block (the `for (const [col, ddl] of [...])` loop found in Step 1), add:

```javascript
// v3: batch_message_ids shape changed from string[] (message IDs only) to
// {messageId, text}[] (ID + that line's own source text), needed for precise
// edit/delete sync on one line of a multi-message batch. Rewrite any row still
// in the old flat-string shape. Safe to run every startup -- a no-op once migrated.
function runRelayMessageMigration() {
    const rows = db.prepare('SELECT id, message_id, text, batch_message_ids FROM translation_relay_messages').all();
    const update = db.prepare('UPDATE translation_relay_messages SET batch_message_ids = ? WHERE id = ?');
    for (const row of rows) {
        let parsed;
        try {
            parsed = JSON.parse(row.batch_message_ids);
        } catch {
            continue; // corrupt/unreadable, leave as-is rather than guess
        }
        if (!Array.isArray(parsed) || parsed.length === 0) continue;
        if (typeof parsed[0] === 'object' && parsed[0] !== null && 'messageId' in parsed[0]) continue; // already migrated
        const lines = row.text.split('\n');
        const rebuilt = parsed.length === lines.length
            ? parsed.map((messageId, i) => ({ messageId, text: lines[i] }))
            : parsed.map(messageId => ({ messageId, text: row.text })); // count mismatch: fall back to whole text per id, best effort
        update.run(JSON.stringify(rebuilt), row.id);
    }
}
runRelayMessageMigration();
```

Expose it and the raw `db` handle for the one migration test added in Step 2:

```javascript
module.exports.__runRelayMessageMigration = runRelayMessageMigration;
module.exports.__testRawDb = db;
```

(These two `__`-prefixed exports exist solely so the test in Step 2 can simulate a legacy row and re-invoke the migration on demand — they are not part of the public API and must not be used anywhere outside that one test.)

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --test utils/translationRelay.test.js`
Expected: all tests PASS, including the 3 rewritten and 3 new ones (9 relay-message tests total in this file, up from 6).

- [ ] **Step 8: Run the full existing suite to confirm no regressions**

Run: `node --test utils/translationRelay.test.js utils/handlers/translationRelayHandler.test.js`
Expected: all pass (23 existing + 3 new − wait, 3 were rewritten not added, so 23 + 3 net new = 26 total; confirm the actual count matches, don't assume).

- [ ] **Step 9: Commit**

```bash
git add utils/db.js utils/translationRelay.test.js
git commit -m "feat: migrate batch_message_ids to per-message {messageId,text} shape"
```

---

### Task 2: Attachment passthrough

**Files:**
- Modify: `utils/handlers/translationRelayHandler.js`
- Modify: `utils/handlers/translationRelayHandler.test.js`

**Interfaces:**
- Consumes: nothing from Task 1 — attachments are independent of the batch-text-shape change.
- Produces: batch entries gain an `attachments` field (array of `{url, name}` passed straight from `message.attachments`); `processTranslationRelay`'s webhook `send` payload gains a `files` key when any message in the batch had attachments.

- [ ] **Step 1: Write the failing test**

In `utils/handlers/translationRelayHandler.test.js`, find the existing tests that build a fake `message` object for `handleTranslationRelay` (used in the stub-client-style tests). Add:

```javascript
test('handleTranslationRelay captures message attachments onto the batch entry', async () => {
    openBatches.clear();
    const fakeMessage = {
        id: 'msg-attach-1',
        author: { id: 'user-1', bot: false, username: 'tester', displayAvatarURL: () => 'http://example.com/a.png' },
        member: { displayName: 'Tester' },
        content: 'check this out',
        channelId: TEST_SOURCE_CHANNEL_ID, // use whatever constant the existing tests use for a configured source channel
        reference: null,
        attachments: new Map([
            ['att-1', { url: 'https://cdn.discordapp.com/attachments/1/2/image.png', name: 'image.png' }],
        ]),
    };
    await handleTranslationRelay(fakeMessage, fakeClientStub); // reuse the existing stub client from earlier tests
    const batch = openBatches.get('default');
    assert.strictEqual(batch.messages[0].attachments.length, 1);
    assert.strictEqual(batch.messages[0].attachments[0].url, 'https://cdn.discordapp.com/attachments/1/2/image.png');
    clearTimeout(batch.timeoutHandle);
    openBatches.delete('default');
});
```

Adjust `TEST_SOURCE_CHANNEL_ID`/`fakeClientStub` to match whatever names the existing stub-client tests in this file already use — read the file first to find them exactly, do not invent new constant names that collide.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test utils/handlers/translationRelayHandler.test.js`
Expected: FAIL — `batch.messages[0].attachments` is `undefined`.

- [ ] **Step 3: Capture attachments onto batch entries**

In `handleTranslationRelay` (`utils/handlers/translationRelayHandler.js:143-199`), change the `entry` construction:

```javascript
const entry = {
    messageId: message.id,
    text,
    attachments: [...message.attachments.values()].map(a => ({ url: a.url, name: a.name })),
};
```

(`message.attachments` is always a `Collection`/`Map`-like even when empty, so `.values()` is always safe — no null check needed.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test utils/handlers/translationRelayHandler.test.js`
Expected: PASS.

- [ ] **Step 5: Write the failing test for the send-payload wiring**

There is no existing `WebhookClient` mock anywhere in this test file today (confirmed: the
current tests only exercise `stripCodeFence`/`truncateQuote`/the batching state machine via
stub Discord clients, none of which reach `sendViaWebhook`). Establish the pattern now:
monkey-patch `WebhookClient.prototype.send`/`editMessage`/`deleteMessage` for the duration
of each test that needs it, restoring the original in a `finally` block. This works because
`getOrCreateWebhook` always does `new WebhookClient({...})` — patching the prototype
intercepts every instance without any dependency-injection refactor. Tasks 4 and 5 reuse
this exact pattern (patching `editMessage`/`deleteMessage` respectively) — do not invent a
second, different mocking approach for them.

Add `processTranslationRelay` to `module.exports` first (test-only export, matching how
`takeBatch`/`openBatches` are already exported for the same reason):

```javascript
const { WebhookClient } = require('discord.js');

test('processTranslationRelay includes files in the webhook send payload when attachments are present', async () => {
    const sentPayloads = [];
    const originalSend = WebhookClient.prototype.send;
    WebhookClient.prototype.send = async function (payload) {
        sentPayloads.push(payload);
        return { id: 'sent-msg-1' };
    };
    try {
        const stubClient = {
            channels: {
                fetch: async () => ({
                    createWebhook: async () => ({ id: 'wh-1', token: 'tok-1' }),
                }),
            },
        };
        // processTranslationRelay calls db.getRelayChannels(relay_group) internally to find
        // target channels, filtering out only the row matching sourceChannelRow.id -- both
        // the source and at least one target must be real rows in the same relay_group for
        // targetChannels.length > 0 and the send path to actually run.
        const sourceChannelRow = db.addRelayChannel({ channelId: 'chan-attach-src', language: 'English', flagEmoji: '🇺🇸', relayGroup: 'attach-test-group' });
        const targetId = db.addRelayChannel({ channelId: 'chan-attach-target', language: 'Spanish', flagEmoji: '🇪🇸', relayGroup: 'attach-test-group' });
        const sourceRow = db.getRelayChannelByChannelId('chan-attach-src');

        const batch = {
            authorId: 'user-1',
            sourceChannelRow: sourceRow,
            isReply: false,
            replyMessageId: null,
            authorDisplayName: 'Tester',
            authorAvatarURL: 'http://example.com/a.png',
            messages: [{
                messageId: 'msg-1',
                text: 'look at this',
                attachments: [{ url: 'https://cdn.discordapp.com/attachments/1/2/image.png', name: 'image.png' }],
            }],
        };
        try {
            await processTranslationRelay(stubClient, batch);
            assert.ok(sentPayloads[0].files);
            assert.strictEqual(sentPayloads[0].files[0].attachment, 'https://cdn.discordapp.com/attachments/1/2/image.png');
        } finally {
            db.removeRelayChannel(sourceChannelRow);
            db.removeRelayChannel(targetId);
        }
    } finally {
        WebhookClient.prototype.send = originalSend;
    }
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `node --test utils/handlers/translationRelayHandler.test.js`
Expected: FAIL — no `files` key on the payload yet.

- [ ] **Step 7: Wire attachments into the send/edit payload**

In `processTranslationRelay` (`utils/handlers/translationRelayHandler.js:201-304`), after `bodyText = fitContent(quotePrefix, bodyText);` and before the `sendViaWebhook` call, add:

```javascript
const allAttachments = messages.flatMap(m => m.attachments ?? []);
const files = allAttachments.length > 0
    ? allAttachments.map(a => ({ attachment: a.url, name: a.name }))
    : undefined;
```

Then change the `sendViaWebhook` call's payload object to conditionally include `files`:

```javascript
const sent = await sendViaWebhook(targetRow, channel, {
    content: quotePrefix + bodyText,
    username: authorDisplayName,
    avatarURL: authorAvatarURL,
    allowedMentions: { parse: ['users'] },
    ...(files ? { files } : {}),
});
```

- [ ] **Step 8: Run test to verify it passes**

Run: `node --test utils/handlers/translationRelayHandler.test.js`
Expected: PASS.

- [ ] **Step 9: Run the full suite**

Run: `node --test utils/translationRelay.test.js utils/handlers/translationRelayHandler.test.js`
Expected: all pass, no regressions.

- [ ] **Step 10: Commit**

```bash
git add utils/handlers/translationRelayHandler.js utils/handlers/translationRelayHandler.test.js
git commit -m "feat: relay message attachments through the translation webhook payload"
```

---

### Task 3: Bidirectional reaction sync

**Files:**
- Modify: `utils/handlers/translationRelayHandler.js` (new `handleTranslationReactionSync` function + export)
- Modify: `index.js` (register the two new listeners)
- Create: `utils/handlers/translationReactionSync.test.js`

**Interfaces:**
- Consumes: `db.getRelayMessageByMessageId` and `db.getRelayMessagesByGroupId` (both already exist, no changes needed from Task 1 — reaction sync doesn't touch `batch_message_ids` at all).
- Produces: `handleTranslationReactionSync(reaction, user, client, isAdd)`, exported from `translationRelayHandler.js` and wired into `index.js`.

- [ ] **Step 1: Write the failing unit tests**

Create `utils/handlers/translationReactionSync.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const { handleTranslationReactionSync } = require('./translationRelayHandler');
const db = require('../db');

const BOT_USER_ID = 'bot-self-id';

function makeStubReaction({ messageId, emojiName = '👍', partial = false }) {
    return {
        partial,
        message: { id: messageId },
        emoji: { name: emojiName, id: null },
        fetch: async function () { this.partial = false; return this; },
    };
}

test('handleTranslationReactionSync ignores reactions added by the bot itself (loop guard)', async () => {
    let reactCalled = false;
    const stubClient = {
        user: { id: BOT_USER_ID },
        channels: { fetch: async () => ({ messages: { fetch: async () => ({ react: async () => { reactCalled = true; } }) } }) },
    };
    const reaction = makeStubReaction({ messageId: 'does-not-matter' });
    const user = { id: BOT_USER_ID };
    await handleTranslationReactionSync(reaction, user, stubClient, true);
    assert.strictEqual(reactCalled, false);
});

test('handleTranslationReactionSync no-ops when the reacted message is not a tracked relay message', async () => {
    let reactCalled = false;
    const stubClient = {
        user: { id: BOT_USER_ID },
        channels: { fetch: async () => ({ messages: { fetch: async () => ({ react: async () => { reactCalled = true; } }) } }) },
    };
    const reaction = makeStubReaction({ messageId: 'not-in-db-at-all' });
    const user = { id: 'real-user-1' };
    await handleTranslationReactionSync(reaction, user, stubClient, true);
    assert.strictEqual(reactCalled, false);
});

test('handleTranslationReactionSync mirrors a reaction on the original onto its relayed copy', async () => {
    const groupId = db.insertRelayMessage({
        relayGroupMessageId: 0, channelId: 'chan-src', messageId: 'msg-orig-1',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'English', text: 'hi',
    });
    db.setRelayMessageGroupId(groupId, groupId);
    db.insertRelayMessage({
        relayGroupMessageId: groupId, channelId: 'chan-target', messageId: 'msg-copy-1',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'Spanish', text: 'hola',
    });

    const reactedMessageIds = [];
    const stubClient = {
        user: { id: BOT_USER_ID },
        channels: {
            fetch: async () => ({
                messages: { fetch: async (id) => ({ react: async (emoji) => reactedMessageIds.push([id, emoji]) }) },
            }),
        },
    };
    const reaction = makeStubReaction({ messageId: 'msg-orig-1', emojiName: '🔥' });
    const user = { id: 'real-user-1' };
    await handleTranslationReactionSync(reaction, user, stubClient, true);
    assert.strictEqual(reactedMessageIds.length, 1);
    assert.strictEqual(reactedMessageIds[0][0], 'msg-copy-1');
});

test('handleTranslationReactionSync mirrors a reaction on a relayed copy back onto the original (bidirectional)', async () => {
    const groupId = db.insertRelayMessage({
        relayGroupMessageId: 0, channelId: 'chan-src', messageId: 'msg-orig-2',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'English', text: 'hi again',
    });
    db.setRelayMessageGroupId(groupId, groupId);
    db.insertRelayMessage({
        relayGroupMessageId: groupId, channelId: 'chan-target', messageId: 'msg-copy-2',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'Spanish', text: 'hola de nuevo',
    });

    const reactedMessageIds = [];
    const stubClient = {
        user: { id: BOT_USER_ID },
        channels: {
            fetch: async () => ({
                messages: { fetch: async (id) => ({ react: async (emoji) => reactedMessageIds.push([id, emoji]) }) },
            }),
        },
    };
    const reaction = makeStubReaction({ messageId: 'msg-copy-2', emojiName: '🔥' });
    const user = { id: 'real-user-1' };
    await handleTranslationReactionSync(reaction, user, stubClient, true);
    assert.strictEqual(reactedMessageIds.length, 1);
    assert.strictEqual(reactedMessageIds[0][0], 'msg-orig-2');
});

test('handleTranslationReactionSync fetches a partial reaction before reading its emoji', async () => {
    const groupId = db.insertRelayMessage({
        relayGroupMessageId: 0, channelId: 'chan-src', messageId: 'msg-orig-3',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'English', text: 'partial test',
    });
    db.setRelayMessageGroupId(groupId, groupId);
    db.insertRelayMessage({
        relayGroupMessageId: groupId, channelId: 'chan-target', messageId: 'msg-copy-3',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'Spanish', text: 'prueba parcial',
    });
    let fetchWasCalled = false;
    const reaction = makeStubReaction({ messageId: 'msg-orig-3', partial: true });
    reaction.fetch = async function () { fetchWasCalled = true; this.partial = false; return this; };
    const stubClient = {
        user: { id: BOT_USER_ID },
        channels: { fetch: async () => ({ messages: { fetch: async () => ({ react: async () => {} }) } }) },
    };
    await handleTranslationReactionSync(reaction, { id: 'real-user-1' }, stubClient, true);
    assert.strictEqual(fetchWasCalled, true);
});

test('handleTranslationReactionSync one target channel failing does not block others', async () => {
    const groupId = db.insertRelayMessage({
        relayGroupMessageId: 0, channelId: 'chan-src', messageId: 'msg-orig-4',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'English', text: 'multi target',
    });
    db.setRelayMessageGroupId(groupId, groupId);
    db.insertRelayMessage({
        relayGroupMessageId: groupId, channelId: 'chan-target-fail', messageId: 'msg-copy-fail',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'Spanish', text: 'fallara',
    });
    db.insertRelayMessage({
        relayGroupMessageId: groupId, channelId: 'chan-target-ok', messageId: 'msg-copy-ok',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'Russian', text: 'budet rabotat',
    });
    const reacted = [];
    const stubClient = {
        user: { id: BOT_USER_ID },
        channels: {
            fetch: async (channelId) => {
                if (channelId === 'chan-target-fail') throw new Error('missing access');
                return { messages: { fetch: async (id) => ({ react: async () => reacted.push(id) }) } };
            },
        },
    };
    const reaction = makeStubReaction({ messageId: 'msg-orig-4' });
    await handleTranslationReactionSync(reaction, { id: 'real-user-1' }, stubClient, true);
    assert.deepStrictEqual(reacted, ['msg-copy-ok']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test utils/handlers/translationReactionSync.test.js`
Expected: FAIL — `handleTranslationReactionSync` is not exported yet.

- [ ] **Step 3: Implement `handleTranslationReactionSync`**

Add to `utils/handlers/translationRelayHandler.js`, after `processTranslationRelay`:

```javascript
async function handleTranslationReactionSync(reaction, user, client, isAdd) {
    if (user.id === client.user.id) return; // loop guard: our own synced reaction re-fires this event
    if (reaction.partial) {
        try {
            await reaction.fetch();
        } catch (err) {
            console.error('[TranslationRelay] Failed to fetch partial reaction:', err.message);
            return;
        }
    }
    const row = db.getRelayMessageByMessageId(reaction.message.id);
    if (!row) return;
    const siblings = db.getRelayMessagesByGroupId(row.relay_group_message_id)
        .filter(r => r.message_id !== reaction.message.id);

    for (const sibling of siblings) {
        try {
            const channel = await client.channels.fetch(sibling.channel_id);
            const message = await channel.messages.fetch(sibling.message_id);
            if (isAdd) {
                await message.react(reaction.emoji.id ? reaction.emoji : reaction.emoji.name);
            } else {
                const existing = message.reactions.resolve(reaction.emoji.id ? reaction.emoji : reaction.emoji.name);
                if (existing) await existing.users.remove(client.user.id);
            }
        } catch (err) {
            console.error(`[TranslationRelay] Reaction sync failed for channel ${sibling.channel_id}:`, err.message);
        }
    }
}
```

Add `handleTranslationReactionSync` to the `module.exports` line at the bottom of the file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test utils/handlers/translationReactionSync.test.js`
Expected: all 6 PASS.

- [ ] **Step 5: Register the listeners in `index.js`**

In `index.js`, near the existing `client.on('messageCreate', ...)` block (around line 60), add:

```javascript
const { handleTranslationReactionSync } = require('./utils/handlers/translationRelayHandler');
// (add to the existing require line for translationRelayHandler if one already exists,
// rather than adding a second require of the same module — check line 10 first)

client.on('messageReactionAdd', (reaction, user) => {
    handleTranslationReactionSync(reaction, user, client, true).catch(err => console.error('[TranslationRelay] Reaction sync (add) unhandled error:', err));
});
client.on('messageReactionRemove', (reaction, user) => {
    handleTranslationReactionSync(reaction, user, client, false).catch(err => console.error('[TranslationRelay] Reaction sync (remove) unhandled error:', err));
});
```

Check whether `GatewayIntentBits.GuildMessageReactions` and `GatewayIntentBits.GuildMessages` (partials support for reactions may also require `Partials.Reaction`/`Partials.Message` in the client's `partials` array) are already enabled in the `Client` constructor near the top of `index.js`. If either is missing, add it — reaction events silently never fire without the intent, which would make this feature appear broken with no error.

- [ ] **Step 6: Run the full suite**

Run: `node --test utils/translationRelay.test.js utils/handlers/translationRelayHandler.test.js utils/handlers/translationReactionSync.test.js`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add utils/handlers/translationRelayHandler.js utils/handlers/translationReactionSync.test.js index.js
git commit -m "feat: bidirectional reaction sync across translation relay copies"
```

---

### Task 4: Edit sync

**Files:**
- Modify: `utils/handlers/translationRelayHandler.js` (new `handleTranslationEditSync` function + export)
- Modify: `index.js` (register the listener)
- Create: `utils/handlers/translationEditSync.test.js`

**Interfaces:**
- Consumes: `db.getRelayMessageByMessageId`, `db.updateRelayMessageText` (from Task 1), `callClaude` (already in this file, not exported — this task calls it internally, no new export needed since the new function lives in the same file).
- Produces: `handleTranslationEditSync(message, client)`, exported and wired into `index.js`.
- A shared internal helper `rebuildBatchAfterChange(batchMessageIds, messageId, newText)` — given the current `{messageId,text}[]` array, a target `messageId`, and either its replacement text (edit) or `null` (delete), returns the rebuilt array with that entry replaced or removed. This helper is reused by Task 5's delete sync, so its exact name and signature here are binding for that task.

- [ ] **Step 1: Write the failing unit tests**

Create `utils/handlers/translationEditSync.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const { handleTranslationEditSync, rebuildBatchAfterChange } = require('./translationRelayHandler');
const db = require('../db');

test('rebuildBatchAfterChange replaces the matching entry\'s text and leaves others untouched', () => {
    const batch = [
        { messageId: 'a', text: 'first' },
        { messageId: 'b', text: 'second' },
        { messageId: 'c', text: 'third' },
    ];
    const result = rebuildBatchAfterChange(batch, 'b', 'SECOND EDITED');
    assert.deepStrictEqual(result, [
        { messageId: 'a', text: 'first' },
        { messageId: 'b', text: 'SECOND EDITED' },
        { messageId: 'c', text: 'third' },
    ]);
});

test('rebuildBatchAfterChange removes the matching entry when newText is null', () => {
    const batch = [
        { messageId: 'a', text: 'first' },
        { messageId: 'b', text: 'second' },
    ];
    const result = rebuildBatchAfterChange(batch, 'a', null);
    assert.deepStrictEqual(result, [{ messageId: 'b', text: 'second' }]);
});

test('handleTranslationEditSync ignores edits from bot authors (loop guard)', async () => {
    let dbUpdateCalled = false;
    const originalUpdate = db.updateRelayMessageText;
    db.updateRelayMessageText = (...args) => { dbUpdateCalled = true; return originalUpdate(...args); };
    try {
        await handleTranslationEditSync({ author: { bot: true }, id: 'irrelevant', content: 'x' }, {});
        assert.strictEqual(dbUpdateCalled, false);
    } finally {
        db.updateRelayMessageText = originalUpdate;
    }
});

test('handleTranslationEditSync no-ops when the edited message is not a tracked relay message', async () => {
    let dbUpdateCalled = false;
    const originalUpdate = db.updateRelayMessageText;
    db.updateRelayMessageText = (...args) => { dbUpdateCalled = true; return originalUpdate(...args); };
    try {
        await handleTranslationEditSync({ author: { bot: false }, id: 'not-tracked-at-all', content: 'x' }, {});
        assert.strictEqual(dbUpdateCalled, false);
    } finally {
        db.updateRelayMessageText = originalUpdate;
    }
});

test('handleTranslationEditSync updates the source row and edits target copies (real Claude call)', async () => {
    // Requires ANTHROPIC_API_KEY to be set in this worktree's .env -- same live-API
    // convention as the batching feature's stub-client + real-API split (see
    // task-3-report.md). This test makes one real, small translation call.
    const { WebhookClient } = require('discord.js');

    // resyncRelayGroup looks up each sibling's channel row via db.getRelayChannelByChannelId,
    // so the target channel must be registered as a real relay channel row, not just
    // referenced by a bare string id in insertRelayMessage.
    const sourceChannelId = db.addRelayChannel({ channelId: 'chan-editsrc', language: 'English', flagEmoji: '🇺🇸' });
    const targetChannelId = db.addRelayChannel({ channelId: 'chan-edittarget-1', language: 'Spanish', flagEmoji: '🇪🇸' });

    const groupId = db.insertRelayMessage({
        relayGroupMessageId: 0, channelId: 'chan-editsrc', messageId: 'msg-editsrc-1',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'English', text: 'hello there',
    });
    db.setRelayMessageGroupId(groupId, groupId);
    db.insertRelayMessage({
        relayGroupMessageId: groupId, channelId: 'chan-edittarget-1', messageId: 'msg-editcopy-1',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'Spanish', text: 'hola',
    });

    const editedContent = [];
    const originalEdit = WebhookClient.prototype.editMessage;
    WebhookClient.prototype.editMessage = async function (messageId, payload) {
        editedContent.push({ messageId, payload });
        return { id: messageId };
    };
    const stubClient = {
        channels: {
            fetch: async () => ({
                createWebhook: async () => ({ id: 'wh-x', token: 'tok-x' }),
            }),
        },
    };
    try {
        await handleTranslationEditSync({ author: { bot: false }, id: 'msg-editsrc-1', content: 'hello world now' }, stubClient);

        const updatedSource = db.getRelayMessageByMessageId('msg-editsrc-1');
        assert.strictEqual(updatedSource.text, 'hello world now');
        assert.ok(editedContent.length > 0, 'expected at least one webhook editMessage call');
        assert.strictEqual(editedContent[0].messageId, 'msg-editcopy-1');
    } finally {
        WebhookClient.prototype.editMessage = originalEdit;
        db.removeRelayChannel(sourceChannelId);
        db.removeRelayChannel(targetChannelId);
    }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test utils/handlers/translationEditSync.test.js`
Expected: FAIL — neither function exists yet.

- [ ] **Step 3: Implement `rebuildBatchAfterChange` and `handleTranslationEditSync`**

Add to `utils/handlers/translationRelayHandler.js`, after `handleTranslationReactionSync`:

```javascript
function rebuildBatchAfterChange(batchMessageIds, messageId, newText) {
    if (newText === null) {
        return batchMessageIds.filter(entry => entry.messageId !== messageId);
    }
    return batchMessageIds.map(entry => entry.messageId === messageId ? { ...entry, text: newText } : entry);
}

async function resyncRelayGroup(client, sourceRow, rebuiltBatch) {
    const combinedText = rebuiltBatch.map(e => e.text).join('\n');
    const lastLineText = rebuiltBatch.length > 0 ? rebuiltBatch[rebuiltBatch.length - 1].text : '';
    db.updateRelayMessageText(sourceRow.id, { text: combinedText, batchMessageIds: rebuiltBatch, lastLineText });

    const siblings = db.getRelayMessagesByGroupId(sourceRow.relay_group_message_id)
        .filter(r => r.id !== sourceRow.id);
    if (siblings.length === 0 || rebuiltBatch.length === 0) return siblings;

    const sourceChannelRow = db.getRelayChannelByChannelId(sourceRow.channel_id);
    const targetLanguages = siblings.map(s => s.language);
    let translations = null;
    try {
        const result = await callClaude(sourceChannelRow.language, targetLanguages, rebuiltBatch.map(e => e.text));
        translations = result.translations;
    } catch (err) {
        console.error('[TranslationRelay] Re-translation on edit/delete failed, leaving stale copies:', err.message);
        return siblings;
    }

    for (const sibling of siblings) {
        try {
            const targetRow = db.getRelayChannelByChannelId(sibling.channel_id);
            const bodyLines = translations[sibling.language];
            const bodyText = bodyLines.join('\n');
            const channel = await client.channels.fetch(sibling.channel_id);
            const webhook = await getOrCreateWebhook(targetRow, channel);
            await webhook.editMessage(sibling.message_id, { content: bodyText });
            db.updateRelayMessageText(sibling.id, {
                text: bodyText,
                batchMessageIds: sibling.batch_message_ids ? JSON.parse(sibling.batch_message_ids) : [],
                lastLineText: bodyLines[bodyLines.length - 1],
            });
        } catch (err) {
            console.error(`[TranslationRelay] Failed to sync edit to channel ${sibling.channel_id}:`, err.message);
        }
    }
    return siblings;
}

async function handleTranslationEditSync(message, client) {
    if (message.author?.bot) return;
    const row = db.getRelayMessageByMessageId(message.id);
    if (!row) return;
    const batchMessageIds = JSON.parse(row.batch_message_ids);
    const newContent = (message.content || '').trim();
    const rebuilt = rebuildBatchAfterChange(batchMessageIds, message.id, newContent);
    await resyncRelayGroup(client, row, rebuilt);
}
```

Note: `resyncRelayGroup` is written here so Task 5 (delete sync) can reuse it directly — Task 5 must NOT duplicate this logic.

Add `handleTranslationEditSync`, `rebuildBatchAfterChange`, and `resyncRelayGroup` to `module.exports`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test utils/handlers/translationEditSync.test.js`
Expected: all PASS.

- [ ] **Step 5: Register the listener in `index.js`**

```javascript
const { handleTranslationEditSync } = require('./utils/handlers/translationRelayHandler');
// (again, consolidate into the single existing require of this module rather than a new one)

client.on('messageUpdate', (oldMessage, newMessage) => {
    handleTranslationEditSync(newMessage, client).catch(err => console.error('[TranslationRelay] Edit sync unhandled error:', err));
});
```

- [ ] **Step 6: Run the full suite**

Run: `node --test utils/translationRelay.test.js utils/handlers/translationRelayHandler.test.js utils/handlers/translationReactionSync.test.js utils/handlers/translationEditSync.test.js`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add utils/handlers/translationRelayHandler.js utils/handlers/translationEditSync.test.js index.js
git commit -m "feat: re-translate and edit relayed copies when the original message is edited"
```

---

### Task 5: Delete sync

**Files:**
- Modify: `utils/handlers/translationRelayHandler.js` (new `handleTranslationDeleteSync` function + export)
- Modify: `index.js` (register the listener)
- Create: `utils/handlers/translationDeleteSync.test.js`

**Interfaces:**
- Consumes: `db.getRelayMessageByMessageId`, `db.deleteRelayMessagesByGroupId` (Task 1), `rebuildBatchAfterChange` + `resyncRelayGroup` (Task 4 — reused, not reimplemented).
- Produces: `handleTranslationDeleteSync(message, client)`, exported and wired into `index.js`.

- [ ] **Step 1: Write the failing unit tests**

Create `utils/handlers/translationDeleteSync.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const { handleTranslationDeleteSync } = require('./translationRelayHandler');
const db = require('../db');

test('handleTranslationDeleteSync no-ops when the deleted message is not a tracked relay message', async () => {
    let deleteCalled = false;
    const originalDelete = db.deleteRelayMessagesByGroupId;
    db.deleteRelayMessagesByGroupId = (...args) => { deleteCalled = true; return originalDelete(...args); };
    try {
        await handleTranslationDeleteSync({ id: 'not-tracked-at-all' }, {});
        assert.strictEqual(deleteCalled, false);
    } finally {
        db.deleteRelayMessagesByGroupId = originalDelete;
    }
});

test('handleTranslationDeleteSync deletes all copies when the deleted message was the only line', async () => {
    const { WebhookClient } = require('discord.js');
    const srcId = db.addRelayChannel({ channelId: 'chan-delsolo-src', language: 'English', flagEmoji: '🇺🇸', relayGroup: 'delsolo-group' });
    const targetId = db.addRelayChannel({ channelId: 'chan-delsolo-target', language: 'Spanish', flagEmoji: '🇪🇸', relayGroup: 'delsolo-group' });

    const groupId = db.insertRelayMessage({
        relayGroupMessageId: 0, channelId: 'chan-delsolo-src', messageId: 'msg-delsolo-src',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'English', text: 'solo message',
    });
    db.setRelayMessageGroupId(groupId, groupId);
    db.insertRelayMessage({
        relayGroupMessageId: groupId, channelId: 'chan-delsolo-target', messageId: 'msg-delsolo-copy',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'Spanish', text: 'mensaje solo',
    });

    const deletedIds = [];
    const originalDelete = WebhookClient.prototype.deleteMessage;
    WebhookClient.prototype.deleteMessage = async function (messageId) { deletedIds.push(messageId); };
    const stubClient = {
        channels: {
            fetch: async () => ({
                createWebhook: async () => ({ id: 'wh-y', token: 'tok-y' }),
            }),
        },
    };
    try {
        await handleTranslationDeleteSync({ id: 'msg-delsolo-src' }, stubClient);
        assert.strictEqual(db.getRelayMessagesByGroupId(groupId).length, 0);
        assert.deepStrictEqual(deletedIds, ['msg-delsolo-copy']);
    } finally {
        WebhookClient.prototype.deleteMessage = originalDelete;
        db.removeRelayChannel(srcId);
        db.removeRelayChannel(targetId);
    }
});

test('handleTranslationDeleteSync re-translates remaining lines when one line of a batch is deleted', async () => {
    // Requires ANTHROPIC_API_KEY -- resyncRelayGroup calls the real callClaude, same as
    // Task 4's edit-sync test. This test makes one real, small translation call.
    const { WebhookClient } = require('discord.js');
    const srcId = db.addRelayChannel({ channelId: 'chan-delbatch-src', language: 'English', flagEmoji: '🇺🇸', relayGroup: 'delbatch-group' });
    const targetId = db.addRelayChannel({ channelId: 'chan-delbatch-target', language: 'Spanish', flagEmoji: '🇪🇸', relayGroup: 'delbatch-group' });

    const batchMessageIds = [
        { messageId: 'msg-batch-a', text: 'first line' },
        { messageId: 'msg-batch-b', text: 'second line' },
    ];
    const groupId = db.insertRelayMessage({
        relayGroupMessageId: 0, channelId: 'chan-delbatch-src', messageId: 'msg-batch-a',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'English',
        text: 'first line\nsecond line', batchMessageIds, lastLineText: 'second line',
    });
    db.setRelayMessageGroupId(groupId, groupId);
    db.insertRelayMessage({
        relayGroupMessageId: groupId, channelId: 'chan-delbatch-target', messageId: 'msg-batchcopy-1',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'Spanish', text: 'primera linea\nsegunda linea',
    });

    const originalEdit = WebhookClient.prototype.editMessage;
    WebhookClient.prototype.editMessage = async function (messageId, payload) { return { id: messageId }; };
    const stubClient = {
        channels: { fetch: async () => ({ createWebhook: async () => ({ id: 'wh-z', token: 'tok-z' }) }) },
    };
    try {
        await handleTranslationDeleteSync({ id: 'msg-batch-a' }, stubClient);

        const remaining = db.getRelayMessageByMessageId('msg-batch-b');
        assert.strictEqual(remaining.text, 'second line');
        assert.deepStrictEqual(JSON.parse(remaining.batch_message_ids), [{ messageId: 'msg-batch-b', text: 'second line' }]);
    } finally {
        WebhookClient.prototype.editMessage = originalEdit;
        db.removeRelayChannel(srcId);
        db.removeRelayChannel(targetId);
    }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test utils/handlers/translationDeleteSync.test.js`
Expected: FAIL — `handleTranslationDeleteSync` not exported yet.

- [ ] **Step 3: Implement `handleTranslationDeleteSync`**

Add to `utils/handlers/translationRelayHandler.js`, after `handleTranslationEditSync`:

```javascript
async function handleTranslationDeleteSync(message, client) {
    const row = db.getRelayMessageByMessageId(message.id);
    if (!row) return;
    const batchMessageIds = JSON.parse(row.batch_message_ids);
    const rebuilt = rebuildBatchAfterChange(batchMessageIds, message.id, null);

    if (rebuilt.length > 0) {
        await resyncRelayGroup(client, row, rebuilt);
        return;
    }

    const siblings = db.getRelayMessagesByGroupId(row.relay_group_message_id)
        .filter(r => r.id !== row.id);
    for (const sibling of siblings) {
        try {
            const targetRow = db.getRelayChannelByChannelId(sibling.channel_id);
            const channel = await client.channels.fetch(sibling.channel_id);
            const webhook = await getOrCreateWebhook(targetRow, channel);
            await webhook.deleteMessage(sibling.message_id);
        } catch (err) {
            console.error(`[TranslationRelay] Failed to delete relayed copy in channel ${sibling.channel_id}:`, err.message);
        }
    }
    db.deleteRelayMessagesByGroupId(row.relay_group_message_id);
}
```

Add `handleTranslationDeleteSync` to `module.exports`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test utils/handlers/translationDeleteSync.test.js`
Expected: all PASS.

- [ ] **Step 5: Register the listener in `index.js`**

```javascript
const { handleTranslationDeleteSync } = require('./utils/handlers/translationRelayHandler');
// (consolidate into the single existing require line)

client.on('messageDelete', message => {
    handleTranslationDeleteSync(message, client).catch(err => console.error('[TranslationRelay] Delete sync unhandled error:', err));
});
```

- [ ] **Step 6: Run the full suite**

Run: `node --test utils/translationRelay.test.js utils/handlers/translationRelayHandler.test.js utils/handlers/translationReactionSync.test.js utils/handlers/translationEditSync.test.js utils/handlers/translationDeleteSync.test.js`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add utils/handlers/translationRelayHandler.js utils/handlers/translationDeleteSync.test.js index.js
git commit -m "feat: delete/shrink relayed copies when the original message is deleted"
```

---

### Task 6: Live Discord verification + CLAUDE.md docs sync

**Files:**
- Modify: `CLAUDE.md` (Key Files table entry for `translationRelayHandler.js`, `translation_relay_messages` schema entry, note about the new `messageReactionAdd`/`Remove`/`messageUpdate`/`messageDelete` listeners in `index.js`'s Key Files entry, and GatewayIntentBits note if Task 3 Step 5 added new intents)

This task has no code changes of its own — it is the live-testing and documentation gate before this branch is considered done, matching the bar set by v1 and v2 (both of which shipped real bugs that only live testing or final review caught).

- [ ] **Step 1: Restart `meerbot-test` and confirm clean startup**

Ask the user to run (do not run PM2 restarts yourself — see project convention):
```
pm2 restart meerbot-test --update-env
pm2 logs meerbot-test --lines 30 --nostream
```
Confirm no errors, especially none related to the new intents/partials or the startup migration function.

- [ ] **Step 2: Live-verify attachment passthrough**

In the test guild's configured English relay channel, post a message with an image attached. Confirm in Discord: the Spanish/Russian relayed copies show the same image. Then edit that message's text (keep the image). Confirm the relayed copies' text updates and the image is still attached (not dropped by the edit).

- [ ] **Step 3: Live-verify bidirectional reaction sync**

React to the original message with an emoji. Confirm it appears on both relayed copies. Remove the reaction. Confirm it's removed from both copies. Then react to one of the relayed copies directly. Confirm it mirrors back to the original AND the other relayed copy.

- [ ] **Step 4: Live-verify edit sync on a single (non-batched) message**

Post a message, wait for it to relay, then edit it. Confirm the relayed copies update to the new translated text.

- [ ] **Step 5: Live-verify edit sync no-ops correctly on a mid-batch (non-anchor) message**

**Amended after the final whole-branch review (2026-08-09):** this step originally read "edit
the 2nd message of a batch, confirm only that line changes" -- that description CONTRADICTS
the shipped guard behavior. Tasks 4/5's `row.message_id !== message.id` check (and the
`getRelayMessageByMessageId` ambiguity guard) mean edit/delete sync only ever acts on a
batch's ANCHOR (first) message -- `row.message_id` is always `messages[0].messageId`. Editing
or deleting a non-first line of an already-relayed batch is a known, documented **no-op**, not
a bug, per two independent re-reviewers (both ruled it a safety improvement over the prior
ambiguous/corrupting behavior). Precise per-line edit/delete for non-anchor batch messages is
new design work, out of scope for this branch.

Post 3 quick messages in a row (same author, same channel, within the batch window) so they
combine into one relayed post. Then edit the 2nd message. Confirm the relayed copies do
**NOT** change (the edit is silently ignored) -- this is the expected, documented behavior,
not something to treat as a failure. Then edit the 1st (anchor) message instead and confirm
that DOES update all lines' translation as expected (see Step 4's single-message case for the
same underlying path).

- [ ] **Step 6: Live-verify delete sync on a single (non-batched) message**

Post a message, wait for it to relay, then delete it. Confirm the relayed copies are deleted too.

- [ ] **Step 7: Live-verify delete sync no-ops correctly on a mid-batch (non-anchor) message**

**Amended after the final whole-branch review (2026-08-09):** same contradiction as Step 5 --
this step originally read "delete one (not all), confirm the relayed copies update to show
only the remaining line(s)." That describes precise per-line delete, which the shipped guard
does not do: deleting a non-anchor line of a batch is a documented no-op (see Step 5's note for
the full explanation -- same `row.message_id !== message.id` / ambiguity-guard mechanism).

There are exactly three reachable cases, confirmed against the shipped code and covered by
`translationDeleteSync.test.js`'s unit tests -- verify all three live:

1. **Non-anchor line delete → documented no-op.** Post 2-3 quick messages as a batch, then
   delete the 2nd (non-anchor) message. Confirm the relayed copies do **NOT** change -- this is
   the expected, documented no-op (`getRelayMessageByMessageId`'s ambiguity guard rejects a
   lookup that doesn't match the row's own `message_id`), not a failure.
2. **Anchor delete, other lines remain → the batch shrinks and re-flows.** Post 2-3 quick
   messages as a batch, then delete the 1st (anchor) message. Confirm the relayed copies are
   edited in place to show only the remaining line(s), re-translated fresh -- NOT deleted
   entirely. (Proven at the unit level: `handleTranslationDeleteSync re-translates remaining
   lines when one line of a batch is deleted` deletes the anchor of a 2-line batch and asserts
   the survivor's text/`batch_message_ids` reflect only the remaining line.) Note: this
   resync path passes no `replyMessageId` (a deleted message arrives partial, so its own
   reply-reference usually isn't available) -- if the deleted anchor was itself a reply, the
   re-flowed copies will NOT carry the quote-prefix that a live edit-sync resync would keep.
   Accepted degrade, not a bug to chase in this wave.
3. **Last/only line deleted → the whole group is deleted.** Post a message with no batch
   (single message, not part of a multi-line batch), wait for it to relay, then delete it.
   Confirm the relayed copies are deleted too (this also covers the batch case once its last
   remaining line is deleted after case 2 above).

- [ ] **Step 8: Update CLAUDE.md**

Update the `translationRelayHandler.js` row in the Key Files table to mention: attachment passthrough, bidirectional reaction sync (with the webhook-can't-react / loop-guard note), and edit/delete sync (with the per-message batch storage note). Update the `translation_relay_messages` schema entry to describe the new `{messageId,text}[]` shape of `batch_message_ids`. If Task 3 Step 5 added new `GatewayIntentBits`/`Partials`, add a line noting them (matching the existing style of the `GatewayIntentBits.GuildMembers` note already in the Key Decisions section).

- [ ] **Step 9: Commit the docs update**

```bash
git add CLAUDE.md
git commit -m "docs: sync CLAUDE.md for attachments/reaction/edit/delete sync"
```

- [ ] **Step 10: Hand off to finishing-a-development-branch**

Once all live verification passes and docs are synced, use superpowers:finishing-a-development-branch to present merge/PR/keep-as-is options.
