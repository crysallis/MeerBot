require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { handleTranslationEditSync, rebuildBatchAfterChange, resyncRelayGroup, callClaude } = require('./translationRelayHandler');
const translationRelayHandler = require('./translationRelayHandler');
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

test('rebuildBatchAfterChange does not mutate its input array', () => {
    const batch = [
        { messageId: 'a', text: 'first' },
        { messageId: 'b', text: 'second' },
    ];
    const snapshot = JSON.parse(JSON.stringify(batch));
    rebuildBatchAfterChange(batch, 'a', 'EDITED');
    assert.deepStrictEqual(batch, snapshot, 'edit case must not mutate input');
    rebuildBatchAfterChange(batch, 'a', null);
    assert.deepStrictEqual(batch, snapshot, 'delete case must not mutate input');
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

test('handleTranslationEditSync updates the SOURCE row, not a sibling, when both match by batch_message_ids (ambiguity guard)', async () => {
    // db.getRelayMessageByMessageId matches a row by its own message_id OR by any entry
    // inside ANY row's batch_message_ids JSON. Every sibling copy stores the source
    // message's own id inside its own batch_message_ids (for quote lookups), so looking
    // up by the source's id can match the source row OR a sibling row with no guaranteed
    // ordering. This test reproduces that ambiguity directly and confirms
    // handleTranslationEditSync's row.message_id === message.id guard picks the real
    // source row rather than accepting whichever row SQLite's unordered .get() returns.
    const sourceChannelId = db.addRelayChannel({ channelId: 'chan-ambig-src', language: 'English', flagEmoji: '🇺🇸' });
    const targetChannelId = db.addRelayChannel({ channelId: 'chan-ambig-target', language: 'Spanish', flagEmoji: '🇪🇸' });

    const groupId = db.insertRelayMessage({
        relayGroupMessageId: 0, channelId: 'chan-ambig-src', messageId: 'msg-ambig-src',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'English', text: 'hello there',
        batchMessageIds: [{ messageId: 'msg-ambig-src', text: 'hello there' }],
    });
    db.setRelayMessageGroupId(groupId, groupId);
    // The sibling's own batch_message_ids deliberately embeds the SOURCE message's id --
    // this is the exact shape that makes getRelayMessageByMessageId('msg-ambig-src')
    // ambiguous between the source row and this sibling row.
    const siblingId = db.insertRelayMessage({
        relayGroupMessageId: groupId, channelId: 'chan-ambig-target', messageId: 'msg-ambig-copy',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'Spanish', text: 'hola',
        batchMessageIds: [{ messageId: 'msg-ambig-src', text: 'hola' }],
    });

    // Sanity check: confirm the ambiguity actually exists in this environment before
    // relying on the guard to resolve it -- if getRelayMessageByMessageId ever returns
    // only one unambiguous row, this assertion (not the guard) is what would need updating.
    const direct = db.getRelayMessageByMessageId('msg-ambig-src');
    assert.ok(direct, 'expected a row to be found at all');

    const { WebhookClient } = require('discord.js');
    const editedContent = [];
    const originalEdit = WebhookClient.prototype.editMessage;
    WebhookClient.prototype.editMessage = async function (messageId, payload) {
        editedContent.push({ messageId, payload });
        return { id: messageId };
    };
    const originalCallClaude = translationRelayHandler.callClaude;
    translationRelayHandler.callClaude = async () => ({
        translations: { Spanish: ['hola mundo'] },
        usage: { input_tokens: 1, output_tokens: 1 },
    });
    try {
        await handleTranslationEditSync({ author: { bot: false }, id: 'msg-ambig-src', content: 'hello world' }, {
            channels: { fetch: async () => ({ createWebhook: async () => ({ id: 'wh-y', token: 'tok-y' }) }) },
        });

        const sourceRow = db.getRelayMessageByMessageId('msg-ambig-src');
        // After the fix, the row genuinely matching by its OWN message_id must be the one
        // that got updated -- the sibling's text must be untouched by this direct id lookup
        // in ways inconsistent with it being treated as an editable source.
        const rows = db.getRelayMessagesByGroupId(groupId);
        const sourceRowById = rows.find(r => r.message_id === 'msg-ambig-src');
        const siblingRowById = rows.find(r => r.id === siblingId);
        assert.strictEqual(sourceRowById.text, 'hello world', 'the genuine source row (own message_id match) should be updated');
        assert.notStrictEqual(siblingRowById.text, 'hello world', 'the sibling row must not have been overwritten with the edit source text');
    } finally {
        WebhookClient.prototype.editMessage = originalEdit;
        translationRelayHandler.callClaude = originalCallClaude;
        db.deleteRelayMessagesByGroupId(groupId);
        db.removeRelayChannel(sourceChannelId);
        db.removeRelayChannel(targetChannelId);
    }
});

test('resyncRelayGroup leaves stale copies in place (does not throw) when re-translation fails', async () => {
    const sourceChannelId = db.addRelayChannel({ channelId: 'chan-resync-fail-src', language: 'English', flagEmoji: '🇺🇸' });
    const targetChannelId = db.addRelayChannel({ channelId: 'chan-resync-fail-target', language: 'Spanish', flagEmoji: '🇪🇸' });

    const groupId = db.insertRelayMessage({
        relayGroupMessageId: 0, channelId: 'chan-resync-fail-src', messageId: 'msg-resync-fail-src',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'English', text: 'original text',
    });
    db.setRelayMessageGroupId(groupId, groupId);
    db.insertRelayMessage({
        relayGroupMessageId: groupId, channelId: 'chan-resync-fail-target', messageId: 'msg-resync-fail-copy',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'Spanish', text: 'texto original',
    });

    const originalCallClaude = translationRelayHandler.callClaude;
    translationRelayHandler.callClaude = async () => { throw new Error('simulated Claude failure'); };
    try {
        const sourceRow = db.getRelayMessageByMessageId('msg-resync-fail-src');
        const rebuilt = rebuildBatchAfterChange(JSON.parse(sourceRow.batch_message_ids), 'msg-resync-fail-src', 'edited text');

        const siblingsBefore = db.getRelayMessagesByGroupId(groupId).find(r => r.message_id === 'msg-resync-fail-copy');
        await assert.doesNotReject(resyncRelayGroup({}, sourceRow, rebuilt));

        // Source row DOES get updated (that happens before translation is attempted).
        const updatedSource = db.getRelayMessageByMessageId('msg-resync-fail-src');
        assert.strictEqual(updatedSource.text, 'edited text');

        // Sibling copy is left stale -- untouched -- since translation failed.
        const siblingAfter = db.getRelayMessagesByGroupId(groupId).find(r => r.message_id === 'msg-resync-fail-copy');
        assert.strictEqual(siblingAfter.text, siblingsBefore.text);
    } finally {
        translationRelayHandler.callClaude = originalCallClaude;
        db.deleteRelayMessagesByGroupId(groupId);
        db.removeRelayChannel(sourceChannelId);
        db.removeRelayChannel(targetChannelId);
    }
});

test('resyncRelayGroup (direct unit test): stubbed Claude, multiple siblings, one webhook failure does not block the other', async () => {
    const sourceChannelId = db.addRelayChannel({ channelId: 'chan-resync-multi-src', language: 'English', flagEmoji: '🇺🇸' });
    const targetChannelId1 = db.addRelayChannel({ channelId: 'chan-resync-multi-t1', language: 'Spanish', flagEmoji: '🇪🇸' });
    const targetChannelId2 = db.addRelayChannel({ channelId: 'chan-resync-multi-t2', language: 'Russian', flagEmoji: '🇷🇺' });

    const groupId = db.insertRelayMessage({
        relayGroupMessageId: 0, channelId: 'chan-resync-multi-src', messageId: 'msg-resync-multi-src',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'English', text: 'hi',
    });
    db.setRelayMessageGroupId(groupId, groupId);
    db.insertRelayMessage({
        relayGroupMessageId: groupId, channelId: 'chan-resync-multi-t1', messageId: 'msg-resync-multi-c1',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'Spanish', text: 'hola',
    });
    db.insertRelayMessage({
        relayGroupMessageId: groupId, channelId: 'chan-resync-multi-t2', messageId: 'msg-resync-multi-c2',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'Russian', text: 'privet',
    });

    const originalCallClaude = translationRelayHandler.callClaude;
    translationRelayHandler.callClaude = async () => ({
        translations: { Spanish: ['hola editado'], Russian: ['privet edited'] },
        usage: { input_tokens: 1, output_tokens: 1 },
    });
    const editAttempts = [];
    const stubClient = {
        channels: {
            fetch: async (channelId) => {
                if (channelId === 'chan-resync-multi-t1') {
                    return {
                        createWebhook: async () => ({ id: 'wh-fail', token: 'tok-fail' }),
                    };
                }
                return { createWebhook: async () => ({ id: 'wh-ok', token: 'tok-ok' }) };
            },
        },
    };
    const { WebhookClient } = require('discord.js');
    const originalEdit = WebhookClient.prototype.editMessage;
    WebhookClient.prototype.editMessage = async function (messageId, payload) {
        editAttempts.push(messageId);
        if (messageId === 'msg-resync-multi-c1') throw new Error('simulated webhook failure');
        return { id: messageId };
    };
    try {
        const sourceRow = db.getRelayMessageByMessageId('msg-resync-multi-src');
        const rebuilt = rebuildBatchAfterChange(JSON.parse(sourceRow.batch_message_ids), 'msg-resync-multi-src', 'hi edited');
        const siblings = await resyncRelayGroup(stubClient, sourceRow, rebuilt);

        assert.strictEqual(siblings.length, 2, 'should report both siblings regardless of the failure');
        assert.deepStrictEqual(editAttempts.sort(), ['msg-resync-multi-c1', 'msg-resync-multi-c2']);

        const c1After = db.getRelayMessagesByGroupId(groupId).find(r => r.message_id === 'msg-resync-multi-c1');
        const c2After = db.getRelayMessagesByGroupId(groupId).find(r => r.message_id === 'msg-resync-multi-c2');
        assert.strictEqual(c1After.text, 'hola', 'failed sibling should remain unchanged (stale)');
        assert.strictEqual(c2After.text, 'privet edited', 'succeeding sibling should be updated');
    } finally {
        WebhookClient.prototype.editMessage = originalEdit;
        translationRelayHandler.callClaude = originalCallClaude;
        db.deleteRelayMessagesByGroupId(groupId);
        db.removeRelayChannel(sourceChannelId);
        db.removeRelayChannel(targetChannelId1);
        db.removeRelayChannel(targetChannelId2);
    }
});

test('resyncRelayGroup rebuilds the quote-prefix and applies fitContent when editing a reply (Fix 2)', async () => {
    // Design spec Feature 3 Step 7 requires the quote-prefix to survive an edit -- before
    // the fix, resyncRelayGroup sent bare { content: bodyText } with no prefix and no
    // length guard, silently stripping the "> quoted text" header from every copy on edit.
    // The quoted message and the reply must share the same TARGET channel (both live in
    // the same relay_group and route to the same Spanish channel) -- resyncRelayGroup's
    // quote lookup matches replySource entries by channel_id against each sibling's own
    // channel_id, so the reply's Spanish copy and the quoted message's Spanish copy need
    // to be in the same channel for the match to succeed.
    const quotedChannelId = db.addRelayChannel({ channelId: 'chan-quoted-src', language: 'English', flagEmoji: '🇺🇸', relayGroup: 'quote-test-group' });
    const sharedTargetId = db.addRelayChannel({ channelId: 'chan-shared-target', language: 'Spanish', flagEmoji: '🇪🇸', relayGroup: 'quote-test-group' });
    const replySourceId = db.addRelayChannel({ channelId: 'chan-reply-src', language: 'English', flagEmoji: '🇺🇸', relayGroup: 'quote-test-group-2' });

    // The message being replied to -- needs its own relay group (source + copy row) so
    // resyncRelayGroup's replySource lookup can find the copy in the reply's target channel.
    const quotedGroupId = db.insertRelayMessage({
        relayGroupMessageId: 0, channelId: 'chan-quoted-src', messageId: 'msg-quoted-src',
        authorId: 'user-2', authorDisplayName: 'Other', language: 'English', text: 'the original quoted message',
    });
    db.setRelayMessageGroupId(quotedGroupId, quotedGroupId);
    db.insertRelayMessage({
        relayGroupMessageId: quotedGroupId, channelId: 'chan-shared-target', messageId: 'msg-quoted-copy',
        authorId: 'user-2', authorDisplayName: 'Other', language: 'Spanish', text: 'el mensaje citado original',
    });

    // The reply row being edited -- its Spanish copy lives in the SAME 'chan-shared-target'
    // channel as the quoted message's Spanish copy above.
    const replyGroupId = db.insertRelayMessage({
        relayGroupMessageId: 0, channelId: 'chan-reply-src', messageId: 'msg-reply-src',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'English', text: 'a reply',
    });
    db.setRelayMessageGroupId(replyGroupId, replyGroupId);
    db.insertRelayMessage({
        relayGroupMessageId: replyGroupId, channelId: 'chan-shared-target', messageId: 'msg-reply-copy',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'Spanish', text: '> el mensaje citado original\nuna respuesta',
    });

    const { WebhookClient } = require('discord.js');
    const editedPayloads = [];
    const originalEdit = WebhookClient.prototype.editMessage;
    WebhookClient.prototype.editMessage = async function (messageId, payload) {
        editedPayloads.push({ messageId, payload });
        return { id: messageId };
    };
    const originalCallClaude = translationRelayHandler.callClaude;
    translationRelayHandler.callClaude = async () => ({
        translations: { Spanish: ['una respuesta editada'] },
        usage: { input_tokens: 1, output_tokens: 1 },
    });
    const stubClient = {
        channels: { fetch: async () => ({ createWebhook: async () => ({ id: 'wh-quote', token: 'tok-quote' }) }) },
    };
    try {
        const sourceRow = db.getRelayMessageByMessageId('msg-reply-src');
        const rebuilt = rebuildBatchAfterChange(JSON.parse(sourceRow.batch_message_ids), 'msg-reply-src', 'an edited reply');

        // Pass the quoted message's id as replyMessageId, same as handleTranslationEditSync
        // now derives from message.reference?.messageId.
        await resyncRelayGroup(stubClient, sourceRow, rebuilt, 'msg-quoted-src');

        assert.strictEqual(editedPayloads.length, 1);
        assert.strictEqual(editedPayloads[0].messageId, 'msg-reply-copy');
        assert.ok(
            editedPayloads[0].payload.content.startsWith('> '),
            `expected the edited content to keep the quote-prefix, got: ${JSON.stringify(editedPayloads[0].payload.content)}`,
        );
        assert.ok(editedPayloads[0].payload.content.includes('una respuesta editada'));

        // The stored text (DB) stays prefix-free, matching processTranslationRelay's own
        // convention (text column never includes the quote-prefix, only the sent content does).
        const updatedCopy = db.getRelayMessageByMessageId('msg-reply-copy');
        assert.strictEqual(updatedCopy.text, 'una respuesta editada');
    } finally {
        WebhookClient.prototype.editMessage = originalEdit;
        translationRelayHandler.callClaude = originalCallClaude;
        db.deleteRelayMessagesByGroupId(quotedGroupId);
        db.deleteRelayMessagesByGroupId(replyGroupId);
        db.removeRelayChannel(quotedChannelId);
        db.removeRelayChannel(sharedTargetId);
        db.removeRelayChannel(replySourceId);
    }
});

test('resyncRelayGroup applies fitContent to keep the edited content under Discord\'s 2000-char limit (Fix 2)', async () => {
    const sourceChannelId = db.addRelayChannel({ channelId: 'chan-fit-src', language: 'English', flagEmoji: '🇺🇸', relayGroup: 'fit-test-group' });
    const targetChannelId = db.addRelayChannel({ channelId: 'chan-fit-target', language: 'Spanish', flagEmoji: '🇪🇸', relayGroup: 'fit-test-group' });

    const groupId = db.insertRelayMessage({
        relayGroupMessageId: 0, channelId: 'chan-fit-src', messageId: 'msg-fit-src',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'English', text: 'short',
    });
    db.setRelayMessageGroupId(groupId, groupId);
    db.insertRelayMessage({
        relayGroupMessageId: groupId, channelId: 'chan-fit-target', messageId: 'msg-fit-copy',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'Spanish', text: 'corto',
    });

    const { WebhookClient } = require('discord.js');
    const editedPayloads = [];
    const originalEdit = WebhookClient.prototype.editMessage;
    WebhookClient.prototype.editMessage = async function (messageId, payload) {
        editedPayloads.push({ messageId, payload });
        return { id: messageId };
    };
    const originalCallClaude = translationRelayHandler.callClaude;
    const oversized = 'x'.repeat(2500);
    translationRelayHandler.callClaude = async () => ({
        translations: { Spanish: [oversized] },
        usage: { input_tokens: 1, output_tokens: 1 },
    });
    const stubClient = {
        channels: { fetch: async () => ({ createWebhook: async () => ({ id: 'wh-fit', token: 'tok-fit' }) }) },
    };
    try {
        const sourceRow = db.getRelayMessageByMessageId('msg-fit-src');
        const rebuilt = rebuildBatchAfterChange(JSON.parse(sourceRow.batch_message_ids), 'msg-fit-src', 'a very long edit');

        await resyncRelayGroup(stubClient, sourceRow, rebuilt);

        assert.strictEqual(editedPayloads.length, 1);
        assert.ok(editedPayloads[0].payload.content.length <= 2000, `expected content to fit Discord's 2000-char limit, got length ${editedPayloads[0].payload.content.length}`);
    } finally {
        WebhookClient.prototype.editMessage = originalEdit;
        translationRelayHandler.callClaude = originalCallClaude;
        db.deleteRelayMessagesByGroupId(groupId);
        db.removeRelayChannel(sourceChannelId);
        db.removeRelayChannel(targetChannelId);
    }
});

test('handleTranslationEditSync no-ops when the edited message is a relayed COPY, not the source (Fix 5 symmetry)', async () => {
    const sourceChannelId = db.addRelayChannel({ channelId: 'chan-editcopy-src', language: 'English', flagEmoji: '🇺🇸', relayGroup: 'editcopy-group' });
    const targetChannelId = db.addRelayChannel({ channelId: 'chan-editcopy-target', language: 'Spanish', flagEmoji: '🇪🇸', relayGroup: 'editcopy-group' });

    const groupId = db.insertRelayMessage({
        relayGroupMessageId: 0, channelId: 'chan-editcopy-src', messageId: 'msg-editcopy-src',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'English', text: 'original message',
    });
    db.setRelayMessageGroupId(groupId, groupId);
    db.insertRelayMessage({
        relayGroupMessageId: groupId, channelId: 'chan-editcopy-target', messageId: 'msg-editcopy-copy',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'Spanish', text: 'mensaje original',
    });

    let updateCalled = false;
    const originalUpdate = db.updateRelayMessageText;
    db.updateRelayMessageText = (...args) => { updateCalled = true; return originalUpdate(...args); };
    try {
        // Edit-syncing the COPY row's own message id -- getRelayMessageByMessageId would
        // find this row's message_id directly, so it passes the row.message_id === message.id
        // check; only the row.id !== row.relay_group_message_id copy-detection guard stops it.
        await handleTranslationEditSync({ author: { bot: false }, id: 'msg-editcopy-copy', content: 'edited copy text' }, {});
        assert.strictEqual(updateCalled, false, 'must not touch the copy row -- only the source row is editable');

        const copyRow = db.getRelayMessagesByGroupId(groupId).find(r => r.message_id === 'msg-editcopy-copy');
        assert.strictEqual(copyRow.text, 'mensaje original', 'copy text must be unchanged');
    } finally {
        db.updateRelayMessageText = originalUpdate;
        db.deleteRelayMessagesByGroupId(groupId);
        db.removeRelayChannel(sourceChannelId);
        db.removeRelayChannel(targetChannelId);
    }
});

test('handleTranslationEditSync routes its resync through enqueueRelay keyed by the row\'s ACTUAL relay_group string, not its numeric row id (Fix 3)', async () => {
    // enqueueRelay(relayGroup, task) keys its queue Map on the relay_group STRING (e.g.
    // 'default' or a custom group name) -- handleTranslationEditSync only has
    // row.relay_group_message_id (a numeric row id) after its DB lookup, NOT that string.
    // The fix derives it via db.getRelayChannelByChannelId(row.channel_id).relay_group.
    // This test proves the derivation is correct by using a NON-default relay_group name
    // and confirming translationRelayHandler.relayQueues gets a new entry under that exact
    // string key (not under 'default', not under the numeric row id) once the edit's
    // queued task settles.
    const { relayQueues } = translationRelayHandler;
    const customGroup = `custom-relay-group-${Date.now()}`;
    const sourceChannelId = db.addRelayChannel({ channelId: 'chan-enqueue-src', language: 'English', flagEmoji: '🇺🇸', relayGroup: customGroup });
    const targetChannelId = db.addRelayChannel({ channelId: 'chan-enqueue-target', language: 'Spanish', flagEmoji: '🇪🇸', relayGroup: customGroup });

    const groupId = db.insertRelayMessage({
        relayGroupMessageId: 0, channelId: 'chan-enqueue-src', messageId: 'msg-enqueue-src',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'English', text: 'hi',
    });
    db.setRelayMessageGroupId(groupId, groupId);
    db.insertRelayMessage({
        relayGroupMessageId: groupId, channelId: 'chan-enqueue-target', messageId: 'msg-enqueue-copy',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'Spanish', text: 'hola',
    });

    const { WebhookClient } = require('discord.js');
    const originalEdit = WebhookClient.prototype.editMessage;
    WebhookClient.prototype.editMessage = async function (messageId) { return { id: messageId }; };
    const originalCallClaude = translationRelayHandler.callClaude;
    translationRelayHandler.callClaude = async () => ({
        translations: { Spanish: ['hola editado'] },
        usage: { input_tokens: 1, output_tokens: 1 },
    });
    const stubClient = {
        channels: { fetch: async () => ({ createWebhook: async () => ({ id: 'wh-enq', token: 'tok-enq' }) }) },
    };
    try {
        assert.ok(!relayQueues.has(customGroup), 'sanity check: no pre-existing queue entry for this fresh custom group');
        assert.ok(!relayQueues.has(String(groupId)), 'sanity check: nothing keyed under the numeric row id string either');

        await handleTranslationEditSync({ author: { bot: false }, id: 'msg-enqueue-src', content: 'hi edited' }, stubClient);

        assert.ok(relayQueues.has(customGroup), 'expected the edit\'s task to have been enqueued under the row\'s real relay_group string');
        assert.ok(!relayQueues.has(groupId), 'must not have been keyed under the numeric relay_group_message_id');

        // Confirm the queued promise actually settled (the work really ran through the queue).
        await relayQueues.get(customGroup);
        const updatedSource = db.getRelayMessageByMessageId('msg-enqueue-src');
        assert.strictEqual(updatedSource.text, 'hi edited');
    } finally {
        WebhookClient.prototype.editMessage = originalEdit;
        translationRelayHandler.callClaude = originalCallClaude;
        relayQueues.delete(customGroup);
        db.deleteRelayMessagesByGroupId(groupId);
        db.removeRelayChannel(sourceChannelId);
        db.removeRelayChannel(targetChannelId);
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
