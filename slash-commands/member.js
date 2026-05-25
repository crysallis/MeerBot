const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const db = require('../utils/db');

function fmtPower(val) {
    if (!val) return '·';
    if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`;
    return `${(val / 1_000).toFixed(0)}K`;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('member')
        .setDescription('Look up a guild member\'s stats and history')
        .addStringOption(opt =>
            opt.setName('name')
                .setDescription('In-game name')
                .setRequired(false)
                .setAutocomplete(true)
        )
        .addUserOption(opt =>
            opt.setName('user')
                .setDescription('Discord user (must be linked)')
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
        const name = interaction.options.getString('name');
        const mentionedUser = interaction.options.getUser('user');

        if (!name && !mentionedUser) {
            return interaction.reply({ content: 'Provide a name or mention a linked user.', flags: MessageFlags.Ephemeral });
        }

        let current;
        if (mentionedUser) {
            current = db.prepare(`
                SELECT m.ingame_name, m.discord_id, m.first_seen,
                       ms.last_active, ms.combat_power, ms.combat_power_value, ms.activeness
                FROM member_snapshots ms
                JOIN members m ON m.id = ms.member_id
                WHERE ms.snapshot_id = (SELECT MAX(id) FROM snapshots)
                  AND m.discord_id = ?
                LIMIT 1
            `).get(mentionedUser.id);
            if (!current) {
                return interaction.reply({ content: `<@${mentionedUser.id}> is not linked to any guild member.`, flags: MessageFlags.Ephemeral });
            }
        } else {
            current = db.prepare(`
                SELECT m.ingame_name, m.discord_id, m.first_seen,
                       ms.last_active, ms.combat_power, ms.combat_power_value, ms.activeness
                FROM member_snapshots ms
                JOIN members m ON m.id = ms.member_id
                WHERE ms.snapshot_id = (SELECT MAX(id) FROM snapshots)
                  AND m.ingame_name LIKE ?
                LIMIT 1
            `).get(name);
        }

        if (!current) {
            return interaction.reply({ content: `Member **${name}** not found in the latest snapshot.`, flags: MessageFlags.Ephemeral });
        }
        const lookupName = current.ingame_name;

        const history = db.prepare(`
            SELECT s.scraped_at, ms.combat_power_value, ms.activeness, ms.last_active
            FROM member_snapshots ms
            JOIN snapshots s ON s.id = ms.snapshot_id
            JOIN members m ON m.id = ms.member_id
            WHERE m.ingame_name = ?
            ORDER BY s.scraped_at DESC
            LIMIT 8
        `).all(lookupName);

        const histLines = history.map(h =>
            `${h.scraped_at.slice(0, 10)}  ${fmtPower(h.combat_power_value).padStart(7)}  ${String(h.activeness).padStart(4)}  ${h.last_active}`
        );

        const embed = new EmbedBuilder()
            .setTitle(`👤 ${current.ingame_name}`)
            .addFields(
                { name: 'Combat Power',  value: current.combat_power || '·',                          inline: true },
                { name: 'Activeness',    value: String(current.activeness),                             inline: true },
                { name: 'Last Active',   value: current.last_active || '·',                            inline: true },
                { name: 'Discord',       value: current.discord_id ? `<@${current.discord_id}>` : 'Not linked', inline: true },
                { name: 'First Seen',    value: current.first_seen?.slice(0, 10) || '·',               inline: true },
            )
            .setColor(0xe67e22);

        if (histLines.length) {
            embed.setDescription('**Snapshot History**\n```\nDate        Power   Act  Last Active\n' + histLines.join('\n') + '\n```');
        }

        await interaction.reply({ embeds: [embed] });
    },
};
