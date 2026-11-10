const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const db = require('../utils/db');
const { pickColor } = require('../utils/colors');
const { enforcePermissions } = require('../utils/permissions');
const stages = require('../utils/afkStages');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('afkstage')
        .setDescription('Find the AFK stages post(s) for a stage')
        .addStringOption(opt =>
            opt.setName('stage')
                .setDescription('Stage label, e.g. 127, P127, A127 or PA127')
                .setRequired(true)
                .setAutocomplete(true)
        ),

    async autocomplete(interaction) {
        const typed = interaction.options.getFocused().replace(/[\[\]\s]/g, '').toUpperCase();
        const matches = stages.getKnownLabels(db)
            .filter(row => row.label.includes(typed))
            .slice(0, 25);
        await interaction.respond(matches.map(row => ({
            name: `${row.label} (${row.posts} post${row.posts === 1 ? '' : 's'})`,
            value: row.label,
        })));
    },

    async execute(interaction) {
        if (!(await enforcePermissions(interaction, 'afkstage', null))) return;

        const input = interaction.options.getString('stage');
        const label = stages.normalizeStageInput(input);
        if (!label) {
            return interaction.reply({
                content: `**${input}** is not a stage label. Use a number with an optional P, A or PA in front, like 127, P127, A127 or PA127.`,
                flags: MessageFlags.Ephemeral,
            });
        }

        const posts = stages.getStagePosts(db, label);
        if (posts.length === 0) {
            return interaction.reply({
                content: `No posts found for stage **${label}**.`,
                flags: MessageFlags.Ephemeral,
            });
        }

        const embed = new EmbedBuilder()
            .setColor(pickColor())
            .setTitle(`📍 AFK Stage ${label}`)
            .setDescription(
                posts.map((p, i) => `${i + 1}. [Jump to post](${p.message_url})${p.posted_by ? ` — <@${p.posted_by}>` : ''}`).join('\n')
            );

        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    },
};
