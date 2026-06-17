const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const db = require('../utils/db');
const botConfig = require('../utils/botConfig');
const { pickColor } = require('../utils/colors');
const { enforcePermissions } = require('../utils/permissions');

// Homestead role to ping (mirrors how roster.js/permissions.js hardcode role IDs).
// The channel is admin-configurable via the HOMESTEAD_CHANNEL_ID config key.
const HOMESTEAD_ROLE_ID = '1403623545984127036';

module.exports = {
    data: new SlashCommandBuilder()
        .setName('invasion')
        .setDescription('Alert the Homestead role that a homestead is being invaded')
        .addStringOption(opt =>
            opt.setName('name')
                .setDescription('In-game name (defaults to you)')
                .setRequired(false)
                .setAutocomplete(true)
        )
        .addUserOption(opt =>
            opt.setName('user')
                .setDescription('Discord user, must be linked (defaults to you)')
                .setRequired(false)
        ),

    async autocomplete(interaction) {
        const focused = interaction.options.getFocused().toLowerCase();
        const names = db.prepare(`
            SELECT DISTINCT name FROM member_snapshots
            WHERE snapshot_id = (SELECT MAX(id) FROM snapshots)
        `).all().map(r => r.name);
        const filtered = names.filter(n => n.toLowerCase().includes(focused)).slice(0, 25);
        await interaction.respond(filtered.map(n => ({ name: n, value: n })));
    },

    async execute(interaction) {
        if (!(await enforcePermissions(interaction, 'invasion', null))) return;

        const name = interaction.options.getString('name');
        const mentionedUser = interaction.options.getUser('user');

        // Resolve the target member: explicit name > mentioned user (linked) > caller (linked).
        let member;
        if (name) {
            member = db.prepare('SELECT ingame_name FROM members WHERE ingame_name LIKE ? LIMIT 1').get(name);
            if (!member) {
                return interaction.reply({ content: `Member **${name}** not found.`, flags: MessageFlags.Ephemeral });
            }
        } else {
            const targetId = mentionedUser ? mentionedUser.id : interaction.user.id;
            member = db.prepare('SELECT ingame_name FROM members WHERE discord_id = ? LIMIT 1').get(targetId);
            if (!member) {
                const who = mentionedUser ? `<@${targetId}> is` : "You're";
                return interaction.reply({
                    content: `${who} not linked to an in-game member. Pass a \`name\` instead.`,
                    flags: MessageFlags.Ephemeral,
                });
            }
        }

        const channelId = botConfig.get('HOMESTEAD_CHANNEL_ID');
        const channel = channelId && interaction.guild.channels.cache.get(channelId);
        if (!channel) {
            return interaction.reply({ content: 'Homestead channel is not configured or could not be found.', flags: MessageFlags.Ephemeral });
        }

        const embed = new EmbedBuilder()
            .setColor(pickColor())
            .setTitle('🏠 Homestead Invasion!')
            .setDescription(`**${member.ingame_name}**'s Homestead is being invaded 🏠 come help repel the invasion!`);

        await channel.send({
            content: `<@&${HOMESTEAD_ROLE_ID}>`,
            embeds: [embed],
            allowedMentions: { roles: [HOMESTEAD_ROLE_ID] },
        });

        await interaction.reply({
            content: `🏠 Invasion alert for **${member.ingame_name}** posted to <#${channelId}>.`,
            flags: MessageFlags.Ephemeral,
        });
    },
};
