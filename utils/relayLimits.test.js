const test = require('node:test');
const assert = require('node:assert/strict');
const { splitForDiscord, outputTokenBudget } = require('./relayLimits');

test('splitForDiscord leaves text under the limit as one chunk', () => {
    assert.deepEqual(splitForDiscord('hello there', 2000), ['hello there']);
});

test('splitForDiscord prefers a paragraph break over cutting mid-paragraph', () => {
    const text = `${'A'.repeat(1500)}\n\n${'B'.repeat(1500)}`;
    assert.deepEqual(splitForDiscord(text, 2000), ['A'.repeat(1500), 'B'.repeat(1500)]);
});

test('splitForDiscord falls back to a space when there is no line break', () => {
    const text = `${'word '.repeat(600)}`.trim();
    const chunks = splitForDiscord(text, 2000);
    assert.ok(chunks.length >= 2);
    for (const c of chunks) {
        assert.ok(c.length <= 2000);
        assert.ok(!c.startsWith(' ') && !c.endsWith(' '));
    }
    assert.equal(chunks.join(' '), text);
});

test('splitForDiscord hard-cuts a long unbroken string and loses nothing', () => {
    const text = 'x'.repeat(4500);
    const chunks = splitForDiscord(text, 2000);
    assert.equal(chunks.length, 3);
    for (const c of chunks) assert.ok(c.length <= 2000);
    assert.equal(chunks.join(''), text);
});

test('splitForDiscord never cuts inside a mention or custom emoji', () => {
    const mention = '<@123456789012345678>';
    const text = 'x'.repeat(1995) + mention;
    const chunks = splitForDiscord(text, 2000);
    assert.deepEqual(chunks, ['x'.repeat(1995), mention]);
});

test('splitForDiscord caps the chunk count and marks the cut with an ellipsis', () => {
    const text = 'y'.repeat(10000);
    const chunks = splitForDiscord(text, 2000, 3);
    assert.equal(chunks.length, 3);
    for (const c of chunks) assert.ok(c.length <= 2000);
    assert.ok(chunks[2].endsWith('…'));
});

test('outputTokenBudget keeps the old floor for a short single line', () => {
    assert.equal(outputTokenBudget(['hola'], 2), 1024);
});

test('outputTokenBudget scales with the text so a 3,800 character post fits two languages', () => {
    const budget = outputTokenBudget(['z'.repeat(3827)], 2);
    assert.ok(budget >= 6000, `expected at least 6000, got ${budget}`);
});

test('outputTokenBudget never exceeds the non-streaming ceiling', () => {
    assert.equal(outputTokenBudget(['z'.repeat(100000)], 3), 16000);
});
