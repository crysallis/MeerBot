# Configurable Auto-Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded, undiscoverable 30-second auto-delete baked into `/guild` and `/member` with an opt-in, admin-panel-configurable system covering every slash command (per command/subcommand) and every `message_reactions` rule (reply/message response types).

**Architecture:** A new `auto_delete_rules` table (mirroring `command_permissions`' shape and precedence) holds on/off rows. A single new lookup helper (`utils/autoDelete.js`) is called from exactly two places: `index.js`'s existing slash-command dispatch chokepoint (after `cmd.execute()` returns), and `utils/messageReactions.js` (after a `reply`/`message` response sends). One global delay lives in `bot_config.AUTO_DELETE_SECONDS`. The admin panel gets new REST endpoints plus UI in the existing Permissions tab (for commands) and the existing reaction-rules UI (for rules).

**Tech Stack:** Node.js, discord.js v14, better-sqlite3, Express (admin panel), vanilla JS admin frontend (Vite).

**Spec:** `docs/superpowers/specs/2026-09-03-configurable-autodelete-design.md`

## Global Constraints

- Default is OFF (opt-in) for anything with no row in `auto_delete_rules` — this must not change behavior for the 22 commands/all reaction rules that currently post permanently.
- One global delay only (`bot_config.AUTO_DELETE_SECONDS`, default `30`) — no per-item delay.
- Precedence for command scope: exact `(command, subcommand)` row wins over `(command, subcommand=NULL)` whole-command row, decided independently the same way `permissions.js`'s `pickRows` already does it for `command_permissions`.
- `emoji` and `dm` reaction-rule response types are never eligible for auto-delete.
- An error reply (the `catch` branch in `index.js`'s dispatcher) is never auto-deleted.
- All `deleteReply()`/`message.delete()` calls are wrapped in `.catch(() => {})` — a failed delete is never surfaced.
- New admin endpoints are tier-gated via `admin/auth.js`'s `OPERATIONS` registry, `defaultTier: 'manage'`.

---

## File Structure

- **Modify** `utils/db.js` — add `auto_delete_rules` table CREATE (near `command_permissions`).
- **Modify** `utils/botConfig.js` — add `AUTO_DELETE_SECONDS` to `CONFIG_META`.
- **Rewrite** `utils/autoDelete.js` — replace the fixed-30s-only helper with a DB-aware lookup + scheduler, exporting `scheduleCommandAutoDelete(interaction, command, subcommand)` and `scheduleReactionAutoDelete(message, ruleId)`.
- **Create** `utils/autoDelete.test.js` — unit tests for the precedence lookup.
- **Modify** `index.js` — call `scheduleCommandAutoDelete` after `cmd.execute()` succeeds; remove nothing here (dispatcher already has the chokepoint).
- **Modify** `slash-commands/guild.js` — remove the three `autoDelete()` call sites and the now-unused import.
- **Modify** `slash-commands/member.js` — remove the two `autoDelete()` call sites and the now-unused import.
- **Modify** `utils/messageReactions.js` — call `scheduleReactionAutoDelete` after `reply`/`message` sends.
- **Modify** `admin/server.js` — add `GET/POST/DELETE /api/auto-delete` endpoints.
- **Modify** `admin/auth.js` — register the new endpoints in `OPERATIONS`.
- **Modify** `admin/src/permissions.js` — add an auto-delete checkbox section reusing the existing command/subcommand dropdowns.
- **Modify** admin reaction-rules UI file (found in Task 7) — add an auto-delete checkbox per rule row.

---

### Task 1: Schema — `auto_delete_rules` table + `AUTO_DELETE_SECONDS` config key

**Files:**
- Modify: `utils/db.js` (add CREATE TABLE block near line 257, right after `command_permissions`)
- Modify: `utils/botConfig.js` (add one `CONFIG_META` entry)
- Test: `utils/db.test.js` (new file if none exists for schema smoke-checks — check first)

**Interfaces:**
- Produces: table `auto_delete_rules(id, scope, command, subcommand, reaction_rule_id, enabled, created_at)` with `UNIQUE(scope, command, subcommand, reaction_rule_id)` and index `idx_adr_lookup(scope, command, subcommand)`.
- Produces: `botConfig.get('AUTO_DELETE_SECONDS')` returns `'30'` by default (string, matching every other `botConfig` value).

- [ ] **Step 1: Check for an existing db schema test file**

Run: `ls utils/db.test.js 2>&1 || echo "no existing file"`

If it exists, add to it in later steps instead of creating a new one. If not, Task 1's test step creates one.

- [ ] **Step 2: Add the `auto_delete_rules` CREATE TABLE block to `utils/db.js`**

Insert immediately after the existing `command_permissions` block (after line 266's index statement):

```js
  CREATE TABLE IF NOT EXISTS auto_delete_rules (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    scope            TEXT NOT NULL CHECK(scope IN ('command', 'reaction_rule')),
    command          TEXT,
    subcommand       TEXT,
    reaction_rule_id INTEGER,
    enabled          INTEGER NOT NULL DEFAULT 1,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(scope, command, subcommand, reaction_rule_id),
    FOREIGN KEY (reaction_rule_id) REFERENCES message_reactions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_adr_lookup ON auto_delete_rules(scope, command, subcommand);
```

- [ ] **Step 3: Add `AUTO_DELETE_SECONDS` to `CONFIG_META` in `utils/botConfig.js`**

Add under the `// --- Thresholds ---` section (after `LATE_WARNING_MINUTES` at line 24):

```js
    AUTO_DELETE_SECONDS:         { label: 'Auto-Delete Delay (seconds)', description: 'How long after posting an auto-delete-enabled reply is removed', category: 'thresholds', default: '30' },
```

- [ ] **Step 4: Write a schema smoke test**

Create `utils/db.test.js` if it didn't already exist, or add to it:

```js
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('./db');

test('auto_delete_rules table exists with expected columns', () => {
    const cols = db.prepare("PRAGMA table_info(auto_delete_rules)").all().map(c => c.name);
    assert.deepEqual(cols.sort(), ['command', 'created_at', 'enabled', 'id', 'reaction_rule_id', 'scope', 'subcommand'].sort());
});

test('AUTO_DELETE_SECONDS config default is 30', () => {
    const botConfig = require('./botConfig');
    assert.equal(botConfig.get('AUTO_DELETE_SECONDS'), '30');
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- --test-name-pattern="auto_delete_rules|AUTO_DELETE_SECONDS"`
Expected: both tests PASS (table already created on `require('./db')` since `db.exec` runs at module load).

- [ ] **Step 6: Commit**

```bash
git add utils/db.js utils/botConfig.js utils/db.test.js
git commit -m "feat: add auto_delete_rules table and AUTO_DELETE_SECONDS config key"
```

---

### Task 2: Lookup helper — `utils/autoDelete.js`

**Files:**
- Modify (full rewrite): `utils/autoDelete.js`
- Test: `utils/autoDelete.test.js` (new)

**Interfaces:**
- Consumes: `db` from `./db` (raw `better-sqlite3` prepared statements, same style as `permissions.js`), `botConfig.get` from `./botConfig`.
- Produces:
  - `isCommandAutoDeleteEnabled(command, subcommand)` → `boolean` — exported for testing, used internally.
  - `scheduleCommandAutoDelete(interaction, command, subcommand)` → `void`, called from `index.js`.
  - `scheduleReactionAutoDelete(message, ruleId)` → `void`, called from `utils/messageReactions.js`.

- [ ] **Step 1: Write the failing precedence tests**

Create `utils/autoDelete.test.js`:

```js
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('./db');
const { isCommandAutoDeleteEnabled } = require('./autoDelete');

// Namespaced command name so this test can never collide with real saved rows.
const CMD = 'test_autodelete_cmd';

function insertRule({ subcommand = null, enabled = 1 }) {
    db.prepare(`INSERT INTO auto_delete_rules (scope, command, subcommand, enabled)
        VALUES ('command', ?, ?, ?)`).run(CMD, subcommand, enabled);
}

function clearRules() {
    db.prepare("DELETE FROM auto_delete_rules WHERE scope = 'command' AND command = ?").run(CMD);
}

test.afterEach(() => clearRules());

test('no rule -> disabled by default', () => {
    assert.equal(isCommandAutoDeleteEnabled(CMD, 'status'), false);
});

test('whole-command enabled row applies to any subcommand', () => {
    insertRule({ subcommand: null, enabled: 1 });
    assert.equal(isCommandAutoDeleteEnabled(CMD, 'status'), true);
    assert.equal(isCommandAutoDeleteEnabled(CMD, 'top'), true);
});

test('subcommand-specific row overrides whole-command row', () => {
    insertRule({ subcommand: null, enabled: 1 });
    insertRule({ subcommand: 'status', enabled: 0 });
    assert.equal(isCommandAutoDeleteEnabled(CMD, 'status'), false);
    assert.equal(isCommandAutoDeleteEnabled(CMD, 'top'), true);
});

test('command with no subcommands uses subcommand=null lookup', () => {
    insertRule({ subcommand: null, enabled: 1 });
    assert.equal(isCommandAutoDeleteEnabled(CMD, null), true);
});

test('scheduleCommandAutoDelete swallows a DB read failure instead of throwing', async () => {
    // Simulates SQLITE_BUSY from a concurrent /scan write -- must not propagate into
    // index.js's dispatch try/catch, which would editReply() over a successful command.
    const { scheduleCommandAutoDelete } = require('./autoDelete');
    const originalPrepare = db.prepare;
    db.prepare = () => { throw new Error('SQLITE_BUSY: database is locked'); };
    const fakeInteraction = { replied: true, deferred: false, deleteReply: async () => {} };
    try {
        assert.doesNotThrow(() => scheduleCommandAutoDelete(fakeInteraction, CMD, 'status'));
    } finally {
        db.prepare = originalPrepare;
    }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="autodelete"`
Expected: FAIL — `isCommandAutoDeleteEnabled is not a function` (current `utils/autoDelete.js` only exports `autoDelete`).

- [ ] **Step 3: Rewrite `utils/autoDelete.js`**

```js
'use strict';
const db = require('./db');
const botConfig = require('./botConfig');
const { pickRows } = require('./permissions');

function getDelayMs() {
    return Number(botConfig.get('AUTO_DELETE_SECONDS')) * 1000;
}

function isCommandAutoDeleteEnabled(command, subcommand) {
    const rows = db.prepare(
        `SELECT subcommand, enabled FROM auto_delete_rules
         WHERE scope = 'command' AND command = ? AND (subcommand IS ? OR subcommand IS NULL)`
    ).all(command, subcommand);
    const picked = pickRows(rows, subcommand);
    return picked.length > 0 && picked.some(r => r.enabled);
}

function isReactionAutoDeleteEnabled(ruleId) {
    const row = db.prepare(
        `SELECT enabled FROM auto_delete_rules WHERE scope = 'reaction_rule' AND reaction_rule_id = ?`
    ).get(ruleId);
    return !!row?.enabled;
}

function scheduleCommandAutoDelete(interaction, command, subcommand) {
    if (!interaction.replied && !interaction.deferred) return;
    let enabled;
    try {
        enabled = isCommandAutoDeleteEnabled(command, subcommand);
    } catch (err) {
        // A DB read failure here must never bubble into index.js's command dispatch
        // try/catch -- that catch calls interaction.editReply() on any thrown error,
        // which would silently overwrite this command's already-successful reply
        // with a generic error message. Swallow and skip auto-delete instead.
        console.error(`[autoDelete] lookup failed for ${command}/${subcommand ?? 'null'}: ${err.message}`);
        return;
    }
    if (!enabled) return;
    setTimeout(() => {
        interaction.deleteReply().catch(() => {});
    }, getDelayMs());
}

function scheduleReactionAutoDelete(message, ruleId) {
    if (!message) return;
    let enabled;
    try {
        enabled = isReactionAutoDeleteEnabled(ruleId);
    } catch (err) {
        console.error(`[autoDelete] reaction rule lookup failed for rule ${ruleId}: ${err.message}`);
        return;
    }
    if (!enabled) return;
    setTimeout(() => {
        message.delete().catch(() => {});
    }, getDelayMs());
}

module.exports = {
    isCommandAutoDeleteEnabled,
    isReactionAutoDeleteEnabled,
    scheduleCommandAutoDelete,
    scheduleReactionAutoDelete,
};
```

Note: `pickRows` is reused directly from `./permissions` (it operates on any array of `{subcommand, ...}` rows — already generic, not `command_permissions`-specific — so it's already correct here since it filters by `r.subcommand === subcommand` and needs the `enabled` field only from the caller).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="autodelete"`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Commit**

```bash
git add utils/autoDelete.js utils/autoDelete.test.js
git commit -m "feat: DB-backed auto-delete lookup helper replacing fixed 30s version"
```

---

### Task 3: Wire slash commands through `index.js`; remove old call sites

**Files:**
- Modify: `index.js:158-161` (dispatch block)
- Modify: `slash-commands/guild.js` (remove `autoDelete` import + 3 call sites)
- Modify: `slash-commands/member.js` (remove `autoDelete` import + 2 call sites)
- Test: manual (Discord live test — no automated interaction-object test harness exists in this repo for `index.js`'s dispatcher; covered by Task 2's unit tests plus live verification in Task 8)

**Interfaces:**
- Consumes: `scheduleCommandAutoDelete(interaction, command, subcommand)` from Task 2.

- [ ] **Step 1: Update `index.js`'s dispatch block**

Locate the block at `index.js:158-161`:

```js
  logCommand(interaction);

  try {
    await cmd.execute(interaction);
  } catch (err) {
```

Replace with:

```js
  logCommand(interaction);

  try {
    await cmd.execute(interaction);
    scheduleCommandAutoDelete(interaction, interaction.commandName, interaction.options.getSubcommand(false));
  } catch (err) {
```

Add the import near the top of `index.js`, alongside the existing `logCommand` import:

```js
const { scheduleCommandAutoDelete } = require('./utils/autoDelete');
```

- [ ] **Step 2: Remove the old call sites from `slash-commands/guild.js`**

Remove line 4 (`const { autoDelete } = require('../utils/autoDelete');`).

Remove the three `autoDelete(interaction);` calls at (original) lines 132, 153, and inside `handleUnlinked`'s branch — leave the surrounding `return`/`break` statements untouched, just delete the `autoDelete(interaction);` line itself in each spot.

- [ ] **Step 3: Remove the old call sites from `slash-commands/member.js`**

Remove line 4 (`const { autoDelete } = require('../utils/autoDelete');`).

Remove the two `autoDelete(interaction);` calls (original lines 229 and 234).

- [ ] **Step 4: Run the full existing test suite to confirm nothing broke**

Run: `npm test`
Expected: all existing tests PASS (138+ tests, plus the new ones from Tasks 1-2). No test currently exercises `guild.js`/`member.js`'s reply behavior directly, so this is a regression check on everything else, not a direct test of this task's change.

- [ ] **Step 5: Commit**

```bash
git add index.js slash-commands/guild.js slash-commands/member.js
git commit -m "refactor: move auto-delete scheduling into index.js dispatcher"
```

---

### Task 4: Wire reaction rules through `messageReactions.js`

**Files:**
- Modify: `utils/messageReactions.js:129-146`

**Interfaces:**
- Consumes: `scheduleReactionAutoDelete(message, ruleId)` from Task 2.

- [ ] **Step 1: Add the import**

Add near the top of `utils/messageReactions.js`, alongside its other `require`s:

```js
const { scheduleReactionAutoDelete } = require('./autoDelete');
```

- [ ] **Step 2: Capture the sent message and schedule auto-delete for `reply` and `message` response types**

Replace:

```js
            if (rule.response_type === 'reply') {
                await message.reply(payload);

            } else if (rule.response_type === 'emoji') {
                await message.react(rule.response_content);

            } else if (rule.response_type === 'message') {
                let channel = message.channel;
                if (rule.response_channel) {
                    const fetched = client.channels.cache.get(rule.response_channel)
                        ?? await client.channels.fetch(rule.response_channel).catch(() => null);
                    if (fetched) channel = fetched;
                }
                await channel.send(payload);

            } else if (rule.response_type === 'dm') {
                await message.author.send(payload).catch(() => {});
            }
```

With:

```js
            if (rule.response_type === 'reply') {
                const sent = await message.reply(payload);
                scheduleReactionAutoDelete(sent, rule.id);

            } else if (rule.response_type === 'emoji') {
                await message.react(rule.response_content);

            } else if (rule.response_type === 'message') {
                let channel = message.channel;
                if (rule.response_channel) {
                    const fetched = client.channels.cache.get(rule.response_channel)
                        ?? await client.channels.fetch(rule.response_channel).catch(() => null);
                    if (fetched) channel = fetched;
                }
                const sent = await channel.send(payload);
                scheduleReactionAutoDelete(sent, rule.id);

            } else if (rule.response_type === 'dm') {
                await message.author.send(payload).catch(() => {});
            }
```

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: all tests PASS (this file has no dedicated unit tests today per the existing suite composition — this is a regression check).

- [ ] **Step 4: Commit**

```bash
git add utils/messageReactions.js
git commit -m "feat: wire auto-delete into reaction-rule reply/message responses"
```

---

### Task 5: Admin panel REST endpoints

**Files:**
- Modify: `admin/server.js` (add endpoints near the existing `/api/permissions` block, after line 211)
- Modify: `admin/auth.js` (register in `OPERATIONS`)

**Interfaces:**
- Produces: `GET /api/auto-delete?scope=command|reaction_rule`, `POST /api/auto-delete`, `DELETE /api/auto-delete/:id` — same response shapes as the existing `/api/permissions` endpoints (`{ok: true, id}` / `{ok: true}` / `{error: msg}`).

- [ ] **Step 1: Add the three endpoints to `admin/server.js`**

Insert after the existing `DELETE /api/permissions/:id` block (after line 211):

```js
// GET /api/auto-delete — all rules, optionally filtered by scope
app.get('/api/auto-delete', (req, res) => {
    const { scope } = req.query;
    const rows = scope
        ? db.prepare('SELECT * FROM auto_delete_rules WHERE scope = ? ORDER BY command, subcommand, reaction_rule_id').all(scope)
        : db.prepare('SELECT * FROM auto_delete_rules ORDER BY scope, command, subcommand, reaction_rule_id').all();
    res.json(rows);
});

// POST /api/auto-delete — upsert a rule
app.post('/api/auto-delete', (req, res) => {
    const { scope, command, subcommand, reaction_rule_id, enabled } = req.body;
    if (!['command', 'reaction_rule'].includes(scope)) return res.status(400).json({ error: 'scope must be command or reaction_rule' });
    if (scope === 'command' && !command?.trim()) return res.status(400).json({ error: 'command is required for scope=command' });
    if (scope === 'reaction_rule' && !reaction_rule_id) return res.status(400).json({ error: 'reaction_rule_id is required for scope=reaction_rule' });
    try {
        const existing = db.prepare(
            `SELECT id FROM auto_delete_rules WHERE scope = ? AND command IS ? AND subcommand IS ? AND reaction_rule_id IS ?`
        ).get(scope, command?.trim() || null, subcommand?.trim() || null, reaction_rule_id || null);
        if (existing) {
            db.prepare('UPDATE auto_delete_rules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, existing.id);
            return res.json({ ok: true, id: existing.id });
        }
        const r = db.prepare(
            `INSERT INTO auto_delete_rules (scope, command, subcommand, reaction_rule_id, enabled) VALUES (?, ?, ?, ?, ?)`
        ).run(scope, command?.trim() || null, subcommand?.trim() || null, reaction_rule_id || null, enabled ? 1 : 0);
        res.json({ ok: true, id: r.lastInsertRowid });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/auto-delete/:id — remove a rule
app.delete('/api/auto-delete/:id', (req, res) => {
    const r = db.prepare('DELETE FROM auto_delete_rules WHERE id = ?').run(parseInt(req.params.id, 10));
    if (r.changes === 0) return res.status(404).json({ error: 'Rule not found' });
    res.json({ ok: true });
});
```

- [ ] **Step 2: Register the new endpoint in `admin/auth.js`'s `OPERATIONS`**

Add after the existing `permissions` entry (after line 63):

```js
    { key: 'auto-delete',     group: 'Permissions',    label: 'Edit auto-delete rules',   defaultTier: 'manage', match: r => /^\/api\/auto-delete/.test(r.path) },
```

- [ ] **Step 3: Manual smoke test via curl**

Start the admin server locally on a free port (per project convention — never touch the live PM2 `meerbot-admin` process):

Run: `ADMIN_PORT=3099 node admin/server.js`

In a separate terminal:
```bash
curl -s -X POST http://localhost:3099/api/auto-delete -H "Content-Type: application/json" -d '{"scope":"command","command":"guild","subcommand":"status","enabled":true}'
curl -s "http://localhost:3099/api/auto-delete?scope=command"
```
Expected: POST returns `{"ok":true,"id":<n>}`; GET returns an array containing that row. (Auth will likely reject unauthenticated curl requests per `admin/auth.js`'s tier gating — if so, verify instead that the route exists and returns a 401/403 rather than a 404, confirming it's wired up; full auth flow is exercised in Task 8's live UI test.)

Stop the local server (`Ctrl+C` or kill the process) once verified — do not leave a second admin instance running.

- [ ] **Step 4: Commit**

```bash
git add admin/server.js admin/auth.js
git commit -m "feat: add /api/auto-delete admin endpoints"
```

---

### Task 6: Admin panel UI — slash commands

**Files:**
- Modify: `admin/src/permissions.js` (add auto-delete section)
- Modify: `admin/src/index.html` (add the section's markup + mount points)
- Modify: `admin/src/main.js` (wire the new functions to `window.*` if using inline `onclick`-style calls — check existing convention first)

**Interfaces:**
- Consumes: `state.COMMAND_SUBS` (already populated in `admin/src/state.js`), `GET/POST/DELETE /api/auto-delete` from Task 5.
- Produces: `populateAutoDeleteCommands()`, `loadAutoDeleteRules()`, `toggleAutoDeleteRule(command, subcommand, enabled)` — exported from `admin/src/permissions.js`.

- [ ] **Step 1: Check how the existing Permissions tab section is mounted in `admin/src/index.html`**

Run: `grep -n "perm-command\|perm-subcommand\|section-permissions" admin/src/index.html`

Read the surrounding HTML structure so the new section matches existing markup conventions (CSP forbids inline `onclick`/`oninput` — must use `addEventListener`, per the project's documented CSP gotcha).

- [ ] **Step 2: Add markup for an "Auto-Delete" mini-section within `section-permissions` in `admin/src/index.html`**

Add a new `<div>` block reusing the existing command `<select id="perm-command">`-style pattern but with its own IDs (`autodelete-command`, `autodelete-subcommand`, `autodelete-enabled` checkbox, `autodelete-save-btn`, and a `<tbody id="autoDeleteTableBody">` for the list), placed visually below the existing role/channel permissions table in the same tab.

- [ ] **Step 3: Implement the JS in `admin/src/permissions.js`**

Add:

```js
export function populateAutoDeleteCommands() {
  const sel = document.getElementById('autodelete-command');
  if (!sel) return;
  sel.innerHTML = '';
  Object.keys(state.COMMAND_SUBS).sort().forEach(cmd => {
    const opt = document.createElement('option');
    opt.value = cmd;
    opt.textContent = '/' + cmd;
    sel.appendChild(opt);
  });
}

export function autoDeleteCommandChanged() {
  const cmd    = document.getElementById('autodelete-command').value;
  const subSel = document.getElementById('autodelete-subcommand');
  subSel.innerHTML = '<option value="">— whole command —</option>';
  const subs = state.COMMAND_SUBS[cmd] || [];
  subs.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    subSel.appendChild(opt);
  });
  subSel.disabled = subs.length === 0;
}

export async function loadAutoDeleteRules() {
  const rows  = await fetch('/api/auto-delete?scope=command').then(r => r.json());
  const tbody = document.getElementById('autoDeleteTableBody');
  if (!tbody) return;
  tbody.replaceChildren();
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="3" style="color:var(--color-neutral-content)">No auto-delete rules configured.</td></tr>';
    return;
  }
  for (const r of rows) {
    const tr = document.createElement('tr');
    const tdCmd = document.createElement('td');
    tdCmd.innerHTML = `<code>/${escHtml(r.command)}${r.subcommand ? ' ' + escHtml(r.subcommand) : ''}</code>`;
    const tdStatus = document.createElement('td');
    tdStatus.textContent = r.enabled ? 'ON' : 'OFF';
    const tdAct = document.createElement('td');
    const removeBtn = document.createElement('button');
    removeBtn.className = 'reset-btn';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async () => {
      await fetch('/api/auto-delete/' + r.id, { method: 'DELETE' });
      await loadAutoDeleteRules();
    });
    tdAct.appendChild(removeBtn);
    tr.append(tdCmd, tdStatus, tdAct);
    tbody.appendChild(tr);
  }
}

export async function saveAutoDeleteRule() {
  const command    = document.getElementById('autodelete-command').value;
  const subcommand = document.getElementById('autodelete-subcommand').value || null;
  const enabled    = document.getElementById('autodelete-enabled').checked;
  await fetch('/api/auto-delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: 'command', command, subcommand, enabled }),
  });
  await loadAutoDeleteRules();
}
```

(`escHtml` is already imported at the top of `admin/src/permissions.js` per the existing file.)

- [ ] **Step 4: Wire event listeners in `admin/src/main.js`**

Check the existing pattern for how `perm-command`'s change event and `perm-add-btn`'s click are wired (likely `addEventListener` calls in a bootstrap function, given the CSP constraint). Add equivalent listeners for `autodelete-command` (change → `autoDeleteCommandChanged`), `autodelete-save-btn` (click → `saveAutoDeleteRule`), and call `populateAutoDeleteCommands()` + `loadAutoDeleteRules()` wherever `populatePermCommands()`/`loadPermissions()` are already called on tab load/bootstrap.

- [ ] **Step 5: Build the admin bundle and verify no build errors**

Run: `npm run build --prefix admin`
Expected: build succeeds with no errors (warnings about unrelated pre-existing issues are fine).

- [ ] **Step 6: Commit**

```bash
git add admin/src/permissions.js admin/src/index.html admin/src/main.js
git commit -m "feat: admin panel UI for per-command auto-delete rules"
```

---

### Task 7: Admin panel UI — reaction rules

**Files:**
- Find and modify: the admin source file rendering the message-reactions rule list (check `admin/src/*.js` for one matching `message_reactions`/`reactions` — likely `admin/src/reactions.js` per the Key Files table's tab-module list)
- Modify: `admin/src/index.html` if the rule-row template lives there

**Interfaces:**
- Consumes: `GET/POST/DELETE /api/auto-delete` (scope=`reaction_rule`) from Task 5.

- [ ] **Step 1: Locate the reaction-rule row rendering code**

Run: `grep -n "message_reactions\|response_type" admin/src/reactions.js`

Read the file's rule-list rendering function to find where each rule's row/card is built (mirroring how `guild.js`'s bot-side `RESPONSE_LABELS` describes `reply`/`message`/`emoji`/`dm`).

- [ ] **Step 2: Add an auto-delete checkbox to each rule row, shown only for `reply`/`message` response types**

Following whatever DOM-building pattern that file already uses (createElement + addEventListener, per the CSP constraint), add a checkbox reflecting the rule's current auto-delete state (fetched via `GET /api/auto-delete?scope=reaction_rule`, matched by `reaction_rule_id`), wired to POST/DELETE `/api/auto-delete` with `scope: 'reaction_rule', reaction_rule_id: rule.id` on toggle. Skip rendering the checkbox entirely when `rule.response_type` is `emoji` or `dm`.

- [ ] **Step 3: Build the admin bundle**

Run: `npm run build --prefix admin`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add admin/src/reactions.js
git commit -m "feat: admin panel UI for per-reaction-rule auto-delete"
```

---

### Task 8: Live verification

**Files:** none (manual verification only)

**This task must run from the real checkout (`C:\vscode\DiscordBotAfkJ`) after this branch is
merged to `main`, not from this worktree.** PM2's `meerbot` and `meerbot-admin` processes both
have `pm_cwd` set to the main checkout — `pm2 restart` reads whatever code sits there, not this
worktree's branch, so running these steps beforehand would silently "verify" the OLD code and
produce a false pass. This is the same gotcha already documented for the admin panel
(`meerbot-admin runs from main repo, not worktrees`) and applies equally to the bot process. Do
not attempt an early admin-only check via `ADMIN_PORT=3099 node admin/server.js` from the
worktree either — the Discord-side half (Tasks Step 2/4/5/6) still needs the bot process, so a
split verification adds a step without removing the need for the real one after merge.

- [ ] **Step 1: Merge this branch to main, then restart the bot and admin panel to pick up all changes**

Once this branch is merged (via `finishing-a-development-branch`), from `C:\vscode\DiscordBotAfkJ`,
hand these commands to Daniel to run (PM2 restarts need elevation, per project convention):
```
git pull
pm2 restart meerbot --update-env
pm2 restart meerbot-admin
```

- [ ] **Step 2: Verify default OFF behavior**

In Discord, run `/guild status`. Confirm the reply now posts **permanently** (no more 30s disappearance) since no `auto_delete_rules` row exists for it yet — this is the opt-in default taking effect.

- [ ] **Step 3: Turn auto-delete ON for `/guild status` via the admin panel**

In the admin panel's Permissions tab, use the new Auto-Delete section: select `/guild`, subcommand `status`, check enabled, save. Confirm the new row appears in the auto-delete rules list.

- [ ] **Step 4: Verify it now auto-deletes**

Run `/guild status` again in Discord. Confirm the reply is deleted after `AUTO_DELETE_SECONDS` (default 30s).

- [ ] **Step 5: Verify whole-command vs subcommand precedence**

Run `/guild power` (no specific rule, and `power` never called `autoDelete` even in the old hardcoded version). Confirm it still posts permanently, unaffected by the `status`-specific rule.

- [ ] **Step 6: Verify a reaction rule**

Pick or create one `message_reactions` rule with `response_type = 'reply'`. Enable auto-delete for it via the admin panel's reaction rules UI. Trigger the rule live in Discord (post a message matching its pattern). Confirm the bot's reply deletes after the configured delay.

- [ ] **Step 7: Update CLAUDE.md and README per the project's docs-sync-on-commit convention**

Update the `utils/autoDelete.js` / `utils/db.js` / `command_permissions` table entries in `c:\vscode\DiscordBotAfkJ\CLAUDE.md`'s Key Files and Database Tables sections to describe the new `auto_delete_rules` table and the removal of the old hardcoded behavior from `guild.js`/`member.js`. Add a line to the Key Decisions Made section documenting the opt-in-default choice and precedence rule, similar in style to the existing `enforcePermissions` decision entry.

- [ ] **Step 8: Final commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: document configurable auto-delete feature"
```

---

## Self-Review Notes

- **Spec coverage:** Data model (Task 1), slash command mechanism (Tasks 2-3), reaction rule mechanism (Tasks 2, 4), admin panel — commands (Tasks 5-6), admin panel — reaction rules (Tasks 5, 7), error handling (`.catch(() => {})` throughout Task 2, error-reply exclusion already true by construction since `scheduleCommandAutoDelete` is only called after the `try` block's success line), testing (Tasks 1-2 unit tests, Task 8 live verification) — all covered.
- **Type consistency:** `scheduleCommandAutoDelete(interaction, command, subcommand)` and `scheduleReactionAutoDelete(message, ruleId)` signatures are identical everywhere they're defined (Task 2) and called (Tasks 3-4).
- **Placeholder scan:** Task 6 Step 4 and Task 7 Steps 1-2 intentionally direct the implementer to read existing code first rather than guessing exact DOM IDs/patterns sight-unseen (the admin frontend's exact event-wiring convention wasn't confirmed during planning) — this is a deliberate "read before you write" step, not a content gap, since the actual component code (checkbox creation, fetch calls) is fully specified in Task 6 Step 3.
