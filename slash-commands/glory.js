// slash-commands/glory.js
const { SlashCommandBuilder, EmbedBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const db = require('../utils/db');
const { pickColor } = require('../utils/colors');
const { enforcePermissions } = require('../utils/permissions');
const { pickPollEmoji, nextOccurrenceUtc } = require('../utils/glorycta');

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const CONFIRM_EMOJI = ['✅', '❌', '🤔'];
const MESSAGE_LINK_RE = /channels\/\d+\/(\d+)\/(\d+)$/;

async function tallyReactions(message, pairs) {
    const results = [];
    for (const { emoji, label } of pairs) {
        const reaction = message.reactions.cache.get(emoji);
        const users = reaction ? [...(await reaction.users.fetch()).values()].filter(u => !u.bot) : [];
        const resolve = discordUser => {
            const member = db.prepare('SELECT ingame_name FROM members WHERE discord_id = ?').get(discordUser.id);
            return member ? `${discordUser.tag} (${member.ingame_name})` : discordUser.tag;
        };
        const lines = users.length ? users.map(resolve).map(s => `· ${s}`).join('\n') : '*No votes*';
        results.push({ emoji, label, count: users.length, lines: lines.slice(0, 1024) });
    }
    return results;
}

async function executeCta(interaction) {
    if (!(await enforcePermissions(interaction, 'glory', 'cta'))) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const time1 = interaction.options.getString('time1');
    const time2 = interaction.options.getString('time2');
    const duration = interaction.options.getInteger('duration');

    if (!TIME_RE.test(time1) || !TIME_RE.test(time2)) {
        return interaction.editReply({
            content: '❌ Times must be in 24-hour UTC `HH:MM` format, e.g. `06:00` or `20:00`.',
        });
    }

    const now = new Date();
    const fireAtA = nextOccurrenceUtc(time1, now);
    const fireAtB = nextOccurrenceUtc(time2, now);
    const [emojiA, emojiB] = pickPollEmoji();

    const tsA = Math.floor(fireAtA.getTime() / 1000);
    const tsB = Math.floor(fireAtB.getTime() / 1000);

    const embed = new EmbedBuilder()
        .setColor(pickColor())
        .setTitle('⚔️ Clash of Glory · Call to Arms')
        .setDescription(
            'The horns sound, RiffRaff! Clash of Glory draws near, and the guild ' +
            'must stand united at a single hour. Two banners are raised below — ' +
            'react with the matching emoji to pledge your hour of battle. Vote for ' +
            'one, or both if either hour serves you. The call closes in ' +
            `**${duration} hour${duration === 1 ? '' : 's'}** — choose your glory.`
        )
        .addFields(
            { name: `${emojiA} Option A`, value: `Local: <t:${tsA}:t>\nUTC: ${time1}`, inline: true },
            { name: `${emojiB} Option B`, value: `Local: <t:${tsB}:t>\nUTC: ${time2}`, inline: true },
        );

    let message;
    let jobId;
    try {
        message = await interaction.channel.send({ embeds: [embed] });
        await message.react(emojiA);
        await message.react(emojiB);
        await message.pin();

        const nowIso = now.toISOString();
        const tallyFireAt = new Date(now.getTime() + duration * 60 * 60 * 1000).toISOString();
        const jobResult = db.prepare(
            'INSERT INTO scheduled_jobs (type, fire_at, created_at) VALUES (?, ?, ?)'
        ).run('glorycta_tally', tallyFireAt, nowIso);
        jobId = jobResult.lastInsertRowid;

        const poll = db.createGloryctaPoll({
            kind: 'cta',
            jobId,
            messageId: message.id,
            channelId: message.channelId,
            emojiA, emojiB,
            labelA: time1, labelB: time2,
            fireAtA: fireAtA.toISOString(),
            fireAtB: fireAtB.toISOString(),
        });

        // The cancel button's customId needs the poll row's own id, which only
        // exists after the INSERT above -- so the button is attached via a
        // follow-up edit rather than in the original send().
        const cancelRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`glorycta_cancel:${poll.id}`).setLabel('Cancel Vote').setStyle(ButtonStyle.Danger)
        );
        await message.edit({ components: [cancelRow] });
    } catch (err) {
        console.error('[Glory] Failed to post cta poll, cleaning up:', err.message);
        if (message) await message.delete().catch(() => {});
        if (jobId) {
            try {
                db.prepare('DELETE FROM scheduled_jobs WHERE id = ?').run(jobId);
            } catch (cleanupErr) {
                console.error('[Glory] Failed to clean up orphaned scheduled_jobs row:', cleanupErr.message);
            }
        }
        return interaction.editReply({
            content: '❌ Could not finish posting the vote. The partial message and any partial data were removed — try again.',
        }).catch(() => {});
    }

    await interaction.editReply({
        content: `⚔️ Call to arms posted. Vote closes in ${duration} hour${duration === 1 ? '' : 's'}.`,
    });
}

async function executeConfirm(interaction) {
    if (!(await enforcePermissions(interaction, 'glory', 'confirm'))) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const time = interaction.options.getString('time');
    const [emojiYes, emojiNo, emojiMaybe] = CONFIRM_EMOJI;

    if (!TIME_RE.test(time)) {
        return interaction.editReply({
            content: '❌ Time must be in 24-hour UTC `HH:MM` format, e.g. `06:00` or `20:00`.',
        });
    }

    const fireAt = nextOccurrenceUtc(time, new Date());
    const ts = Math.floor(fireAt.getTime() / 1000);

    const embed = new EmbedBuilder()
        .setColor(pickColor())
        .setTitle('⚔️ Clash of Glory · The Guild Has Spoken')
        .setDescription(
            `The guild has spoken! React below to confirm you'll be available.\n\n` +
            `Local: <t:${ts}:t>\nUTC: ${time}`
        )
        .addFields(
            { name: `${emojiYes} Yes`, value: 'Available', inline: true },
            { name: `${emojiNo} No`, value: 'Not available', inline: true },
            { name: `${emojiMaybe} Maybe`, value: 'Unsure', inline: true },
        );

    let message;
    try {
        message = await interaction.channel.send({ embeds: [embed] });
        await message.react(emojiYes);
        await message.react(emojiNo);
        await message.react(emojiMaybe);

        db.createGloryctaPoll({
            kind: 'confirm',
            messageId: message.id,
            channelId: message.channelId,
            emojiA: emojiYes, emojiB: emojiNo, emojiC: emojiMaybe,
            labelA: 'Yes', labelB: 'No', labelC: 'Maybe',
        });
    } catch (err) {
        console.error('[Glory] Failed to post confirm, cleaning up:', err.message);
        if (message) await message.delete().catch(() => {});
        return interaction.editReply({
            content: '❌ Could not finish posting the confirmation. The partial message was removed — try again.',
        }).catch(() => {});
    }

    await interaction.editReply({ content: '⚔️ Confirmation posted.' });
}

async function executeCount(interaction) {
    if (!(await enforcePermissions(interaction, 'glory', 'count'))) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const link = interaction.options.getString('message');
    const match = link.match(MESSAGE_LINK_RE);
    if (!match) {
        return interaction.editReply({
            content: '❌ That doesn\'t look like a Discord message link. Right-click (or long-press) the confirmation post → Copy Message Link.',
        });
    }
    const [, channelId, messageId] = match;

    const poll = db.getGloryctaPollByMessageId(messageId);
    if (!poll) {
        return interaction.editReply({
            content: '❌ That message isn\'t a tracked `/glory` post (or it was already tallied/cancelled).',
        });
    }

    const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
    const message = channel ? await channel.messages.fetch(messageId).catch(() => null) : null;
    if (!message) {
        return interaction.editReply({ content: '❌ Could not fetch that message — it may have been deleted.' });
    }

    const pairs = [
        { emoji: poll.emoji_a, label: poll.label_a },
        { emoji: poll.emoji_b, label: poll.label_b },
    ];
    if (poll.emoji_c) pairs.push({ emoji: poll.emoji_c, label: poll.label_c });

    const results = await tallyReactions(message, pairs);

    const embed = new EmbedBuilder()
        .setColor(pickColor())
        .setTitle('⚔️ Clash of Glory · Count')
        .addFields(results.map(r => ({ name: `${r.emoji} ${r.label} (${r.count})`, value: r.lines, inline: true })));

    // Post in the SOURCE post's channel, not wherever /glory count happened to be
    // run from -- those can differ if the message link points at another channel.
    await channel.send({ embeds: [embed] });
    await interaction.editReply({ content: '⚔️ Count posted.' });
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('glory')
        .setDescription('Clash of Glory guild coordination')
        .addSubcommand(s => s
            .setName('cta')
            .setDescription('Post a timed battle-time vote')
            .addStringOption(opt => opt.setName('time1').setDescription('First UTC time option, HH:MM (e.g. 06:00)').setRequired(true))
            .addStringOption(opt => opt.setName('time2').setDescription('Second UTC time option, HH:MM (e.g. 20:00)').setRequired(true))
            .addIntegerOption(opt => opt.setName('duration').setDescription('How many hours the vote stays open').setRequired(true).setMinValue(1)))
        .addSubcommand(s => s
            .setName('confirm')
            .setDescription('Post the decided battle time for yes/no/maybe confirmation')
            .addStringOption(opt => opt.setName('time').setDescription('The decided UTC time, HH:MM (e.g. 06:00 or 20:00)').setRequired(true)))
        .addSubcommand(s => s
            .setName('count')
            .setDescription('Count reactions on a /glory cta or /glory confirm post')
            .addStringOption(opt => opt.setName('message').setDescription('Link to the post (right-click/long-press → Copy Message Link)').setRequired(true))),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        if (sub === 'cta') return executeCta(interaction);
        if (sub === 'confirm') return executeConfirm(interaction);
        if (sub === 'count') return executeCount(interaction);
    },
};
