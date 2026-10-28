const DISCORD_CONTENT_MAX_LEN = 2000;
const MAX_OUTPUT_TOKENS = 16000; // stays under the SDK's non-streaming request limit
const BASE_OUTPUT_TOKENS = 512;
const PER_LINE_PER_LANGUAGE_TOKENS = 128;
const TOKENS_PER_CHAR = 0.8; // Cyrillic is the worst case for the tokenizer
const JSON_OVERHEAD_PER_LINE = 24;
const MIN_CUT_RATIO = 0.3;

function pickCut(rest, max) {
    const minCut = Math.floor(max * MIN_CUT_RATIO);
    for (const separator of ['\n\n', '\n', ' ']) {
        const at = rest.lastIndexOf(separator, max);
        if (at >= minCut) return at;
    }
    const open = rest.lastIndexOf('<', max - 1);
    if (open > 0 && open > rest.lastIndexOf('>', max - 1)) return open;
    return max;
}

function splitForDiscord(text, max = DISCORD_CONTENT_MAX_LEN, maxChunks = Infinity) {
    const chunks = [];
    let rest = text;
    while (rest.length > max) {
        if (chunks.length === maxChunks - 1) {
            chunks.push(rest.slice(0, max - 1).trimEnd() + '…');
            return chunks;
        }
        const cut = pickCut(rest, max);
        chunks.push(rest.slice(0, cut).trimEnd());
        rest = rest.slice(cut).trimStart();
    }
    if (rest.length > 0 || chunks.length === 0) chunks.push(rest);
    return chunks;
}

function outputTokenBudget(lines, languageCount) {
    const chars = lines.reduce((sum, l) => sum + l.length, 0);
    const perLanguage = Math.ceil(chars * TOKENS_PER_CHAR) + lines.length * JSON_OVERHEAD_PER_LINE;
    const budget = Math.max(
        1024,
        BASE_OUTPUT_TOKENS + lines.length * languageCount * PER_LINE_PER_LANGUAGE_TOKENS,
        BASE_OUTPUT_TOKENS + languageCount * perLanguage,
    );
    return Math.min(budget, MAX_OUTPUT_TOKENS);
}

module.exports = { splitForDiscord, outputTokenBudget, DISCORD_CONTENT_MAX_LEN };
