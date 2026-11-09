const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const reg = require('./guildRegistry');

let h;

beforeEach(() => {
    h = new Database(':memory:');
    h.exec(`CREATE TABLE guilds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        override_role_ids TEXT NOT NULL DEFAULT '[]'
    )`);
    reg.ensureGuildSchema(h);
});

const colNames = () => new Set(h.prepare('PRAGMA table_info(guilds)').all().map(c => c.name));

test('ensureGuildSchema adds the four columns and is idempotent', () => {
    for (const c of ['guild_role_id', 'leader_role_id', 'category_id', 'main_channel_id']) {
        assert.ok(colNames().has(c), c);
    }
    assert.doesNotThrow(() => reg.ensureGuildSchema(h));
    assert.ok(h.prepare("SELECT 1 FROM sqlite_master WHERE name = 'guild_channels'").get());
});

test('createGuild is idempotent and returns the row', () => {
    const a = reg.createGuild(h, 'RKF Bulls');
    const b = reg.createGuild(h, 'RKF Bulls');
    assert.equal(a.name, 'RKF Bulls');
    assert.equal(a.id, b.id);
    assert.equal(h.prepare('SELECT COUNT(*) AS n FROM guilds').get().n, 1);
});

test('getGuildByName is exact and getGuildById resolves', () => {
    const g = reg.createGuild(h, 'RKF Bulls');
    assert.equal(reg.getGuildById(h, g.id).name, 'RKF Bulls');
    assert.equal(reg.getGuildByName(h, 'RKF Bulls').id, g.id);
    assert.equal(reg.getGuildByName(h, 'rkf bulls'), undefined);
});

test('setGuildDiscordIds updates only the given keys', () => {
    const g = reg.createGuild(h, 'RKF Bulls');
    reg.setGuildDiscordIds(h, g.id, { guildRoleId: 'r1', categoryId: 'c1' });
    reg.setGuildDiscordIds(h, g.id, { leaderRoleId: 'l1' });
    const row = reg.getGuildById(h, g.id);
    assert.equal(row.guild_role_id, 'r1');
    assert.equal(row.category_id, 'c1');
    assert.equal(row.leader_role_id, 'l1');
    assert.equal(row.main_channel_id, null);
});

test('addOverrideRole appends once', () => {
    const g = reg.createGuild(h, 'RKF Bulls');
    reg.addOverrideRole(h, g.id, 'l1');
    reg.addOverrideRole(h, g.id, 'l1');
    reg.addOverrideRole(h, g.id, 'l2');
    assert.deepEqual(JSON.parse(reg.getGuildById(h, g.id).override_role_ids), ['l1', 'l2']);
});

test('addGuildChannel ignores a duplicate discord_id', () => {
    const g = reg.createGuild(h, 'RKF Bulls');
    reg.addGuildChannel(h, g.id, 'channel', 'guildduel', 'ch1');
    reg.addGuildChannel(h, g.id, 'channel', 'guildduel', 'ch1');
    reg.addGuildChannel(h, g.id, 'shared_grant', 'category', 'cat9');
    const rows = reg.getGuildChannels(h, g.id);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(r => r.kind).sort(), ['channel', 'shared_grant']);
});

test('seedKnownGuilds fills nulls and never overwrites an existing value', () => {
    reg.createGuild(h, 'RKF RiffRaff');
    const frop = reg.createGuild(h, 'RKF Frop');
    reg.setGuildDiscordIds(h, frop.id, { categoryId: 'x' });
    reg.seedKnownGuilds(h);
    reg.seedKnownGuilds(h);
    const f = reg.getGuildByName(h, 'RKF Frop');
    assert.equal(f.category_id, 'x');
    assert.equal(f.guild_role_id, '1533951415633051688');
    assert.equal(f.leader_role_id, '1303422881002426398');
    assert.equal(f.main_channel_id, '1482485945675550720');
    assert.deepEqual(JSON.parse(f.override_role_ids), ['1303422881002426398']);
    const r = reg.getGuildByName(h, 'RKF RiffRaff');
    assert.equal(r.guild_role_id, '1523580372208717964');
    assert.equal(r.category_id, '1510145205582692393');
    assert.equal(r.main_channel_id, '1303421884687192174');
    assert.equal(r.leader_role_id, null);
});
