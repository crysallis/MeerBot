const db = require('../db');

const PROMO_CHANNEL_ID = '1229551249209430066';

// A code is a whole line with no spaces, 7-20 alphanumeric chars (+ & for codes
// like Alna&Patch154AFK), optionally wrapped in ** or `. One line = one code,
// matching how every code has ever been posted (bold, labeled, or bare).
const LINE_RE = /^[*`]{0,2}([A-Za-z0-9&]{7,20})[*`]{0,2}$/gm;

// Same shape, but sharing a line with a "code:" label (e.g. "Redeem Code: 6kMtRBeUa5nh").
// Requires the literal label text so it can't catch an arbitrary line-ending word.
const LABELED_RE = /\bcode:\s*[*`]{0,2}([A-Za-z0-9&]{7,20})[*`]{0,2}\s*$/gim;

// Discord UI chrome, not user content - "Forwarded" lands alone on its own
// line in a forwarded message's content, same shape as a real bare code
const NON_CODES = new Set(['FORWARDED']);

function extractCodes(text) {
    const codes = new Set();
    const collect = re => {
        for (const m of text.matchAll(re)) {
            const code = m[1].toUpperCase();
            if (!NON_CODES.has(code)) codes.add(code);
        }
    };
    collect(LINE_RE);
    collect(LABELED_RE);
    return [...codes];
}

const insertCode = db.prepare(
    `INSERT OR IGNORE INTO promo_codes (code, posted_at, message_id) VALUES (?, ?, ?)`
);

function handlePromoCode(message) {
    if (message.channelId !== PROMO_CHANNEL_ID) return;

    const postedAt  = message.createdAt.toISOString();
    const messageId = message.id;

    const parts = [message.content || ''];
    for (const e of message.embeds) {
        if (e.title)       parts.push(e.title);
        if (e.description) parts.push(e.description);
        for (const f of (e.fields ?? [])) parts.push(f.value);
    }
    const fullText = parts.join('\n');

    const codes = extractCodes(fullText);
    let savedAny = false;
    for (const code of codes) {
        const result = insertCode.run(code, postedAt, messageId);
        if (result.changes > 0) {
            console.log(`[PromoCode] Saved new code: ${code}`);
            savedAny = true;
        }
    }
    if (savedAny) {
        message.react('💾').catch(() => {});
    } else if (codes.length > 0) {
        message.react('🔁').catch(() => {});
    }
}

function getRecentCodes(limit = 10) {
    return db.prepare(
        `SELECT code, posted_at FROM promo_codes ORDER BY posted_at DESC LIMIT ?`
    ).all(limit);
}

module.exports = { handlePromoCode, getRecentCodes, extractCodes };
