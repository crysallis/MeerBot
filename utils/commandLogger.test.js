require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCommandString } = require('./commandLogger');

function fake(commandName, subName, options) {
    return { commandName, options: { data: [{ type: 1, name: subName, options }] } };
}

test('buildCommandString keeps ordinary option values', () => {
    const s = buildCommandString(fake('note', 'add', [{ name: 'name', value: 'Alpha' }, { name: 'text', value: 'hello there' }]));
    assert.equal(s, '/note add name:Alpha text:hello there');
});

test('buildCommandString hides the reason and note typed into /warn', () => {
    const add = buildCommandString(fake('warn', 'add', [{ name: 'member', value: 'Alpha' }, { name: 'reason', value: 'secret reason' }, { name: 'expires', value: '2026-12-31' }]));
    assert.equal(add, '/warn add member:Alpha reason:[hidden] expires:2026-12-31');
    const expire = buildCommandString(fake('warn', 'expire', [{ name: 'member', value: 'Alpha' }, { name: 'warning', value: '12' }, { name: 'note', value: 'private note' }]));
    assert.ok(!expire.includes('private'));
    assert.ok(expire.includes('warning:12'));
});

test('buildCommandString does not hide a reason option on other commands', () => {
    const s = buildCommandString(fake('afk', 'set', [{ name: 'reason', value: 'vacation' }]));
    assert.ok(s.includes('reason:vacation'));
});
