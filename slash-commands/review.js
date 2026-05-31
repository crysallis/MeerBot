const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const db = require('../utils/db');
const { mergeMembers } = db;
const { enforce } = require('../utils/permissions');
const { pickColor } = require('../utils/colors');

const pendingRows = db.prepare(`
    SELECT m.id, m.ingame_name, m.discord_id,
           ms.combat_power, ms.warband, ms.last_active
    FROM members m
    LEFT JOIN member_snapshots ms
           ON ms.member_id = m.id AND ms.snapshot_id = (SELECT MAX(id) FROM snapshots)
    WHERE m.pending = 1
    ORDER BY m.ingame_name COLLATE NOCASE
`);

function pendingNames() {
    return db.prepare('SELECT ingame_name FROM members WHERE pending = 1 ORDER BY ingame_name COLLATE NOCASE')
        .all().map(r => r.ingame_name);
}

function rosterNames() {
    return db.prepare('SELECT ingame_name FROM members WHERE active = 1 AND pending = 0 ORDER BY ingame_name COLLATE NOCASE')
        .all().map(r => r.ingame_name);
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('review')
        .setDescription('Review members the scanner flagged as new/unrecognized (scan user only)')
        .addSubcommand(s => s
            .setName('list')
            .setDescription('List pending members awaiting review'))
        .addSubcommand(s => s
            .setName('approve')
            .setDescription('Confirm a pending member is a real, correctly-named member')
            .addStringOption(o => o
                .setName('name').setDescription('Pending member name').setRequired(true).setAutocomplete(true)))
        .addSubcommand(s => s
            .setName('merge')
            .setDescription('Merge a pending member into an existing one (duplicate)')
            .addStringOption(o => o
                .setName('pending_name').setDescription('Pending (duplicate) name').setRequired(true).setAutocomplete(true))
            .addStringOption(o => o
                .setName('into_name').setDescription('Existing member to merge into').setRequired(true).setAutocomplete(true))),

    async autocomplete(interaction) {
        const focusedOpt = interaction.options.getFocused(true);
        const focused = focusedOpt.value.toLowerCase();
        const source = focusedOpt.name === 'into_name' ? rosterNames() : pendingNames();
        const filtered = source.filter(n => n.toLowerCase().includes(focused)).slice(0, 25);
        await interaction.respond(filtered.map(n => ({ name: n, value: n })));
    },

    async execute(interaction) {
        if (!(await enforce(interaction, 'scanUser'))) return;
        const sub = interaction.options.getSubcommand();

        if (sub === 'list') {
            const rows = pendingRows.all();
            if (rows.length === 0) {
                return interaction.reply({ content: '✅ No pending members to review.', flags: MessageFlags.Ephemeral });
            }
            const lines = rows.map(r => {
                const wb = r.warband ? ` · ${r.warband}` : '';
                const cp = r.combat_power ? ` · ${r.combat_power}` : '';
                return `· **${r.ingame_name}**${wb}${cp}${r.last_active ? ` · ${r.last_active}` : ''}`;
            });
            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setTitle(`🕵️ ${rows.length} Pending Member${rows.length > 1 ? 's' : ''}`)
                    .setDescription(lines.join('\n'))
                    .setFooter({ text: 'Use /review approve <name> or /review merge <pending> <into>' })
                    .setColor(pickColor())],
                flags: MessageFlags.Ephemeral,
            });
        }

        if (sub === 'approve') {
            const name = interaction.options.getString('name');
            const m = db.prepare('SELECT id FROM members WHERE ingame_name = ? AND pending = 1').get(name);
            if (!m) {
                return interaction.reply({ content: `❌ **${name}** is not a pending member.`, flags: MessageFlags.Ephemeral });
            }
            db.prepare('UPDATE members SET pending = 0 WHERE id = ?').run(m.id);
            return interaction.reply({ content: `✅ Approved **${name}** as a confirmed member.`, flags: MessageFlags.Ephemeral });
        }

        if (sub === 'merge') {
            const pendingName = interaction.options.getString('pending_name');
            const intoName = interaction.options.getString('into_name').trim();
            const drop = db.prepare('SELECT id FROM members WHERE ingame_name = ?').get(pendingName);
            const keep = db.prepare('SELECT id FROM members WHERE ingame_name = ?').get(intoName);
            if (!drop) return interaction.reply({ content: `❌ **${pendingName}** not found.`, flags: MessageFlags.Ephemeral });
            if (!keep) return interaction.reply({ content: `❌ **${intoName}** not found.`, flags: MessageFlags.Ephemeral });
            if (keep.id === drop.id) return interaction.reply({ content: '❌ Pick two different members.', flags: MessageFlags.Ephemeral });
            mergeMembers(keep.id, drop.id);
            return interaction.reply({ content: `✅ Merged **${pendingName}** into **${intoName}** (duplicate removed).`, flags: MessageFlags.Ephemeral });
        }
    },
};
