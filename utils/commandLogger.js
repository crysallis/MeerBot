const { EmbedBuilder } = require('discord.js');
const botConfig = require('./botConfig');

// Discord option types — 1 = SUB_COMMAND, 2 = SUB_COMMAND_GROUP
const SUB_COMMAND = 1;
const SUB_COMMAND_GROUP = 2;

function buildCommandString(interaction) {
    const parts = [`/${interaction.commandName}`];
    let opts = interaction.options.data;

    // Walk into subcommand group / subcommand if present
    while (opts.length && (opts[0].type === SUB_COMMAND_GROUP || opts[0].type === SUB_COMMAND)) {
        parts.push(opts[0].name);
        opts = opts[0].options ?? [];
    }

    for (const opt of opts) {
        let value = opt.value;
        if (typeof value === 'string' && value.length > 60) value = value.slice(0, 57) + '...';
        parts.push(`${opt.name}:${value}`);
    }

    return parts.join(' ');
}

async function logCommand(interaction) {
    const channelId = botConfig.get('COMMAND_LOG_CHANNEL_ID');
    if (!channelId) return;

    try {
        const channel = await interaction.client.channels.fetch(channelId);
        if (!channel?.isTextBased()) return;

        const user = interaction.user;
        const cmdStr = buildCommandString(interaction);
        const channelMention = interaction.channelId ? `<#${interaction.channelId}>` : '(DM)';

        const embed = new EmbedBuilder()
            .setAuthor({
                name: user.username,
                iconURL: user.displayAvatarURL({ size: 64 }),
            })
            .setDescription(
                `Used \`${interaction.commandName}\` command in ${channelMention}\n` +
                '```\n' + cmdStr + '\n```'
            )
            .setColor(0x4a90e2)
            .setTimestamp();

        await channel.send({ embeds: [embed] });
    } catch (err) {
        console.error('Command log failed:', err);
    }
}

module.exports = { logCommand };
