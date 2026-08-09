require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const { stripCodeFence, truncateQuote } = require('./translationRelayHandler');
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
