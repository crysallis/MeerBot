# Translation Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the cross-channel translated conversation relay described in
`docs/superpowers/specs/2026-08-08-translation-relay-design.md`.

**Architecture:** A `messageCreate` handler watches configured relay channels, translates each
message via one Claude Haiku 4.5 call (JSON output keyed by target language), and posts the
result into every other configured channel via a per-channel webhook so it displays with the
original author's name/avatar. Reply context is preserved via a quoted-text prefix (webhooks
cannot carry native Discord replies — verified). An admin panel tab manages which channels are
in the relay and their languages.

**Tech Stack:** discord.js v14 (webhooks, `messageCreate`), `@anthropic-ai/sdk` (already a
dependency, used by `slash-commands/newsletter.js`), better-sqlite3, Express (admin API), vanilla
JS admin frontend (no framework, matches `admin/src/*.js` convention).

## Global Constraints

- Webhooks cannot send native Discord replies (verified via live probe against the test bot,
  2026-08-08). All reply context uses a quoted-text prefix: `> {quoted text}\n{reply text}`,
  quoted text truncated to 100 chars with a trailing `…` if longer.
- Loop prevention is mandatory and must be the first check in the handler: skip any message
  where `message.author.bot` is true (covers our own relay webhooks and any other bot).
- Translation is exactly one `anthropic.messages.create` call per relayed source message,
  model `claude-haiku-4-5`, requesting a single JSON object keyed by target language name.
- Every relayed copy (including the original source message) gets its own row in
  `translation_relay_messages`, sharing one `relay_group_message_id` per logical message, so
  reply lookups and quoted-context text can be resolved per-target-channel language.
- On translation failure (API error or unparseable/incomplete JSON response): still relay the
  original untranslated text to every target channel, then react to each relayed copy with that
  channel's configured `flag_emoji`.
- Token usage (`input_tokens`, `output_tokens`) from every successful Claude call is logged to
  `translation_usage`, one row per source message.
- No editing/deleting relayed copies, no attachments, no auto language detection — all
  explicitly out of scope for this plan (see spec's Deferred list).
- Follow the existing bot-owned-tables convention in `utils/db.js`: CREATE TABLE IF NOT EXISTS
  statements reflect current shape, no migration trail.
- Admin panel CSP blocks inline event handlers (`onclick=` etc.) — all dynamic HTML must wire
  events via `addEventListener`, matching `admin/src/seasons.js`.
- New admin mutations must be registered in `admin/auth.js`'s `OPERATIONS` array (tier
  `manage`, matching comparable config-editing operations like `seasons`) so they appear in the
  Access tab automatically.

---

### Task 1: Database schema + relay message lookup helpers

**Files:**
- Modify: `utils/db.js` (add table CREATEs + exported helper functions)
- Test: `utils/translationRelay.test.js` (new)

**Interfaces:**
- Produces (consumed by Task 2 and Task 3):
  - `db.getRelayChannels(relayGroup = 'default')` → array of
    `{ id, channel_id, language, flag_emoji, relay_group, webhook_id, webhook_token }`, ordered
    by `id`
  - `db.getRelayChannelByChannelId(channelId)` → single row or `undefined`
  - `db.addRelayChannel({ channelId, language, flagEmoji, relayGroup = 'default' })` → inserts,
    returns the new row's `id`. Throws if `channelId` already exists (UNIQUE constraint —
    caller catches and reports a friendly error, same convention as `seasons` INSERT).
  - `db.removeRelayChannel(id)` → deletes the channel row. Does NOT delete existing
    `translation_relay_messages` rows (historical data, harmless to keep).
  - `db.setRelayChannelWebhook(id, webhookId, webhookToken)` → updates cached webhook creds
    (pass `null, null` to clear when a webhook is confirmed deleted).
  - `db.insertRelayMessage({ relayGroupMessageId, channelId, messageId, authorId,
    authorDisplayName, language, text })` → inserts one row, returns its own `id`.
  - `db.getRelayMessageByMessageId(messageId)` → single row (`relay_group_message_id`,
    `channel_id`, `text`, `language`, ...) or `undefined`. Used to resolve what a reply is
    replying to.
  - `db.getRelayMessagesByGroupId(relayGroupMessageId)` → array of every copy sharing that
    group id (all channels). Used to find the per-channel quoted text for a reply.
  - `db.insertTranslationUsage({ messageId, inputTokens, outputTokens, targetCount })` →
    inserts one row into `translation_usage`.

- [ ] **Step 1: Add the three CREATE TABLE statements to `utils/db.js`**

Add this block inside the existing `db.exec(\`...\`)` template literal in `utils/db.js`,
immediately after the `transfer_approval_eligibility` table (the last one currently defined,
just before the closing backtick + `);` around line 325):

```sql
  CREATE TABLE IF NOT EXISTS translation_relay_channels (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id    TEXT NOT NULL UNIQUE,
    language      TEXT NOT NULL,
    flag_emoji    TEXT NOT NULL,
    relay_group   TEXT NOT NULL DEFAULT 'default',
    webhook_id    TEXT,
    webhook_token TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_trc_group ON translation_relay_channels(relay_group);

  -- One row per relayed copy of a message, INCLUDING the original (channel_id = source
  -- channel, message_id = the original message's own id). relay_group_message_id is shared
  -- across every copy of the same logical message: it is the `id` of that message's
  -- first-inserted row (the source copy), looked up via whichever message a reply references.
  CREATE TABLE IF NOT EXISTS translation_relay_messages (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    relay_group_message_id INTEGER NOT NULL,
    channel_id              TEXT NOT NULL,
    message_id               TEXT NOT NULL UNIQUE,
    author_id                TEXT NOT NULL,
    author_display_name      TEXT NOT NULL,
    language                 TEXT NOT NULL,
    text                     TEXT NOT NULL,
    created_at               TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_trm_group_msg ON translation_relay_messages(relay_group_message_id);
  CREATE INDEX IF NOT EXISTS idx_trm_message ON translation_relay_messages(message_id);

  CREATE TABLE IF NOT EXISTS translation_usage (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id    TEXT NOT NULL,
    input_tokens  INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    target_count  INTEGER NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
```

- [ ] **Step 2: Add the helper functions to `utils/db.js`**

Add below the existing `getTransferApprovalDms` function (just before the `module.exports`
block):

```javascript
/** List relay channels in a group, ordered by id (stable for iteration). */
function getRelayChannels(relayGroup = 'default') {
    return db.prepare('SELECT * FROM translation_relay_channels WHERE relay_group = ? ORDER BY id')
        .all(relayGroup);
}

function getRelayChannelByChannelId(channelId) {
    return db.prepare('SELECT * FROM translation_relay_channels WHERE channel_id = ?').get(channelId);
}

function addRelayChannel({ channelId, language, flagEmoji, relayGroup = 'default' }) {
    const r = db.prepare(`INSERT INTO translation_relay_channels (channel_id, language, flag_emoji, relay_group)
        VALUES (?, ?, ?, ?)`).run(channelId, language, flagEmoji, relayGroup);
    return r.lastInsertRowid;
}

function removeRelayChannel(id) {
    db.prepare('DELETE FROM translation_relay_channels WHERE id = ?').run(id);
}

function setRelayChannelWebhook(id, webhookId, webhookToken) {
    db.prepare('UPDATE translation_relay_channels SET webhook_id = ?, webhook_token = ? WHERE id = ?')
        .run(webhookId, webhookToken, id);
}

function insertRelayMessage({ relayGroupMessageId, channelId, messageId, authorId, authorDisplayName, language, text }) {
    const r = db.prepare(`INSERT INTO translation_relay_messages
        (relay_group_message_id, channel_id, message_id, author_id, author_display_name, language, text)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(relayGroupMessageId, channelId, messageId, authorId, authorDisplayName, language, text);
    return r.lastInsertRowid;
}

function getRelayMessageByMessageId(messageId) {
    return db.prepare('SELECT * FROM translation_relay_messages WHERE message_id = ?').get(messageId);
}

function getRelayMessagesByGroupId(relayGroupMessageId) {
    return db.prepare('SELECT * FROM translation_relay_messages WHERE relay_group_message_id = ?')
        .all(relayGroupMessageId);
}

function insertTranslationUsage({ messageId, inputTokens, outputTokens, targetCount }) {
    db.prepare(`INSERT INTO translation_usage (message_id, input_tokens, output_tokens, target_count)
        VALUES (?, ?, ?, ?)`).run(messageId, inputTokens, outputTokens, targetCount);
}
```

Add matching `module.exports.xxx = xxx;` lines for all nine functions above, following the
exact pattern of the existing exports at the bottom of the file.

- [ ] **Step 3: Write `utils/translationRelay.test.js`**

```javascript
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('./db');

test('addRelayChannel + getRelayChannels round-trip', () => {
    const id = db.addRelayChannel({ channelId: 'test-ch-1', language: 'English', flagEmoji: '🇺🇸', relayGroup: 'test-group-1' });
    const rows = db.getRelayChannels('test-group-1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, id);
    assert.equal(rows[0].channel_id, 'test-ch-1');
    assert.equal(rows[0].language, 'English');
    db.removeRelayChannel(id);
});

test('getRelayChannelByChannelId finds the right row', () => {
    const id = db.addRelayChannel({ channelId: 'test-ch-2', language: 'Spanish', flagEmoji: '🇪🇸', relayGroup: 'test-group-2' });
    const row = db.getRelayChannelByChannelId('test-ch-2');
    assert.equal(row.id, id);
    db.removeRelayChannel(id);
});

test('addRelayChannel rejects duplicate channel_id', () => {
    const id = db.addRelayChannel({ channelId: 'test-ch-3', language: 'English', flagEmoji: '🇺🇸', relayGroup: 'test-group-3' });
    assert.throws(() => db.addRelayChannel({ channelId: 'test-ch-3', language: 'French', flagEmoji: '🇫🇷', relayGroup: 'test-group-3' }));
    db.removeRelayChannel(id);
});

test('setRelayChannelWebhook updates cached webhook creds', () => {
    const id = db.addRelayChannel({ channelId: 'test-ch-4', language: 'English', flagEmoji: '🇺🇸', relayGroup: 'test-group-4' });
    db.setRelayChannelWebhook(id, 'wh-id-123', 'wh-token-abc');
    const row = db.getRelayChannelByChannelId('test-ch-4');
    assert.equal(row.webhook_id, 'wh-id-123');
    assert.equal(row.webhook_token, 'wh-token-abc');
    db.removeRelayChannel(id);
});

test('insertRelayMessage + getRelayMessageByMessageId + getRelayMessagesByGroupId', () => {
    const groupId = db.insertRelayMessage({
        relayGroupMessageId: 0, channelId: 'test-ch-5', messageId: 'msg-source-1',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'English', text: 'hello',
    });
    db.insertRelayMessage({
        relayGroupMessageId: groupId, channelId: 'test-ch-6', messageId: 'msg-copy-1',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'Spanish', text: 'hola',
    });

    const found = db.getRelayMessageByMessageId('msg-copy-1');
    assert.equal(found.relay_group_message_id, groupId);
    assert.equal(found.text, 'hola');

    const group = db.getRelayMessagesByGroupId(groupId);
    assert.equal(group.length, 2);
});

test('insertTranslationUsage stores a usage row', () => {
    db.insertTranslationUsage({ messageId: 'msg-usage-1', inputTokens: 42, outputTokens: 17, targetCount: 2 });
    const row = db.prepare('SELECT * FROM translation_usage WHERE message_id = ?').get('msg-usage-1');
    assert.equal(row.input_tokens, 42);
    assert.equal(row.output_tokens, 17);
    assert.equal(row.target_count, 2);
});
```

- [ ] **Step 4: Run the test file**

Run: `node --test utils/translationRelay.test.js`
Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add utils/db.js utils/translationRelay.test.js
git commit -m "feat: add translation relay schema + DB helpers"
```

---

### Task 2: Core relay handler — translation call, loop guard, webhook posting, reply quoting

**Files:**
- Create: `utils/handlers/translationRelayHandler.js`
- Modify: `index.js` (wire the handler into `messageCreate`)

**Interfaces:**
- Consumes: every `db.*` function from Task 1
- Produces: `handleTranslationRelay(message, client)` — the single exported function, called
  from `index.js`'s `messageCreate` listener exactly like `handlePromoCode`.

- [ ] **Step 1: Write `utils/handlers/translationRelayHandler.js`**

```javascript
const { WebhookClient } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db');

const anthropic = new Anthropic();

const QUOTE_MAX_LEN = 100;

function truncateQuote(text) {
    const t = text.replace(/\n/g, ' ').trim();
    return t.length > QUOTE_MAX_LEN ? t.slice(0, QUOTE_MAX_LEN) + '…' : t;
}

async function getOrCreateWebhook(channelRow, channel) {
    if (channelRow.webhook_id && channelRow.webhook_token) {
        return new WebhookClient({ id: channelRow.webhook_id, token: channelRow.webhook_token });
    }
    const webhook = await channel.createWebhook({ name: 'Translation Relay' });
    db.setRelayChannelWebhook(channelRow.id, webhook.id, webhook.token);
    return new WebhookClient({ id: webhook.id, token: webhook.token });
}

async function sendViaWebhook(channelRow, channel, payload) {
    try {
        const webhook = await getOrCreateWebhook(channelRow, channel);
        return await webhook.send(payload);
    } catch (err) {
        if (err.code === 10015) {
            // Unknown Webhook -- deleted on Discord's side, clear cache and retry once
            db.setRelayChannelWebhook(channelRow.id, null, null);
            const fresh = await channel.createWebhook({ name: 'Translation Relay' });
            db.setRelayChannelWebhook(channelRow.id, fresh.id, fresh.token);
            const webhook = new WebhookClient({ id: fresh.id, token: fresh.token });
            return await webhook.send(payload);
        }
        console.error(`[TranslationRelay] Failed to send to channel ${channelRow.channel_id}:`, err.message);
        return null;
    }
}

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
    const parsed = JSON.parse(raw); // throws on malformed JSON -- caller catches
    for (const lang of targetLanguages) {
        if (typeof parsed[lang] !== 'string') throw new Error(`Missing translation for ${lang}`);
    }
    return { translations: parsed, usage: response.usage };
}

async function handleTranslationRelay(message, client) {
    if (message.author.bot) return; // loop guard: covers our own relay webhooks + any other bot
    const sourceChannelRow = db.getRelayChannelByChannelId(message.channelId);
    if (!sourceChannelRow) return;
    const text = (message.content || '').trim();
    if (!text) return;

    const allChannels = db.getRelayChannels(sourceChannelRow.relay_group);
    const targetChannels = allChannels.filter(c => c.id !== sourceChannelRow.id);
    if (targetChannels.length === 0) return;

    const authorDisplayName = message.member?.displayName ?? message.author.username;
    const authorAvatarURL = message.author.displayAvatarURL();

    // Record the source message's own row first -- its id becomes the shared
    // relay_group_message_id for every translated copy. SQLite can't reference a row's own
    // not-yet-known id in the same INSERT, so insert with a placeholder then self-update.
    const relayGroupMessageId = db.insertRelayMessage({
        relayGroupMessageId: 0,
        channelId: message.channelId,
        messageId: message.id,
        authorId: message.author.id,
        authorDisplayName,
        language: sourceChannelRow.language,
        text,
    });
    db.prepare('UPDATE translation_relay_messages SET relay_group_message_id = ? WHERE id = ?')
        .run(relayGroupMessageId, relayGroupMessageId);

    // Resolve reply context, if any
    let replySource = null;
    if (message.reference?.messageId) {
        const referenced = db.getRelayMessageByMessageId(message.reference.messageId);
        if (referenced) {
            replySource = db.getRelayMessagesByGroupId(referenced.relay_group_message_id);
        }
    }

    const targetLanguages = targetChannels.map(c => c.language);
    let translations = null;
    let usage = null;
    try {
        const result = await callClaude(sourceChannelRow.language, targetLanguages, text);
        translations = result.translations;
        usage = result.usage;
    } catch (err) {
        console.error('[TranslationRelay] Claude translation failed:', err.message);
    }

    if (translations) {
        db.insertTranslationUsage({
            messageId: message.id,
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            targetCount: targetLanguages.length,
        });
    }

    for (const targetRow of targetChannels) {
        const channel = await client.channels.fetch(targetRow.channel_id).catch(() => null);
        if (!channel) continue;

        const bodyText = translations ? translations[targetRow.language] : text;
        let quotePrefix = '';
        if (replySource) {
            const quoteRow = replySource.find(r => r.channel_id === targetRow.channel_id);
            if (quoteRow) quotePrefix = `> ${truncateQuote(quoteRow.text)}\n`;
        }

        const sent = await sendViaWebhook(targetRow, channel, {
            content: quotePrefix + bodyText,
            username: authorDisplayName,
            avatarURL: authorAvatarURL,
        });
        if (!sent) continue;

        db.insertRelayMessage({
            relayGroupMessageId,
            channelId: targetRow.channel_id,
            messageId: sent.id,
            authorId: message.author.id,
            authorDisplayName,
            language: targetRow.language,
            text: bodyText,
        });

        if (!translations) {
            channel.messages.fetch(sent.id)
                .then(m => m.react(targetRow.flag_emoji))
                .catch(() => {});
        }
    }
}

module.exports = { handleTranslationRelay };
```

Since `utils/db.js` does `module.exports = db;` then attaches helpers as properties of that
same object, `db.prepare(...)` and `db.getRelayChannels(...)` both work directly off the one
`require('../db')` import — no second require needed anywhere in this file.

- [ ] **Step 2: Wire the handler into `index.js`**

Add near the top with the other handler requires (after the `handlePromoCode` require):

```javascript
const { handleTranslationRelay } = require('./utils/handlers/translationRelayHandler');
```

In the `messageCreate` listener, add the call alongside the existing ones:

```javascript
client.on('messageCreate', message => {
  handleMessage(message, client);
  handlePromoCode(message);
  handleTranslationRelay(message, client).catch(err => console.error('[TranslationRelay] Unhandled error:', err));
});
```

- [ ] **Step 3: Manual smoke test in the test bot**

No automated test for this step (requires live Discord channels + a real Claude call — matches
how `promoCodeHandler.js` and `translationRoleHandler.js` also have no test files). Verify via
the test bot instead:

1. `pm2 restart meerbot-test` to pick up the change.
2. Insert two rows into `translation_relay_channels` (via the sqlite MCP tool, using two real
   test-server channel IDs):
   ```sql
   INSERT INTO translation_relay_channels (channel_id, language, flag_emoji) VALUES ('<channel-A-id>', 'English', '🇺🇸');
   INSERT INTO translation_relay_channels (channel_id, language, flag_emoji) VALUES ('<channel-B-id>', 'Spanish', '🇪🇸');
   ```
3. Post a message in Channel A. Confirm a translated copy appears in Channel B via webhook,
   with the poster's display name/avatar.
4. Reply to the relayed copy in Channel B. Confirm the reply appears in Channel A with a quoted
   English prefix.
5. Check `pm2 logs meerbot-test --lines 30 --nostream` for unexpected errors.

- [ ] **Step 4: Commit**

```bash
git add utils/handlers/translationRelayHandler.js index.js
git commit -m "feat: add translation relay message handler"
```

---

### Task 3: Admin API routes + OPERATIONS registration

**Files:**
- Modify: `admin/server.js` (add routes)
- Modify: `admin/auth.js` (add OPERATIONS entry)

**Interfaces:**
- Consumes: `db.getRelayChannels`, `db.addRelayChannel`, `db.removeRelayChannel` (Task 1)
- Produces (consumed by Task 4): `GET /api/translation-relay`, `POST /api/translation-relay`,
  `DELETE /api/translation-relay/:id`

- [ ] **Step 1: Add the routes to `admin/server.js`**

Add near the `ally-seasons` routes, following the same comment-banner convention used
throughout the file:

```javascript
// ── Translation Relay ───────────────────────────────────────────────────────

// GET /api/translation-relay — list configured relay channels
app.get('/api/translation-relay', (req, res) => {
    try {
        res.json(db.getRelayChannels());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/translation-relay — add a channel to the relay
app.post('/api/translation-relay', (req, res) => {
    const channelId = (req.body.channelId || '').trim();
    const language = (req.body.language || '').trim();
    const flagEmoji = (req.body.flagEmoji || '').trim();
    if (!channelId || !language || !flagEmoji) {
        return res.status(400).json({ error: 'channelId, language, and flagEmoji are all required' });
    }
    try {
        const id = db.addRelayChannel({ channelId, language, flagEmoji });
        res.json({ ok: true, id });
    } catch (err) {
        res.status(err.message.includes('UNIQUE') ? 400 : 500)
           .json({ error: err.message.includes('UNIQUE') ? 'That channel is already in the relay' : err.message });
    }
});

// DELETE /api/translation-relay/:id — remove a channel from the relay
app.delete('/api/translation-relay/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
        db.removeRelayChannel(id);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
```

Confirm `db` at the top of `admin/server.js` is required the same way it is elsewhere in that
file (a single `require('../utils/db')` import) — no new require needed since Task 1 attached
the new helpers as properties of that same module object.

- [ ] **Step 2: Add the OPERATIONS entry to `admin/auth.js`**

Add alongside the existing `seasons` entry, same array, same style:

```javascript
{ key: 'translation-relay', group: 'Translation Relay', label: 'Edit translation relay channels', defaultTier: 'manage', match: r => /^\/api\/translation-relay/.test(r.path) },
```

- [ ] **Step 3: Manual verification**

The `meerbot-test` PM2 process only runs the bot, not admin/stats (per the current test-bot
scope), so verify these new routes against the real admin panel (`meerbot-admin`, port 3001)
instead — these are new, currently-empty tables and routes, so this carries no risk to existing
production data:

1. Restart `meerbot-admin`: `pm2 restart meerbot-admin --update-env`.
2. `GET /api/translation-relay` returns `[]`.
3. `POST /api/translation-relay` with body `{"channelId":"123","language":"Test","flagEmoji":"🏳️"}`
   returns `{"ok":true,"id":<n>}`; a duplicate `channelId` POST returns 400 with the friendly
   error message.
4. `DELETE /api/translation-relay/<id>` removes it, confirmed via a follow-up GET returning `[]`
   again.
5. Confirm a "Translation Relay" entry appears in the admin panel's Access tab (Config → Access,
   local tier only).

- [ ] **Step 4: Commit**

```bash
git add admin/server.js admin/auth.js
git commit -m "feat: add translation relay admin API routes"
```

---

### Task 4: Admin UI tab

**Files:**
- Create: `admin/src/translationRelay.js`
- Modify: `admin/src/index.html` (new section markup)
- Modify: `admin/src/main.js` (tab wiring)

**Interfaces:**
- Consumes: `GET`/`POST`/`DELETE /api/translation-relay` (Task 3), `state.channelList`
  (existing global state)
- Produces: nothing (last task)

- [ ] **Step 1: Add the section markup to `admin/src/index.html`**

Add a new `<div class="section" id="section-translationrelay">` block placed right after the
existing `section-seasons` block (before `section-serverstructure` begins), following the same
structure as the seasons block:

```html
  <div class="section" id="section-translationrelay">
    <div class="section-title">Translation Relay</div>
    <p style="color:var(--color-neutral-content); font-size:12px; margin-bottom:12px">
      Channels in this list stay in sync as one translated conversation: a message posted in
      any one of them is relayed into all the others, translated into each channel's language,
      and posted as the original author via webhook.
    </p>
    <div style="margin-bottom:16px; display:flex; gap:8px; flex-wrap:wrap">
      <select id="newRelayChannel" style="max-width:280px"></select>
      <input id="newRelayLanguage" placeholder="Language (e.g. Spanish)" style="max-width:180px">
      <input id="newRelayFlag" placeholder="Flag emoji (e.g. 🇪🇸)" style="max-width:100px">
      <button id="addRelayChannelBtn" class="save-btn" style="background:var(--color-success)">+ Add Channel</button>
    </div>
    <div class="panel-card">
      <table class="jobs-table">
        <thead>
          <tr class="jobs-header-row"><th>Channel</th><th>Language</th><th>Flag</th><th>Actions</th></tr>
        </thead>
        <tbody id="translationRelayBody"></tbody>
      </table>
    </div>
  </div>
```

- [ ] **Step 2: Write `admin/src/translationRelay.js`**

```javascript
import { escHtml } from './utils.js';
import { state } from './state.js';

let relayData = [];

export async function loadTranslationRelay() {
    try {
        relayData = await fetch('/api/translation-relay').then(r => r.json());
    } catch {
        relayData = [];
    }
    renderTranslationRelay();
}

function channelLabel(channelId) {
    const ch = state.channelList.find(c => c.id === channelId);
    return ch ? `${ch.name.replace(/[^\w\s#-]/gu, '').trim()} (${channelId})` : channelId;
}

export function renderTranslationRelay() {
    const tbody = document.getElementById('translationRelayBody');
    if (!tbody) return;
    if (!relayData.length) {
        tbody.innerHTML = '<tr><td colspan="4" style="color:var(--color-neutral-content)">No relay channels configured.</td></tr>';
    } else {
        tbody.innerHTML = '';
        for (const r of relayData) {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td style="color:var(--color-base-content)">${escHtml(channelLabel(r.channel_id))}</td>
                <td>${escHtml(r.language)}</td>
                <td>${escHtml(r.flag_emoji)}</td>
                <td class="action-col"></td>`;
            const delBtn = document.createElement('button');
            delBtn.className = 'reset-btn';
            delBtn.textContent = 'Remove';
            delBtn.addEventListener('click', () => removeRelayChannel(r.id, channelLabel(r.channel_id)));
            tr.lastElementChild.append(delBtn);
            tbody.appendChild(tr);
        }
    }

    const select = document.getElementById('newRelayChannel');
    if (select) {
        select.innerHTML = '<option value="">— choose a channel —</option>' +
            state.channelList.map(ch => `<option value="${ch.id}">${escHtml(ch.name)} (${ch.id})</option>`).join('');
    }
}

async function addRelayChannel() {
    const channelId = document.getElementById('newRelayChannel').value;
    const language = document.getElementById('newRelayLanguage').value.trim();
    const flagEmoji = document.getElementById('newRelayFlag').value.trim();
    if (!channelId || !language || !flagEmoji) {
        alert('Channel, language, and flag emoji are all required.');
        return;
    }
    const res = await fetch('/api/translation-relay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId, language, flagEmoji }),
    });
    const body = await res.json();
    if (!res.ok) {
        alert(body.error || 'Failed to add channel');
        return;
    }
    document.getElementById('newRelayLanguage').value = '';
    document.getElementById('newRelayFlag').value = '';
    await loadTranslationRelay();
}

async function removeRelayChannel(id, label) {
    if (!confirm(`Remove ${label} from the translation relay?`)) return;
    const res = await fetch(`/api/translation-relay/${id}`, { method: 'DELETE' });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(body.error || 'Failed to remove channel');
        return;
    }
    await loadTranslationRelay();
}

export function initTranslationRelay() {
    document.getElementById('addRelayChannelBtn')?.addEventListener('click', addRelayChannel);
}
```

- [ ] **Step 3: Wire the tab into `admin/src/main.js`**

Add the import near the top with the other tab-module imports:

```javascript
import { loadTranslationRelay, initTranslationRelay } from './translationRelay.js';
```

Add `{ id: 'translationrelay', label: 'Translation Relay', local: false }` to the `extras`
array, after the `seasons` entry.

Add `'translationrelay'` right after `'seasons'` in the `cats` array inside `switchTab`, so
tab-click highlighting stays correctly indexed against the same relative position used in
`extras`.

Add a case in `switchTab` alongside the existing `if (cat === 'access')` /
`if (cat === 'serverstructure')` lines:

```javascript
if (cat === 'translationrelay') loadTranslationRelay();
```

Before finalizing this step, read the bottom section of `admin/src/seasons.js` (past line 60,
not yet read as of writing this plan) to find how its own button listeners get attached during
initial page load, and call `initTranslationRelay()` at the equivalent point in the bootstrap
sequence — whether that's a dedicated `initSeasons()`-style call or something wired inline. Match
whatever pattern `seasons.js` actually uses so the new tab's init timing is consistent with its
closest sibling.

- [ ] **Step 4: Manual verification**

1. Rebuild the admin Vite bundle: `npm run build --prefix admin`.
2. Restart `meerbot-admin`: `pm2 restart meerbot-admin --update-env`.
3. Open `http://localhost:3001`, navigate to the new "Translation Relay" tab.
4. Add a channel using the form, confirm it appears in the table.
5. Remove it, confirm it disappears.
6. Confirm the add/remove controls are gated the same way as the `seasons` tab's controls
   (both use `manage` tier).

- [ ] **Step 5: Commit**

```bash
git add admin/src/translationRelay.js admin/src/index.html admin/src/main.js
git commit -m "feat: add translation relay admin UI tab"
```

---

## Final Verification

After all four tasks: run the full manual test matrix from the spec's Testing Plan section
end-to-end — relay behavior in the test bot, admin CRUD against the real admin panel (new,
currently-empty tables/routes only, no risk to existing production data or Discord-facing
behavior). Confirm `translation_usage` rows accumulate with plausible token counts. Leave the
feature configured with 0 relay channels in the real `guild.db` (clean up any rows added during
Task 3/4 verification) until you're ready to actually turn it on with real channels.
