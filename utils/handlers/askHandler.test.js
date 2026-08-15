require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');

test('help.js exports COMMANDS with expected shape', () => {
    const { COMMANDS } = require('../../slash-commands/help.js');
    assert.equal(typeof COMMANDS, 'object');
    assert.ok(COMMANDS.glory, 'expected a glory entry in COMMANDS');
    assert.equal(typeof COMMANDS.glory.description, 'string');
    assert.ok(Array.isArray(COMMANDS.glory.subcommands));
});

test('permissions.js exports pickRows', () => {
    const { pickRows } = require('../permissions');
    assert.equal(typeof pickRows, 'function');
    const rows = [{ subcommand: 'power', value_id: 'a' }, { subcommand: null, value_id: 'b' }];
    assert.deepEqual(pickRows(rows, 'power'), [{ subcommand: 'power', value_id: 'a' }]);
    assert.deepEqual(pickRows(rows, 'top'), [{ subcommand: null, value_id: 'b' }]);
});
