// Discord's standard emoji set minus flags (regional-indicator pairs, which would
// dominate the randomness and carry no in-domain meaning here) and skin-tone
// modifier variants (redundant repeats of the same base emoji). Deliberately NOT
// admin-configurable and NOT fixed -- pickPollEmoji() draws two fresh ones every
// call so voters can't develop a positional/emoji habit instead of reading the
// actual time labels.
const EMOJI_POOL = [
    '😀', '😂', '😍', '🤔', '😎', '🥳', '😴', '🤯', '🙃', '😇',
    '🐢', '🦋', '🐙', '🦊', '🐸', '🦉', '🐝', '🦁', '🐳', '🦄',
    '🍕', '🍔', '🍩', '🍎', '🍇', '🥑', '🍉', '🌮', '🍪', '🧁',
    '⚔️', '🛡️', '🏹', '🔥', '⭐', '🌙', '⚡', '💎', '🎯', '🚀',
];

function pickPollEmoji() {
    const a = EMOJI_POOL[Math.floor(Math.random() * EMOJI_POOL.length)];
    let b = a;
    while (b === a) {
        b = EMOJI_POOL[Math.floor(Math.random() * EMOJI_POOL.length)];
    }
    return [a, b];
}

// Clash of Glory times are same-day-recurring slots, not far-future dates -- resolve
// "06:00" to the next UTC instant matching that clock time. If it's already passed
// today (or is exactly now), roll to tomorrow. Evaluated independently per call: the
// caller is responsible for calling this once per time option, so the two options in
// a poll are never assumed to land on the same calendar date.
function nextOccurrenceUtc(hhmm, fromDate = new Date()) {
    const [hh, mm] = hhmm.split(':').map(Number);
    const candidate = new Date(Date.UTC(
        fromDate.getUTCFullYear(), fromDate.getUTCMonth(), fromDate.getUTCDate(), hh, mm, 0, 0
    ));
    if (candidate <= fromDate) {
        candidate.setUTCDate(candidate.getUTCDate() + 1);
    }
    return candidate;
}

module.exports = { pickPollEmoji, nextOccurrenceUtc, EMOJI_POOL };
