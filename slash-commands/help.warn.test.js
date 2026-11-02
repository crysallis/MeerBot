require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const { COMMANDS } = require('./help');
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

test('Ask MeerBot hides /warn from a member without Manage Server', () => {
    assert.equal(visibleCommands(fakeMember(false), { warn: COMMANDS.warn }).warn, undefined);
});

test('Ask MeerBot shows all /warn subcommands to a member with Manage Server', () => {
    const out = visibleCommands(fakeMember(true), { warn: COMMANDS.warn });
    assert.equal(out.warn.subcommands.length, 6);
});
