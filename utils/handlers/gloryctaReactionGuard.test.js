require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { handleGloryctaReactionGuard, stripVariationSelectors } = require('./gloryctaReactionGuard');
const db = require('../db');

function makeStubReaction({ messageId, emojiName, partial = false }) {
    let removeCalledWith = null;
    return {
        partial,
        message: { id: messageId },
        emoji: { name: emojiName, id: null },
        fetch: async function () { this.partial = false; return this; },
        users: { remove: async (userId) => { removeCalledWith = userId; } },
        get removeCalledWith() { return removeCalledWith; },
    };
}

// Stub db.getGloryctaPollByMessageId directly rather than inserting a real glorycta_polls row --
// that table's job_id column is a NOT NULL FK into scheduled_jobs, so a standalone test row would
// need a throwaway scheduled_jobs row too. Reassigning the property on the shared `db` module
// object works because the handler calls db.getGloryctaPollByMessageId(...) through that object
// (not a bare destructured local), so this isn't the module.exports mock trap.
function withStubbedPoll(poll, fn) {
    const original = db.getGloryctaPollByMessageId;
    db.getGloryctaPollByMessageId = () => poll;
    return Promise.resolve(fn()).finally(() => { db.getGloryctaPollByMessageId = original; });
}

test('stripVariationSelectors removes VS15/VS16 so the same base emoji compares equal either way', () => {
    assert.strictEqual(stripVariationSelectors('⚔️'), stripVariationSelectors('⚔'));
    assert.strictEqual(stripVariationSelectors('🛡️'), stripVariationSelectors('🛡'));
});

test('handleGloryctaReactionGuard ignores reactions added by the bot itself', async () => {
    const reaction = makeStubReaction({ messageId: 'msg-1', emojiName: '🍕' });
    const user = { id: 'bot-1', bot: true };
    await handleGloryctaReactionGuard(reaction, user, {});
    assert.strictEqual(reaction.removeCalledWith, null);
});

test('handleGloryctaReactionGuard no-ops when the message is not a tracked open poll', async () => {
    await withStubbedPoll(undefined, async () => {
        const reaction = makeStubReaction({ messageId: 'msg-untracked', emojiName: '🍕' });
        const user = { id: 'user-1', bot: false };
        await handleGloryctaReactionGuard(reaction, user, {});
        assert.strictEqual(reaction.removeCalledWith, null);
    });
});

test('handleGloryctaReactionGuard does not remove when the gateway echoes the emoji WITH the VS16 the DB also has', async () => {
    const poll = { emoji_a: '⚔️', emoji_b: '🛡️' };
    await withStubbedPoll(poll, async () => {
        const reaction = makeStubReaction({ messageId: 'msg-2', emojiName: '⚔️' });
        const user = { id: 'user-1', bot: false };
        await handleGloryctaReactionGuard(reaction, user, {});
        assert.strictEqual(reaction.removeCalledWith, null);
    });
});

test('handleGloryctaReactionGuard does not remove when the gateway strips the VS16 that the DB has', async () => {
    // This is the core risk this task exists to cover: DB stores '⚔️' (with VS16, exactly what
    // pickPollEmoji()/EMOJI_POOL produced and glorycta.js passed to message.react()), but the
    // gateway's messageReactionAdd payload echoes back '⚔' (bare, no VS16). A naive === here
    // would incorrectly treat a legitimate poll vote as invalid and delete it.
    const poll = { emoji_a: '⚔️', emoji_b: '🛡️' };
    await withStubbedPoll(poll, async () => {
        const reaction = makeStubReaction({ messageId: 'msg-3', emojiName: '⚔' });
        const user = { id: 'user-1', bot: false };
        await handleGloryctaReactionGuard(reaction, user, {});
        assert.strictEqual(reaction.removeCalledWith, null);
    });
});

test('handleGloryctaReactionGuard does not remove when the gateway strips the VS16 for emoji_b', async () => {
    const poll = { emoji_a: '⚔️', emoji_b: '🛡️' };
    await withStubbedPoll(poll, async () => {
        const reaction = makeStubReaction({ messageId: 'msg-4', emojiName: '🛡' });
        const user = { id: 'user-1', bot: false };
        await handleGloryctaReactionGuard(reaction, user, {});
        assert.strictEqual(reaction.removeCalledWith, null);
    });
});

test('handleGloryctaReactionGuard removes a reaction using an emoji outside the poll\'s two', async () => {
    const poll = { emoji_a: '⚔️', emoji_b: '🛡️' };
    await withStubbedPoll(poll, async () => {
        const reaction = makeStubReaction({ messageId: 'msg-5', emojiName: '🍕' });
        const user = { id: 'user-1', bot: false };
        await handleGloryctaReactionGuard(reaction, user, {});
        assert.strictEqual(reaction.removeCalledWith, 'user-1');
    });
});

test('handleGloryctaReactionGuard fetches a partial reaction before reading its emoji', async () => {
    const poll = { emoji_a: '⚔️', emoji_b: '🛡️' };
    await withStubbedPoll(poll, async () => {
        let fetchWasCalled = false;
        const reaction = makeStubReaction({ messageId: 'msg-6', emojiName: '⚔️', partial: true });
        reaction.fetch = async function () { fetchWasCalled = true; this.partial = false; return this; };
        const user = { id: 'user-1', bot: false };
        await handleGloryctaReactionGuard(reaction, user, {});
        assert.strictEqual(fetchWasCalled, true);
        assert.strictEqual(reaction.removeCalledWith, null);
    });
});

test('handleGloryctaReactionGuard bails out silently when fetching a partial reaction fails', async () => {
    const poll = { emoji_a: '⚔️', emoji_b: '🛡️' };
    await withStubbedPoll(poll, async () => {
        const reaction = makeStubReaction({ messageId: 'msg-7', emojiName: '🍕', partial: true });
        reaction.fetch = async () => { throw new Error('unknown message'); };
        const user = { id: 'user-1', bot: false };
        await assert.doesNotReject(handleGloryctaReactionGuard(reaction, user, {}));
        assert.strictEqual(reaction.removeCalledWith, null);
    });
});
