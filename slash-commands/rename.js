const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const db = require('../utils/db');
const { enforce } = require('../utils/permissions');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('rename')
        .setDescription('Rename a guild member in the database (Riff/Raff only)')
        .addStringOption(opt =>
            opt.setName('old_name')
                .setDescription('Current in-game name')
                .setRequired(true)
                .setAutocomplete(true)
        )
        .addStringOption(opt =>
            opt.setName('new_name')
                .setDescription('Correct in-game name')
                .setRequired(true)
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
        if (!(await enforce(interaction, 'riffOrRaff'))) return;
        const oldName = interaction.options.getString('old_name');
        const newName = interaction.options.getString('new_name').trim();

        const member = db.prepare('SELECT * FROM members WHERE ingame_name = ?').get(oldName);
        if (!member) {
            return interaction.reply({ content: `❌ Member **${oldName}** not found.`, flags: MessageFlags.Ephemeral });
        }

        const now = new Date().toISOString();
        db.prepare('UPDATE members SET ingame_name = ? WHERE id = ?').run(newName, member.id);
        db.prepare('INSERT INTO member_name_history (member_id, old_name, new_name, changed_at) VALUES (?, ?, ?, ?)').run(member.id, oldName, newName, now);
        db.prepare('INSERT OR REPLACE INTO name_corrections (ocr_name, correct_name, source) VALUES (?, ?, ?)').run(oldName.toLowerCase(), newName, 'admin');

        await interaction.reply({ content: `✅ Renamed **${oldName}** → **${newName}**`, flags: MessageFlags.Ephemeral });
    },
};
