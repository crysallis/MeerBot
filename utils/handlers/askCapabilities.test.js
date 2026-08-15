require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { buildCapabilitySummary } = require('./askCapabilities');

const CMD = 'test_ask_cmd';

function insertRule({ subcommand = null, type, valueId }) {
    db.prepare(`INSERT INTO command_permissions (command, subcommand, type, value_id)
        VALUES (?, ?, ?, ?)`).run(CMD, subcommand, type, valueId);
}
function clearRules() {
    db.prepare('DELETE FROM command_permissions WHERE command = ?').run(CMD);
}
test.afterEach(() => clearRules());

function fakeMember({ roleIds = [], isAdmin = false } = {}) {
    return {
        roles: { cache: new Map(roleIds.map(id => [id, { id }])) },
        permissions: { has: () => isAdmin },
    };
}

test('buildCapabilitySummary notes a command-wide role restriction the member does not have', () => {
    insertRule({ subcommand: null, type: 'role', valueId: 'role-riff' });
    const summary = buildCapabilitySummary(fakeMember({ roleIds: [] }), { [CMD]: { description: 'Test command', subcommands: [{ name: `/${CMD}`, desc: 'does a thing' }] } });
    assert.match(summary, new RegExp(`${CMD}[\\s\\S]*(cannot|can't|no)`, 'i'));
});

test('buildCapabilitySummary notes a command-wide role restriction the member DOES have', () => {
    insertRule({ subcommand: null, type: 'role', valueId: 'role-riff' });
    const summary = buildCapabilitySummary(fakeMember({ roleIds: ['role-riff'] }), { [CMD]: { description: 'Test command', subcommands: [{ name: `/${CMD}`, desc: 'does a thing' }] } });
    assert.match(summary, new RegExp(`${CMD}[\\s\\S]*(can|yes)`, 'i'));
});

test('buildCapabilitySummary lists allowed channels for a channel-restricted command', () => {
    insertRule({ subcommand: null, type: 'channel', valueId: 'chan-leader' });
    const summary = buildCapabilitySummary(fakeMember({ roleIds: [] }), { [CMD]: { description: 'Test command', subcommands: [{ name: `/${CMD}`, desc: 'does a thing' }] } });
    assert.match(summary, /chan-leader/);
});

test('buildCapabilitySummary marks an unrestricted command as usable everywhere', () => {
    const summary = buildCapabilitySummary(fakeMember({ roleIds: [] }), { [CMD]: { description: 'Test command', subcommands: [{ name: `/${CMD}`, desc: 'does a thing' }] } });
    assert.match(summary, new RegExp(`${CMD}: no role restriction; usable in any channel`));
});
