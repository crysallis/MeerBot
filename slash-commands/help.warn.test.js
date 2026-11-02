require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const { COMMANDS } = require('./help');
const warnCmd = require('./warn');
const { visibleCommands } = require('../utils/handlers/askCapabilities');

const SUBS = ['add', 'edit', 'expire', 'strike', 'list', 'report'];

function fakeMember(canManage) {
    return { id: 'member-x', roles: { cache: new Map() }, permissions: { has: () => canManage } };
}

test('/help lists all six /warn subcommands', () => {
    assert.ok(COMMANDS.warn, 'warn entry exists');
    assert.deepEqual(COMMANDS.warn.subcommands.map(s => s.name.split(/\s+/)[1]), SUBS);
});

test('every /warn help line says who sees the reply', () => {
    for (const s of COMMANDS.warn.subcommands) {
        assert.match(s.desc, /(Only you see the reply\.|The reply is public\.)$/, s.name);
    }
});

const ISOLATED = 'test_warn_ask_isolated';
const MANAGE_SERVER = BigInt(warnCmd.data.default_member_permissions);

test('Ask MeerBot hides a Manage Server command from a member without Manage Server', () => {
    assert.equal(visibleCommands(fakeMember(false), { [ISOLATED]: COMMANDS.warn }, { [ISOLATED]: MANAGE_SERVER })[ISOLATED], undefined);
});

test('Ask MeerBot shows all /warn subcommands to a member with Manage Server', () => {
    const out = visibleCommands(fakeMember(true), { [ISOLATED]: COMMANDS.warn }, { [ISOLATED]: MANAGE_SERVER });
    assert.equal(out[ISOLATED].subcommands.length, 6);
});

test('/help follows the saved permission rules for /warn instead of a fixed Manage Server label', () => {
    assert.equal(COMMANDS.warn.perm, 'configured');
});
