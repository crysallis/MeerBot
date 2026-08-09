require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { handleTranslationReactionSync } = require('./translationRelayHandler');
const db = require('../db');

const BOT_USER_ID = 'bot-self-id';

function makeStubReaction({ messageId, emojiName = '👍', partial = false }) {
    return {
        partial,
        message: { id: messageId },
        emoji: { name: emojiName, id: null },
        fetch: async function () { this.partial = false; return this; },
    };
}

test('handleTranslationReactionSync ignores reactions added by the bot itself (loop guard)', async () => {
    let reactCalled = false;
    const stubClient = {
        user: { id: BOT_USER_ID },
        channels: { fetch: async () => ({ messages: { fetch: async () => ({ react: async () => { reactCalled = true; } }) } }) },
    };
    const reaction = makeStubReaction({ messageId: 'does-not-matter' });
    const user = { id: BOT_USER_ID };
    await handleTranslationReactionSync(reaction, user, stubClient, true);
    assert.strictEqual(reactCalled, false);
});

test('handleTranslationReactionSync no-ops when the reacted message is not a tracked relay message', async () => {
    let reactCalled = false;
    const stubClient = {
        user: { id: BOT_USER_ID },
        channels: { fetch: async () => ({ messages: { fetch: async () => ({ react: async () => { reactCalled = true; } }) } }) },
    };
    const reaction = makeStubReaction({ messageId: 'not-in-db-at-all' });
    const user = { id: 'real-user-1' };
    await handleTranslationReactionSync(reaction, user, stubClient, true);
    assert.strictEqual(reactCalled, false);
});

test('handleTranslationReactionSync mirrors a reaction on the original onto its relayed copy', async () => {
    const groupId = db.insertRelayMessage({
        relayGroupMessageId: 0, channelId: 'chan-src', messageId: 'msg-orig-1',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'English', text: 'hi',
    });
    db.setRelayMessageGroupId(groupId, groupId);
    db.insertRelayMessage({
        relayGroupMessageId: groupId, channelId: 'chan-target', messageId: 'msg-copy-1',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'Spanish', text: 'hola',
    });

    const reactedMessageIds = [];
    const stubClient = {
        user: { id: BOT_USER_ID },
        channels: {
            fetch: async () => ({
                messages: { fetch: async (id) => ({ react: async (emoji) => reactedMessageIds.push([id, emoji]) }) },
            }),
        },
    };
    const reaction = makeStubReaction({ messageId: 'msg-orig-1', emojiName: '🔥' });
    const user = { id: 'real-user-1' };
    await handleTranslationReactionSync(reaction, user, stubClient, true);
    assert.strictEqual(reactedMessageIds.length, 1);
    assert.strictEqual(reactedMessageIds[0][0], 'msg-copy-1');
});

test('handleTranslationReactionSync mirrors a reaction on a relayed copy back onto the original (bidirectional)', async () => {
    const groupId = db.insertRelayMessage({
        relayGroupMessageId: 0, channelId: 'chan-src', messageId: 'msg-orig-2',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'English', text: 'hi again',
    });
    db.setRelayMessageGroupId(groupId, groupId);
    db.insertRelayMessage({
        relayGroupMessageId: groupId, channelId: 'chan-target', messageId: 'msg-copy-2',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'Spanish', text: 'hola de nuevo',
    });

    const reactedMessageIds = [];
    const stubClient = {
        user: { id: BOT_USER_ID },
        channels: {
            fetch: async () => ({
                messages: { fetch: async (id) => ({ react: async (emoji) => reactedMessageIds.push([id, emoji]) }) },
            }),
        },
    };
    const reaction = makeStubReaction({ messageId: 'msg-copy-2', emojiName: '🔥' });
    const user = { id: 'real-user-1' };
    await handleTranslationReactionSync(reaction, user, stubClient, true);
    assert.strictEqual(reactedMessageIds.length, 1);
    assert.strictEqual(reactedMessageIds[0][0], 'msg-orig-2');
});

test('handleTranslationReactionSync fetches a partial reaction before reading its emoji', async () => {
    const groupId = db.insertRelayMessage({
        relayGroupMessageId: 0, channelId: 'chan-src', messageId: 'msg-orig-3',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'English', text: 'partial test',
    });
    db.setRelayMessageGroupId(groupId, groupId);
    db.insertRelayMessage({
        relayGroupMessageId: groupId, channelId: 'chan-target', messageId: 'msg-copy-3',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'Spanish', text: 'prueba parcial',
    });
    let fetchWasCalled = false;
    const reaction = makeStubReaction({ messageId: 'msg-orig-3', partial: true });
    reaction.fetch = async function () { fetchWasCalled = true; this.partial = false; return this; };
    const stubClient = {
        user: { id: BOT_USER_ID },
        channels: { fetch: async () => ({ messages: { fetch: async () => ({ react: async () => {} }) } }) },
    };
    await handleTranslationReactionSync(reaction, { id: 'real-user-1' }, stubClient, true);
    assert.strictEqual(fetchWasCalled, true);
});

test('handleTranslationReactionSync one target channel failing does not block others', async () => {
    const groupId = db.insertRelayMessage({
        relayGroupMessageId: 0, channelId: 'chan-src', messageId: 'msg-orig-4',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'English', text: 'multi target',
    });
    db.setRelayMessageGroupId(groupId, groupId);
    db.insertRelayMessage({
        relayGroupMessageId: groupId, channelId: 'chan-target-fail', messageId: 'msg-copy-fail',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'Spanish', text: 'fallara',
    });
    db.insertRelayMessage({
        relayGroupMessageId: groupId, channelId: 'chan-target-ok', messageId: 'msg-copy-ok',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'Russian', text: 'budet rabotat',
    });
    const reacted = [];
    const stubClient = {
        user: { id: BOT_USER_ID },
        channels: {
            fetch: async (channelId) => {
                if (channelId === 'chan-target-fail') throw new Error('missing access');
                return { messages: { fetch: async (id) => ({ react: async () => reacted.push(id) }) } };
            },
        },
    };
    const reaction = makeStubReaction({ messageId: 'msg-orig-4' });
    await handleTranslationReactionSync(reaction, { id: 'real-user-1' }, stubClient, true);
    assert.deepStrictEqual(reacted, ['msg-copy-ok']);
});
