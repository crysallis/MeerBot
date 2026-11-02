require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { PermissionFlagsBits } = require('discord.js');
const cmd = require('./warn');
const W = require('../utils/warnings');

const NOW = new Date('2026-11-02T12:00:00.000Z');

function memDb() {
    const h = new Database(':memory:');
    h.exec(`
      CREATE TABLE members (id INTEGER PRIMARY KEY, ingame_name TEXT, active INTEGER DEFAULT 1, pending INTEGER DEFAULT 0);
      CREATE TABLE member_warnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER NOT NULL, reason TEXT NOT NULL, created_by TEXT NOT NULL,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, ended_at TEXT, ended_by TEXT
      );
      CREATE TABLE warning_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, warning_id INTEGER NOT NULL, member_id INTEGER NOT NULL,
        action TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL, detail TEXT
      );
      INSERT INTO members (id, ingame_name) VALUES (1, 'Alpha'), (2, 'Beta');
    `);
    return h;
}

const opts = (sub) => cmd.data.toJSON().options.find(o => o.name === sub).options.map(o => o.name);
const sub = (name) => cmd.data.toJSON().options.find(o => o.name === name);

test('/warn has exactly the six subcommands in order', () => {
    assert.deepEqual(cmd.data.toJSON().options.map(o => o.name), ['add', 'edit', 'expire', 'strike', 'list', 'report']);
});

test('/warn option names per subcommand', () => {
    assert.deepEqual(opts('add'), ['member', 'reason', 'expires']);
    assert.deepEqual(opts('edit'), ['member', 'warning', 'reason', 'expires']);
    assert.deepEqual(opts('expire'), ['member', 'warning', 'note']);
    assert.deepEqual(opts('strike'), ['member', 'warning']);
    assert.deepEqual(opts('list'), ['member']);
    assert.deepEqual(opts('report'), ['include_expired']);
});

test('add needs member and reason, expires is optional; edit changes are optional', () => {
    const byName = (s) => Object.fromEntries(sub(s).options.map(o => [o.name, o]));
    assert.equal(byName('add').member.required, true);
    assert.equal(byName('add').reason.required, true);
    assert.notEqual(byName('add').expires.required, true);
    assert.equal(byName('edit').warning.required, true);
    assert.notEqual(byName('edit').reason.required, true);
    assert.notEqual(byName('edit').expires.required, true);
    assert.equal(byName('edit').warning.autocomplete, true);
    assert.equal(byName('add').member.autocomplete, true);
});

test('reason is capped at 500 characters and the expire note at 200', () => {
    assert.equal(sub('add').options.find(o => o.name === 'reason').max_length, 500);
    assert.equal(sub('expire').options.find(o => o.name === 'note').max_length, 200);
});

test('/warn is restricted to Manage Server by default', () => {
    assert.equal(cmd.data.toJSON().default_member_permissions, String(PermissionFlagsBits.ManageGuild));
});

test('memberChoices offers only active, non-pending members, at most 25', () => {
    const h = memDb();
    h.prepare("INSERT INTO members (id, ingame_name, active) VALUES (10, 'Gone', 0)").run();
    h.prepare("INSERT INTO members (id, ingame_name, pending) VALUES (11, 'Maybe', 1)").run();
    for (let i = 0; i < 30; i++) h.prepare('INSERT INTO members (ingame_name) VALUES (?)').run(`Bulk${i}`);
    const all = cmd.memberChoices(h, '');
    assert.equal(all.length, 25);
    const names = cmd.memberChoices(h, 'a').map(c => c.name);
    assert.ok(!names.includes('Gone') && !names.includes('Maybe'));
    assert.deepEqual(cmd.memberChoices(h, 'alp'), [{ name: 'Alpha', value: 'Alpha' }]);
});

test('warningChoices scopes to the member and the mode, values are ids as strings', () => {
    const h = memDb();
    const live = W.addWarning(h, { memberId: 1, reason: 'Live one', createdBy: '1', now: NOW });
    const old = W.addWarning(h, { memberId: 1, reason: 'Lapsed one', createdBy: '1', now: new Date('2026-01-01T00:00:00.000Z') });
    W.addWarning(h, { memberId: 2, reason: 'Not Alpha', createdBy: '1', now: NOW });
    const expire = cmd.warningChoices(h, 'Alpha', 'expire', '', NOW);
    assert.deepEqual(expire.map(c => c.value), [String(live)]);
    assert.ok(expire[0].name.startsWith(`#${live} `));
    assert.ok(expire[0].name.length <= 100);
    const strike = cmd.warningChoices(h, 'Alpha', 'strike', '', NOW);
    assert.deepEqual(strike.map(c => c.value).sort(), [String(live), String(old)].sort());
    assert.deepEqual(cmd.warningChoices(h, 'Alpha', 'strike', 'lapsed', NOW).map(c => c.value), [String(old)]);
    assert.deepEqual(cmd.warningChoices(h, 'Nobody', 'strike', '', NOW), []);
});

test('addCommand records the warning and says how many are now active', () => {
    const h = memDb();
    const msg = cmd.addCommand(h, { name: 'alpha', reason: ' No attacks ', expires: '2026-12-31', actor: '111', now: NOW });
    assert.match(msg, /Alpha/);
    assert.match(msg, /2026-12-31/);
    assert.match(msg, /1 active/);
    const row = h.prepare('SELECT * FROM member_warnings').get();
    assert.equal(row.reason, 'No attacks');
    assert.equal(row.expires_at, '2026-12-31T23:59:59.999Z');
});

test('addCommand defaults the expiry to three months out', () => {
    const h = memDb();
    cmd.addCommand(h, { name: 'Alpha', reason: 'R', expires: null, actor: '111', now: NOW });
    assert.equal(h.prepare('SELECT expires_at FROM member_warnings').get().expires_at, '2027-02-02T12:00:00.000Z');
});

test('addCommand rejects a bad or past expiry, a blank reason and an unknown member, writing nothing', () => {
    const h = memDb();
    for (const expires of ['soon', '2026-02-30', '2026-11-01']) {
        assert.match(cmd.addCommand(h, { name: 'Alpha', reason: 'R', expires, actor: '1', now: NOW }), /YYYY-MM-DD/, expires);
    }
    assert.match(cmd.addCommand(h, { name: 'Alpha', reason: '   ', expires: null, actor: '1', now: NOW }), /reason/i);
    assert.match(cmd.addCommand(h, { name: 'Nobody', reason: 'R', expires: null, actor: '1', now: NOW }), /not found/i);
    assert.equal(h.prepare('SELECT COUNT(*) AS n FROM member_warnings').get().n, 0);
    assert.equal(h.prepare('SELECT COUNT(*) AS n FROM warning_log').get().n, 0);
});

test('editCommand amends the warning, refuses another member\'s warning and an empty edit', () => {
    const h = memDb();
    const id = W.addWarning(h, { memberId: 1, reason: 'Old', createdBy: '1', now: NOW });
    assert.match(cmd.editCommand(h, { name: 'Beta', warningId: String(id), reason: 'x', expires: null, actor: '2', now: NOW }), /not found|doesn't belong/i);
    assert.match(cmd.editCommand(h, { name: 'Alpha', warningId: String(id), reason: null, expires: null, actor: '2', now: NOW }), /nothing to change/i);
    assert.match(cmd.editCommand(h, { name: 'Alpha', warningId: String(id), reason: null, expires: 'soon', actor: '2', now: NOW }), /YYYY-MM-DD/);
    assert.match(cmd.editCommand(h, { name: 'Alpha', warningId: String(id), reason: 'New', expires: null, actor: '2', now: NOW }), /#\d+/);
    assert.equal(h.prepare('SELECT reason FROM member_warnings WHERE id = ?').get(id).reason, 'New');
});

test('expireCommand ends an active warning once and refuses a repeat or a foreign id', () => {
    const h = memDb();
    const id = W.addWarning(h, { memberId: 1, reason: 'R', createdBy: '1', now: NOW });
    assert.match(cmd.expireCommand(h, { name: 'Beta', warningId: String(id), note: null, actor: '2', now: NOW }), /not found|doesn't belong/i);
    assert.match(cmd.expireCommand(h, { name: 'Alpha', warningId: String(id), note: 'done', actor: '2', now: NOW }), /ended/i);
    assert.match(cmd.expireCommand(h, { name: 'Alpha', warningId: String(id), note: null, actor: '2', now: NOW }), /already/i);
    assert.match(cmd.expireCommand(h, { name: 'Alpha', warningId: 'abc', note: null, actor: '2', now: NOW }), /not found|doesn't belong/i);
});

test('strikePrompt names the warning and member but never the reason, and checks ownership', () => {
    const h = memDb();
    const id = W.addWarning(h, { memberId: 1, reason: 'very private reason', createdBy: '1', now: NOW });
    const ok = cmd.strikePrompt(h, { name: 'Alpha', warningId: String(id), userId: '77', now: NOW });
    assert.ok(ok.content.includes(`#${id}`) && ok.content.includes('Alpha'));
    assert.ok(!ok.content.includes('private'));
    assert.equal(ok.components.length, 1);
    const ids = ok.components[0].toJSON().components.map(c => c.custom_id);
    assert.deepEqual(ids, [`warn_strike:${id}:77:${NOW.getTime()}`, 'warn_strike_cancel:77']);
    const bad = cmd.strikePrompt(h, { name: 'Beta', warningId: String(id), userId: '77', now: NOW });
    assert.equal(bad.components, undefined);
    assert.match(bad.content, /not found|doesn't belong/i);
});

test('member autocomplete answers with at most 25 plain choices', async () => {
    const responses = [];
    const interaction = {
        options: { getFocused: () => ({ name: 'member', value: '' }), getSubcommand: () => 'add', getString: () => null },
        respond: async (c) => { responses.push(c); },
    };
    await cmd.autocomplete(interaction);
    assert.ok(responses[0].length <= 25);
    for (const c of responses[0]) assert.equal(c.name, c.value);
});
