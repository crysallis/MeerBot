const { SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const db = require('../utils/db');
const { buildBirthdayEmbed } = require('../utils/birthdayCheck');

const DAYS_IN_MONTH = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function validDay(month, day) {
    return day <= DAYS_IN_MONTH[month];
}

function dateStr(bday) {
    const month = bday.month.toString().padStart(2, '0');
    const day   = bday.day.toString().padStart(2, '0');
    return bday.year ? `${bday.year}-${month}-${day}` : `${month}/${day}`;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('birthday')
        .setDescription('Register or view birthdays')
        .addSubcommand(s => s
            .setName('register')
            .setDescription('Register your birthday')
            .addIntegerOption(o => o.setName('month').setDescription('Month (1-12)').setRequired(true).setMinValue(1).setMaxValue(12))
            .addIntegerOption(o => o.setName('day').setDescription('Day (1-31)').setRequired(true).setMinValue(1).setMaxValue(31))
            .addIntegerOption(o => o.setName('year').setDescription('Birth year (optional, stored privately)').setRequired(false).setMinValue(1900))
        )
        .addSubcommand(s => s
            .setName('list')
            .setDescription('List all birthdays in this guild')
        )
        .addSubcommand(s => s
            .setName('remove')
            .setDescription('Remove your registered birthday')
        )
        .addSubcommand(s => s
            .setName('test')
            .setDescription('(Admin) Preview the birthday embed for a user')
            .addUserOption(o => o.setName('user').setDescription('User to preview for (defaults to you)').setRequired(false))
        ),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        if (sub === 'register') {
            const month = interaction.options.getInteger('month');
            const day   = interaction.options.getInteger('day');
            const year  = interaction.options.getInteger('year') ?? null;

            if (!validDay(month, day)) {
                return interaction.reply({ content: `❌ ${month}/${day} is not a valid date.`, flags: MessageFlags.Ephemeral });
            }

            db.prepare(`
                INSERT INTO birthdays (user_id, username, month, day, year, guild_id, registered_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(user_id, guild_id) DO UPDATE SET
                    username = excluded.username, month = excluded.month,
                    day = excluded.day, year = excluded.year,
                    registered_at = excluded.registered_at
            `).run(interaction.user.id, interaction.user.username, month, day, year, interaction.guildId, new Date().toISOString());

            return interaction.reply({ content: `🎂 Birthday registered: **${dateStr({ month, day, year })}**`, flags: MessageFlags.Ephemeral });
        }

        if (sub === 'remove') {
            const result = db.prepare('DELETE FROM birthdays WHERE user_id = ? AND guild_id = ?').run(interaction.user.id, interaction.guildId);
            if (result.changes === 0) {
                return interaction.reply({ content: `You don't have a birthday registered.`, flags: MessageFlags.Ephemeral });
            }
            return interaction.reply({ content: `🗑️ Your birthday has been removed.`, flags: MessageFlags.Ephemeral });
        }

        if (sub === 'test') {
            if (!interaction.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
                return interaction.reply({ content: 'Admin only.', flags: MessageFlags.Ephemeral });
            }
            const target = interaction.options.getUser('user') ?? interaction.user;
            const bday = db.prepare('SELECT month, day FROM birthdays WHERE user_id = ? AND guild_id = ?').get(target.id, interaction.guildId);
            const { content, embed } = buildBirthdayEmbed(target.id, target.username, bday?.month, bday?.day);
            return interaction.reply({ content, embeds: [embed] });
        }

        if (sub === 'list') {
            const rows = db.prepare(`
                SELECT b.user_id, b.month, b.day, b.year, m.ingame_name
                FROM birthdays b
                LEFT JOIN members m ON m.discord_id = b.user_id
                WHERE b.guild_id = ?
                ORDER BY b.month, b.day
            `).all(interaction.guildId);

            if (!rows.length) {
                return interaction.reply({ content: 'No birthdays registered yet.', flags: MessageFlags.Ephemeral });
            }

            const today = new Date();
            const tm = today.getUTCMonth() + 1;
            const td = today.getUTCDate();

            const lines = rows.map(r => {
                const isToday = r.month === tm && r.day === td;
                const ingame  = r.ingame_name ? ` · *${r.ingame_name}*` : '';
                const age     = r.year ? ` · ${today.getUTCFullYear() - r.year} this year` : '';
                return `${isToday ? '🎂 ' : ''}<@${r.user_id}>${ingame} · ${dateStr(r)}${age}`;
            });

            return interaction.reply({ embeds: [
                new EmbedBuilder()
                    .setTitle('🎂 Guild Birthdays')
                    .setDescription(lines.join('\n'))
                    .setColor(0xFF69B4)
                    .setFooter({ text: `${rows.length} registered` }),
            ], flags: MessageFlags.Ephemeral });
        }
    },
};
