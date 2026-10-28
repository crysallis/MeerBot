require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const { WebhookClient } = require('discord.js');
const handler = require('./translationRelayHandler');
const db = require('../db');

const longSpanish = `${'p'.repeat(1500)}\n${'q'.repeat(1500)}`;

function stubClient() {
    return {
        channels: {
            fetch: async () => ({
                createWebhook: async () => ({ id: 'wh-chunk', token: 'tok-chunk' }),
                messages: {
                    fetch: async () => ({ react: async () => {}, author: { displayAvatarURL: () => 'https://example.com/a.png' } }),
                },
            }),
        },
    };
}

function uniqueId(label) {
    return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function setupGroup(id) {
    const srcId = db.addRelayChannel({ channelId: `src-${id}`, language: 'English', flagEmoji: '🇺🇸', relayGroup: id });
    const tgtId = db.addRelayChannel({ channelId: `tgt-${id}`, language: 'Spanish', flagEmoji: '🇪🇸', relayGroup: id });
    return { srcId, tgtId };
}

function cleanup(id, { srcId, tgtId }) {
    db.removeRelayChannel(srcId);
    db.removeRelayChannel(tgtId);
    db.prepare('DELETE FROM translation_relay_messages WHERE message_id LIKE ? OR channel_id LIKE ?').run(`%${id}%`, `%${id}%`);
    db.prepare("DELETE FROM claude_usage WHERE feature = 'translation' AND ref_id LIKE ?").run(`%${id}%`);
}

async function relayLongPost(id) {
    const sent = [];
    let n = 0;
    const originalSend = WebhookClient.prototype.send;
    const originalCallClaude = handler.callClaude;
    WebhookClient.prototype.send = async function (payload) {
        sent.push(payload);
        return { id: `sent-${id}-${++n}` };
    };
    handler.callClaude = async () => ({ translations: { Spanish: [longSpanish] }, usage: { input_tokens: 10, output_tokens: 5 } });
    try {
        await handler.processTranslationRelay(stubClient(), {
            authorId: 'user-1',
            sourceChannelRow: db.getRelayChannelByChannelId(`src-${id}`),
            isReply: false,
            replyMessageId: null,
            authorDisplayName: 'Tester',
            authorAvatarURL: 'https://example.com/a.png',
            messages: [{ messageId: `msg-${id}`, text: 'a long english post', attachments: [{ url: 'https://cdn.example.com/i.png', name: 'i.png' }] }],
        });
    } finally {
        WebhookClient.prototype.send = originalSend;
        handler.callClaude = originalCallClaude;
    }
    return sent;
}

test('a translation over 2000 characters is sent as consecutive messages, none over the limit', async () => {
    const id = uniqueId('split');
    const group = setupGroup(id);
    try {
        const sent = await relayLongPost(id);
        assert.equal(sent.length, 2);
        for (const payload of sent) assert.ok(payload.content.length <= 2000);
        assert.equal(sent.map(p => p.content).join('\n'), longSpanish);
    } finally {
        cleanup(id, group);
    }
});

test('only the first chunk carries the attachments', async () => {
    const id = uniqueId('files');
    const group = setupGroup(id);
    try {
        const sent = await relayLongPost(id);
        assert.ok(sent[0].files);
        assert.equal(sent[1].files, undefined);
        assert.equal(sent[1].username, 'Tester');
    } finally {
        cleanup(id, group);
    }
});

test('the copy row is anchored on the first chunk and remembers the later ones', async () => {
    const id = uniqueId('anchor');
    const group = setupGroup(id);
    try {
        await relayLongPost(id);
        const row = db.getRelayMessageByMessageId(`sent-${id}-1`);
        assert.equal(row.message_id, `sent-${id}-1`);
        assert.deepEqual(JSON.parse(row.extra_message_ids), [`sent-${id}-2`]);
        assert.equal(row.text, longSpanish);
    } finally {
        cleanup(id, group);
    }
});

test('a lookup by a later chunk id resolves to the same relay group, so replies to any chunk quote correctly', async () => {
    const id = uniqueId('lookup');
    const group = setupGroup(id);
    try {
        await relayLongPost(id);
        const viaFirst = db.getRelayMessageByMessageId(`sent-${id}-1`);
        const viaSecond = db.getRelayMessageByMessageId(`sent-${id}-2`);
        assert.ok(viaSecond);
        assert.equal(viaSecond.id, viaFirst.id);
        assert.equal(viaSecond.relay_group_message_id, viaFirst.relay_group_message_id);
    } finally {
        cleanup(id, group);
    }
});

test('deleting the source post deletes every chunk of the copy', async () => {
    const id = uniqueId('del');
    const group = setupGroup(id);
    const deleted = [];
    const originalDelete = WebhookClient.prototype.deleteMessage;
    WebhookClient.prototype.deleteMessage = async function (messageId) { deleted.push(messageId); };
    try {
        await relayLongPost(id);
        await handler.handleTranslationDeleteSync({ id: `msg-${id}` }, stubClient());
        assert.deepEqual(deleted.sort(), [`sent-${id}-1`, `sent-${id}-2`]);
    } finally {
        WebhookClient.prototype.deleteMessage = originalDelete;
        cleanup(id, group);
    }
});

async function resyncWith(id, translation) {
    const calls = { edited: [], deleted: [], sent: [] };
    const originalEdit = WebhookClient.prototype.editMessage;
    const originalDelete = WebhookClient.prototype.deleteMessage;
    const originalSend = WebhookClient.prototype.send;
    const originalCallClaude = handler.callClaude;
    WebhookClient.prototype.editMessage = async function (messageId, payload) { calls.edited.push([messageId, payload.content]); return { id: messageId }; };
    WebhookClient.prototype.deleteMessage = async function (messageId) { calls.deleted.push(messageId); };
    WebhookClient.prototype.send = async function (payload) { calls.sent.push(payload); return { id: `resent-${id}-${calls.sent.length}` }; };
    handler.callClaude = async () => ({ translations: { Spanish: [translation] }, usage: { input_tokens: 1, output_tokens: 1 } });
    try {
        const source = db.getRelayMessageByMessageId(`msg-${id}`);
        await handler.resyncRelayGroup(stubClient(), source, [{ messageId: `msg-${id}`, text: 'edited english' }]);
    } finally {
        WebhookClient.prototype.editMessage = originalEdit;
        WebhookClient.prototype.deleteMessage = originalDelete;
        WebhookClient.prototype.send = originalSend;
        handler.callClaude = originalCallClaude;
    }
    return calls;
}

test('an edit that shortens the translation edits the first chunk and deletes the leftover chunks', async () => {
    const id = uniqueId('shrink');
    const group = setupGroup(id);
    try {
        await relayLongPost(id);
        const calls = await resyncWith(id, 'corto');
        assert.deepEqual(calls.edited, [[`sent-${id}-1`, 'corto']]);
        assert.deepEqual(calls.deleted, [`sent-${id}-2`]);
        const row = db.getRelayMessageByMessageId(`sent-${id}-1`);
        assert.deepEqual(JSON.parse(row.extra_message_ids), []);
    } finally {
        cleanup(id, group);
    }
});

test('an edit that lengthens the translation edits the existing chunks and sends the extra one', async () => {
    const id = uniqueId('grow');
    const group = setupGroup(id);
    try {
        await relayLongPost(id);
        const threeChunks = ['a', 'b', 'c'].map(ch => ch.repeat(1800)).join('\n');
        const calls = await resyncWith(id, threeChunks);
        assert.deepEqual(calls.edited.map(e => e[0]), [`sent-${id}-1`, `sent-${id}-2`]);
        assert.equal(calls.sent.length, 1);
        assert.ok(calls.sent[0].content.length <= 2000);
        const row = db.getRelayMessageByMessageId(`sent-${id}-1`);
        assert.deepEqual(JSON.parse(row.extra_message_ids), [`sent-${id}-2`, `resent-${id}-1`]);
    } finally {
        cleanup(id, group);
    }
});

function reactionClient(reactedOn) {
    return {
        user: { id: 'bot-id' },
        channels: {
            fetch: async () => ({
                messages: { fetch: async (messageId) => ({ react: async () => { reactedOn.push(messageId); } }) },
            }),
        },
    };
}

test('a reaction on the source post lands on the first chunk of the copy only', async () => {
    const id = uniqueId('react-src');
    const group = setupGroup(id);
    try {
        await relayLongPost(id);
        const reactedOn = [];
        await handler.handleTranslationReactionSync(
            { partial: false, message: { id: `msg-${id}` }, emoji: { id: null, name: '👍' } },
            { id: 'member-1' }, reactionClient(reactedOn), true);
        assert.deepEqual(reactedOn, [`sent-${id}-1`]);
    } finally {
        cleanup(id, group);
    }
});

test('a reaction on a later chunk of the copy still reaches the source post', async () => {
    const id = uniqueId('react-chunk');
    const group = setupGroup(id);
    try {
        await relayLongPost(id);
        const reactedOn = [];
        await handler.handleTranslationReactionSync(
            { partial: false, message: { id: `sent-${id}-2` }, emoji: { id: null, name: '👍' } },
            { id: 'member-1' }, reactionClient(reactedOn), true);
        assert.deepEqual(reactedOn, [`msg-${id}`]);
    } finally {
        cleanup(id, group);
    }
});
