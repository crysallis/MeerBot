require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db');
const { handleAsk, getRecentHistory } = require('./askHandler');

const MessagesProto = Object.getPrototypeOf(new Anthropic({ apiKey: 'test-key' }).messages);

function fakeClient() {
    const member = { id: 'flow-test-member', roles: { cache: new Map() }, permissions: { has: () => false } };
    const guild = { channels: { cache: new Map() }, members: { fetch: async () => member } };
    return { guilds: { cache: new Map([[process.env.GUILD_ID, guild]]) } };
}

async function ask(userId, question, modelReply) {
    const sentToClaude = [];
    const replies = [];
    const saved = { create: MessagesProto.create, usage: db.insertAskUsage, flag: db.insertAskFlag };
    MessagesProto.create = async body => {
        sentToClaude.push(body);
        return { usage: { input_tokens: 1, output_tokens: 1 }, content: [{ text: JSON.stringify(modelReply) }] };
    };
    db.insertAskUsage = () => {};
    db.insertAskFlag = () => {};
    try {
        const message = {
            author: { id: userId, bot: false },
            guild: null,
            content: question,
            reply: async text => { replies.push(text); return { id: `reply-${userId}-${replies.length}` }; },
        };
        await handleAsk(message, fakeClient());
    } finally {
        MessagesProto.create = saved.create;
        db.insertAskUsage = saved.usage;
        db.insertAskFlag = saved.flag;
    }
    return { sentToClaude, replies };
}

test('the Ask MeerBot prompt tells the model to answer in the language the member wrote in', async () => {
    const { sentToClaude } = await ask('flow-lang-user', 'Banda, hay grupo de la cacería de cuernos?', { reply: 'ok', flagged: false });
    assert.equal(sentToClaude.length, 1);
    assert.match(sentToClaude[0].system, /same language the member wrote in/i);
    assert.match(sentToClaude[0].system, /never say you only speak/i);
});

test('an off-topic (flagged) answer is not kept as history, so one refusal cannot repeat', async () => {
    const user = 'flow-flagged-user';
    const first = await ask(user, 'is there a horn group?', { reply: 'I can only help with MeerBot stuff.', flagged: true });
    assert.equal(first.replies.length, 1, 'the refusal is still sent to the member');
    assert.deepEqual(getRecentHistory(user), []);
});

test('a normal (unflagged) answer is still kept as history', async () => {
    const user = 'flow-normal-user';
    await ask(user, 'what does /hornrally do?', { reply: 'It lists who took part.', flagged: false });
    assert.deepEqual(getRecentHistory(user).map(e => [e.question, e.answer]), [['what does /hornrally do?', 'It lists who took part.']]);
});

test('a refusal is dropped from the next request but earlier normal answers stay', async () => {
    const user = 'flow-mixed-user';
    await ask(user, 'q1', { reply: 'a1', flagged: false });
    await ask(user, 'q2', { reply: 'refused', flagged: true });
    const third = await ask(user, 'q3', { reply: 'a3', flagged: false });
    const sentHistory = third.sentToClaude[0].messages.map(m => m.content);
    assert.deepEqual(sentHistory, ['q1', 'a1', 'q3']);
});

// ---- @mention in a server channel ----

const messageReactions = require('../messageReactions');
const BOT_ID = 'bot-1';
let mentionCounter = 0;

async function mention(content, over = {}) {
    const sentToClaude = [];
    const replies = [];
    const saved = {
        create: MessagesProto.create, usage: db.insertAskUsage, flag: db.insertAskFlag,
        rule: messageReactions.matchesReactionRule,
    };
    MessagesProto.create = async body => {
        sentToClaude.push(body);
        return { usage: { input_tokens: 1, output_tokens: 1 }, content: [{ text: JSON.stringify(over.modelReply || { reply: 'channel answer', flagged: false }) }] };
    };
    const flags = [];
    db.insertAskUsage = () => {};
    db.insertAskFlag = f => { flags.push(f); };
    messageReactions.matchesReactionRule = () => over.ruleMatches === true;
    const userId = over.userId || `chan-user-${++mentionCounter}`;
    try {
        const message = {
            author: { id: userId, bot: false },
            guild: { id: over.guildId || process.env.GUILD_ID, channels: { cache: new Map() } },
            content,
            reference: over.reference === undefined ? null : over.reference,
            fetchReference: async () => over.referenced || null,
            mentions: {
                has: (user, opts = {}) => {
                    if (over.explicit === false) return !opts.ignoreRepliedUser && over.autoPing === true;
                    return content.includes(`<@${user.id}>`);
                },
            },
            reply: async payload => { replies.push(payload); return { id: `reply-${mentionCounter}` }; },
        };
        await handleAsk(message, { user: { id: BOT_ID }, guilds: { cache: new Map() } });
    } finally {
        MessagesProto.create = saved.create;
        db.insertAskUsage = saved.usage;
        db.insertAskFlag = saved.flag;
        messageReactions.matchesReactionRule = saved.rule;
    }
    return { sentToClaude, replies, userId, flags };
}

test('an @mention with a question in a server channel is answered right there', async () => {
    const { sentToClaude, replies } = await mention(`<@${BOT_ID}> how do I link my account?`);
    assert.equal(sentToClaude.length, 1);
    assert.deepEqual(sentToClaude[0].messages, [{ role: 'user', content: 'how do I link my account?' }]);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].content, 'channel answer');
});

test('a channel answer can never ping anyone, and carries no report hint', async () => {
    const { replies } = await mention(`<@${BOT_ID}> hi, what can you do?`);
    assert.deepEqual(replies[0].allowedMentions.parse, []);
    assert.doesNotMatch(replies[0].content, /React to this message/);
});

test('the channel prompt is written for a public reply, with no personal permission claims', async () => {
    const { sentToClaude } = await mention(`<@${BOT_ID}> what can I run?`);
    const system = sentToClaude[0].system;
    assert.match(system, /public/i);
    assert.doesNotMatch(system, /has DMed you/);
    assert.doesNotMatch(system, /THIS USER'S CAPABILITIES/);
    assert.match(system, /same language the member wrote in/i);
});

test('a message that does not mention the bot is ignored', async () => {
    const { sentToClaude, replies } = await mention('just chatting in the channel', { explicit: false });
    assert.equal(sentToClaude.length, 0);
    assert.equal(replies.length, 0);
});

test('the automatic ping from replying to one of the bot\'s own messages is not a mention', async () => {
    const { sentToClaude, replies } = await mention('thanks!', { explicit: false, autoPing: true });
    assert.equal(sentToClaude.length, 0);
    assert.equal(replies.length, 0);
});

test('a message in some other server is ignored', async () => {
    const { sentToClaude, replies } = await mention(`<@${BOT_ID}> hello?`, { guildId: 'some-other-guild' });
    assert.equal(sentToClaude.length, 0);
    assert.equal(replies.length, 0);
});

test('when a reaction rule matches the message, the Ask handler stays out (the rule wins)', async () => {
    const { sentToClaude, replies } = await mention(`Hello <@${BOT_ID}>`, { ruleMatches: true });
    assert.equal(sentToClaude.length, 0);
    assert.equal(replies.length, 0);
});

test('replying to someone\'s question and mentioning the bot answers that question', async () => {
    const { sentToClaude, replies } = await mention(`<@${BOT_ID}>`, {
        reference: { messageId: 'ref-1' },
        referenced: { content: 'does anyone know how to add a birthday?', author: { id: 'asker', bot: false } },
    });
    assert.deepEqual(sentToClaude[0].messages, [{ role: 'user', content: 'does anyone know how to add a birthday?' }]);
    assert.equal(replies.length, 1);
});

test('words added to a reply-mention are sent along with the question being replied to', async () => {
    const { sentToClaude } = await mention(`<@${BOT_ID}> answer in Spanish please`, {
        reference: { messageId: 'ref-1' },
        referenced: { content: 'how do I add a birthday?', author: { id: 'asker', bot: false } },
    });
    const sent = sentToClaude[0].messages[0].content;
    assert.match(sent, /answer in Spanish please/);
    assert.match(sent, /how do I add a birthday\?/);
});

test('a bare mention with nothing to answer gets a short nudge and no Claude call', async () => {
    const { sentToClaude, replies } = await mention(`<@${BOT_ID}>`);
    assert.equal(sentToClaude.length, 0);
    assert.equal(replies.length, 1);
    assert.match(replies[0].content, /\/help/);
});

test('a reply to a message that has no text (an image) with a bare mention gets the same nudge', async () => {
    const { sentToClaude, replies } = await mention(`<@${BOT_ID}>`, {
        reference: { messageId: 'ref-1' }, referenced: { content: '', author: { id: 'asker', bot: false } },
    });
    assert.equal(sentToClaude.length, 0);
    assert.match(replies[0].content, /\/help/);
});

test('a channel answer is not kept as conversation history', async () => {
    const { userId } = await mention(`<@${BOT_ID}> what is /hornrally?`);
    assert.deepEqual(getRecentHistory(userId), []);
});

test('mentions count against the same 10-per-hour limit as DMs', async () => {
    const userId = 'chan-limit-user';
    for (let i = 0; i < 10; i++) await mention(`<@${BOT_ID}> q${i}`, { userId });
    const eleventh = await mention(`<@${BOT_ID}> one more`, { userId });
    assert.equal(eleventh.sentToClaude.length, 0);
    assert.match(eleventh.replies[0].content, /limit of 10 questions per hour/);
});

test('a flagged channel answer is still logged for leadership', async () => {
    const { replies, flags } = await mention(`<@${BOT_ID}> what is the weather`, { modelReply: { reply: 'only guild stuff', flagged: true } });
    assert.equal(replies.length, 1);
    assert.deepEqual(flags.map(f => [f.question, f.source]), [['what is the weather', 'auto']]);
});
