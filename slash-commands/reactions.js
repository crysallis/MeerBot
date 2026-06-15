'use strict';
const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const db = require('../utils/db');
const { pickColor } = require('../utils/colors');
const { enforcePermissions } = require('../utils/permissions');

const PATTERN_LABELS = {
    contains: 'contains',
    exact:    'exact match',
    regex:    'regex',
    mention:  '@mention',
};

const RESPONSE_LABELS = {
    reply:   'reply',
    message: 'message',
    emoji:   'emoji react',
    dm:      'DM sender',
};

module.exports = {
    data: new SlashCommandBuilder()
        .setName('reactions')
        .setDescription('List configured message reaction rules'),

    async execute(interaction) {
        if (!(await enforcePermissions(interaction, 'reactions', null))) return;
        const rules = db.prepare(
            'SELECT * FROM message_reactions ORDER BY enabled DESC, id'
        ).all();

        const embed = new EmbedBuilder()
            .setTitle('Message Reactions')
            .setColor(pickColor())
            .setFooter({ text: `${rules.length} rule${rules.length !== 1 ? 's' : ''} · manage via admin panel` })
            .setTimestamp();

        if (!rules.length) {
            embed.setDescription('No reaction rules configured yet.\nAdd them via the admin panel at `http://localhost:3001`.');
            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }

        for (const rule of rules) {
            const status = rule.enabled ? '**ON**' : '~~OFF~~';
            const trigger = rule.pattern_type === 'mention'
                ? `@mention`
                : `\`${rule.pattern}\` (${PATTERN_LABELS[rule.pattern_type] ?? rule.pattern_type})`;

            let scope = 'all channels';
            if (rule.channel_filter) {
                const ids = JSON.parse(rule.channel_filter);
                scope = ids.map(id => `<#${id}>`).join(', ');
            }

            const lines = [
                `Trigger: ${trigger}`,
                `Response: ${RESPONSE_LABELS[rule.response_type] ?? rule.response_type} · \`${rule.response_content || '(empty)'}\``,
                `Scope: ${scope}`,
                `Cooldown: ${rule.cooldown_seconds}s · ${rule.require_mention ? 'requires @mention' : 'no mention needed'}`,
            ];

            embed.addFields({
                name: `${status} · ${rule.name}`,
                value: lines.join('\n'),
                inline: false,
            });
        }

        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    },
};
