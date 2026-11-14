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
