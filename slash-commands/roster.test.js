require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cmd = require('./roster');

const sub = name => cmd.data.toJSON().options.find(o => o.name === name);

test('roster add and remove take an autocompleted guild option', () => {
    for (const name of ['add', 'remove']) {
        const guild = sub(name).options.find(o => o.name === 'guild');
        assert.equal(guild.autocomplete, true, name);
        assert.equal(guild.choices, undefined, name);
    }
});

test('roster no longer exports a hardcoded GUILDS map', () => {
    assert.equal(cmd.GUILDS, undefined);
});
