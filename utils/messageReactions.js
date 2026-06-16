'use strict';
const db = require('./db');
const { EmbedBuilder } = require('discord.js');

// In-memory cache of enabled rules
let cache = [];
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

// Per-user cooldown tracking: Map<userId, Map<ruleId, lastFiredMs>>
const cooldowns = new Map();

function loadCache() {
    cache = db.prepare(
        'SELECT * FROM message_reactions WHERE enabled = 1 ORDER BY id'
    ).all();
    cacheLoadedAt = Date.now();
}

function reloadCache() {
    loadCache();
}

function isOnCooldown(userId, ruleId, cooldownSec) {
    const userMap = cooldowns.get(userId);
    if (!userMap) return false;
    const last = userMap.get(ruleId);
    if (!last) return false;
    return Date.now() - last < cooldownSec * 1000;
}

function setCooldown(userId, ruleId) {
    if (!cooldowns.has(userId)) cooldowns.set(userId, new Map());
    cooldowns.get(userId).set(ruleId, Date.now());
}

function matchesPattern(rule, content) {
    const text = rule.ignore_case ? content.toLowerCase() : content;
    const pattern = rule.ignore_case ? rule.pattern.toLowerCase() : rule.pattern;

    if (rule.pattern_type === 'contains') return text.includes(pattern);
    if (rule.pattern_type === 'exact')    return text === pattern;
    if (rule.pattern_type === 'regex') {
        try {
            const flags = rule.ignore_case ? 'i' : '';
            return new RegExp(rule.pattern, flags).test(content);
        } catch {
            return false;
        }
    }
    return false;
}

function substituteVars(text, message) {
    if (!text) return text;
    const displayName = message.member?.displayName ?? message.author.displayName ?? message.author.username;
    return text
        .replace(/\{user\}/gi,     `<@${message.author.id}>`)
        .replace(/\{username\}/gi, displayName)
        .replace(/\{server\}/gi,   message.guild?.name ?? '')
        .replace(/\{channel\}/gi,  `<#${message.channelId}>`);
}

function buildPayload(rule) {
    const hasEmbed = rule.embed_title || rule.embed_description;
    if (!hasEmbed) return rule.response_content || '';

    const embed = new EmbedBuilder();
    if (rule.embed_title)       embed.setTitle(rule.embed_title);
    if (rule.embed_description) embed.setDescription(rule.embed_description);
    if (rule.embed_color) {
        try { embed.setColor(rule.embed_color); } catch {}
    }

    const payload = { embeds: [embed] };
    if (rule.response_content) payload.content = rule.response_content;
    return payload;
}

async function handleMessage(message, client) {
    if (message.author.bot) return;
    if (!message.guild)     return;

    // Refresh cache if stale
    if (Date.now() - cacheLoadedAt > CACHE_TTL_MS) loadCache();

    for (const rule of cache) {
        // Channel filter
        if (rule.channel_filter) {
            const allowed = JSON.parse(rule.channel_filter);
            if (!allowed.includes(message.channelId)) continue;
        }

        // Mention check
        const mentioned = message.mentions.has(client.user);
        if (rule.require_mention && !mentioned) continue;

        // Pattern match (mention type skips pattern, just needs the @mention)
        if (rule.pattern_type !== 'mention') {
            if (!matchesPattern(rule, message.content)) continue;
        } else {
            if (!mentioned) continue;
        }

        // Cooldown
        if (isOnCooldown(message.author.id, rule.id, rule.cooldown_seconds)) continue;
        setCooldown(message.author.id, rule.id);

        console.log(`[Reactions] Rule "${rule.name}" matched for @${message.author.username} in #${message.channel.name ?? message.channelId}`);
        try {
            const resolved = {
                ...rule,
                response_content:  substituteVars(rule.response_content,  message),
                embed_title:       substituteVars(rule.embed_title,        message),
                embed_description: substituteVars(rule.embed_description,  message),
            };
            const payload = buildPayload(resolved);

            if (rule.response_type === 'reply') {
                await message.reply(payload);

            } else if (rule.response_type === 'emoji') {
                await message.react(rule.response_content);

            } else if (rule.response_type === 'message') {
                let channel = message.channel;
                if (rule.response_channel) {
                    const fetched = client.channels.cache.get(rule.response_channel)
                        ?? await client.channels.fetch(rule.response_channel).catch(() => null);
                    if (fetched) channel = fetched;
                }
                await channel.send(payload);

            } else if (rule.response_type === 'dm') {
                await message.author.send(payload).catch(() => {});
            }
        } catch (err) {
            console.error(`[MessageReactions] Rule "${rule.name}" failed:`, err.message);
        }
    }
}

// Load on startup
loadCache();

module.exports = { handleMessage, reloadCache };
