const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits } = require('discord.js');
const model = require('./guildOnboardingModel');

test('buildNames derives role, category and the five channels from the guild name', () => {
    const n = model.buildNames('Bulls', '🐂');
    assert.equal(n.slug, 'bulls');
    assert.equal(n.guildRoleName, 'RKF Bulls (Guild)');
    assert.equal(n.categoryName, '⚔️🏰⋮RKF Bulls⋮🏰⚔️');
    assert.deepEqual(n.channels, [
        { key: 'main', name: '╠⋮ㆍbullsㆍ🐂' },
        { key: 'battledrills', name: '╠⋮🏰battleㆍdrillsㆍbulls' },
        { key: 'guildduel', name: '╠⋮🐦‍🔥guildㆍduelㆍbulls' },
        { key: 'clashofglory', name: '╠⋮🗺️clashㆍofㆍglory' },
        { key: 'clashfronts', name: '﴾ㆍclashfrontsㆍbulls' },
    ]);
});

test('channel keys match the model order', () => {
    assert.deepEqual(model.CHANNEL_KEYS, ['main', 'battledrills', 'guildduel', 'clashofglory', 'clashfronts']);
});

test('slugify strips everything but letters and digits', () => {
    assert.equal(model.slugify('Red Bulls'), 'redbulls');
});

test('buildNames rejects a name with no usable characters', () => {
    assert.throws(() => model.buildNames('!!!', '🐂'), /Invalid guild name/);
});

test('buildNames rejects a name that makes a Discord name over 100 characters', () => {
    assert.throws(() => model.buildNames('a'.repeat(95), '🐂'), /Invalid guild name/);
});

test('buildCategoryOverwrites orders everyone, guild role, leader role', () => {
    const o = model.buildCategoryOverwrites({ everyoneId: 'e', guildRoleId: 'g', leaderRoleId: 'l' });
    assert.deepEqual(o.map(x => x.id), ['e', 'g', 'l']);
    assert.deepEqual(o[0].allow, []);
    assert.deepEqual(o[0].deny, ['ViewChannel', 'Connect']);
    assert.deepEqual(o[1].allow, model.MEMBER_PERMS.allow);
    assert.deepEqual(o[2].deny, model.LEADER_PERMS.deny);
});

test('every permission name in the model exists in discord.js PermissionFlagsBits', () => {
    for (const set of [model.MEMBER_PERMS, model.LEADER_PERMS, model.SHARED_PERMS]) {
        for (const name of [...set.allow, ...set.deny]) {
            assert.ok(name in PermissionFlagsBits, name);
        }
    }
});

test('permission sets keep their snapshot sizes', () => {
    assert.equal(model.MEMBER_PERMS.allow.length, 21);
    assert.equal(model.MEMBER_PERMS.deny.length, 18);
    assert.equal(model.LEADER_PERMS.allow.length, 35);
    assert.equal(model.LEADER_PERMS.deny.length, 4);
    assert.equal(model.SHARED_PERMS.allow.length, 23);
    assert.equal(model.SHARED_PERMS.deny.length, 16);
});
