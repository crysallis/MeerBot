// utils/handlers/gloryctaReactionGuard.js
const db = require('../db');

// Discord's gateway is not guaranteed to echo variation selectors (VS15/VS16, U+FE0E/U+FE0F)
// consistently -- different clients encode reactions on emoji like '⚔️' (U+2694 U+FE0F) with
// or without the trailing VS16 depending on platform/keyboard. A naive === on reaction.emoji.name
// vs. the DB's stored string can therefore false-negative on a LEGITIMATE poll emoji. Because
// this guard *removes* on mismatch, a false negative silently deletes a real vote -- worse than
// a false positive letting something slip through -- so both sides are normalized before
// comparing. Verified this doesn't introduce collisions within EMOJI_POOL (utils/glorycta.js):
// all 40 entries remain distinct after stripping VS15/VS16.
//
// Note this is a different concern than translationRelayHandler.js's
// `reaction.emoji.id ? reaction.emoji : reaction.emoji.name` branch (lines ~347/349) -- that
// dispatches between a GuildEmoji object and a raw unicode string for re-react()/resolve() calls
// against custom vs. standard emoji. It doesn't touch string equality and doesn't apply here:
// glorycta's EMOJI_POOL is standard unicode emoji only (no custom guild emoji, no `id`), so the
// risk in this handler is VS16 normalization, not custom-emoji dispatch.
function stripVariationSelectors(str) {
    return typeof str === 'string' ? str.replace(/[︎️]/g, '') : str;
}

// Enforces that only a glory post's own valid emoji (2 for a cta poll, 3 for a
// confirm post -- emoji_c is NULL for cta rows, so filtering it out below is a
// no-op there) can be reacted onto its message. Any other emoji is removed
// immediately and silently -- no DM, no channel message. Untracked messages (not
// an open glory post, or a cta poll already tallied) are a no-op: fail safe,
// never act on a message this handler can't positively identify.
async function handleGloryctaReactionGuard(reaction, user, client) {
    if (user.bot) return;

    if (reaction.partial) {
        try {
            await reaction.fetch();
        } catch (err) {
            console.error('[Glorycta] Failed to fetch partial reaction:', err.message);
            return;
        }
    }

    const poll = db.getGloryctaPollByMessageId(reaction.message.id);
    if (!poll) return;

    const emojiName = stripVariationSelectors(reaction.emoji.name);
    const validEmoji = [poll.emoji_a, poll.emoji_b, poll.emoji_c]
        .filter(Boolean)
        .map(stripVariationSelectors);
    if (validEmoji.includes(emojiName)) return;

    try {
        await reaction.users.remove(user.id);
    } catch (err) {
        console.error(`[Glorycta] Failed to remove invalid reaction from ${user.id}:`, err.message);
    }
}

module.exports = { handleGloryctaReactionGuard, stripVariationSelectors };
