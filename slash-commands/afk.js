const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const db = require('../utils/db');
const { pickColor } = require('../utils/colors');

function getMemberByName(name) {
    return db.prepare('SELECT id, ingame_name FROM members WHERE ingame_name LIKE ?').get(name);
}

function getLatestNames() {
    return db.prepare(`
        SELECT DISTINCT ms.name FROM member_snapshots ms
        JOIN members m ON m.id = ms.member_id
        WHERE ms.snapshot_id = (SELECT MAX(id) FROM snapshots)
          AND m.active = 1
    `).all().map(r => r.name);
}

async function autocomplete(interaction) {
    const focused = interaction.options.getFocused().toLowerCase();
    const names = getLatestNames();
    const filtered = names.filter(n => n.toLowerCase().includes(focused)).slice(0, 25);
    await interaction.respond(filtered.map(n => ({ name: n, value: n })));
}

module.exports = {
    autocomplete,
    data: new SlashCommandBuilder()
        .setName('afk')
        .setDescription('Manage AFK status for guild members')
        .addSubcommand(s => s
            .setName('set')
            .setDescription('Mark a member as AFK (exempts from inactivity alerts)')
            .addStringOption(o => o.setName('name').setDescription('Member name').setRequired(true).setAutocomplete(true))
            .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false))
            .addStringOption(o => o.setName('return_date').setDescription('Expected return (e.g. 2025-06-01)').setRequired(false))
        )
        .addSubcommand(s => s
            .setName('clear')
            .setDescription('Remove AFK status from a member')
            .addStringOption(o => o.setName('name').setDescription('Member name').setRequired(true).setAutocomplete(true))
        )
        .addSubcommand(s => s
            .setName('list')
            .setDescription('List all members currently marked AFK')
        ),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        if (sub === 'set') {
            const name = interaction.options.getString('name').trim();
            const reason = interaction.options.getString('reason') ?? null;
            const rawDate = interaction.options.getString('return_date') ?? null;

            let returnDate = null;
            if (rawDate) {
                if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate) || isNaN(Date.parse(rawDate))) {
                    return interaction.reply({ content: '❌ Return date must be in `YYYY-MM-DD` format (e.g. `2025-06-15`).', flags: MessageFlags.Ephemeral });
                }
                returnDate = rawDate;
            }

            const member = getMemberByName(name);
            if (!member) {
                return interaction.reply({ content: `Member **${name}** not found.`, flags: MessageFlags.Ephemeral });
            }
            db.prepare(`
                INSERT OR REPLACE INTO member_afk (member_id, reason, return_date, set_by, set_at)
                VALUES (?, ?, ?, ?, ?)
            `).run(member.id, reason, returnDate, interaction.user.id, new Date().toISOString());

            const parts = [`✈️ **${member.ingame_name}** is now marked AFK.`];
            if (reason) parts.push(`Reason: ${reason}`);
            if (returnDate) parts.push(`Expected back: ${returnDate}`);
            return interaction.reply({ content: parts.join('\n'), ephemeral: false });
        }

        if (sub === 'clear') {
            const name = interaction.options.getString('name').trim();
            const member = getMemberByName(name);
            if (!member) {
                return interaction.reply({ content: `Member **${name}** not found.`, flags: MessageFlags.Ephemeral });
            }
            const result = db.prepare('DELETE FROM member_afk WHERE member_id = ?').run(member.id);
            if (result.changes === 0) {
                return interaction.reply({ content: `**${member.ingame_name}** was not marked AFK.`, flags: MessageFlags.Ephemeral });
            }
            return interaction.reply({ content: `✅ AFK status cleared for **${member.ingame_name}**.`, ephemeral: false });
        }

        if (sub === 'list') {
            const rows = db.prepare(`
                SELECT m.ingame_name, afk.reason, afk.return_date, afk.set_by, afk.set_at,
                       setter.ingame_name AS setter_ingame
                FROM member_afk afk
                JOIN members m ON m.id = afk.member_id
                LEFT JOIN members setter ON setter.discord_id = afk.set_by
                ORDER BY afk.set_at DESC
            `).all();

            if (rows.length === 0) {
                return interaction.reply({ content: '✅ No members currently marked AFK.', flags: MessageFlags.Ephemeral });
            }

            const lines = rows.map(r => {
                let line = `· **${r.ingame_name}**`;
                if (r.reason) line += ` · ${r.reason}`;
                if (r.return_date) line += ` · back ${r.return_date}`;
                const setterStr = r.setter_ingame
                    ? `<@${r.set_by}> / ${r.setter_ingame}`
                    : `<@${r.set_by}>`;
                line += ` · set by ${setterStr}`;
                return line;
            });

            return interaction.reply({ embeds: [
                new EmbedBuilder()
                    .setTitle('✈️ AFK Members')
                    .setDescription(lines.join('\n'))
                    .setColor(pickColor()),
            ], flags: MessageFlags.Ephemeral });
        }
    },
};
