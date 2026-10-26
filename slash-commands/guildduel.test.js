require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const cmd = require('./guildduel');

function fakeInteraction(focused) {
    const responses = [];
    return {
        responses,
        options: { getFocused: (full) => (full ? focused : focused.value) },
        respond: async (choices) => { responses.push(choices); },
    };
}

test('/guildduel has a recap subcommand with one optional, autocompleting date option', () => {
    const recap = cmd.data.toJSON().options.find(o => o.name === 'recap');
    assert.ok(recap, 'recap subcommand exists');
    assert.equal(recap.options.length, 1);
    assert.equal(recap.options[0].name, 'date');
    assert.equal(recap.options[0].autocomplete, true);
    assert.notEqual(recap.options[0].required, true);
});

test('the other /guildduel subcommands are still there', () => {
    const names = cmd.data.toJSON().options.map(o => o.name).sort();
    assert.deepEqual(names, ['add', 'low', 'missing', 'recap']);
});

test('date autocomplete offers weeks as plain labels with an ISO date value', async () => {
    const i = fakeInteraction({ name: 'date', value: '' });
    await cmd.autocomplete(i);
    assert.equal(i.responses.length, 1);
    for (const choice of i.responses[0]) {
        assert.match(choice.value, /^\d{4}-\d{2}-\d{2}$/);
        assert.match(choice.name, /^[A-Z][a-z]{2} \d{1,2} to [A-Z][a-z]{2} \d{1,2}, \d{4}$/);
    }
});

test('date autocomplete filters by what was typed and never offers more than 25', async () => {
    const i = fakeInteraction({ name: 'date', value: 'zzzz-no-such-week' });
    await cmd.autocomplete(i);
    assert.deepEqual(i.responses[0], []);
});

test('the member-name autocomplete used by /guildduel add still works', async () => {
    const i = fakeInteraction({ name: 'name', value: '' });
    await cmd.autocomplete(i);
    assert.ok(Array.isArray(i.responses[0]));
    assert.ok(i.responses[0].length <= 25);
    for (const choice of i.responses[0]) assert.equal(choice.name, choice.value);
});
