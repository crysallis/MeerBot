const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const reg = require('./guildRegistry');
const { runOnboarding } = require('./guildOnboarding');
const { SHARED_PERMS } = require('./guildOnboardingModel');

let h;
let discord;

const WRITE_CALLS = ['createRole', 'createCategory', 'createChannel', 'grantAccess'];

function makeDiscord({ canManage = true, failChannelOn = 0 } = {}) {
    const calls = [];
    let seq = 0;
    const roles = new Map([['GR1', 'RKF RiffRaff (Guild)'], ['GF1', 'RKF Frop (Guild)'], ['LF1', 'Queen of the Frogs']]);
    const categories = new Map([['CAT1', 'riffraff'], ['CAT2', 'frop']]);
    const channels = new Map();
    let channelCreates = 0;
    const api = {
        calls,
        roles,
        categories,
        channels,
        failChannelOn,
        async botCanManage() { calls.push('botCanManage'); return canManage; },
        everyoneRoleId() { return 'EVERYONE'; },
        async roleExists(id) { calls.push('roleExists'); return roles.has(id); },
        async categoryExists(id) { calls.push('categoryExists'); return categories.has(id); },
        async lowestRoleAmong(ids) { calls.push('lowestRoleAmong'); return ids.length ? ids[ids.length - 1] : null; },
        async findRoleByName(name) {
            calls.push('findRoleByName');
            for (const [id, n] of roles) if (n === name) return { id };
            return null;
        },
        async findCategoryByName(name) {
            calls.push('findCategoryByName');
            for (const [id, n] of categories) if (n === name) return { id };
            return null;
        },
        async findChannelInCategory(categoryId, name) {
            calls.push('findChannelInCategory');
            const id = channels.get(`${categoryId}|${name}`);
            return id ? { id } : null;
        },
        async createRole({ name }) { calls.push('createRole'); const id = `R${++seq}`; roles.set(id, name); return { id }; },
        async createCategory({ name, overwrites }) {
            calls.push('createCategory');
            const id = `C${++seq}`;
            categories.set(id, name);
            api.lastOverwrites = overwrites;
            return { id };
        },
        async createChannel({ name, categoryId }) {
            calls.push('createChannel');
            channelCreates += 1;
            if (api.failChannelOn && channelCreates === api.failChannelOn) throw new Error('boom');
            const id = `H${++seq}`;
            channels.set(`${categoryId}|${name}`, id);
            return { id };
        },
        async grantAccess(args) {
            calls.push('grantAccess');
            if (api.failGrant) throw new Error('50013 Missing Permissions');
            (api.grants ||= []).push(args);
        },
        async snapshotStructure() {
            calls.push('snapshotStructure');
            const v = id => ({ id, allow: ['ViewChannel'], deny: [] });
            return {
                categories: [
                    { id: 'CAT1', name: 'riffraff', overwrites: [v('GR1')], channels: [] },
                    { id: 'CAT2', name: 'frop', overwrites: [v('GF1')], channels: [] },
                    { id: 'BM', name: 'Battle Modes', overwrites: [v('GR1'), v('GF1')], channels: [{ id: 'bm1', name: 'chat', synced: true, overwrites: [] }] },
                ],
                uncategorised: [],
            };
        },
    };
    return api;
}

beforeEach(() => {
    h = new Database(':memory:');
    h.exec(`CREATE TABLE guilds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        override_role_ids TEXT NOT NULL DEFAULT '[]'
    )`);
    reg.ensureGuildSchema(h);
    const rr = reg.createGuild(h, 'RKF RiffRaff');
    reg.setGuildDiscordIds(h, rr.id, { guildRoleId: 'GR1', categoryId: 'CAT1' });
    const frop = reg.createGuild(h, 'RKF Frop');
    reg.setGuildDiscordIds(h, frop.id, { guildRoleId: 'GF1', leaderRoleId: 'LF1', categoryId: 'CAT2' });
    discord = makeDiscord();
});

const input = (over = {}) => ({ name: 'Bulls', leaderRoleName: 'Bull Boss', emoji: '🐂', ...over });
const run = (over = {}, apply = true, d = discord) =>
    runOnboarding({ input: input(over), discord: d, h, apply, log: () => {} });
const writeCalls = () => discord.calls.filter(c => WRITE_CALLS.includes(c));

test('dry run makes no create or grant calls and writes nothing', async () => {
    const r = await run({}, false);
    assert.equal(r.ok, true);
    assert.deepEqual(writeCalls(), []);
    assert.equal(h.prepare('SELECT COUNT(*) AS n FROM guilds').get().n, 2);
    assert.ok(r.lines.some(l => l.includes('RKF Bulls (Guild)')));
    assert.ok(r.lines.some(l => l.includes('Battle Modes')));
});

test('apply creates role, leader role, category and five channels and records every id', async () => {
    const r = await run();
    assert.equal(r.ok, true, r.lines.join('\n'));
    const g = reg.getGuildByName(h, 'RKF Bulls');
    assert.ok(g.guild_role_id && g.leader_role_id && g.category_id && g.main_channel_id);
    assert.equal(discord.roles.get(g.guild_role_id), 'RKF Bulls (Guild)');
    assert.equal(discord.roles.get(g.leader_role_id), 'Bull Boss');
    assert.equal(discord.categories.get(g.category_id), '⚔️🏰⋮RKF Bulls⋮🏰⚔️');
    const keys = reg.getGuildChannels(h, g.id).filter(c => c.kind === 'channel').map(c => c.key).sort();
    assert.deepEqual(keys, ['battledrills', 'clashfronts', 'clashofglory', 'guildduel']);
    assert.equal(writeCalls().filter(c => c === 'createChannel').length, 5);
    assert.deepEqual(discord.lastOverwrites.map(o => o.id), ['EVERYONE', g.guild_role_id, g.leader_role_id]);
});

test('apply grants the new guild role on every shared target found', async () => {
    await run();
    const g = reg.getGuildByName(h, 'RKF Bulls');
    assert.equal(discord.grants.length, 1);
    assert.deepEqual(discord.grants[0], { targetId: 'BM', roleId: g.guild_role_id, perms: SHARED_PERMS });
    const grants = reg.getGuildChannels(h, g.id).filter(c => c.kind === 'shared_grant' && c.key !== 'grants_complete');
    assert.deepEqual(grants.map(c => c.discord_id), ['BM']);
});

test('the leader role is appended to override_role_ids', async () => {
    await run();
    const g = reg.getGuildByName(h, 'RKF Bulls');
    assert.deepEqual(JSON.parse(g.override_role_ids), [g.leader_role_id]);
});

test('re-run after a mid-run failure creates no duplicates', async () => {
    discord.failChannelOn = 3;
    const first = await run();
    assert.equal(first.ok, false);
    discord.failChannelOn = 0;
    const second = await run();
    assert.equal(second.ok, true, second.lines.join('\n'));
    const created = c => discord.calls.filter(x => x === c).length;
    assert.equal(created('createRole'), 2);
    assert.equal(created('createCategory'), 1);
    assert.equal(discord.channels.size, 5);
});

test('re-run of a complete guild is refused', async () => {
    await run();
    const before = discord.calls.length;
    const r = await run();
    assert.equal(r.ok, false);
    assert.match(r.lines.join('\n'), /already onboarded/i);
    assert.equal(discord.calls.length, before);
});

test('a name equal to an existing guild ignoring case is refused before any adapter call', async () => {
    await run();
    const before = discord.calls.length;
    const r = await run({ name: 'bulls' });
    assert.equal(r.ok, false);
    assert.equal(discord.calls.length, before);
});

test('an invalid name is refused before any adapter call', async () => {
    const r = await run({ name: '!!!' });
    assert.equal(r.ok, false);
    assert.match(r.lines.join('\n'), /Invalid guild name/);
    assert.equal(discord.calls.length, 0);
});

test('a leader role named like another guild leader role is refused', async () => {
    const r = await run({ leaderRoleName: 'Queen of the Frogs' });
    assert.equal(r.ok, false);
    assert.deepEqual(writeCalls(), []);
    assert.equal(reg.getGuildByName(h, 'RKF Bulls'), undefined);
});

test('missing bot permissions refuse before creating anything', async () => {
    discord = makeDiscord({ canManage: false });
    const r = await run();
    assert.equal(r.ok, false);
    assert.deepEqual(writeCalls(), []);
});

test('an existing guild whose recorded role was deleted refuses', async () => {
    discord.roles.delete('GF1');
    const r = await run();
    assert.equal(r.ok, false);
    assert.deepEqual(writeCalls(), []);
});

test('a pre-existing guild is never resumed or extended by name', async () => {
    const r = await run({ name: 'Frop', leaderRoleName: 'Some Leader' });
    assert.equal(r.ok, false);
    assert.match(r.lines.join('\n'), /not created by onboarding/i);
    assert.deepEqual(writeCalls(), []);
    assert.equal(discord.calls.length, 0);
});

test('a failure while granting access is resumable and the finished guild is then refused', async () => {
    discord.failGrant = true;
    const first = await run();
    assert.equal(first.ok, false);
    assert.match(first.lines.join('\n'), /Stopped/);
    discord.failGrant = false;
    const second = await run();
    assert.equal(second.ok, true, second.lines.join('\n'));
    assert.equal(discord.grants.length, 1);
    assert.equal(discord.channels.size, 5);
    const third = await run();
    assert.equal(third.ok, false);
    assert.match(third.lines.join('\n'), /already onboarded/i);
});
