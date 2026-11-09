const { test } = require('node:test');
const assert = require('node:assert/strict');
const { entryFromRow, formatGuildNames, LEGACY_WELCOME_KEYS } = require('./guildEntries');

const none = () => '';

test('entryFromRow returns null without a guild role', () => {
    assert.equal(entryFromRow({ name: 'RKF Bulls', guild_role_id: null }, none), null);
});

test('entryFromRow uses the guild role as id and the name as label', () => {
    const e = entryFromRow({ name: 'RKF Bulls', guild_role_id: 'r1', main_channel_id: 'c1' }, none);
    assert.equal(e.id, 'r1');
    assert.equal(e.label, 'RKF Bulls');
    assert.equal(e.welcomeChannelId, 'c1');
});

test('entryFromRow prefers main_channel_id over the legacy config', () => {
    const getConfig = () => 'legacy';
    const e = entryFromRow({ name: 'RKF Frop', guild_role_id: 'r1', main_channel_id: 'c1' }, getConfig);
    assert.equal(e.welcomeChannelId, 'c1');
});

test('entryFromRow falls back to the legacy key for RKF Frop', () => {
    const asked = [];
    const getConfig = key => { asked.push(key); return 'legacy-chan'; };
    const e = entryFromRow({ name: 'RKF Frop', guild_role_id: 'r1', main_channel_id: null }, getConfig);
    assert.equal(e.welcomeChannelId, 'legacy-chan');
    assert.deepEqual(asked, [LEGACY_WELCOME_KEYS['RKF Frop']]);
});

test('entryFromRow gives a null welcome channel when neither exists', () => {
    const e = entryFromRow({ name: 'RKF Bulls', guild_role_id: 'r1', main_channel_id: null }, () => 'should not be asked');
    assert.equal(e.welcomeChannelId, null);
    const f = entryFromRow({ name: 'RKF Frop', guild_role_id: 'r1', main_channel_id: null }, none);
    assert.equal(f.welcomeChannelId, null);
});

test('formatGuildNames strips the RKF prefix and joins naturally', () => {
    assert.equal(formatGuildNames([]), '');
    assert.equal(formatGuildNames([{ name: 'RKF RiffRaff' }]), 'RiffRaff');
    assert.equal(formatGuildNames([{ name: 'RKF RiffRaff' }, { name: 'RKF Frop' }]), 'RiffRaff and Frop');
    assert.equal(
        formatGuildNames([{ name: 'RKF RiffRaff' }, { name: 'RKF Frop' }, { name: 'RKF Bulls' }]),
        'RiffRaff, Frop and Bulls',
    );
});
