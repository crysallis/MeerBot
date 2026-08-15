require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');

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

const { isRateLimited, getRecentHistory, recordExchange } = require('./askHandler');

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

test('getRecentHistory returns answered exchanges in order, capped at the last 3', () => {
    const userId = `test-user-history-${Date.now()}`;
    for (let i = 1; i <= 4; i++) {
        isRateLimited(userId);
        recordExchange(userId, `question ${i}`, `answer ${i}`);
    }
    const history = getRecentHistory(userId);
    assert.equal(history.length, 3, 'should cap at the last 3 exchanges');
    assert.deepEqual(history.map(h => h.question), ['question 2', 'question 3', 'question 4']);
});

test('getRecentHistory excludes an in-flight question with no answer yet', () => {
    const userId = `test-user-inflight-${Date.now()}`;
    isRateLimited(userId);
    recordExchange(userId, 'answered question', 'the answer');
    isRateLimited(userId); // second question checked but not yet answered
    const history = getRecentHistory(userId);
    assert.equal(history.length, 1);
    assert.equal(history[0].question, 'answered question');
});

test('recordExchange fills in the in-flight entry rather than double-counting against the rate limit', () => {
    const userId = `test-user-fillin-${Date.now()}`;
    for (let i = 0; i < 10; i++) {
        isRateLimited(userId);
        recordExchange(userId, `q${i}`, `a${i}`);
    }
    assert.equal(isRateLimited(userId), true, '10 answered questions should still hit the 10/hour cap');
});

test('db.insertAskUsage writes a row with token counts for the asking user', () => {
    const userId = `test-user-usage-${Date.now()}`;
    db.insertAskUsage({ userId, inputTokens: 1234, outputTokens: 56 });
    const row = db.prepare('SELECT * FROM ask_usage WHERE user_id = ?').get(userId);
    assert.ok(row, 'expected a row to be inserted');
    assert.equal(row.input_tokens, 1234);
    assert.equal(row.output_tokens, 56);
    db.prepare('DELETE FROM ask_usage WHERE user_id = ?').run(userId);
});
