require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('./db');
const { enforcePermissions } = require('./permissions');

// Command name namespaced to this test file so it can never collide with a real
// command's saved rows in the shared DB.
const CMD = 'test_perm_cmd';

function insertRule({ subcommand = null, type, valueId }) {
    db.prepare(`INSERT INTO command_permissions (command, subcommand, type, value_id)
        VALUES (?, ?, ?, ?)`).run(CMD, subcommand, type, valueId);
}

function clearRules() {
    db.prepare('DELETE FROM command_permissions WHERE command = ?').run(CMD);
}

// enforcePermissions replies on rejection -- stub just needs to not throw.
function fakeInteraction({ channelId = 'chan-allowed', roleIds = [] } = {}) {
    return {
        channelId,
        member: { roles: { cache: new Set(roleIds) } },
        reply: async () => {},
    };
}

test.afterEach(() => clearRules());

test('enforcePermissions allows anything when no rules exist for the command', async () => {
    const result = await enforcePermissions(fakeInteraction(), CMD, 'sub1');
    assert.equal(result, true);
});

test('enforcePermissions applies a command-wide (subcommand=NULL) channel rule to a subcommand call', async () => {
    // This is the bug this test exists to catch: a rule saved with no subcommand
    // (the admin panel's "whole command" option) must still gate a call made with a
    // specific subcommand name -- it must not be silently ignored just because the
    // lookup's subcommand argument doesn't literally equal NULL.
    insertRule({ subcommand: null, type: 'channel', valueId: 'chan-allowed' });

    const allowed = await enforcePermissions(fakeInteraction({ channelId: 'chan-allowed' }), CMD, 'power');
    assert.equal(allowed, true);

    const denied = await enforcePermissions(fakeInteraction({ channelId: 'chan-other' }), CMD, 'power');
    assert.equal(denied, false);
});

test('enforcePermissions applies a command-wide (subcommand=NULL) role rule to a subcommand call', async () => {
    insertRule({ subcommand: null, type: 'role', valueId: 'role-riff' });

    const allowed = await enforcePermissions(fakeInteraction({ roleIds: ['role-riff'] }), CMD, 'top');
    assert.equal(allowed, true);

    const denied = await enforcePermissions(fakeInteraction({ roleIds: ['role-other'] }), CMD, 'top');
    assert.equal(denied, false);
});

test('enforcePermissions applies a command-wide rule identically across different subcommands', async () => {
    insertRule({ subcommand: null, type: 'channel', valueId: 'chan-allowed' });

    const powerAllowed = await enforcePermissions(fakeInteraction({ channelId: 'chan-allowed' }), CMD, 'power');
    const topAllowed = await enforcePermissions(fakeInteraction({ channelId: 'chan-allowed' }), CMD, 'top');
    assert.equal(powerAllowed, true);
    assert.equal(topAllowed, true);
});

test('enforcePermissions: a subcommand-specific rule overrides the command-wide rule of the SAME type', async () => {
    insertRule({ subcommand: null, type: 'channel', valueId: 'chan-general' });
    insertRule({ subcommand: 'power', type: 'channel', valueId: 'chan-power-only' });

    // The specific 'power' rule replaces (not adds to) the general one for 'power' calls.
    const generalChannelDenied = await enforcePermissions(fakeInteraction({ channelId: 'chan-general' }), CMD, 'power');
    assert.equal(generalChannelDenied, false);

    const specificChannelAllowed = await enforcePermissions(fakeInteraction({ channelId: 'chan-power-only' }), CMD, 'power');
    assert.equal(specificChannelAllowed, true);

    // A different subcommand with no specific rule of its own still falls back to general.
    const otherSubUsesGeneral = await enforcePermissions(fakeInteraction({ channelId: 'chan-general' }), CMD, 'top');
    assert.equal(otherSubUsesGeneral, true);
});

test('enforcePermissions: a subcommand-specific rule of one type does not suppress a command-wide rule of the OTHER type', async () => {
    // Regression guard for the precedence trap: picking specific-vs-general must be
    // decided independently per type (role, channel), not once for the whole lookup.
    insertRule({ subcommand: null, type: 'channel', valueId: 'chan-general' });
    insertRule({ subcommand: 'power', type: 'role', valueId: 'role-power-only' });

    // Right channel (from the general rule), right role (from the specific rule) -> allowed.
    const allowed = await enforcePermissions(
        fakeInteraction({ channelId: 'chan-general', roleIds: ['role-power-only'] }), CMD, 'power'
    );
    assert.equal(allowed, true);

    // Right role, but the general CHANNEL rule must still apply -- wrong channel is denied.
    const wrongChannel = await enforcePermissions(
        fakeInteraction({ channelId: 'chan-other', roleIds: ['role-power-only'] }), CMD, 'power'
    );
    assert.equal(wrongChannel, false);
});
