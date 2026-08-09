const { WebhookClient } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db');
const botConfig = require('../botConfig');

const anthropic = new Anthropic();

const QUOTE_MAX_LEN = 100;
const DISCORD_CONTENT_MAX_LEN = 2000;

const BATCH_TIMEOUT_KEY = 'translation_relay_batch_timeout_seconds';
const BATCH_TIMEOUT_DEFAULT_SECONDS = 10;
const BATCH_TIMEOUT_MAX_SECONDS = 15;

function getBatchTimeoutMs() {
    const raw = parseInt(botConfig.get(BATCH_TIMEOUT_KEY, String(BATCH_TIMEOUT_DEFAULT_SECONDS)), 10);
    const seconds = Number.isInteger(raw) && raw >= 1 ? Math.min(raw, BATCH_TIMEOUT_MAX_SECONDS) : BATCH_TIMEOUT_DEFAULT_SECONDS;
    return seconds * 1000;
}

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

// Safety net, kept even after the system prompt explicitly forbids code fences (2026-08-09
// probe: 3/3 fenced with the old "Output ONLY" wording alone, 0/3 fenced once the prompt
// named the fence directly and told the model not to add one) -- an explicit instruction
// makes it rare, not guaranteed, so this stays as defense-in-depth rather than being removed.
function stripCodeFence(text) {
    const fenced = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
    return fenced ? fenced[1].trim() : text;
}

// Base budget covers a normal single-message translation with headroom; batching multiplies
// output size by both line count and target-language count (one full JSON array per language),
// so the ceiling scales with both rather than staying fixed at the single-message value.
const BASE_MAX_TOKENS = 512;
const PER_LINE_PER_LANGUAGE_TOKENS = 128;

async function callClaude(sourceLanguage, targetLanguages, lines) {
    const numberedLines = lines.map((l, i) => `${i + 1}. ${l}`).join('\n');
    const maxTokens = Math.max(1024, BASE_MAX_TOKENS + lines.length * targetLanguages.length * PER_LINE_PER_LANGUAGE_TOKENS);
    const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: maxTokens,
        system: [
            'You are a chat relay bot, translating casual Discord messages for a gaming guild based on AFK Journey.',
            'Preserve tone, slang, and emotes/emoji as-is where they don\'t need translation.',
            'Keep Discord mention syntax (<@id>, <#id>) and custom emoji syntax (<:name:id>) completely unchanged.',
            'The message is a numbered list of one or more lines, all from the same person, sent in order.',
            'Output ONLY a JSON object mapping each requested language name to an ARRAY of translated strings,',
            'one array entry per input line, in the same order -- never a single string, even for one line.',
            'Output raw JSON with no markdown formatting -- do not wrap it in ```json or any code fence.',
        ].join(' '),
        messages: [{
            role: 'user',
            content: `Source language: ${sourceLanguage}\nTarget languages: ${targetLanguages.join(', ')}\n\nMessage (${lines.length} line(s)):\n${numberedLines}`,
        }],
    });
    const raw = response.content[0].text.trim();
    const parsed = JSON.parse(stripCodeFence(raw)); // throws on malformed JSON -- caller catches
    for (const lang of targetLanguages) {
        if (!Array.isArray(parsed[lang]) || parsed[lang].length !== lines.length) {
            throw new Error(`Expected an array of ${lines.length} line(s) for ${lang}, got: ${JSON.stringify(parsed[lang])}`);
        }
        for (const line of parsed[lang]) {
            if (typeof line !== 'string') throw new Error(`Non-string entry in ${lang} translation array`);
        }
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

// relay_group -> { authorId, sourceChannelRow, isReply, replyMessageId, messages: [{messageId, text}], authorDisplayName, authorAvatarURL, timeoutHandle }
const openBatches = new Map();

// Synchronously claims/clears a relay group's batch slot BEFORE any async work, per the
// race-safety requirement in the design doc: whichever of (timeout firing) or (interrupting
// message arriving) reaches this line first wins; the other finds the slot already gone.
function takeBatch(relayGroup) {
    const batch = openBatches.get(relayGroup);
    if (batch) {
        clearTimeout(batch.timeoutHandle);
        openBatches.delete(relayGroup);
    }
    return batch;
}

function flushBatch(relayGroup, client, batch) {
    if (!batch || batch.messages.length === 0) return;
    return enqueueRelay(relayGroup, () => processTranslationRelay(client, batch));
}

async function handleTranslationRelay(message, client) {
    if (message.author.bot) return; // loop guard: covers our own relay webhooks + any other bot
    const sourceChannelRow = db.getRelayChannelByChannelId(message.channelId);
    if (!sourceChannelRow) return;
    const text = (message.content || '').trim();
    if (!text) return;

    const relayGroup = sourceChannelRow.relay_group;
    const isReply = !!message.reference?.messageId;
    const existing = openBatches.get(relayGroup);

    // A reply always flushes whatever is open (even same-author) and starts its own batch.
    // A different author's message flushes whatever is open and starts a new batch.
    // A message from a different source channel (even same author, same relay group)
    // flushes whatever is open -- otherwise the combined batch would get translated and
    // routed using the FIRST message's source language/channel, silently mistranslating
    // and misrouting the second message.
    // A same-author, same-channel, non-reply message joins the existing batch.
    const shouldFlushExisting = existing && (isReply
        || existing.authorId !== message.author.id
        || existing.sourceChannelRow.channel_id !== sourceChannelRow.channel_id);
    if (shouldFlushExisting) {
        const claimed = takeBatch(relayGroup);
        flushBatch(relayGroup, client, claimed);
    }

    const current = openBatches.get(relayGroup);
    const authorDisplayName = message.member?.displayName ?? message.author.username;
    const authorAvatarURL = message.author.displayAvatarURL();
    const entry = {
        messageId: message.id,
        text,
        attachments: [...message.attachments.values()].map(a => ({ url: a.url, name: a.name })),
    };

    if (current && !isReply && current.authorId === message.author.id) {
        current.messages.push(entry);
        clearTimeout(current.timeoutHandle);
        current.timeoutHandle = setTimeout(() => {
            const claimed = takeBatch(relayGroup);
            flushBatch(relayGroup, client, claimed);
        }, getBatchTimeoutMs());
        return;
    }

    const newBatch = {
        authorId: message.author.id,
        sourceChannelRow,
        isReply,
        replyMessageId: isReply ? message.reference.messageId : null,
        messages: [entry],
        authorDisplayName,
        authorAvatarURL,
        timeoutHandle: null,
    };
    newBatch.timeoutHandle = setTimeout(() => {
        const claimed = takeBatch(relayGroup);
        flushBatch(relayGroup, client, claimed);
    }, getBatchTimeoutMs());
    openBatches.set(relayGroup, newBatch);
}

async function processTranslationRelay(client, batch) {
    const { sourceChannelRow, messages, authorDisplayName, authorAvatarURL, isReply, replyMessageId } = batch;
    const allChannels = db.getRelayChannels(sourceChannelRow.relay_group);
    const targetChannels = allChannels.filter(c => c.id !== sourceChannelRow.id);
    if (targetChannels.length === 0) return;

    const combinedText = messages.map(m => m.text).join('\n');
    const lastLine = messages[messages.length - 1].text;
    const batchMessageIds = messages.map(m => ({ messageId: m.messageId, text: m.text }));

    // Record the source batch's own row first -- its id becomes the shared
    // relay_group_message_id for every translated copy.
    const relayGroupMessageId = db.insertRelayMessage({
        relayGroupMessageId: 0,
        channelId: sourceChannelRow.channel_id,
        messageId: messages[0].messageId, // the batch's first message id anchors the row's own unique message_id
        authorId: batch.authorId,
        authorDisplayName,
        language: sourceChannelRow.language,
        text: combinedText,
        batchMessageIds,
        lastLineText: lastLine,
    });
    db.setRelayMessageGroupId(relayGroupMessageId, relayGroupMessageId);

    let replySource = null;
    if (isReply && replyMessageId) {
        const referenced = db.getRelayMessageByMessageId(replyMessageId);
        if (referenced) {
            replySource = db.getRelayMessagesByGroupId(referenced.relay_group_message_id);
        }
    }

    const targetLanguages = targetChannels.map(c => c.language);
    let translations = null;
    let usage = null;
    try {
        const result = await module.exports.callClaude(sourceChannelRow.language, targetLanguages, messages.map(m => m.text));
        translations = result.translations;
        usage = result.usage;
    } catch (err) {
        console.error('[TranslationRelay] Claude translation failed:', err.message);
    }

    if (translations) {
        db.insertTranslationUsage({
            messageId: messages[0].messageId,
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            targetCount: targetLanguages.length,
        });
    }

    for (const targetRow of targetChannels) {
        const channel = await client.channels.fetch(targetRow.channel_id).catch(() => null);
        if (!channel) continue;

        let bodyLines, lastLineTranslated;
        if (translations) {
            bodyLines = translations[targetRow.language];
            lastLineTranslated = bodyLines[bodyLines.length - 1];
        } else {
            bodyLines = messages.map(m => m.text);
            lastLineTranslated = lastLine;
        }
        let bodyText = bodyLines.join('\n');

        let quotePrefix = '';
        if (replySource) {
            const quoteRow = replySource.find(r => r.channel_id === targetRow.channel_id);
            if (quoteRow) {
                const quoteText = quoteRow.last_line_text || quoteRow.text; // fallback for pre-batching rows
                quotePrefix = `> ${truncateQuote(quoteText)}\n`;
            }
        }
        bodyText = fitContent(quotePrefix, bodyText);

        const allAttachments = messages.flatMap(m => m.attachments ?? []);
        const files = allAttachments.length > 0
            ? allAttachments.map(a => ({ attachment: a.url, name: a.name }))
            : undefined;

        const sent = await sendViaWebhook(targetRow, channel, {
            content: quotePrefix + bodyText,
            username: authorDisplayName,
            avatarURL: authorAvatarURL,
            allowedMentions: { parse: ['users'] },
            ...(files ? { files } : {}),
        });
        if (!sent) continue;

        db.insertRelayMessage({
            relayGroupMessageId,
            channelId: targetRow.channel_id,
            messageId: sent.id,
            authorId: batch.authorId,
            authorDisplayName,
            language: targetRow.language,
            text: bodyText,
            batchMessageIds,
            lastLineText: lastLineTranslated,
        });

        if (!translations) {
            channel.messages.fetch(sent.id)
                .then(m => m.react(targetRow.flag_emoji))
                .catch(() => {});
        }
    }
}

async function handleTranslationReactionSync(reaction, user, client, isAdd) {
    if (user.id === client.user.id) return; // loop guard: our own synced reaction re-fires this event
    if (reaction.partial) {
        try {
            await reaction.fetch();
        } catch (err) {
            console.error('[TranslationRelay] Failed to fetch partial reaction:', err.message);
            return;
        }
    }
    const row = db.getRelayMessageByMessageId(reaction.message.id);
    if (!row) return;
    // Compare against the ROW's own message_id, not reaction.message.id -- for a reaction
    // on a non-first message of a multi-message batch, reaction.message.id is that
    // specific line's id, but row.message_id is always the batch's first/anchor message
    // (getRelayMessageByMessageId matches via batch_message_ids for non-anchor lines).
    // Filtering on reaction.message.id would fail to exclude the row itself in that case,
    // causing a spurious extra react() call against the row's own anchor message.
    const siblings = db.getRelayMessagesByGroupId(row.relay_group_message_id)
        .filter(r => r.message_id !== row.message_id);

    for (const sibling of siblings) {
        try {
            const channel = await client.channels.fetch(sibling.channel_id);
            const message = await channel.messages.fetch(sibling.message_id);
            if (isAdd) {
                await message.react(reaction.emoji.id ? reaction.emoji : reaction.emoji.name);
            } else {
                const existing = message.reactions.resolve(reaction.emoji.id ? reaction.emoji : reaction.emoji.name);
                if (existing) await existing.users.remove(client.user.id);
            }
        } catch (err) {
            console.error(`[TranslationRelay] Reaction sync failed for channel ${sibling.channel_id}:`, err.message);
        }
    }
}

function rebuildBatchAfterChange(batchMessageIds, messageId, newText) {
    if (newText === null) {
        return batchMessageIds.filter(entry => entry.messageId !== messageId);
    }
    return batchMessageIds.map(entry => entry.messageId === messageId ? { ...entry, text: newText } : entry);
}

// replyMessageId (optional): the message.reference?.messageId of the edited/deleted
// message, when available -- the same value processTranslationRelay's caller reads off
// the live Discord message to build batch.replyMessageId. Nothing in the DB tracks
// whether a source row was itself a reply (translation_relay_messages has no such
// column, and copy rows store bodyText WITHOUT the quote-prefix baked in -- only the
// live send in processTranslationRelay ever combined them), so this must be threaded in
// from the caller's live message object rather than re-derived from stored rows. A
// deleted message often arrives partial with no reference available -- degrading to no
// quote-prefix in that case is an honest best-effort, not a bug.
async function resyncRelayGroup(client, sourceRow, rebuiltBatch, replyMessageId = null) {
    const combinedText = rebuiltBatch.map(e => e.text).join('\n');
    const lastLineText = rebuiltBatch.length > 0 ? rebuiltBatch[rebuiltBatch.length - 1].text : '';
    db.updateRelayMessageText(sourceRow.id, { text: combinedText, batchMessageIds: rebuiltBatch, lastLineText });

    const siblings = db.getRelayMessagesByGroupId(sourceRow.relay_group_message_id)
        .filter(r => r.id !== sourceRow.id);
    if (siblings.length === 0 || rebuiltBatch.length === 0) return siblings;

    const sourceChannelRow = db.getRelayChannelByChannelId(sourceRow.channel_id);
    const targetLanguages = siblings.map(s => s.language);
    let translations = null;
    try {
        const result = await module.exports.callClaude(sourceChannelRow.language, targetLanguages, rebuiltBatch.map(e => e.text));
        translations = result.translations;
    } catch (err) {
        console.error('[TranslationRelay] Re-translation on edit/delete failed, leaving stale copies:', err.message);
        return siblings;
    }

    // Same quote-prefix derivation as processTranslationRelay (lines ~230-236): resolve
    // the replied-to message's relay group, then per-target find that group's copy in the
    // matching channel.
    let replySource = null;
    if (replyMessageId) {
        const referenced = db.getRelayMessageByMessageId(replyMessageId);
        if (referenced) {
            replySource = db.getRelayMessagesByGroupId(referenced.relay_group_message_id);
        }
    }

    for (const sibling of siblings) {
        try {
            const targetRow = db.getRelayChannelByChannelId(sibling.channel_id);
            const bodyLines = translations[sibling.language];
            let bodyText = bodyLines.join('\n');

            let quotePrefix = '';
            if (replySource) {
                const quoteRow = replySource.find(r => r.channel_id === sibling.channel_id);
                if (quoteRow) {
                    const quoteText = quoteRow.last_line_text || quoteRow.text; // fallback for pre-batching rows
                    quotePrefix = `> ${truncateQuote(quoteText)}\n`;
                }
            }
            bodyText = fitContent(quotePrefix, bodyText);

            const channel = await client.channels.fetch(sibling.channel_id);
            const webhook = await getOrCreateWebhook(targetRow, channel);
            await webhook.editMessage(sibling.message_id, { content: quotePrefix + bodyText });
            db.updateRelayMessageText(sibling.id, {
                text: bodyText,
                batchMessageIds: sibling.batch_message_ids ? JSON.parse(sibling.batch_message_ids) : [],
                lastLineText: bodyLines[bodyLines.length - 1],
            });
        } catch (err) {
            console.error(`[TranslationRelay] Failed to sync edit to channel ${sibling.channel_id}:`, err.message);
        }
    }
    return siblings;
}

async function handleTranslationEditSync(message, client) {
    if (message.author?.bot) return;
    const row = db.getRelayMessageByMessageId(message.id);
    if (!row) return;
    // db.getRelayMessageByMessageId matches a row either by its own message_id OR by any
    // entry inside ANY row's batch_message_ids JSON (that's how quote-lookup finds a group
    // from a reply). Every sibling copy stores the SOURCE message's id inside its own
    // batch_message_ids too, so looking up by the source's id can match the source row OR
    // a sibling row -- SQLite's .get() has no ORDER BY, so which one comes back is
    // implementation-defined, not guaranteed. Require a genuine own-row match before
    // treating this as the source row; anything else (a sibling matched instead) is
    // treated the same as "not found" rather than guessed at.
    if (row.message_id !== message.id) return;
    // Same copy-row-detection guard as handleTranslationDeleteSync (Task 5's fix round):
    // only the source row has id === relay_group_message_id. Editing a copy directly is
    // already impossible via Discord (webhook-token-only), but this closes the same class
    // of gap symmetrically for one line.
    if (row.id !== row.relay_group_message_id) return;
    const relayGroup = db.getRelayChannelByChannelId(row.channel_id)?.relay_group;
    if (!relayGroup) {
        console.error(`[TranslationRelay] Edit sync: no relay channel row found for channel ${row.channel_id}, cannot serialize -- skipping`);
        return;
    }
    const newContent = (message.content || '').trim();
    const replyMessageId = message.reference?.messageId ?? null;
    // Re-read the row INSIDE the queued task rather than closing over the snapshot fetched
    // above -- an edit and a delete on the same batch can both pass their guards and enqueue
    // before either runs. If this task built `rebuilt` from the pre-queue snapshot, whichever
    // of the two runs second would rebuild from stale (pre-sibling-task) data and silently
    // revert the first task's change when it writes back. Re-fetching here, inside the task,
    // is what makes the two tasks actually see each other's effects in queue order. (In
    // practice, with the current anchor-only guards, the only reachable operations on an
    // entry are wholesale text replacement and whole-group deletion -- neither reads prior
    // entry content, so no currently-reachable interleaving produces stale-based corruption.
    // This re-read is defense-in-depth: it becomes load-bearing the moment per-line
    // edit/delete for non-anchor batch messages ships.)
    await enqueueRelay(relayGroup, async () => {
        const fresh = db.getRelayMessageByMessageId(message.id);
        if (!fresh || fresh.message_id !== message.id || fresh.id !== fresh.relay_group_message_id) return;
        const rebuilt = rebuildBatchAfterChange(JSON.parse(fresh.batch_message_ids), message.id, newContent);
        await resyncRelayGroup(client, fresh, rebuilt, replyMessageId);
    });
}

async function handleTranslationDeleteSync(message, client) {
    const row = db.getRelayMessageByMessageId(message.id);
    if (!row) return;
    // Same ambiguity as handleTranslationEditSync: getRelayMessageByMessageId can match
    // either the message's own row or a sibling row that merely references this id inside
    // its batch_message_ids. Only trust a direct match.
    if (row.message_id !== message.id) return;
    // Design spec: deleting a relayed COPY (not the source) is a deliberate moderation
    // action that needs no bot handling -- a no-op. A copy row's batch_message_ids stores
    // the SOURCE message's id(s), not a self-reference, so naively rebuilding against the
    // copy's own message.id would find nothing to remove and fall into resyncRelayGroup,
    // which unconditionally overwrites this row's own text/last_line_text with the
    // re-translated SOURCE-language content -- silent, persistent corruption of the copy's
    // stored translation (and any later reply-quote sourced from it). Only the source row
    // has id === relay_group_message_id (set by the same setRelayMessageGroupId(X, X) call
    // right after its own insert); every copy is inserted with relay_group_message_id
    // pointing at that pre-existing source id, so a copy's own id can never equal it.
    if (row.id !== row.relay_group_message_id) return;
    const relayGroup = db.getRelayChannelByChannelId(row.channel_id)?.relay_group;
    if (!relayGroup) {
        console.error(`[TranslationRelay] Delete sync: no relay channel row found for channel ${row.channel_id}, cannot serialize -- skipping`);
        return;
    }
    // The whole resync-or-delete body runs as ONE queued task, keyed by the same
    // relay_group string flushBatch/edit-sync use -- not just the resyncRelayGroup call.
    // The full-delete branch below does its own webhook deletes + deleteRelayMessagesByGroupId
    // outside resyncRelayGroup; leaving that part unserialized would still let a delete-all
    // interleave with a concurrent edit on the same batch, which is the exact race this fix
    // exists to close.
    //
    // Re-read the row INSIDE the task rather than closing over the pre-queue snapshot, same
    // reasoning as handleTranslationEditSync: an edit and a delete on the same batch can
    // both pass their guards and enqueue before either runs. Rebuilding from a stale
    // snapshot here would silently revert whichever sibling task ran first.
    await enqueueRelay(relayGroup, async () => {
        const fresh = db.getRelayMessageByMessageId(message.id);
        if (!fresh || fresh.message_id !== message.id || fresh.id !== fresh.relay_group_message_id) return;
        const rebuilt = rebuildBatchAfterChange(JSON.parse(fresh.batch_message_ids), message.id, null);

        if (rebuilt.length > 0) {
            await resyncRelayGroup(client, fresh, rebuilt);
            return;
        }

        const siblings = db.getRelayMessagesByGroupId(fresh.relay_group_message_id)
            .filter(r => r.id !== fresh.id);
        for (const sibling of siblings) {
            try {
                const targetRow = db.getRelayChannelByChannelId(sibling.channel_id);
                const channel = await client.channels.fetch(sibling.channel_id);
                const webhook = await getOrCreateWebhook(targetRow, channel);
                await webhook.deleteMessage(sibling.message_id);
            } catch (err) {
                console.error(`[TranslationRelay] Failed to delete relayed copy in channel ${sibling.channel_id}:`, err.message);
            }
        }
        db.deleteRelayMessagesByGroupId(fresh.relay_group_message_id);
    });
}

module.exports = { handleTranslationRelay, processTranslationRelay, stripCodeFence, truncateQuote, takeBatch, openBatches, callClaude, handleTranslationReactionSync, handleTranslationEditSync, handleTranslationDeleteSync, rebuildBatchAfterChange, resyncRelayGroup, enqueueRelay, relayQueues };
