require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const translationRelayHandlerModule = require('./translationRelayHandler');
const { stripCodeFence, truncateQuote, processTranslationRelay } = translationRelayHandlerModule;
const { WebhookClient } = require('discord.js');
const db = require('../db');

test('stripCodeFence leaves plain JSON unchanged', () => {
    const input = '{"English":"hello","Spanish":"hola"}';
    assert.equal(stripCodeFence(input), input);
});

test('stripCodeFence unwraps a ```json fenced block', () => {
    const input = '```json\n{"English":"hello"}\n```';
    assert.equal(stripCodeFence(input), '{"English":"hello"}');
});

test('stripCodeFence unwraps a bare ``` fenced block (no json tag)', () => {
    const input = '```\n{"English":"hello"}\n```';
    assert.equal(stripCodeFence(input), '{"English":"hello"}');
});

test('stripCodeFence does not strip backticks that only appear inside a JSON string value', () => {
    const input = '{"English":"use the `/scan` command"}';
    assert.equal(stripCodeFence(input), input);
});

test('truncateQuote leaves short text unchanged', () => {
    const input = 'a short message';
    assert.equal(truncateQuote(input), input);
});

test('truncateQuote truncates text over 100 chars with a trailing ellipsis', () => {
    const input = 'x'.repeat(150);
    const result = truncateQuote(input);
    assert.equal(result.length, 101); // 100 chars + …
    assert.ok(result.endsWith('…'));
    assert.equal(result.slice(0, 100), 'x'.repeat(100));
});

test('truncateQuote collapses newlines to spaces', () => {
    const input = 'line one\nline two\nline three';
    assert.equal(truncateQuote(input), 'line one line two line three');
});

test('takeBatch clears and returns the open batch for a relay group', () => {
    const { takeBatch, openBatches } = require('./translationRelayHandler');
    const fakeBatch = { authorId: 'user-1', messages: [{ messageId: 'm1', text: 'hi' }], timeoutHandle: setTimeout(() => {}, 100000) };
    openBatches.set('test-group-A', fakeBatch);

    const claimed = takeBatch('test-group-A');

    assert.equal(claimed, fakeBatch);
    assert.equal(openBatches.has('test-group-A'), false);
    clearTimeout(fakeBatch.timeoutHandle); // avoid leaving a dangling timer past the test
});

test('takeBatch returns undefined and is a no-op when no batch is open for that group', () => {
    const { takeBatch, openBatches } = require('./translationRelayHandler');
    assert.equal(openBatches.has('test-group-B'), false);

    const claimed = takeBatch('test-group-B');

    assert.equal(claimed, undefined);
    assert.equal(openBatches.has('test-group-B'), false);
});

test('takeBatch called twice in a row: second call returns undefined', () => {
    const { takeBatch, openBatches } = require('./translationRelayHandler');
    const fakeBatch = { authorId: 'user-1', messages: [{ messageId: 'm1', text: 'hi' }], timeoutHandle: setTimeout(() => {}, 100000) };
    openBatches.set('test-group-C', fakeBatch);

    const first = takeBatch('test-group-C');
    const second = takeBatch('test-group-C');

    assert.equal(first, fakeBatch);
    assert.equal(second, undefined);
    clearTimeout(fakeBatch.timeoutHandle);
});

// --- handleTranslationRelay routing tests ---------------------------------
//
// These lock in the JOIN / FLUSH / NEW-BATCH decision tree, not the
// translate-and-post pipeline (that stays live/manual per project
// convention). Each test's relay group only has ONE relay channel row
// registered (the source), so processTranslationRelay's targetChannels
// filter is empty and it early-returns before any Claude call or webhook
// send -- no live network calls happen even when a flush is forced.
// Cross-channel tests register a second channel (still zero *other*
// targets relative to whichever channel is "source" for that message,
// since both source rows share the group) -- see the cross-channel test
// for why that one still can't reach Claude either.

function fakeMessage({ channelId, authorId, content, isReply = false, username = 'tester' }) {
    return {
        author: { bot: false, id: authorId, username, displayAvatarURL: () => 'https://example.com/avatar.png' },
        member: null,
        channelId,
        id: `msg-${Math.random().toString(36).slice(2)}`,
        content,
        reference: isReply ? { messageId: 'referenced-msg-id' } : undefined,
        attachments: new Map(),
    };
}

const noopClient = {
    channels: { fetch: async () => null }, // targetChannels is always empty in these tests, so unused, but keep it safe
};

test('handleTranslationRelay: same author, same channel, two messages join one batch', async () => {
    const { handleTranslationRelay, takeBatch, openBatches } = require('./translationRelayHandler');
    const group = 'test-route-A';
    const chId = db.addRelayChannel({ channelId: 'route-a-ch1', language: 'English', flagEmoji: '🇺🇸', relayGroup: group });
    try {
        const m1 = fakeMessage({ channelId: 'route-a-ch1', authorId: 'author-1', content: 'hello' });
        const m2 = fakeMessage({ channelId: 'route-a-ch1', authorId: 'author-1', content: 'world' });

        await handleTranslationRelay(m1, noopClient);
        await handleTranslationRelay(m2, noopClient);

        const batch = openBatches.get(group);
        assert.ok(batch, 'expected an open batch for the group');
        assert.equal(batch.authorId, 'author-1');
        assert.equal(batch.messages.length, 2);
        assert.deepEqual(batch.messages.map(m => m.text), ['hello', 'world']);
    } finally {
        const leftover = takeBatch(group);
        if (leftover) clearTimeout(leftover.timeoutHandle);
        db.removeRelayChannel(chId);
    }
});

test('handleTranslationRelay: same author, different channel in same relay group flushes and starts a new batch', async () => {
    const { handleTranslationRelay, takeBatch, openBatches } = require('./translationRelayHandler');
    const group = 'test-route-B';
    const ch1 = db.addRelayChannel({ channelId: 'route-b-ch1', language: 'English', flagEmoji: '🇺🇸', relayGroup: group });
    const ch2 = db.addRelayChannel({ channelId: 'route-b-ch2', language: 'Spanish', flagEmoji: '🇪🇸', relayGroup: group });
    // The scenario needs two channels in-group so the routing decision has somewhere
    // to route the second message from -- but that means the forced flush of ch1's
    // batch would otherwise find ch2 as a real translate target and reach the live
    // Claude API. Neuter processTranslationRelay's target lookup for the duration of
    // this test only (restored in finally) so the flush early-returns before any
    // Claude call or webhook send -- this test is about routing, not the pipeline.
    const originalGetRelayChannels = db.getRelayChannels;
    db.getRelayChannels = () => [];
    try {
        const m1 = fakeMessage({ channelId: 'route-b-ch1', authorId: 'author-1', content: 'hello from ch1' });
        const m2 = fakeMessage({ channelId: 'route-b-ch2', authorId: 'author-1', content: 'hello from ch2' });

        await handleTranslationRelay(m1, noopClient);
        await handleTranslationRelay(m2, noopClient);

        const batch = openBatches.get(group);
        assert.ok(batch, 'expected a fresh open batch for the group');
        assert.equal(batch.messages.length, 1, 'the second message must NOT join the first channel\'s batch');
        assert.equal(batch.messages[0].text, 'hello from ch2');
        assert.equal(batch.sourceChannelRow.channel_id, 'route-b-ch2');
    } finally {
        db.getRelayChannels = originalGetRelayChannels;
        const leftover = takeBatch(group);
        if (leftover) clearTimeout(leftover.timeoutHandle);
        db.removeRelayChannel(ch1);
        db.removeRelayChannel(ch2);
    }
});

test('handleTranslationRelay: a different author\'s message flushes the open batch and starts their own', async () => {
    const { handleTranslationRelay, takeBatch, openBatches } = require('./translationRelayHandler');
    const group = 'test-route-C';
    const chId = db.addRelayChannel({ channelId: 'route-c-ch1', language: 'English', flagEmoji: '🇺🇸', relayGroup: group });
    try {
        const m1 = fakeMessage({ channelId: 'route-c-ch1', authorId: 'author-1', content: 'author one' });
        const m2 = fakeMessage({ channelId: 'route-c-ch1', authorId: 'author-2', content: 'author two' });

        await handleTranslationRelay(m1, noopClient);
        await handleTranslationRelay(m2, noopClient);

        const batch = openBatches.get(group);
        assert.ok(batch, 'expected an open batch for the second author');
        assert.equal(batch.authorId, 'author-2');
        assert.equal(batch.messages.length, 1);
        assert.equal(batch.messages[0].text, 'author two');
    } finally {
        const leftover = takeBatch(group);
        if (leftover) clearTimeout(leftover.timeoutHandle);
        db.removeRelayChannel(chId);
    }
});

test('handleTranslationRelay: a reply from the same author flushes the open batch and starts fresh', async () => {
    const { handleTranslationRelay, takeBatch, openBatches } = require('./translationRelayHandler');
    const group = 'test-route-D';
    const chId = db.addRelayChannel({ channelId: 'route-d-ch1', language: 'English', flagEmoji: '🇺🇸', relayGroup: group });
    try {
        const m1 = fakeMessage({ channelId: 'route-d-ch1', authorId: 'author-1', content: 'original' });
        const m2 = fakeMessage({ channelId: 'route-d-ch1', authorId: 'author-1', content: 'a reply', isReply: true });

        await handleTranslationRelay(m1, noopClient);
        await handleTranslationRelay(m2, noopClient);

        const batch = openBatches.get(group);
        assert.ok(batch, 'expected a fresh open batch started by the reply');
        assert.equal(batch.messages.length, 1, 'the reply must NOT join the existing batch');
        assert.equal(batch.messages[0].text, 'a reply');
        assert.equal(batch.isReply, true);
    } finally {
        const leftover = takeBatch(group);
        if (leftover) clearTimeout(leftover.timeoutHandle);
        db.removeRelayChannel(chId);
    }
});

test('handleTranslationRelay captures message attachments onto the batch entry', async () => {
    const { handleTranslationRelay, takeBatch, openBatches } = require('./translationRelayHandler');
    const group = 'test-attach-A';
    const chId = db.addRelayChannel({ channelId: 'attach-ch1', language: 'English', flagEmoji: '🇺🇸', relayGroup: group });
    try {
        const fakeMessage = {
            id: 'msg-attach-1',
            author: { id: 'user-1', bot: false, username: 'tester', displayAvatarURL: () => 'http://example.com/a.png' },
            member: { displayName: 'Tester' },
            content: 'check this out',
            channelId: 'attach-ch1',
            reference: null,
            attachments: new Map([
                ['att-1', { url: 'https://cdn.discordapp.com/attachments/1/2/image.png', name: 'image.png' }],
            ]),
        };
        await handleTranslationRelay(fakeMessage, noopClient);
        const batch = openBatches.get(group);
        assert.ok(batch, 'expected an open batch');
        assert.strictEqual(batch.messages[0].attachments.length, 1);
        assert.strictEqual(batch.messages[0].attachments[0].url, 'https://cdn.discordapp.com/attachments/1/2/image.png');
    } finally {
        const leftover = takeBatch(group);
        if (leftover) clearTimeout(leftover.timeoutHandle);
        db.removeRelayChannel(chId);
    }
});

test('processTranslationRelay includes files in the webhook send payload when attachments are present', async () => {
    const sentPayloads = [];
    let sendCallCount = 0;
    const uniqueId = `files-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const originalSend = WebhookClient.prototype.send;
    const originalCallClaude = translationRelayHandlerModule.callClaude;
    WebhookClient.prototype.send = async function (payload) {
        sentPayloads.push(payload);
        return { id: `sent-${uniqueId}-${++sendCallCount}` };
    };
    translationRelayHandlerModule.callClaude = async () => {
        return { translations: { Spanish: ['mira esto'] }, usage: { input_tokens: 10, output_tokens: 5 } };
    };
    try {
        const srcChanId = `src-${uniqueId}`;
        const tgtChanId = `tgt-${uniqueId}`;
        const msgId = `msg-${uniqueId}`;
        const groupId = `group-${uniqueId}`;

        const stubClient = {
            channels: {
                fetch: async () => ({
                    createWebhook: async () => ({ id: 'wh-1', token: 'tok-1' }),
                    messages: {
                        fetch: async () => ({ react: async () => {} }),
                    },
                }),
            },
        };
        const sourceId = db.addRelayChannel({ channelId: srcChanId, language: 'English', flagEmoji: '🇺🇸', relayGroup: groupId });
        const targetId = db.addRelayChannel({ channelId: tgtChanId, language: 'Spanish', flagEmoji: '🇪🇸', relayGroup: groupId });
        const sourceRow = db.getRelayChannelByChannelId(srcChanId);

        const batch = {
            authorId: 'user-1',
            sourceChannelRow: sourceRow,
            isReply: false,
            replyMessageId: null,
            authorDisplayName: 'Tester',
            authorAvatarURL: 'http://example.com/a.png',
            messages: [{
                messageId: msgId,
                text: 'look at this',
                attachments: [{ url: 'https://cdn.discordapp.com/attachments/1/2/image.png', name: 'image.png' }],
            }],
        };
        try {
            await processTranslationRelay(stubClient, batch);
            assert.ok(sentPayloads[0].files, 'expected files key on payload');
            assert.strictEqual(sentPayloads[0].files[0].attachment, 'https://cdn.discordapp.com/attachments/1/2/image.png');
            assert.strictEqual(sentPayloads[0].files[0].name, 'image.png');
        } finally {
            db.removeRelayChannel(sourceId);
            db.removeRelayChannel(targetId);
            db.prepare('DELETE FROM translation_relay_messages WHERE message_id LIKE ?').run(`%${uniqueId}%`);
            db.prepare('DELETE FROM translation_usage WHERE message_id LIKE ?').run(`%${uniqueId}%`);
        }
    } finally {
        WebhookClient.prototype.send = originalSend;
        translationRelayHandlerModule.callClaude = originalCallClaude;
    }
});

// --- Fix 1 verification: batch_message_ids must store {messageId,text}[], never flat
// strings, for a FRESH write made within this running process (not just after a restart's
// migration heals a pre-existing row). ----------------------------------------------------

test('processTranslationRelay stores batch_message_ids as {messageId,text}[] on a fresh write, both for the source row and every target copy', async () => {
    const uniqueId = `shape-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const originalSend = WebhookClient.prototype.send;
    const originalCallClaude = translationRelayHandlerModule.callClaude;
    let sendCallCount = 0;
    WebhookClient.prototype.send = async function () {
        return { id: `sent-${uniqueId}-${++sendCallCount}` };
    };
    translationRelayHandlerModule.callClaude = async () => {
        return {
            translations: { Spanish: ['primera linea', 'segunda linea'] },
            usage: { input_tokens: 10, output_tokens: 5 },
        };
    };
    try {
        const srcChanId = `src-${uniqueId}`;
        const tgtChanId = `tgt-${uniqueId}`;
        const groupId = `group-${uniqueId}`;
        const msgIdA = `msg-a-${uniqueId}`;
        const msgIdB = `msg-b-${uniqueId}`;

        const stubClient = {
            channels: {
                fetch: async () => ({ createWebhook: async () => ({ id: 'wh-shape', token: 'tok-shape' }) }),
            },
        };
        const sourceId = db.addRelayChannel({ channelId: srcChanId, language: 'English', flagEmoji: '🇺🇸', relayGroup: groupId });
        const targetId = db.addRelayChannel({ channelId: tgtChanId, language: 'Spanish', flagEmoji: '🇪🇸', relayGroup: groupId });
        const sourceRow = db.getRelayChannelByChannelId(srcChanId);

        const batch = {
            authorId: 'user-1',
            sourceChannelRow: sourceRow,
            isReply: false,
            replyMessageId: null,
            authorDisplayName: 'Tester',
            authorAvatarURL: 'http://example.com/a.png',
            messages: [
                { messageId: msgIdA, text: 'first line', attachments: [] },
                { messageId: msgIdB, text: 'second line', attachments: [] },
            ],
        };
        try {
            await processTranslationRelay(stubClient, batch);

            const sourceRelayRow = db.getRelayMessageByMessageId(msgIdA);
            assert.ok(sourceRelayRow, 'expected the source row to be findable by its anchor message id');
            const parsedSource = JSON.parse(sourceRelayRow.batch_message_ids);
            assert.deepStrictEqual(parsedSource, [
                { messageId: msgIdA, text: 'first line' },
                { messageId: msgIdB, text: 'second line' },
            ], 'source row batch_message_ids must be {messageId,text}[], not a flat string array');

            const copyRow = db.prepare('SELECT * FROM translation_relay_messages WHERE channel_id = ?').get(tgtChanId);
            assert.ok(copyRow, 'expected a target copy row to exist');
            const parsedCopy = JSON.parse(copyRow.batch_message_ids);
            assert.ok(Array.isArray(parsedCopy) && parsedCopy.length > 0, 'copy row batch_message_ids must be a non-empty array');
            for (const entry of parsedCopy) {
                assert.strictEqual(typeof entry, 'object', 'every entry must be an object, not a bare string');
                assert.ok('messageId' in entry && 'text' in entry, 'every entry must have messageId and text keys');
            }
        } finally {
            db.removeRelayChannel(sourceId);
            db.removeRelayChannel(targetId);
            db.prepare('DELETE FROM translation_relay_messages WHERE message_id LIKE ? OR channel_id = ?').run(`%${uniqueId}%`, tgtChanId);
            db.prepare('DELETE FROM translation_usage WHERE message_id LIKE ?').run(`%${uniqueId}%`);
        }
    } finally {
        WebhookClient.prototype.send = originalSend;
        translationRelayHandlerModule.callClaude = originalCallClaude;
    }
});

test('getRelayMessageByMessageId does not throw when a legacy flat-shaped row exists alongside normal rows, and returns no match for an unrelated lookup', () => {
    const uniqueId = `legacy-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const legacyChan = `legacy-chan-${uniqueId}`;
    const normalChan = `normal-chan-${uniqueId}`;
    const legacyMsgId = `legacy-msg-${uniqueId}`;
    const normalMsgId = `normal-msg-${uniqueId}`;
    const unrelatedMsgId = `unrelated-msg-${uniqueId}`;

    // Simulate a still-poisoned row (old flat-string shape) inserted directly, bypassing
    // insertRelayMessage's own serialization -- same technique the migration test uses.
    db.prepare(`INSERT INTO translation_relay_messages
        (relay_group_message_id, channel_id, message_id, author_id, author_display_name, language, text, batch_message_ids, last_line_text)
        VALUES (0, ?, ?, 'user-1', 'Tester', 'English', 'legacy text', ?, 'legacy text')`)
        .run(legacyChan, legacyMsgId, JSON.stringify([legacyMsgId]));

    const normalGroupId = db.insertRelayMessage({
        relayGroupMessageId: 0, channelId: normalChan, messageId: normalMsgId,
        authorId: 'user-1', authorDisplayName: 'Tester', language: 'English', text: 'normal text',
    });
    db.setRelayMessageGroupId(normalGroupId, normalGroupId);

    try {
        // The direct match path (message_id = ?) still finds the legacy row fine -- the
        // risk was always the EXISTS/json_each scan across OTHER rows' batch_message_ids.
        assert.doesNotThrow(() => db.getRelayMessageByMessageId(legacyMsgId));

        // A lookup that must fall through to the json_each scan (misses on direct match)
        // must not throw just because the legacy row is sitting in the table.
        let result;
        assert.doesNotThrow(() => { result = db.getRelayMessageByMessageId(unrelatedMsgId); });
        assert.strictEqual(result, undefined, 'an unrelated lookup must return no match, not throw or false-match');

        // A genuine match via a normal (non-legacy) row's batch_message_ids must still work
        // correctly with the legacy row present.
        const found = db.getRelayMessageByMessageId(normalMsgId);
        assert.ok(found, 'expected to still find the normal row by its own message_id');
        assert.strictEqual(found.message_id, normalMsgId);
    } finally {
        db.prepare('DELETE FROM translation_relay_messages WHERE channel_id IN (?, ?)').run(legacyChan, normalChan);
    }
});
