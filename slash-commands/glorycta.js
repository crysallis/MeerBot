// slash-commands/glorycta.js
const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const db = require('../utils/db');
const { pickColor } = require('../utils/colors');
const { enforcePermissions } = require('../utils/permissions');
const { pickPollEmoji, nextOccurrenceUtc } = require('../utils/glorycta');

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('glorycta')
        .setDescription('Post a Clash of Glory battle-time vote')
        .addStringOption(opt =>
            opt.setName('time1')
                .setDescription('First UTC time option, HH:MM (e.g. 06:00)')
                .setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName('time2')
                .setDescription('Second UTC time option, HH:MM (e.g. 20:00)')
                .setRequired(true)
        )
        .addIntegerOption(opt =>
            opt.setName('duration')
                .setDescription('How many hours the vote stays open')
                .setRequired(true)
                .setMinValue(1)
        ),

    async execute(interaction) {
        if (!(await enforcePermissions(interaction, 'glorycta'))) return;

        const time1 = interaction.options.getString('time1');
        const time2 = interaction.options.getString('time2');
        const duration = interaction.options.getInteger('duration');

        if (!TIME_RE.test(time1) || !TIME_RE.test(time2)) {
            return interaction.reply({
                content: '❌ Times must be in 24-hour UTC `HH:MM` format, e.g. `06:00` or `20:00`.',
                flags: MessageFlags.Ephemeral,
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
        try {
            message = await interaction.channel.send({ embeds: [embed] });
            await message.react(emojiA);
            await message.react(emojiB);
            await message.pin();
        } catch (err) {
            console.error('[Glorycta] Failed to post poll, cleaning up:', err.message);
            if (message) await message.delete().catch(() => {});
            return interaction.reply({
                content: '❌ Could not finish posting the vote (reactions or pin failed). The partial message was removed — try again.',
                flags: MessageFlags.Ephemeral,
            }).catch(() => {});
        }

        const nowIso = now.toISOString();
        const tallyFireAt = new Date(now.getTime() + duration * 60 * 60 * 1000).toISOString();
        const jobResult = db.prepare(
            'INSERT INTO scheduled_jobs (type, fire_at, created_at) VALUES (?, ?, ?)'
        ).run('glorycta_tally', tallyFireAt, nowIso);

        db.createGloryctaPoll({
            jobId: jobResult.lastInsertRowid,
            messageId: message.id,
            channelId: message.channelId,
            emojiA, emojiB,
            labelA: time1, labelB: time2,
            fireAtA: fireAtA.toISOString(),
            fireAtB: fireAtB.toISOString(),
        });

        await interaction.reply({
            content: `⚔️ Call to arms posted. Vote closes in ${duration} hour${duration === 1 ? '' : 's'}.`,
            flags: MessageFlags.Ephemeral,
        });
    },
};
