const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const db = require('../utils/db');
const { mergeMembers } = db;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('rename')
        .setDescription('Rename a guild member in the database')
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
            SELECT ingame_name AS name FROM members WHERE active = 1
            ORDER BY ingame_name COLLATE NOCASE
        `).all().map(r => r.name);
        const filtered = names.filter(n => n.toLowerCase().includes(focused)).slice(0, 25);
        await interaction.respond(filtered.map(n => ({ name: n, value: n })));
    },

    async execute(interaction) {
        const oldName = interaction.options.getString('old_name');
        const newName = interaction.options.getString('new_name').trim();

        const member = db.prepare('SELECT * FROM members WHERE ingame_name = ?').get(oldName);
        if (!member) {
            return interaction.reply({ content: `❌ Member **${oldName}** not found.`, flags: MessageFlags.Ephemeral });
        }

        // If newName already belongs to a different member, this is a merge (dedupe),
        // not a rename — going through mergeMembers avoids the ingame_name UNIQUE clash.
        const collision = db.prepare('SELECT id FROM members WHERE ingame_name = ? AND id != ?').get(newName, member.id);
        if (collision) {
            mergeMembers(collision.id, member.id);
            return interaction.reply({ content: `✅ Merged **${oldName}** into **${newName}** (duplicate removed).`, flags: MessageFlags.Ephemeral });
        }

        const now = new Date().toISOString();
        db.prepare('UPDATE members SET ingame_name = ?, pending = 0 WHERE id = ?').run(newName, member.id);
        db.prepare('INSERT INTO member_name_history (member_id, old_name, new_name, changed_at) VALUES (?, ?, ?, ?)').run(member.id, oldName, newName, now);
        db.prepare('INSERT OR REPLACE INTO name_corrections (ocr_name, correct_name, source) VALUES (?, ?, ?)').run(oldName.toLowerCase(), newName, 'admin');

        await interaction.reply({ content: `✅ Renamed **${oldName}** → **${newName}**`, flags: MessageFlags.Ephemeral });
    },
};
