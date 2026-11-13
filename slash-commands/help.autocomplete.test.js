require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const { helpChoices } = require('./help');

const DISCORD_CHOICE_LIMIT = 25;
const names = Array.from({ length: 30 }, (_, i) => `cmd${String(i + 1).padStart(2, '0')}`);

test('/help autocomplete with nothing typed stays within Discord\'s 25-choice limit', () => {
    const choices = helpChoices(names, '');
    assert.equal(choices.length, DISCORD_CHOICE_LIMIT);
    assert.deepEqual(choices[0], { name: 'cmd01', value: 'cmd01' });
});

test('/help autocomplete still finds a command past the first 25 by typing', () => {
    assert.deepEqual(helpChoices(names, 'cmd30'), [{ name: 'cmd30', value: 'cmd30' }]);
});

test('/help autocomplete matching is case-insensitive on the typed text', () => {
    assert.deepEqual(helpChoices(['warn', 'member'], 'WAR'), [{ name: 'warn', value: 'warn' }]);
});
