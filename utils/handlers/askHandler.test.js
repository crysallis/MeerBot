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

const { isRateLimited } = require('./askHandler');

test('isRateLimited allows the first 10 questions in an hour then blocks the 11th', () => {
    const userId = `test-user-${Date.now()}`;
    for (let i = 0; i < 10; i++) {
        assert.equal(isRateLimited(userId), false, `question ${i + 1} should be allowed`);
    }
    assert.equal(isRateLimited(userId), true, 'the 11th question within the hour should be blocked');
});

test('isRateLimited tracks separate users independently', () => {
    const userA = `test-user-a-${Date.now()}`;
    const userB = `test-user-b-${Date.now()}`;
    for (let i = 0; i < 10; i++) isRateLimited(userA);
    assert.equal(isRateLimited(userA), true, 'userA should now be blocked');
    assert.equal(isRateLimited(userB), false, 'userB should be unaffected by userA\'s usage');
});
