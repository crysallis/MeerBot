const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { pickColor } = require('../utils/colors');
const { enforcePermissions } = require('../utils/permissions');
const { getTitlePosts, getKnownTitles } = require('../utils/handlers/titlePostHandler');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('titles')
        .setDescription('Find the easter-eggs post(s) explaining how to get a title')
        .addStringOption(opt =>
            opt.setName('titlename')
                .setDescription('The title to look up')
                .setRequired(true)
                .setAutocomplete(true)
        ),

    async autocomplete(interaction) {
        const focused = interaction.options.getFocused().toLowerCase();
        const titles = getKnownTitles();
        const filtered = titles.filter(t => t.toLowerCase().includes(focused)).slice(0, 25);
        await interaction.respond(filtered.map(t => ({ name: t, value: t })));
    },

    async execute(interaction) {
        if (!(await enforcePermissions(interaction, 'titles', null))) return;

        const titleName = interaction.options.getString('titlename');
        const posts = getTitlePosts(titleName);

        if (posts.length === 0) {
            return interaction.reply({
                content: `No posts found for title **${titleName}**.`,
                flags: MessageFlags.Ephemeral,
            });
        }

        const embed = new EmbedBuilder()
            .setColor(pickColor())
            .setTitle(`🏷️ ${posts[0].title}`)
            .setDescription(
                posts.map((p, i) => `${i + 1}. [Jump to post](${p.message_url})${p.posted_by ? ` — <@${p.posted_by}>` : ''}`).join('\n')
            );

        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    },
};
