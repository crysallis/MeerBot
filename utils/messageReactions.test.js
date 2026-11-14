require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const { ruleApplies, anyRuleApplies } = require('./messageReactions');

const BOT = { id: 'bot-1' };
const client = { user: BOT };

// The pattern the Hello MeerBot onboarding rule uses on the admin Reactions tab:
// "hello" first, then the @mention, and nothing else but punctuation.
const GREETING = '^\\s*hello[\\s,.!]*<@!?\\d+>[\\s.!?]*$';

function rule(over = {}) {
    return {
        id: 1, name: 'r', enabled: 1, pattern: 'x', pattern_type: 'contains', ignore_case: 1,
        require_mention: 0, channel_filter: null, cooldown_seconds: 60, ...over,
    };
}

function msg(content, { mentionsBot = false, channelId = 'chan-1' } = {}) {
    return { content, channelId, mentions: { has: () => mentionsBot } };
}

const hello = rule({ pattern: GREETING, pattern_type: 'regex', require_mention: 1 });

test('the greeting rule fires on a bare "hello @MeerBot" in the usual spellings', () => {
    for (const text of ['Hello <@bot-1>'.replace('bot-1', '123'), 'hello, <@!123>!', 'HELLO <@123>  ', 'Hello! <@123>.']) {
        assert.equal(ruleApplies(hello, msg(text, { mentionsBot: true }), client), true, text);
    }
});

test('the greeting rule does not fire when anything else is in the message', () => {
    const cases = ['Hello <@123> how do I link my account?', '<@123> hello', 'Hello there <@123>', 'hello <@123> please', 'ok hello <@123>'];
    for (const text of cases) {
        assert.equal(ruleApplies(hello, msg(text, { mentionsBot: true }), client), false, text);
    }
});

test('the greeting rule still needs the bot to be the one mentioned', () => {
    assert.equal(ruleApplies(hello, msg('Hello <@123>', { mentionsBot: false }), client), false);
});

test('a rule without a mention requirement fires on its pattern alone (the ?channels style)', () => {
    const channels = rule({ pattern: '?channels' });
    assert.equal(ruleApplies(channels, msg('can someone ?channels please'), client), true);
    assert.equal(ruleApplies(channels, msg('nothing here'), client), false);
});

test('a rule limited to certain channels only applies in them', () => {
    const limited = rule({ pattern: 'ping', channel_filter: JSON.stringify(['chan-9']) });
    assert.equal(ruleApplies(limited, msg('ping', { channelId: 'chan-9' }), client), true);
    assert.equal(ruleApplies(limited, msg('ping', { channelId: 'chan-1' }), client), false);
});

test('a "mention" type rule applies to any message that mentions the bot, and only those', () => {
    const anyMention = rule({ pattern_type: 'mention', pattern: '' });
    assert.equal(ruleApplies(anyMention, msg('whatever', { mentionsBot: true }), client), true);
    assert.equal(ruleApplies(anyMention, msg('whatever', { mentionsBot: false }), client), false);
});

test('a broken regex never applies (and never throws)', () => {
    assert.equal(ruleApplies(rule({ pattern: '(', pattern_type: 'regex' }), msg('x'), client), false);
});

test('anyRuleApplies is true when any one rule applies and false for an empty list', () => {
    const rules = [rule({ pattern: 'nope' }), rule({ id: 2, pattern: '?channels' })];
    assert.equal(anyRuleApplies(rules, msg('?channels'), client), true);
    assert.equal(anyRuleApplies(rules, msg('hello'), client), false);
    assert.equal(anyRuleApplies([], msg('?channels'), client), false);
});
