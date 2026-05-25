const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const db = require('../utils/db');

function getMemberByName(name) {
    return db.prepare('SELECT id, ingame_name FROM members WHERE ingame_name LIKE ?').get(name);
}

function getLatestNames() {
    return db.prepare(`
        SELECT DISTINCT name FROM member_snapshots
        WHERE snapshot_id = (SELECT MAX(id) FROM snapshots)
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
        .setName('note')
        .setDescription('Guild leader notes on members (admin only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(s => s
            .setName('add')
            .setDescription('Add a note to a member')
            .addStringOption(o => o.setName('name').setDescription('Member name').setRequired(true).setAutocomplete(true))
            .addStringOption(o => o.setName('text').setDescription('Note text').setRequired(true))
        )
        .addSubcommand(s => s
            .setName('view')
            .setDescription('View notes for a member')
            .addStringOption(o => o.setName('name').setDescription('Member name').setRequired(true).setAutocomplete(true))
        )
        .addSubcommand(s => s
            .setName('delete')
            .setDescription('Delete a note by ID')
            .addIntegerOption(o => o.setName('id').setDescription('Note ID (shown in /note view)').setRequired(true))
        ),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        if (sub === 'add') {
            const name = interaction.options.getString('name').trim();
            const text = interaction.options.getString('text').trim();
            const member = getMemberByName(name);
            if (!member) {
                return interaction.reply({ content: `Member **${name}** not found.`, flags: MessageFlags.Ephemeral });
            }
            db.prepare(`
                INSERT INTO member_notes (member_id, note, created_by, created_at)
                VALUES (?, ?, ?, ?)
            `).run(member.id, text, interaction.user.username, new Date().toISOString());
            return interaction.reply({ content: `📝 Note added for **${member.ingame_name}**.`, flags: MessageFlags.Ephemeral });
        }

        if (sub === 'view') {
            const name = interaction.options.getString('name').trim();
            const member = getMemberByName(name);
            if (!member) {
                return interaction.reply({ content: `Member **${name}** not found.`, flags: MessageFlags.Ephemeral });
            }
            const notes = db.prepare(`
                SELECT id, note, created_by, created_at FROM member_notes
                WHERE member_id = ? ORDER BY created_at DESC
            `).all(member.id);

            if (notes.length === 0) {
                return interaction.reply({ content: `No notes for **${member.ingame_name}**.`, flags: MessageFlags.Ephemeral });
            }

            const fields = notes.map(n => ({
                name: `#${n.id} · ${n.created_at.slice(0, 10)} · ${n.created_by}`,
                value: n.note,
                inline: false,
            }));

            return interaction.reply({ embeds: [
                new EmbedBuilder()
                    .setTitle(`📝 Notes · ${member.ingame_name}`)
                    .addFields(fields)
                    .setColor(0x9b59b6),
            ], flags: MessageFlags.Ephemeral });
        }

        if (sub === 'delete') {
            const id = interaction.options.getInteger('id');
            const note = db.prepare('SELECT id FROM member_notes WHERE id = ?').get(id);
            if (!note) {
                return interaction.reply({ content: `Note #${id} not found.`, flags: MessageFlags.Ephemeral });
            }
            db.prepare('DELETE FROM member_notes WHERE id = ?').run(id);
            return interaction.reply({ content: `🗑️ Note #${id} deleted.`, flags: MessageFlags.Ephemeral });
        }
    },
};
