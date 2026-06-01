const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const db = require('../utils/db');
const { pickColor } = require('../utils/colors');

const PRIORITY_ORDER = { high: 1, medium: 2, low: 3 };
const PRIORITY_EMOJI = { high: '🔴', medium: '🟡', low: '🟢' };

module.exports = {
    data: new SlashCommandBuilder()
        .setName('wishlist')
        .setDescription('Guild feature wishlist')
        .addSubcommand(s => s
            .setName('add')
            .setDescription('Submit a wishlist item')
            .addStringOption(o => o.setName('item').setDescription('What you want').setRequired(true).setMaxLength(200))
            .addStringOption(o => o
                .setName('priority')
                .setDescription('How important is this?')
                .setRequired(true)
                .addChoices(
                    { name: '🔴 High', value: 'high' },
                    { name: '🟡 Medium', value: 'medium' },
                    { name: '🟢 Low', value: 'low' },
                )
            )
        )
        .addSubcommand(s => s
            .setName('list')
            .setDescription('View all wishlist items')
        )
        .addSubcommand(s => s
            .setName('remove')
            .setDescription('Remove a wishlist item by ID')
            .addIntegerOption(o => o.setName('id').setDescription('Item ID (shown in /wishlist list)').setRequired(true))
        ),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        if (sub === 'add') {
            const item = interaction.options.getString('item').trim();
            const priority = interaction.options.getString('priority');
            db.prepare(
                'INSERT INTO wishlist (item, priority, submitted_by, submitted_at) VALUES (?, ?, ?, ?)'
            ).run(item, priority, interaction.user.id, new Date().toISOString());
            return interaction.reply({
                content: `${PRIORITY_EMOJI[priority]} Wishlist item added!`,
                flags: MessageFlags.Ephemeral,
            });
        }

        if (sub === 'list') {
            const rows = db.prepare(`
                SELECT id, item, priority, submitted_by, submitted_at
                FROM wishlist
                ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, submitted_at ASC
            `).all();

            if (rows.length === 0) {
                return interaction.reply({ content: 'The wishlist is empty.', flags: MessageFlags.Ephemeral });
            }

            const fields = rows.map(r => ({
                name: `#${r.id} · ${PRIORITY_EMOJI[r.priority]} ${r.priority.charAt(0).toUpperCase() + r.priority.slice(1)}`,
                value: `${r.item}\n*Submitted by <@${r.submitted_by}> on ${r.submitted_at.slice(0, 10)}*`,
                inline: false,
            }));

            return interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('✨ Guild Wishlist')
                        .addFields(fields)
                        .setColor(pickColor()),
                ],
            });
        }

        if (sub === 'remove') {
            const id = interaction.options.getInteger('id');
            const row = db.prepare('SELECT id, item FROM wishlist WHERE id = ?').get(id);
            if (!row) {
                return interaction.reply({ content: `Item #${id} not found.`, flags: MessageFlags.Ephemeral });
            }
            db.prepare('DELETE FROM wishlist WHERE id = ?').run(id);
            return interaction.reply({
                content: `🗑️ Removed wishlist item #${id}: *${row.item}*`,
                flags: MessageFlags.Ephemeral,
            });
        }
    },
};
