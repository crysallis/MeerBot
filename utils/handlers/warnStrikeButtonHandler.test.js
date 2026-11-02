const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { handleWarnStrikeButton } = require('./warnStrikeButtonHandler');
const W = require('../warnings');

const NOW = Date.parse('2026-11-02T12:00:00.000Z');

function setup() {
    const h = new Database(':memory:');
    h.exec(`
      CREATE TABLE members (id INTEGER PRIMARY KEY, ingame_name TEXT);
      CREATE TABLE member_warnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER NOT NULL, reason TEXT NOT NULL, created_by TEXT NOT NULL,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, ended_at TEXT, ended_by TEXT
      );
      CREATE TABLE warning_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, warning_id INTEGER NOT NULL, member_id INTEGER NOT NULL,
        action TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL, detail TEXT
      );
      INSERT INTO members (id, ingame_name) VALUES (1, 'Alpha');
    `);
    const id = W.addWarning(h, { memberId: 1, reason: 'secret reason', createdBy: '1', now: new Date(NOW) });
    return { h, id };
}

function fake(customId, userId = '77') {
    const calls = { reply: [], update: [], sent: [] };
    const channel = { send: async (m) => { calls.sent.push(m); } };
    return {
        calls,
        customId,
        user: { id: userId },
        client: { channels: { cache: { get: () => channel } } },
        reply: async (p) => { calls.reply.push(p); },
        update: async (p) => { calls.update.push(p); },
    };
}

const deps = (h, over = {}) => ({ h, enforce: async () => true, now: NOW + 5000, logChannelId: 'chan', ...over });
const count = (h) => h.prepare('SELECT COUNT(*) AS n FROM member_warnings').get().n;

test('ignores customIds that are not warn_strike', async () => {
    const { h } = setup();
    assert.equal(await handleWarnStrikeButton(fake('glorycta_cancel:1'), deps(h)), false);
});

test('refuses another user and deletes nothing', async () => {
    const { h, id } = setup();
    const i = fake(`warn_strike:${id}:77:${NOW}`, '88');
    assert.equal(await handleWarnStrikeButton(i, deps(h)), true);
    assert.equal(count(h), 1);
    assert.match(i.calls.reply[0].content, /person who ran/i);
});

test('refuses a confirm older than 60 seconds and deletes nothing', async () => {
    const { h, id } = setup();
    const i = fake(`warn_strike:${id}:77:${NOW}`);
    await handleWarnStrikeButton(i, deps(h, { now: NOW + 61000 }));
    assert.equal(count(h), 1);
    assert.match(i.calls.update[0].content, /timed out/i);
    assert.deepEqual(i.calls.update[0].components, []);
});

test('says so when the warning no longer exists', async () => {
    const { h } = setup();
    const i = fake(`warn_strike:999:77:${NOW}`);
    await handleWarnStrikeButton(i, deps(h));
    assert.match(i.calls.update[0].content, /no longer exists/i);
});

test('cancel changes nothing', async () => {
    const { h } = setup();
    const i = fake('warn_strike_cancel:77');
    assert.equal(await handleWarnStrikeButton(i, deps(h)), true);
    assert.equal(count(h), 1);
    assert.match(i.calls.update[0].content, /cancelled/i);
});

test('cancel by another user changes nothing', async () => {
    const { h } = setup();
    const i = fake('warn_strike_cancel:77', '88');
    await handleWarnStrikeButton(i, deps(h));
    assert.equal(i.calls.update.length, 0);
    assert.match(i.calls.reply[0].content, /person who ran/i);
});

test('a failed permission re-check deletes nothing', async () => {
    const { h, id } = setup();
    const i = fake(`warn_strike:${id}:77:${NOW}`);
    assert.equal(await handleWarnStrikeButton(i, deps(h, { enforce: async () => false })), true);
    assert.equal(count(h), 1);
    assert.equal(i.calls.update.length, 0);
});

test('confirm strikes the warning, logs it, and posts a one-line notice', async () => {
    const { h, id } = setup();
    const i = fake(`warn_strike:${id}:77:${NOW}`);
    assert.equal(await handleWarnStrikeButton(i, deps(h)), true);
    assert.equal(count(h), 0);
    assert.equal(h.prepare("SELECT COUNT(*) AS n FROM warning_log WHERE action = 'strike' AND actor = '77'").get().n, 1);
    assert.match(i.calls.update[0].content, new RegExp(`#${id}`));
    assert.deepEqual(i.calls.update[0].components, []);
    assert.equal(i.calls.sent.length, 1);
    assert.ok(i.calls.sent[0].includes('<@77>') && i.calls.sent[0].includes('Alpha') && !i.calls.sent[0].includes('secret'));
});

test('confirm with no log channel configured still strikes and does not throw', async () => {
    const { h, id } = setup();
    const i = fake(`warn_strike:${id}:77:${NOW}`);
    await handleWarnStrikeButton(i, deps(h, { logChannelId: null }));
    assert.equal(count(h), 0);
    assert.equal(i.calls.sent.length, 0);
});
