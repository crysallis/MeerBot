require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('./db');
const { isCommandAutoDeleteEnabled } = require('./autoDelete');

// Command name namespaced to this test file so it can never collide with a real
// command's saved rows in the shared DB.
const CMD = 'test_autodelete_cmd';

function insertRule({ subcommand = null, enabled = 1 }) {
    db.prepare(`INSERT INTO auto_delete_rules (scope, command, subcommand, enabled)
        VALUES ('command', ?, ?, ?)`).run(CMD, subcommand, enabled);
}

function clearRules() {
    db.prepare("DELETE FROM auto_delete_rules WHERE scope = 'command' AND command = ?").run(CMD);
}

test.afterEach(() => clearRules());

test('no rule -> disabled by default', () => {
    assert.equal(isCommandAutoDeleteEnabled(CMD, 'status'), false);
});

test('whole-command enabled row applies to any subcommand', () => {
    insertRule({ subcommand: null, enabled: 1 });
    assert.equal(isCommandAutoDeleteEnabled(CMD, 'status'), true);
    assert.equal(isCommandAutoDeleteEnabled(CMD, 'top'), true);
});

test('subcommand-specific row overrides whole-command row', () => {
    insertRule({ subcommand: null, enabled: 1 });
    insertRule({ subcommand: 'status', enabled: 0 });
    assert.equal(isCommandAutoDeleteEnabled(CMD, 'status'), false);
    assert.equal(isCommandAutoDeleteEnabled(CMD, 'top'), true);
});

test('command with no subcommands uses subcommand=null lookup', () => {
    insertRule({ subcommand: null, enabled: 1 });
    assert.equal(isCommandAutoDeleteEnabled(CMD, null), true);
});

test('scheduleCommandAutoDelete swallows a DB read failure instead of throwing', async () => {
    // Simulates SQLITE_BUSY from a concurrent /scan write -- must not propagate into
    // index.js's dispatch try/catch, which would editReply() over a successful command.
    const { scheduleCommandAutoDelete } = require('./autoDelete');
    const originalPrepare = db.prepare;
    db.prepare = () => { throw new Error('SQLITE_BUSY: database is locked'); };
    const fakeInteraction = { replied: true, deferred: false, deleteReply: async () => {} };
    try {
        assert.doesNotThrow(() => scheduleCommandAutoDelete(fakeInteraction, CMD, 'status'));
    } finally {
        db.prepare = originalPrepare;
    }
});
