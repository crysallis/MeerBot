const { EmbedBuilder } = require('discord.js');
const db = require('../db');
const botConfig = require('../botConfig');
const { pickColor } = require('../colors');
const { CHECKIN_REACTIONS } = require('../checkinContent');
const { stripVariationSelectors } = require('./gloryctaReactionGuard');

const CONFIRMATION_TEXT = "Thanks, got it! Passed that along to the team.";

// A Discord mention alone doesn't tell leadership which in-game character
// this is (a leader may not recognize a Discord username at a glance), and
// the in-game name alone isn't clickable/pingable -- both together cover
// "who is this" and "let me reach them" in one line.
function checkinDisplayName(row) {
    const ingameName = db.getMemberIngameName(row.member_id);
    return ingameName ? `${ingameName} (<@${row.discord_id}>)` : `<@${row.discord_id}>`;
}

// responseLine is just the response content (quoted reply text, or
// "emoji meaning") -- the member mention/name is assembled HERE, not by
// the caller, and always goes in the embed DESCRIPTION, never the title.
// Discord does not render mentions or markdown inside embed titles (only
// description/field values), so a mention placed in setTitle() shows as
// literal raw text like "<@123>" instead of a clickable ping -- confirmed
// live 2026-08-25.
async function postCheckinRelayAndConfirm(row, { user, responseLine }) {
    const RELAY_CHANNEL = botConfig.get('CHECKIN_RELAY_CHANNEL_ID');
    if (RELAY_CHANNEL) {
        const channel = await user.client.channels.fetch(RELAY_CHANNEL).catch(() => null);
        if (channel) {
            await channel.send({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('💬 Check-in response')
                        .setDescription(`${checkinDisplayName(row)} responded:\n\n${responseLine}`)
                        .setColor(pickColor())
                        .setFooter({ text: `Inactive ${row.days_inactive_at_send}+ days when checked in` }),
                ],
            }).catch(err => console.error('[Checkin] Failed to post relay:', err.message));
        }
    }

    await user.send(CONFIRMATION_TEXT).catch(err => console.error('[Checkin] Failed to send confirmation DM:', err.message));
}

// Reaction path: matches this reaction's message against a pending
// check-in row, records the response, relays it, confirms. Ignores any
// reaction that isn't one of the 4 valid option emoji (mirrors
// gloryctaReactionGuard's fail-safe philosophy: never act on something it
// can't positively identify).
async function handleCheckinReaction(reaction, user, client) {
    if (user.bot) return;

    if (reaction.partial) {
        try {
            await reaction.fetch();
        } catch (err) {
            console.error('[Checkin] Failed to fetch partial reaction:', err.message);
            return;
        }
    }

    const row = db.getPendingCheckinByMessageId(reaction.message.id);
    if (!row) return;

    const emojiName = stripVariationSelectors(reaction.emoji.name);
    const validEmoji = Object.keys(CHECKIN_REACTIONS).map(stripVariationSelectors);
    if (!validEmoji.includes(emojiName)) return;

    const originalEmoji = Object.keys(CHECKIN_REACTIONS).find(
        e => stripVariationSelectors(e) === emojiName
    );

    db.resolveCheckinResponse(row.id, {
        status: 'responded_reaction',
        responseEmoji: originalEmoji,
        respondedAt: new Date().toISOString(),
    });

    const fetchedUser = await client.users.fetch(row.discord_id).catch(() => null);
    if (!fetchedUser) return;

    await postCheckinRelayAndConfirm(row, {
        user: fetchedUser,
        responseLine: `${originalEmoji} ${CHECKIN_REACTIONS[originalEmoji]}`,
    });
}

// Reply path, synchronous half: looks up and updates the row ONLY. Must run
// (and complete its DB write) before askHandler.js's own guard-check reads
// this same row -- index.js fires handleTranslationRelay/handleAsk as
// unawaited promises back-to-back in messageCreate, so an async check-in
// handler in that same list would race askHandler.js's guard-check read
// against this handler's own DB write, both starting at effectively the
// same instant. Calling this synchronously first, before those async calls
// even start, guarantees the row's status is already updated by the time
// the guard checks it.
function resolveCheckinReply(message) {
    if (message.author.bot) return null;
    if (message.guild !== null) return null; // DM only

    const row = db.getPendingCheckinByDiscordId(message.author.id);
    if (!row) return null;

    db.resolveCheckinResponse(row.id, {
        status: 'responded_text',
        responseText: message.content,
        respondedAt: new Date().toISOString(),
    });

    return { ...row, status: 'responded_text', response_text: message.content };
}

module.exports = { handleCheckinReaction, resolveCheckinReply, postCheckinRelayAndConfirm };
