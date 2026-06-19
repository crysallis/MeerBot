const db = require('../db');

const PROMO_CHANNEL_ID = '1229551249209430066';

// English words that show up in reward descriptions but aren't codes
const STOP_WORDS = new Set([
    'DIAMONDS', 'UPDATE', 'LETTERS', 'INVITE', 'REWARDS', 'REDEMPTION',
    'EVERYONE', 'THANKS', 'SEASON', 'BEGINS', 'ADVENTURE', 'CELEBRATE',
    'CRYSTALS', 'BEFORE', 'LAUNCH', 'FESTIVAL', 'SPECIAL', 'PREPARE',
    'DRAGON', 'WORKERS', 'INTERNATIONAL', 'ANNIVERSARY', 'COMMUNITY',
    'GROWTH', 'CELEBRATING', 'ALMOST', 'FUTURE', 'BRIGHT', 'ORIGAMI',
    'HAMSTER', 'LANTERN', 'TREATS', 'SURPRISE', 'CHEERS', 'SPRING',
    'ARRIVAL', 'CREDIT', 'LETTER', 'BANNER', 'SUMMONS', 'TICKETS',
    'SELECTOR', 'INVITATIONS', 'RECRUITMENT', 'MEMORY', 'RANDOM',
    'THOUSAND', 'INCLUDES', 'GLORIOUS', 'COPIED', 'KEEPING', 'AVAILABLE',
    'GOODNESS', 'CLAIMED', 'STOLEN', 'TOTALLY', 'STINGY', 'GENEROUS',
    'THINKS', 'SHOULD', 'ANOTHER', 'LATELY', 'BETTER', 'LETTING',
    'LITTLE', 'STARVE', 'UPDATED', 'MAINTAINED', 'LONGER', 'PLEASE',
    'NOTIFY', 'MODERATOR', 'REMOVE', 'POSSIBLE', 'FROGGIE', 'STONKS',
    'ABYSMAL', 'CELESTIAL', 'SINBAD', 'JOURNEY', 'INSANE', 'PUTTING',
    'BEGIN', 'ABOVE', 'NOICE', 'COMES', 'REISSA', 'CONTESS',
    'THROUGH', 'BECAUSE', 'BEFORE', 'INSIDE', 'OUTSIDE', 'TOGETHER',
]);

// Codes: 5-20 chars, alphanumeric + & (for codes like Alna&Patch154AFK), no other punctuation
const CODE_CHARS = /^[A-Za-z0-9][A-Za-z0-9&]{3,18}[A-Za-z0-9]$/;

// Bold-formatted: **CODE**  (official AFK bot + member posts)
const BOLD_RE    = /\*\*([A-Za-z0-9][A-Za-z0-9&]{3,18}[A-Za-z0-9])\*\*/g;
// Code: XXXX — requires the colon so "Gift Code  Begin" doesn't match
const CODE_LABEL = /\bcode[s]?:\s*([A-Za-z0-9][A-Za-z0-9&]{3,18}[A-Za-z0-9])/gi;
// Whole message is a single token with no spaces
const SOLO_RE    = /^[A-Za-z0-9][A-Za-z0-9&]{3,18}[A-Za-z0-9]$/;
// AFKJ anywhere in text
const AFKJ_RE    = /\b(AFKJ[A-Za-z0-9]{3,15}|AFKJourney[A-Za-z0-9]{2,10})\b/gi;

// A token is a serial code if it contains both letters and digits (e.g. E8BESLBQZLZUD)
function isSerialCode(str) {
    return /[A-Za-z]/.test(str) && /[0-9]/.test(str) && CODE_CHARS.test(str);
}

function extractCodes(text) {
    const codes = new Set();

    const add = raw => {
        // Strip markdown formatting that might have wrapped the token
        const stripped = raw.replace(/^\*+|\*+$/g, '').replace(/^`+|`+$/g, '').trim();
        const c = stripped.toUpperCase().replace(/!$/, '');
        if (!CODE_CHARS.test(c)) return;
        if (STOP_WORDS.has(c)) return;
        codes.add(c);
    };

    // Bold-formatted: **CODE**
    for (const m of text.matchAll(BOLD_RE)) add(m[1]);

    // "Code: XXXX" or "Redemption Code: XXXX"
    for (const m of text.matchAll(CODE_LABEL)) add(m[1]);

    // AFKJ... prefix anywhere in text
    for (const m of text.matchAll(AFKJ_RE)) add(m[1]);

    // Whole message is a single code token
    const trimmed = text.trim();
    if (SOLO_RE.test(trimmed)) add(trimmed);

    // First word if it's a serial code (letters+digits mixed, like Rye60YMmfg7f)
    const firstWord = trimmed.split(/\s+/)[0].replace(/^\*+|\*+$/g, '').replace(/^`+|`+$/g, '');
    if (isSerialCode(firstWord)) add(firstWord);

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
    }
}

function getRecentCodes(limit = 10) {
    return db.prepare(
        `SELECT code, posted_at FROM promo_codes ORDER BY posted_at DESC LIMIT ?`
    ).all(limit);
}

module.exports = { handlePromoCode, getRecentCodes, extractCodes };
