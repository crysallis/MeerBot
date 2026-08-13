require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { Collection } = require('@discordjs/collection');
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

// Builds a reaction whose message.reactions.cache also exposes OTHER existing
// reactions on the same message -- needed for the confirm-post one-vote-per-person
// swap path, which reads reaction.message.reactions.cache to find a user's prior
// pick among the other valid emoji. existingReactorsByEmoji maps an emoji string to
// the set of user ids already holding that reaction (simulating Discord's own
// per-reaction user list at the moment this new reaction arrives).
function makeStubReactionWithSiblings({ messageId, emojiName, existingReactorsByEmoji = {} }) {
    const removedFrom = {};
    const cache = new Collection();
    for (const [emoji, userIds] of Object.entries(existingReactorsByEmoji)) {
        const userSet = new Set(userIds);
        cache.set(emoji, {
            emoji: { name: emoji, id: null },
            users: {
                cache: userSet,
                fetch: async () => userSet,
                remove: async (userId) => { removedFrom[emoji] = userId; userSet.delete(userId); },
            },
        });
    }
    return {
        partial: false,
        message: { id: messageId, reactions: { cache } },
        emoji: { name: emojiName, id: null },
        users: { remove: async () => {} },
        get removedFrom() { return removedFrom; },
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

test('handleGloryctaReactionGuard allows the third emoji (emoji_c) on a cta-kind poll', async () => {
    // kind intentionally left unset here (mirrors the plain cta stub polls above) --
    // this test only checks emoji_c acceptance in the non-confirm early-return path,
    // not the swap logic. See the dedicated 'kind: confirm' tests below for that.
    const poll = { emoji_a: '✅', emoji_b: '❌', emoji_c: '🤔' };
    await withStubbedPoll(poll, async () => {
        const reaction = makeStubReaction({ messageId: 'msg-confirm-1', emojiName: '🤔' });
        const user = { id: 'user-1', bot: false };
        await handleGloryctaReactionGuard(reaction, user, {});
        assert.strictEqual(reaction.removeCalledWith, null);
    });
});

test('handleGloryctaReactionGuard removes an emoji outside a confirm poll\'s three', async () => {
    const poll = { emoji_a: '✅', emoji_b: '❌', emoji_c: '🤔' };
    await withStubbedPoll(poll, async () => {
        const reaction = makeStubReaction({ messageId: 'msg-confirm-2', emojiName: '🍕' });
        const user = { id: 'user-1', bot: false };
        await handleGloryctaReactionGuard(reaction, user, {});
        assert.strictEqual(reaction.removeCalledWith, 'user-1');
    });
});

test('handleGloryctaReactionGuard swaps a confirm vote: removes the user\'s prior pick when they react with a different valid emoji', async () => {
    const poll = { kind: 'confirm', emoji_a: '✅', emoji_b: '❌', emoji_c: '🤔' };
    await withStubbedPoll(poll, async () => {
        const reaction = makeStubReactionWithSiblings({
            messageId: 'msg-confirm-swap-1',
            emojiName: '🤔',
            existingReactorsByEmoji: { '✅': ['user-1', 'user-2'], '❌': [] },
        });
        const user = { id: 'user-1', bot: false };
        await handleGloryctaReactionGuard(reaction, user, {});
        assert.strictEqual(reaction.removedFrom['✅'], 'user-1');
        assert.strictEqual(reaction.removedFrom['❌'], undefined);
    });
});

test('handleGloryctaReactionGuard does not touch other users\' reactions when swapping', async () => {
    const poll = { kind: 'confirm', emoji_a: '✅', emoji_b: '❌', emoji_c: '🤔' };
    await withStubbedPoll(poll, async () => {
        const reaction = makeStubReactionWithSiblings({
            messageId: 'msg-confirm-swap-2',
            emojiName: '❌',
            existingReactorsByEmoji: { '✅': ['user-2', 'user-3'] },
        });
        const user = { id: 'user-1', bot: false };
        await handleGloryctaReactionGuard(reaction, user, {});
        assert.strictEqual(reaction.removedFrom['✅'], undefined);
    });
});

test('handleGloryctaReactionGuard swap is a no-op when the user had no prior reaction on this confirm post', async () => {
    const poll = { kind: 'confirm', emoji_a: '✅', emoji_b: '❌', emoji_c: '🤔' };
    await withStubbedPoll(poll, async () => {
        const reaction = makeStubReactionWithSiblings({
            messageId: 'msg-confirm-swap-3',
            emojiName: '✅',
            existingReactorsByEmoji: { '❌': ['user-2'], '🤔': ['user-3'] },
        });
        const user = { id: 'user-1', bot: false };
        await handleGloryctaReactionGuard(reaction, user, {});
        assert.deepStrictEqual(reaction.removedFrom, {});
    });
});

test('handleGloryctaReactionGuard does not swap on a cta-kind poll (both-emoji is a valid combined vote there)', async () => {
    const poll = { kind: 'cta', emoji_a: '⚔️', emoji_b: '🛡️' };
    await withStubbedPoll(poll, async () => {
        const reaction = makeStubReactionWithSiblings({
            messageId: 'msg-cta-both',
            emojiName: '🛡️',
            existingReactorsByEmoji: { '⚔️': ['user-1'] },
        });
        const user = { id: 'user-1', bot: false };
        await handleGloryctaReactionGuard(reaction, user, {});
        assert.deepStrictEqual(reaction.removedFrom, {});
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
