const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { enforce } = require('../../utils/permissions');
const { pickColor } = require('../../utils/colors');
const botConfig = require('../../utils/botConfig');

const GUILDS = {
    riffraff: { id: '1401783863960666143', name: 'RiffRaffians', label: 'RKF RiffRaff', welcomeKey: 'ROSTER_WELCOME_RIFFRAFF_CHANNEL_ID' },
    frop:     { id: '1482484067965599846', name: 'Penguins',     label: 'RKR Frop',     welcomeKey: 'ROSTER_WELCOME_FROP_CHANNEL_ID' },
};

const GUILD_ROLE_IDS = Object.values(GUILDS).map(g => g.id);

const WHO_DIS_ROLE_ID = '1330742760306638889';

function currentGuild(member) {
    return Object.values(GUILDS).find(g => member.roles.cache.has(g.id)) ?? null;
}

const GUILD_CHOICES = [
    { name: 'RKF RiffRaff', value: 'riffraff' },
    { name: 'RKR Frop',     value: 'frop' },
];

module.exports = {
    data: new SlashCommandBuilder()
        .setName('roster')
        .setDescription('Manage guild membership roles')
        .addSubcommand(s => s
            .setName('add')
            .setDescription('Add a member to a guild')
            .addStringOption(o => o.setName('guild').setDescription('Guild').setRequired(true).addChoices(...GUILD_CHOICES))
            .addUserOption(o => o.setName('user').setDescription('Discord member').setRequired(true))
        )
        .addSubcommand(s => s
            .setName('remove')
            .setDescription('Remove a member from a guild')
            .addStringOption(o => o.setName('guild').setDescription('Guild').setRequired(true).addChoices(...GUILD_CHOICES))
            .addUserOption(o => o.setName('user').setDescription('Discord member').setRequired(true))
        )
        .addSubcommand(s => s
            .setName('transfer')
            .setDescription('Move a member from one guild to the other')
            .addUserOption(o => o.setName('user').setDescription('Discord member').setRequired(true))
            .addStringOption(o => o.setName('to_guild').setDescription('Destination guild').setRequired(true).addChoices(...GUILD_CHOICES))
        ),

    async execute(interaction) {
        if (!(await enforce(interaction, 'riffOrRaff'))) return;

        const sub    = interaction.options.getSubcommand();
        const target = interaction.options.getMember('user');

        if (!target) {
            return interaction.reply({ content: 'That member was not found in this server.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply();

        if (sub === 'add') {
            const guild = GUILDS[interaction.options.getString('guild')];
            const added   = [];
            const removed = [];

            if (!target.roles.cache.has(guild.id)) {
                await target.roles.add(guild.id);
                added.push(guild.name);
            }

            if (target.roles.cache.has(WHO_DIS_ROLE_ID)) {
                await target.roles.remove(WHO_DIS_ROLE_ID);
                removed.push('Who Dis?');
            }

            const lines = [];
            if (added.length)   lines.push(`**Added:** ${added.join(', ')}`);
            if (removed.length) lines.push(`**Removed:** ${removed.join(', ')}`);
            if (!lines.length)  lines.push('No role changes needed.');

            await interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setTitle(`${guild.label} · ${target.displayName} added`)
                    .setDescription(lines.join('\n'))
                    .setColor(pickColor())
                    .setFooter({ text: `By ${interaction.user.username}` })],
            });

            const welcomeChannelId = botConfig.get(guild.welcomeKey);
            if (welcomeChannelId) {
                const ch = interaction.guild.channels.cache.get(welcomeChannelId);
                if (ch) {
                    await ch.send(`Welcome to **${guild.label}**, ${target}! :tada:`);
                }
            }

            return;
        }

        if (sub === 'remove') {
            const guild = GUILDS[interaction.options.getString('guild')];

            if (!target.roles.cache.has(guild.id)) {
                return interaction.editReply({ content: `${target.displayName} does not have the **${guild.name}** role.` });
            }

            await target.roles.remove(guild.id);

            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setTitle(`${guild.label} · ${target.displayName} removed`)
                    .setDescription(`**Removed:** ${guild.name}`)
                    .setColor(pickColor())
                    .setFooter({ text: `By ${interaction.user.username}` })],
            });
        }

        if (sub === 'transfer') {
            const toGuild   = GUILDS[interaction.options.getString('to_guild')];
            const fromGuild = currentGuild(target);

            if (fromGuild?.id === toGuild.id) {
                return interaction.editReply({ content: `${target.displayName} is already in **${toGuild.label}**.` });
            }

            const removed = [];

            for (const g of Object.values(GUILDS)) {
                if (target.roles.cache.has(g.id)) {
                    await target.roles.remove(g.id);
                    removed.push(g.name);
                }
            }

            await target.roles.add(toGuild.id);

            const lines = [];
            if (removed.length) lines.push(`**From:** ${removed.join(', ')}`);
            lines.push(`**To:** ${toGuild.name}`);

            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setTitle(`Transfer · ${target.displayName}`)
                    .setDescription(lines.join('\n'))
                    .setColor(pickColor())
                    .setFooter({ text: `By ${interaction.user.username}` })],
            });
        }
    },
};
