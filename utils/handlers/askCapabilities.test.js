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

function fakeMember({ roleIds = [], isAdmin = false, id = 'member-1' } = {}) {
    return {
        id,
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

const { visibleCommands } = require('./askCapabilities');

const MANAGE_SERVER = 32n;

function twoSubCommands() {
    return {
        [CMD]: {
            description: 'Test command',
            subcommands: [
                { name: `/${CMD} open`, desc: 'anyone can do this' },
                { name: `/${CMD} locked name:`, desc: 'needs a role' },
            ],
        },
    };
}

test('buildCapabilitySummary judges each subcommand by its own rule', () => {
    insertRule({ subcommand: 'locked', type: 'role', valueId: 'role-riff' });
    const summary = buildCapabilitySummary(fakeMember({ roleIds: [] }), twoSubCommands());
    assert.match(summary, new RegExp(`/${CMD} open: no role restriction`));
    assert.match(summary, new RegExp(`/${CMD} locked: you CANNOT use this`));
});

test('buildCapabilitySummary lets a member with the subcommand role through', () => {
    insertRule({ subcommand: 'locked', type: 'role', valueId: 'role-riff' });
    const summary = buildCapabilitySummary(fakeMember({ roleIds: ['role-riff'] }), twoSubCommands());
    assert.match(summary, new RegExp(`/${CMD} locked: you CAN use this`));
});

test('buildCapabilitySummary applies a Discord default permission when the member lacks it', () => {
    const summary = buildCapabilitySummary(fakeMember({ isAdmin: false }), twoSubCommands(), { [CMD]: MANAGE_SERVER });
    assert.match(summary, /CANNOT use this \(requires Manage Server\)/);
});

test('buildCapabilitySummary ignores the default permission for a member who has it', () => {
    const summary = buildCapabilitySummary(fakeMember({ isAdmin: true }), twoSubCommands(), { [CMD]: MANAGE_SERVER });
    assert.match(summary, new RegExp(`/${CMD}: no role restriction`));
    assert.doesNotMatch(summary, /CANNOT/);
});

test('visibleCommands hides subcommands the member cannot run and drops emptied commands', () => {
    insertRule({ subcommand: 'locked', type: 'role', valueId: 'role-riff' });
    const out = visibleCommands(fakeMember({ roleIds: [] }), twoSubCommands());
    assert.deepEqual(out[CMD].subcommands.map(s => s.name), [`/${CMD} open`]);

    insertRule({ subcommand: 'open', type: 'role', valueId: 'role-riff' });
    assert.deepEqual(visibleCommands(fakeMember({ roleIds: [] }), twoSubCommands()), {});
});

test('visibleCommands keeps channel-restricted commands (the summary says where they work)', () => {
    insertRule({ subcommand: null, type: 'channel', valueId: 'chan-leader' });
    const out = visibleCommands(fakeMember({ roleIds: [] }), twoSubCommands());
    assert.equal(out[CMD].subcommands.length, 2);
});

const botConfig = require('../botConfig');

test('visibleCommands hides the scan-user-only commands from everyone but the authorized user', () => {
    const commands = {
        scan: { description: 'scan', subcommands: [{ name: '/scan', desc: 'runs a scan' }] },
        review: { description: 'review', subcommands: [{ name: '/review list', desc: 'pending' }] },
        pearlbazaar: { description: 'pb', subcommands: [{ name: '/pearlbazaar floor:', desc: 'prices' }] },
    };
    assert.deepEqual(visibleCommands(fakeMember({ id: 'someone-else' }), commands, {}), {});
    const authorizedId = botConfig.get('SCAN_AUTHORIZED_USER');
    const roleIds = db.prepare(`SELECT value_id FROM command_permissions WHERE type = 'role' AND command IN ('scan', 'review', 'pearlbazaar')`).all().map(r => r.value_id);
    const out = visibleCommands(fakeMember({ id: authorizedId, roleIds }), commands, {});
    assert.deepEqual(Object.keys(out).sort(), ['pearlbazaar', 'review', 'scan']);
});

test('buildCapabilitySummary tells a non-authorized member the scan commands are scan-user only', () => {
    const commands = { scan: { description: 'scan', subcommands: [{ name: '/scan', desc: 'runs a scan' }] } };
    const summary = buildCapabilitySummary(fakeMember({ id: 'someone-else' }), commands, {});
    assert.match(summary, /\/scan: you CANNOT use this \(only the authorized scan user\)/);
});
