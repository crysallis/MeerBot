require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const { stripCodeFence, truncateQuote } = require('./translationRelayHandler');

test('stripCodeFence leaves plain JSON unchanged', () => {
    const input = '{"English":"hello","Spanish":"hola"}';
    assert.equal(stripCodeFence(input), input);
});

test('stripCodeFence unwraps a ```json fenced block', () => {
    const input = '```json\n{"English":"hello"}\n```';
    assert.equal(stripCodeFence(input), '{"English":"hello"}');
});

test('stripCodeFence unwraps a bare ``` fenced block (no json tag)', () => {
    const input = '```\n{"English":"hello"}\n```';
    assert.equal(stripCodeFence(input), '{"English":"hello"}');
});

test('stripCodeFence does not strip backticks that only appear inside a JSON string value', () => {
    const input = '{"English":"use the `/scan` command"}';
    assert.equal(stripCodeFence(input), input);
});

test('truncateQuote leaves short text unchanged', () => {
    const input = 'a short message';
    assert.equal(truncateQuote(input), input);
});

test('truncateQuote truncates text over 100 chars with a trailing ellipsis', () => {
    const input = 'x'.repeat(150);
    const result = truncateQuote(input);
    assert.equal(result.length, 101); // 100 chars + …
    assert.ok(result.endsWith('…'));
    assert.equal(result.slice(0, 100), 'x'.repeat(100));
});

test('truncateQuote collapses newlines to spaces', () => {
    const input = 'line one\nline two\nline three';
    assert.equal(truncateQuote(input), 'line one line two line three');
});

test('takeBatch clears and returns the open batch for a relay group', () => {
    const { takeBatch, openBatches } = require('./translationRelayHandler');
    const fakeBatch = { authorId: 'user-1', messages: [{ messageId: 'm1', text: 'hi' }], timeoutHandle: setTimeout(() => {}, 100000) };
    openBatches.set('test-group-A', fakeBatch);

    const claimed = takeBatch('test-group-A');

    assert.equal(claimed, fakeBatch);
    assert.equal(openBatches.has('test-group-A'), false);
    clearTimeout(fakeBatch.timeoutHandle); // avoid leaving a dangling timer past the test
});

test('takeBatch returns undefined and is a no-op when no batch is open for that group', () => {
    const { takeBatch, openBatches } = require('./translationRelayHandler');
    assert.equal(openBatches.has('test-group-B'), false);

    const claimed = takeBatch('test-group-B');

    assert.equal(claimed, undefined);
    assert.equal(openBatches.has('test-group-B'), false);
});

test('takeBatch called twice in a row: second call returns undefined', () => {
    const { takeBatch, openBatches } = require('./translationRelayHandler');
    const fakeBatch = { authorId: 'user-1', messages: [{ messageId: 'm1', text: 'hi' }], timeoutHandle: setTimeout(() => {}, 100000) };
    openBatches.set('test-group-C', fakeBatch);

    const first = takeBatch('test-group-C');
    const second = takeBatch('test-group-C');

    assert.equal(first, fakeBatch);
    assert.equal(second, undefined);
    clearTimeout(fakeBatch.timeoutHandle);
});
