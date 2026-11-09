const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, ChannelType } = require('discord.js');
const { toStructure, permsToEditObject } = require('./guildOnboardingDiscord');

const ow = (id, allow, deny = [], type = 0) => ({
    id, type, allow: new PermissionsBitField(allow), deny: new PermissionsBitField(deny),
});
const chan = (props, overwrites = []) => ({
    permissionOverwrites: { cache: new Map(overwrites.map(o => [o.id, o])) },
    position: 0,
    ...props,
});

test('toStructure nests channels under their category with permission names and sync state', () => {
    const channels = new Map([
        ['c1', chan({ id: 'c1', name: 'Cat', type: ChannelType.GuildCategory, parentId: null, permissionsLocked: null },
            [ow('r1', ['ViewChannel']), ow('u1', ['ViewChannel'], [], 1)])],
        ['t1', chan({ id: 't1', name: 'chat', type: ChannelType.GuildText, parentId: 'c1', permissionsLocked: true },
            [ow('r1', ['ViewChannel'])])],
        ['t2', chan({ id: 't2', name: 'lobby', type: ChannelType.GuildText, parentId: null, permissionsLocked: false })],
    ]);

    const s = toStructure(channels);

    assert.equal(s.categories.length, 1);
    assert.equal(s.categories[0].id, 'c1');
    assert.deepEqual(s.categories[0].overwrites, [{ id: 'r1', allow: ['ViewChannel'], deny: [] }]);
    assert.deepEqual(s.categories[0].channels, [
        { id: 't1', name: 'chat', synced: true, overwrites: [{ id: 'r1', allow: ['ViewChannel'], deny: [] }] },
    ]);
    assert.deepEqual(s.uncategorised, [{ id: 't2', name: 'lobby', synced: false, overwrites: [] }]);
});

test('permsToEditObject maps allow to true and deny to false', () => {
    assert.deepEqual(
        permsToEditObject({ allow: ['ViewChannel', 'Connect'], deny: ['ManageRoles'] }),
        { ViewChannel: true, Connect: true, ManageRoles: false },
    );
});
