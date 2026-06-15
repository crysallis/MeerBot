const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const db = require('../utils/db');
const { pickColor } = require('../utils/colors');
const { enforcePermissions } = require('../utils/permissions');

function allSeasonNames() {
    return db.prepare('SELECT name FROM ally_seasons ORDER BY id DESC').all().map(r => r.name);
}

function activeSeasonNames() {
    return db.prepare('SELECT name FROM ally_seasons WHERE active = 1 ORDER BY id DESC').all().map(r => r.name);
}

function getSeasonByName(name) {
    return db.prepare('SELECT * FROM ally_seasons WHERE name = ?').get(name);
}

module.exports = {
    async autocomplete(interaction) {
        const sub = interaction.options.getSubcommand();
        const focused = interaction.options.getFocused().toLowerCase();
        const source = sub === 'inactivate' ? activeSeasonNames() : allSeasonNames();
        const filtered = source.filter(n => n.toLowerCase().includes(focused)).slice(0, 25);
        await interaction.respond(filtered.map(n => ({ name: n, value: n })));
    },

    data: new SlashCommandBuilder()
        .setName('season')
        .setDescription('Manage ally seasons and their server lists')
        .addSubcommand(s => s
            .setName('add')
            .setDescription('Create a new season (inactive by default)')
            .addStringOption(o => o.setName('name').setDescription('Season name (e.g. S7)').setRequired(true).setMaxLength(50))
        )
        .addSubcommand(s => s
            .setName('activate')
            .setDescription('Mark a season as active')
            .addStringOption(o => o.setName('season').setDescription('Season name').setRequired(true).setAutocomplete(true))
        )
        .addSubcommand(s => s
            .setName('inactivate')
            .setDescription('Mark a season as inactive')
            .addStringOption(o => o.setName('season').setDescription('Season name').setRequired(true).setAutocomplete(true))
        )
        .addSubcommand(s => s
            .setName('allyadd')
            .setDescription('Add an ally server number to a season')
            .addStringOption(o => o.setName('season').setDescription('Season name').setRequired(true).setAutocomplete(true))
            .addIntegerOption(o => o.setName('server').setDescription('Server number').setRequired(true).setMinValue(1))
        )
        .addSubcommand(s => s
            .setName('allyremove')
            .setDescription('Remove an ally server number from a season')
            .addStringOption(o => o.setName('season').setDescription('Season name').setRequired(true).setAutocomplete(true))
            .addIntegerOption(o => o.setName('server').setDescription('Server number').setRequired(true).setMinValue(1))
        )
        .addSubcommand(s => s
            .setName('allylist')
            .setDescription('List ally servers for a season (defaults to active)')
            .addStringOption(o => o.setName('season').setDescription('Season name (omit for active season)').setRequired(false).setAutocomplete(true))
        ),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        if (!(await enforcePermissions(interaction, 'season', sub))) return;

        if (sub === 'add') {
            const name = interaction.options.getString('name').trim();
            try {
                db.prepare('INSERT INTO ally_seasons (name, active) VALUES (?, 0)').run(name);
                return interaction.reply({ content: `📅 Season **${name}** created (inactive). Use \`/season allyadd\` to add servers, then \`/season activate\` when ready.`, flags: MessageFlags.Ephemeral });
            } catch {
                return interaction.reply({ content: `Season **${name}** already exists.`, flags: MessageFlags.Ephemeral });
            }
        }

        if (sub === 'activate') {
            const name = interaction.options.getString('season');
            const season = getSeasonByName(name);
            if (!season) return interaction.reply({ content: `Season **${name}** not found.`, flags: MessageFlags.Ephemeral });
            db.prepare('UPDATE ally_seasons SET active = 1 WHERE id = ?').run(season.id);
            return interaction.reply({ content: `✅ Season **${name}** is now active.`, flags: MessageFlags.Ephemeral });
        }

        if (sub === 'inactivate') {
            const name = interaction.options.getString('season');
            const season = getSeasonByName(name);
            if (!season) return interaction.reply({ content: `Season **${name}** not found.`, flags: MessageFlags.Ephemeral });
            db.prepare('UPDATE ally_seasons SET active = 0 WHERE id = ?').run(season.id);
            return interaction.reply({ content: `🔒 Season **${name}** is now inactive.`, flags: MessageFlags.Ephemeral });
        }

        if (sub === 'allyadd') {
            const name = interaction.options.getString('season');
            const serverNum = interaction.options.getInteger('server');
            const season = getSeasonByName(name);
            if (!season) return interaction.reply({ content: `Season **${name}** not found.`, flags: MessageFlags.Ephemeral });
            try {
                db.prepare('INSERT INTO ally_servers (server_number, season_id) VALUES (?, ?)').run(serverNum, season.id);
                return interaction.reply({ content: `✅ Server **${serverNum}** added to **${name}**.`, flags: MessageFlags.Ephemeral });
            } catch {
                return interaction.reply({ content: `Server **${serverNum}** is already in **${name}**.`, flags: MessageFlags.Ephemeral });
            }
        }

        if (sub === 'allyremove') {
            const name = interaction.options.getString('season');
            const serverNum = interaction.options.getInteger('server');
            const season = getSeasonByName(name);
            if (!season) return interaction.reply({ content: `Season **${name}** not found.`, flags: MessageFlags.Ephemeral });
            const result = db.prepare('DELETE FROM ally_servers WHERE server_number = ? AND season_id = ?').run(serverNum, season.id);
            if (result.changes === 0) return interaction.reply({ content: `Server **${serverNum}** not found in **${name}**.`, flags: MessageFlags.Ephemeral });
            return interaction.reply({ content: `🗑️ Server **${serverNum}** removed from **${name}**.`, flags: MessageFlags.Ephemeral });
        }

        if (sub === 'allylist') {
            const nameOpt = interaction.options.getString('season');
            let season;
            if (nameOpt) {
                season = getSeasonByName(nameOpt);
                if (!season) return interaction.reply({ content: `Season **${nameOpt}** not found.`, flags: MessageFlags.Ephemeral });
            } else {
                season = db.prepare('SELECT * FROM ally_seasons WHERE active = 1 ORDER BY id DESC LIMIT 1').get();
                if (!season) return interaction.reply({ content: 'No active season. Create one with `/season add` and `/season activate`.', flags: MessageFlags.Ephemeral });
            }

            const servers = db.prepare('SELECT server_number FROM ally_servers WHERE season_id = ? ORDER BY server_number ASC').all(season.id);
            const statusTag = season.active ? '(active)' : '(inactive)';

            if (servers.length === 0) {
                return interaction.reply({ content: `Season **${season.name}** ${statusTag} has no ally servers yet.`, flags: MessageFlags.Ephemeral });
            }

            const nums = servers.map(r => r.server_number).join(', ');
            return interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle(`🌐 Ally Servers · ${season.name} ${statusTag}`)
                        .setDescription(nums)
                        .setFooter({ text: `${servers.length} server${servers.length !== 1 ? 's' : ''}` })
                        .setColor(pickColor()),
                ],
                flags: MessageFlags.Ephemeral,
            });
        }
    },
};
