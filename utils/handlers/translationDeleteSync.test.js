const test = require('node:test');
const assert = require('node:assert');
const { handleTranslationDeleteSync } = require('./translationRelayHandler');
const db = require('../db');

test('handleTranslationDeleteSync no-ops when the deleted message is not a tracked relay message', async () => {
    let deleteCalled = false;
    const originalDelete = db.deleteRelayMessagesByGroupId;
    db.deleteRelayMessagesByGroupId = (...args) => { deleteCalled = true; return originalDelete(...args); };
    try {
        await handleTranslationDeleteSync({ id: 'not-tracked-at-all' }, {});
        assert.strictEqual(deleteCalled, false);
    } finally {
        db.deleteRelayMessagesByGroupId = originalDelete;
    }
});

test('handleTranslationDeleteSync deletes all copies when the deleted message was the only line', async () => {
    const { WebhookClient } = require('discord.js');
    let srcId, targetId, groupId;
    const deletedIds = [];
    const originalDelete = WebhookClient.prototype.deleteMessage;
    WebhookClient.prototype.deleteMessage = async function (messageId) { deletedIds.push(messageId); };
    const stubClient = {
        channels: {
            fetch: async () => ({
                createWebhook: async () => ({ id: 'wh-y', token: 'tok-y' }),
            }),
        },
    };
    try {
        srcId = db.addRelayChannel({ channelId: 'chan-delsolo-src', language: 'English', flagEmoji: '🇺🇸', relayGroup: 'delsolo-group' });
        targetId = db.addRelayChannel({ channelId: 'chan-delsolo-target', language: 'Spanish', flagEmoji: '🇪🇸', relayGroup: 'delsolo-group' });

        groupId = db.insertRelayMessage({
            relayGroupMessageId: 0, channelId: 'chan-delsolo-src', messageId: 'msg-delsolo-src',
            authorId: 'user-1', authorDisplayName: 'Tester', language: 'English', text: 'solo message',
        });
        db.setRelayMessageGroupId(groupId, groupId);
        db.insertRelayMessage({
            relayGroupMessageId: groupId, channelId: 'chan-delsolo-target', messageId: 'msg-delsolo-copy',
            authorId: 'user-1', authorDisplayName: 'Tester', language: 'Spanish', text: 'mensaje solo',
        });

        await handleTranslationDeleteSync({ id: 'msg-delsolo-src' }, stubClient);
        assert.strictEqual(db.getRelayMessagesByGroupId(groupId).length, 0);
        assert.deepStrictEqual(deletedIds, ['msg-delsolo-copy']);
    } finally {
        WebhookClient.prototype.deleteMessage = originalDelete;
        // db.removeRelayChannel does not cascade-delete translation_relay_messages rows,
        // so leftover fixture rows would collide with fixed message_ids on the next run
        // (SQLITE_CONSTRAINT_UNIQUE) whether this test passed or threw partway through.
        if (groupId) db.deleteRelayMessagesByGroupId(groupId);
        if (srcId) db.removeRelayChannel(srcId);
        if (targetId) db.removeRelayChannel(targetId);
    }
});

test('handleTranslationDeleteSync re-translates remaining lines when one line of a batch is deleted', async () => {
    // Requires ANTHROPIC_API_KEY -- resyncRelayGroup calls the real callClaude, same as
    // Task 4's edit-sync test. This test makes one real, small translation call.
    const { WebhookClient } = require('discord.js');
    let srcId, targetId, groupId;
    const originalEdit = WebhookClient.prototype.editMessage;
    WebhookClient.prototype.editMessage = async function (messageId, payload) { return { id: messageId }; };
    const stubClient = {
        channels: { fetch: async () => ({ createWebhook: async () => ({ id: 'wh-z', token: 'tok-z' }) }) },
    };
    try {
        srcId = db.addRelayChannel({ channelId: 'chan-delbatch-src', language: 'English', flagEmoji: '🇺🇸', relayGroup: 'delbatch-group' });
        targetId = db.addRelayChannel({ channelId: 'chan-delbatch-target', language: 'Spanish', flagEmoji: '🇪🇸', relayGroup: 'delbatch-group' });

        const batchMessageIds = [
            { messageId: 'msg-batch-a', text: 'first line' },
            { messageId: 'msg-batch-b', text: 'second line' },
        ];
        groupId = db.insertRelayMessage({
            relayGroupMessageId: 0, channelId: 'chan-delbatch-src', messageId: 'msg-batch-a',
            authorId: 'user-1', authorDisplayName: 'Tester', language: 'English',
            text: 'first line\nsecond line', batchMessageIds, lastLineText: 'second line',
        });
        db.setRelayMessageGroupId(groupId, groupId);
        db.insertRelayMessage({
            relayGroupMessageId: groupId, channelId: 'chan-delbatch-target', messageId: 'msg-batchcopy-1',
            authorId: 'user-1', authorDisplayName: 'Tester', language: 'Spanish', text: 'primera linea\nsegunda linea',
        });

        await handleTranslationDeleteSync({ id: 'msg-batch-a' }, stubClient);

        const remaining = db.getRelayMessageByMessageId('msg-batch-b');
        assert.strictEqual(remaining.text, 'second line');
        assert.deepStrictEqual(JSON.parse(remaining.batch_message_ids), [{ messageId: 'msg-batch-b', text: 'second line' }]);
    } finally {
        WebhookClient.prototype.editMessage = originalEdit;
        // Same cascade note as the solo test above: resyncRelayGroup only UPDATEs rows
        // (it never deletes), so this test's message rows would leak indefinitely across
        // runs without an explicit delete here, unlike the solo test which self-cleans via
        // handleTranslationDeleteSync's own deleteRelayMessagesByGroupId call.
        if (groupId) db.deleteRelayMessagesByGroupId(groupId);
        if (srcId) db.removeRelayChannel(srcId);
        if (targetId) db.removeRelayChannel(targetId);
    }
});

test('handleTranslationDeleteSync no-ops when the deleted message is a relayed COPY, not the source', async () => {
    // Design spec: a moderator deleting a relayed copy is a deliberate moderation action
    // needing no bot handling. A copy row's batch_message_ids stores the SOURCE message's
    // id, not a self-reference, so without the row.id !== row.relay_group_message_id guard
    // this would fall through to resyncRelayGroup and silently overwrite the copy's own
    // stored text/last_line_text with re-translated SOURCE-language content.
    const { WebhookClient } = require('discord.js');
    let srcId, targetId, groupId;
    let updateCalled = false;
    let deleteMessageCalled = false;
    const originalUpdate = db.updateRelayMessageText;
    db.updateRelayMessageText = (...args) => { updateCalled = true; return originalUpdate(...args); };
    const originalDeleteMsg = WebhookClient.prototype.deleteMessage;
    WebhookClient.prototype.deleteMessage = async function () { deleteMessageCalled = true; };
    const stubClient = {
        channels: { fetch: async () => ({ createWebhook: async () => ({ id: 'wh-copy', token: 'tok-copy' }) }) },
    };
    try {
        srcId = db.addRelayChannel({ channelId: 'chan-delcopy-src', language: 'English', flagEmoji: '🇺🇸', relayGroup: 'delcopy-group' });
        targetId = db.addRelayChannel({ channelId: 'chan-delcopy-target', language: 'Spanish', flagEmoji: '🇪🇸', relayGroup: 'delcopy-group' });

        groupId = db.insertRelayMessage({
            relayGroupMessageId: 0, channelId: 'chan-delcopy-src', messageId: 'msg-delcopy-src',
            authorId: 'user-1', authorDisplayName: 'Tester', language: 'English', text: 'original message',
        });
        db.setRelayMessageGroupId(groupId, groupId);
        db.insertRelayMessage({
            relayGroupMessageId: groupId, channelId: 'chan-delcopy-target', messageId: 'msg-delcopy-copy',
            authorId: 'user-1', authorDisplayName: 'Tester', language: 'Spanish', text: 'mensaje original',
        });

        await handleTranslationDeleteSync({ id: 'msg-delcopy-copy' }, stubClient);

        assert.strictEqual(updateCalled, false, 'must not touch the copy row\'s stored text');
        assert.strictEqual(deleteMessageCalled, false, 'must not delete anything via webhook');

        const copyRow = db.getRelayMessagesByGroupId(groupId).find(r => r.message_id === 'msg-delcopy-copy');
        const sourceRow = db.getRelayMessagesByGroupId(groupId).find(r => r.message_id === 'msg-delcopy-src');
        assert.strictEqual(copyRow.text, 'mensaje original', 'copy text must be unchanged');
        assert.strictEqual(copyRow.last_line_text, 'mensaje original', 'copy last_line_text must be unchanged');
        assert.ok(sourceRow, 'the source row must still exist -- no cascade delete');
        assert.strictEqual(sourceRow.text, 'original message', 'source row must be untouched too');
    } finally {
        WebhookClient.prototype.deleteMessage = originalDeleteMsg;
        db.updateRelayMessageText = originalUpdate;
        if (groupId) db.deleteRelayMessagesByGroupId(groupId);
        if (srcId) db.removeRelayChannel(srcId);
        if (targetId) db.removeRelayChannel(targetId);
    }
});
