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

test('insertTranslationUsage stores a usage row', () => {
    db.prepare('DELETE FROM translation_usage WHERE message_id = ?').run('msg-usage-1');
    db.insertTranslationUsage({ messageId: 'msg-usage-1', inputTokens: 42, outputTokens: 17, targetCount: 2 });
    const row = db.prepare('SELECT * FROM translation_usage WHERE message_id = ?').get('msg-usage-1');
    assert.equal(row.input_tokens, 42);
    assert.equal(row.output_tokens, 17);
    assert.equal(row.target_count, 2);
    db.prepare('DELETE FROM translation_usage WHERE message_id = ?').run('msg-usage-1');
});
