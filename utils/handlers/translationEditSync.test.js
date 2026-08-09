require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { handleTranslationEditSync, rebuildBatchAfterChange } = require('./translationRelayHandler');
const db = require('../db');

test('rebuildBatchAfterChange replaces the matching entry\'s text and leaves others untouched', () => {
    const batch = [
        { messageId: 'a', text: 'first' },
        { messageId: 'b', text: 'second' },
        { messageId: 'c', text: 'third' },
    ];
    const result = rebuildBatchAfterChange(batch, 'b', 'SECOND EDITED');
    assert.deepStrictEqual(result, [
        { messageId: 'a', text: 'first' },
        { messageId: 'b', text: 'SECOND EDITED' },
        { messageId: 'c', text: 'third' },
    ]);
});

test('rebuildBatchAfterChange removes the matching entry when newText is null', () => {
    const batch = [
        { messageId: 'a', text: 'first' },
        { messageId: 'b', text: 'second' },
    ];
    const result = rebuildBatchAfterChange(batch, 'a', null);
    assert.deepStrictEqual(result, [{ messageId: 'b', text: 'second' }]);
});

test('handleTranslationEditSync ignores edits from bot authors (loop guard)', async () => {
    let dbUpdateCalled = false;
    const originalUpdate = db.updateRelayMessageText;
    db.updateRelayMessageText = (...args) => { dbUpdateCalled = true; return originalUpdate(...args); };
    try {
        await handleTranslationEditSync({ author: { bot: true }, id: 'irrelevant', content: 'x' }, {});
        assert.strictEqual(dbUpdateCalled, false);
    } finally {
        db.updateRelayMessageText = originalUpdate;
    }
});

test('handleTranslationEditSync no-ops when the edited message is not a tracked relay message', async () => {
    let dbUpdateCalled = false;
    const originalUpdate = db.updateRelayMessageText;
    db.updateRelayMessageText = (...args) => { dbUpdateCalled = true; return originalUpdate(...args); };
    try {
        await handleTranslationEditSync({ author: { bot: false }, id: 'not-tracked-at-all', content: 'x' }, {});
        assert.strictEqual(dbUpdateCalled, false);
    } finally {
        db.updateRelayMessageText = originalUpdate;
    }
});

test('handleTranslationEditSync updates the source row and edits target copies (real Claude call)', async () => {
    // Requires ANTHROPIC_API_KEY to be set in this worktree's .env -- same live-API
    // convention as the batching feature's stub-client + real-API split (see
    // task-3-report.md). This test makes one real, small translation call.
    const { WebhookClient } = require('discord.js');

    // resyncRelayGroup looks up each sibling's channel row via db.getRelayChannelByChannelId,
    // so the target channel must be registered as a real relay channel row, not just
    // referenced by a bare string id in insertRelayMessage.
    const sourceChannelId = db.addRelayChannel({ channelId: 'chan-editsrc', language: 'English', flagEmoji: '🇺🇸' });
    const targetChannelId = db.addRelayChannel({ channelId: 'chan-edittarget-1', language: 'Spanish', flagEmoji: '🇪🇸' });

    const groupId = db.insertRelayMessage({
        relayGroupMessageId: 0, channelId: 'chan-editsrc', messageId: 'msg-editsrc-1',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'English', text: 'hello there',
    });
    db.setRelayMessageGroupId(groupId, groupId);
    db.insertRelayMessage({
        relayGroupMessageId: groupId, channelId: 'chan-edittarget-1', messageId: 'msg-editcopy-1',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'Spanish', text: 'hola',
    });

    const editedContent = [];
    const originalEdit = WebhookClient.prototype.editMessage;
    WebhookClient.prototype.editMessage = async function (messageId, payload) {
        editedContent.push({ messageId, payload });
        return { id: messageId };
    };
    const stubClient = {
        channels: {
            fetch: async () => ({
                createWebhook: async () => ({ id: 'wh-x', token: 'tok-x' }),
            }),
        },
    };
    try {
        await handleTranslationEditSync({ author: { bot: false }, id: 'msg-editsrc-1', content: 'hello world now' }, stubClient);

        const updatedSource = db.getRelayMessageByMessageId('msg-editsrc-1');
        assert.strictEqual(updatedSource.text, 'hello world now');
        assert.ok(editedContent.length > 0, 'expected at least one webhook editMessage call');
        assert.strictEqual(editedContent[0].messageId, 'msg-editcopy-1');
    } finally {
        WebhookClient.prototype.editMessage = originalEdit;
        db.deleteRelayMessagesByGroupId(groupId);
        db.removeRelayChannel(sourceChannelId);
        db.removeRelayChannel(targetChannelId);
    }
});
