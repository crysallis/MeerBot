const { WebhookClient } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db');

const anthropic = new Anthropic();

const QUOTE_MAX_LEN = 100;
const DISCORD_CONTENT_MAX_LEN = 2000;

function truncateQuote(text) {
    const t = text.replace(/\n/g, ' ').trim();
    return t.length > QUOTE_MAX_LEN ? t.slice(0, QUOTE_MAX_LEN) + '…' : t;
}

// Keeps quotePrefix intact and truncates bodyText so the combined content fits Discord's
// 2000-char message limit -- otherwise the webhook send is rejected outright and
// sendViaWebhook's catch-all silently drops that one target channel's copy.
function fitContent(quotePrefix, bodyText) {
    const budget = DISCORD_CONTENT_MAX_LEN - quotePrefix.length - 1; // -1 for the … marker
    if (bodyText.length <= budget) return bodyText;
    return bodyText.slice(0, Math.max(0, budget)) + '…';
}

async function getOrCreateWebhook(channelRow, channel) {
    if (channelRow.webhook_id && channelRow.webhook_token) {
        return new WebhookClient({ id: channelRow.webhook_id, token: channelRow.webhook_token });
    }
    const webhook = await channel.createWebhook({ name: 'Translation Relay' });
    db.setRelayChannelWebhook(channelRow.id, webhook.id, webhook.token);
    return new WebhookClient({ id: webhook.id, token: webhook.token });
}

async function sendViaWebhook(channelRow, channel, payload) {
    try {
        const webhook = await getOrCreateWebhook(channelRow, channel);
        return await webhook.send(payload);
    } catch (err) {
        if (err.code === 10015) {
            // Unknown Webhook -- deleted on Discord's side, clear cache and retry once
            db.setRelayChannelWebhook(channelRow.id, null, null);
            const fresh = await channel.createWebhook({ name: 'Translation Relay' });
            db.setRelayChannelWebhook(channelRow.id, fresh.id, fresh.token);
            const webhook = new WebhookClient({ id: fresh.id, token: fresh.token });
            return await webhook.send(payload);
        }
        console.error(`[TranslationRelay] Failed to send to channel ${channelRow.channel_id}:`, err.message);
        return null;
    }
}

function stripCodeFence(text) {
    const fenced = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
    return fenced ? fenced[1].trim() : text;
}

async function callClaude(sourceLanguage, targetLanguages, text) {
    const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 1024,
        system: [
            'You are a chat relay bot, translating a casual Discord message for a gaming guild based on AFK Journey.',
            'Preserve tone, slang, and emotes/emoji as-is where they don\'t need translation.',
            'Keep Discord mention syntax (<@id>, <#id>) and custom emoji syntax (<:name:id>) completely unchanged.',
            'Output ONLY a JSON object mapping each requested language name to its translation, no other text.',
        ].join(' '),
        messages: [{
            role: 'user',
            content: `Source language: ${sourceLanguage}\nTarget languages: ${targetLanguages.join(', ')}\n\nMessage:\n${text}`,
        }],
    });
    const raw = response.content[0].text.trim();
    const parsed = JSON.parse(stripCodeFence(raw)); // throws on malformed JSON -- caller catches
    for (const lang of targetLanguages) {
        if (typeof parsed[lang] !== 'string') throw new Error(`Missing translation for ${lang}`);
    }
    return { translations: parsed, usage: response.usage };
}

// Per-relay_group promise chain -- keeps relayed copies posted in arrival order even
// though each message's Claude call has independent, variable latency. A Map from
// relay_group to its current tail promise; each new message chains onto the previous
// one so processing for that group is strictly serialized, while other groups run
// independently. Errors are swallowed on the chain itself so one failure doesn't break
// the chain for subsequent messages -- handleTranslationRelay's own try/catch still
// reports the error to the caller.
const relayQueues = new Map();

function enqueueRelay(relayGroup, task) {
    const previous = relayQueues.get(relayGroup) ?? Promise.resolve();
    const next = previous.then(task, task).catch(err => {
        console.error('[TranslationRelay] Queued relay task failed:', err.message);
    });
    relayQueues.set(relayGroup, next);
    return next;
}

async function handleTranslationRelay(message, client) {
    if (message.author.bot) return; // loop guard: covers our own relay webhooks + any other bot
    const sourceChannelRow = db.getRelayChannelByChannelId(message.channelId);
    if (!sourceChannelRow) return;
    const text = (message.content || '').trim();
    if (!text) return;
    return enqueueRelay(sourceChannelRow.relay_group, () => processTranslationRelay(message, client, sourceChannelRow, text));
}

async function processTranslationRelay(message, client, sourceChannelRow, text) {
    const allChannels = db.getRelayChannels(sourceChannelRow.relay_group);
    const targetChannels = allChannels.filter(c => c.id !== sourceChannelRow.id);
    if (targetChannels.length === 0) return;

    const authorDisplayName = message.member?.displayName ?? message.author.username;
    const authorAvatarURL = message.author.displayAvatarURL();

    // Record the source message's own row first -- its id becomes the shared
    // relay_group_message_id for every translated copy. SQLite can't reference a row's own
    // not-yet-known id in the same INSERT, so insert with a placeholder then self-update.
    const relayGroupMessageId = db.insertRelayMessage({
        relayGroupMessageId: 0,
        channelId: message.channelId,
        messageId: message.id,
        authorId: message.author.id,
        authorDisplayName,
        language: sourceChannelRow.language,
        text,
    });
    db.setRelayMessageGroupId(relayGroupMessageId, relayGroupMessageId);

    // Resolve reply context, if any
    let replySource = null;
    if (message.reference?.messageId) {
        const referenced = db.getRelayMessageByMessageId(message.reference.messageId);
        if (referenced) {
            replySource = db.getRelayMessagesByGroupId(referenced.relay_group_message_id);
        }
    }

    const targetLanguages = targetChannels.map(c => c.language);
    let translations = null;
    let usage = null;
    try {
        const result = await callClaude(sourceChannelRow.language, targetLanguages, text);
        translations = result.translations;
        usage = result.usage;
    } catch (err) {
        console.error('[TranslationRelay] Claude translation failed:', err.message);
    }

    if (translations) {
        db.insertTranslationUsage({
            messageId: message.id,
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            targetCount: targetLanguages.length,
        });
    }

    for (const targetRow of targetChannels) {
        const channel = await client.channels.fetch(targetRow.channel_id).catch(() => null);
        if (!channel) continue;

        let bodyText = translations ? translations[targetRow.language] : text;
        let quotePrefix = '';
        if (replySource) {
            const quoteRow = replySource.find(r => r.channel_id === targetRow.channel_id);
            if (quoteRow) quotePrefix = `> ${truncateQuote(quoteRow.text)}\n`;
        }
        bodyText = fitContent(quotePrefix, bodyText);

        const sent = await sendViaWebhook(targetRow, channel, {
            content: quotePrefix + bodyText,
            username: authorDisplayName,
            avatarURL: authorAvatarURL,
            allowedMentions: { parse: ['users'] },
        });
        if (!sent) continue;

        db.insertRelayMessage({
            relayGroupMessageId,
            channelId: targetRow.channel_id,
            messageId: sent.id,
            authorId: message.author.id,
            authorDisplayName,
            language: targetRow.language,
            text: bodyText,
        });

        if (!translations) {
            channel.messages.fetch(sent.id)
                .then(m => m.react(targetRow.flag_emoji))
                .catch(() => {});
        }
    }
}

module.exports = { handleTranslationRelay, stripCodeFence, truncateQuote };
