const MARKER = '[meerbot]';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

let cache = { text: null, builtAt: 0 };

// Pure so it's testable without a real discord.js Guild -- takes plain
// {id, type, topic} objects, same shape channel.cache values expose.
function buildChannelGuideText(channels) {
    const lines = [];
    for (const channel of channels) {
        if (typeof channel.topic !== 'string') continue;
        const trimmed = channel.topic.trim();
        if (!trimmed.toLowerCase().startsWith(MARKER)) continue;
        const desc = trimmed.slice(MARKER.length).trim();
        if (!desc) continue;
        lines.push(`<#${channel.id}> — ${desc}`);
    }
    return lines.join('\n');
}

// guild.channels.cache is already populated from gateway events -- no REST
// call here, just re-scanning an in-memory cache, so the 24h TTL is purely
// to avoid rebuilding the string on every DM, not to limit API usage. An
// empty result is never cached -- it's cheap to rebuild and caching it would
// silently hide the whole channel guide for a day if the first DM lands
// before any channel is marked (or before the gateway cache is warm).
function getChannelGuideText(guild) {
    const now = Date.now();
    if (cache.text && now - cache.builtAt < CACHE_TTL_MS) {
        return cache.text;
    }
    const channels = [...guild.channels.cache.values()];
    const text = buildChannelGuideText(channels);
    if (text) cache = { text, builtAt: now };
    return text;
}

module.exports = { buildChannelGuideText, getChannelGuideText };
