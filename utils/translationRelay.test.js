require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('./db');

test('addRelayChannel + getRelayChannels round-trip', () => {
    const id = db.addRelayChannel({ channelId: 'test-ch-1', language: 'English', flagEmoji: '🇺🇸', relayGroup: 'test-group-1' });
    const rows = db.getRelayChannels('test-group-1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, id);
    assert.equal(rows[0].channel_id, 'test-ch-1');
    assert.equal(rows[0].language, 'English');
    db.removeRelayChannel(id);
});

test('getRelayChannelByChannelId finds the right row', () => {
    const id = db.addRelayChannel({ channelId: 'test-ch-2', language: 'Spanish', flagEmoji: '🇪🇸', relayGroup: 'test-group-2' });
    const row = db.getRelayChannelByChannelId('test-ch-2');
    assert.equal(row.id, id);
    db.removeRelayChannel(id);
});

test('addRelayChannel rejects duplicate channel_id', () => {
    const id = db.addRelayChannel({ channelId: 'test-ch-3', language: 'English', flagEmoji: '🇺🇸', relayGroup: 'test-group-3' });
    assert.throws(() => db.addRelayChannel({ channelId: 'test-ch-3', language: 'French', flagEmoji: '🇫🇷', relayGroup: 'test-group-3' }));
    db.removeRelayChannel(id);
});

test('setRelayChannelWebhook updates cached webhook creds', () => {
    const id = db.addRelayChannel({ channelId: 'test-ch-4', language: 'English', flagEmoji: '🇺🇸', relayGroup: 'test-group-4' });
    db.setRelayChannelWebhook(id, 'wh-id-123', 'wh-token-abc');
    const row = db.getRelayChannelByChannelId('test-ch-4');
    assert.equal(row.webhook_id, 'wh-id-123');
    assert.equal(row.webhook_token, 'wh-token-abc');
    db.removeRelayChannel(id);
});

test('insertRelayMessage + getRelayMessageByMessageId + getRelayMessagesByGroupId', () => {
    db.prepare('DELETE FROM translation_relay_messages WHERE message_id IN (?, ?)').run('msg-source-1', 'msg-copy-1');
    const groupId = db.insertRelayMessage({
        relayGroupMessageId: 0, channelId: 'test-ch-5', messageId: 'msg-source-1',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'English', text: 'hello',
    });
    db.setRelayMessageGroupId(groupId, groupId);
    db.insertRelayMessage({
        relayGroupMessageId: groupId, channelId: 'test-ch-6', messageId: 'msg-copy-1',
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'Spanish', text: 'hola',
    });

    const found = db.getRelayMessageByMessageId('msg-copy-1');
    assert.equal(found.relay_group_message_id, groupId);
    assert.equal(found.text, 'hola');

    const group = db.getRelayMessagesByGroupId(groupId);
    assert.equal(group.length, 2);
    db.prepare('DELETE FROM translation_relay_messages WHERE message_id IN (?, ?)').run('msg-source-1', 'msg-copy-1');
});

test('insertRelayMessage defaults batch_message_ids to [{messageId, text}] and last_line_text to text when omitted', () => {
    db.prepare('DELETE FROM translation_relay_messages WHERE message_id = ?').run('msg-solo');
    const groupId = db.insertRelayMessage({
        relayGroupMessageId: 0,
        channelId: 'chan-1',
        messageId: 'msg-solo',
        authorId: 'user-1',
        authorDisplayName: 'Tester',
        language: 'English',
        text: 'hello world',
    });
    db.setRelayMessageGroupId(groupId, groupId);
    const row = db.getRelayMessageByMessageId('msg-solo');
    assert.deepStrictEqual(JSON.parse(row.batch_message_ids), [{ messageId: 'msg-solo', text: 'hello world' }]);
    assert.strictEqual(row.last_line_text, 'hello world');
    db.prepare('DELETE FROM translation_relay_messages WHERE message_id = ?').run('msg-solo');
});

test('insertRelayMessage stores explicit batch_message_ids and last_line_text when provided', () => {
    db.prepare('DELETE FROM translation_relay_messages WHERE message_id IN (?, ?)').run('msg-a', 'msg-b');
    const batchMessageIds = [
        { messageId: 'msg-a', text: 'line one' },
        { messageId: 'msg-b', text: 'line two' },
    ];
    const groupId = db.insertRelayMessage({
        relayGroupMessageId: 0,
        channelId: 'chan-1',
        messageId: 'msg-a',
        authorId: 'user-1',
        authorDisplayName: 'Tester',
        language: 'English',
        text: 'line one\nline two',
        batchMessageIds,
        lastLineText: 'line two',
    });
    db.setRelayMessageGroupId(groupId, groupId);
    const row = db.getRelayMessageByMessageId('msg-a');
    assert.deepStrictEqual(JSON.parse(row.batch_message_ids), batchMessageIds);
    assert.strictEqual(row.last_line_text, 'line two');
    db.prepare('DELETE FROM translation_relay_messages WHERE message_id IN (?, ?)').run('msg-a', 'msg-b');
});

test('getRelayMessageByMessageId finds a row by a middle batch_message_ids entry, not just its own message_id', () => {
    db.prepare('DELETE FROM translation_relay_messages WHERE message_id IN (?, ?, ?)').run('msg-x', 'msg-y', 'msg-z');
    const batchMessageIds = [
        { messageId: 'msg-x', text: 'first' },
        { messageId: 'msg-y', text: 'second' },
        { messageId: 'msg-z', text: 'third' },
    ];
    const groupId = db.insertRelayMessage({
        relayGroupMessageId: 0,
        channelId: 'chan-1',
        messageId: 'msg-x',
        authorId: 'user-1',
        authorDisplayName: 'Tester',
        language: 'English',
        text: 'first\nsecond\nthird',
        batchMessageIds,
        lastLineText: 'third',
    });
    db.setRelayMessageGroupId(groupId, groupId);
    const row = db.getRelayMessageByMessageId('msg-y');
    assert.ok(row, 'expected to find the row via a middle batch entry');
    assert.strictEqual(row.message_id, 'msg-x');
    db.prepare('DELETE FROM translation_relay_messages WHERE message_id IN (?, ?, ?)').run('msg-x', 'msg-y', 'msg-z');
});

test('insertTranslationUsage stores a usage row in the shared claude_usage table', () => {
    db.prepare("DELETE FROM claude_usage WHERE feature = 'translation' AND ref_id = ?").run('msg-usage-1');
    db.insertTranslationUsage({ messageId: 'msg-usage-1', inputTokens: 42, outputTokens: 17, targetCount: 2 });
    const row = db.prepare("SELECT * FROM claude_usage WHERE feature = 'translation' AND ref_id = ?").get('msg-usage-1');
    assert.equal(row.input_tokens, 42);
    assert.equal(row.output_tokens, 17);
    assert.equal(row.target_count, 2);
    db.prepare("DELETE FROM claude_usage WHERE feature = 'translation' AND ref_id = ?").run('msg-usage-1');
});

test('updateRelayMessageText updates text, batch_message_ids, and last_line_text in place', () => {
    db.prepare('DELETE FROM translation_relay_messages WHERE message_id = ?').run('msg-edit-1');
    const groupId = db.insertRelayMessage({
        relayGroupMessageId: 0,
        channelId: 'chan-1',
        messageId: 'msg-edit-1',
        authorId: 'user-1',
        authorDisplayName: 'Tester',
        language: 'English',
        text: 'original text',
    });
    db.setRelayMessageGroupId(groupId, groupId);
    const row = db.getRelayMessageByMessageId('msg-edit-1');
    const newBatchMessageIds = [{ messageId: 'msg-edit-1', text: 'edited text' }];
    db.updateRelayMessageText(row.id, {
        text: 'edited text',
        batchMessageIds: newBatchMessageIds,
        lastLineText: 'edited text',
    });
    const updated = db.getRelayMessageByMessageId('msg-edit-1');
    assert.strictEqual(updated.text, 'edited text');
    assert.strictEqual(updated.last_line_text, 'edited text');
    assert.deepStrictEqual(JSON.parse(updated.batch_message_ids), newBatchMessageIds);
    db.prepare('DELETE FROM translation_relay_messages WHERE message_id = ?').run('msg-edit-1');
});

test('deleteRelayMessagesByGroupId removes every row sharing that group id', () => {
    const groupId = db.insertRelayMessage({
        relayGroupMessageId: 0,
        channelId: 'chan-1',
        messageId: 'msg-del-src',
        authorId: 'user-1',
        authorDisplayName: 'Tester',
        language: 'English',
        text: 'source text',
    });
    db.setRelayMessageGroupId(groupId, groupId);
    db.insertRelayMessage({
        relayGroupMessageId: groupId,
        channelId: 'chan-2',
        messageId: 'msg-del-copy',
        authorId: 'user-1',
        authorDisplayName: 'Tester',
        language: 'Spanish',
        text: 'texto fuente',
    });
    assert.strictEqual(db.getRelayMessagesByGroupId(groupId).length, 2);
    db.deleteRelayMessagesByGroupId(groupId);
    assert.strictEqual(db.getRelayMessagesByGroupId(groupId).length, 0);
});

test('startup migration rewrites old flat-string batch_message_ids into {messageId,text} shape', () => {
    // Simulate a pre-v3 row by inserting raw SQL bypassing insertRelayMessage's own serialization
    const rawDb = db.__testRawDb ?? db._db;
    rawDb.prepare('DELETE FROM translation_relay_messages WHERE message_id = ?').run('legacy-msg-1');
    rawDb.prepare(`INSERT INTO translation_relay_messages
        (relay_group_message_id, channel_id, message_id, author_id, author_display_name, language, text, batch_message_ids, last_line_text)
        VALUES (999, 'chan-1', 'legacy-msg-1', 'user-1', 'Tester', 'English', 'legacy text', '["legacy-msg-1"]', 'legacy text')`).run();
    db.__runRelayMessageMigration();
    const row = db.getRelayMessageByMessageId('legacy-msg-1');
    assert.deepStrictEqual(JSON.parse(row.batch_message_ids), [{ messageId: 'legacy-msg-1', text: 'legacy text' }]);
    rawDb.prepare('DELETE FROM translation_relay_messages WHERE message_id = ?').run('legacy-msg-1');
});
