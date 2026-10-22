const { SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits } = require("discord.js");
const db = require("../utils/db");
const { pickColor } = require("../utils/colors");
const { enforcePermissions } = require("../utils/permissions");
const { guildDuelPeriodKey } = require("../utils/guildDuel");

function missingRows(period) {
	return db.prepare(`
		SELECT m.ingame_name FROM members m
		WHERE m.active = 1 AND m.pending = 0
		  AND NOT EXISTS (SELECT 1 FROM guild_duel_rankings g
		                  WHERE g.member_id = m.id AND g.period_start = ?)
		ORDER BY m.ingame_name COLLATE NOCASE
	`).all(period);
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName("guildduel")
		.setDescription("Guild Duel Battle Report data")
		.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
		.addSubcommand(s => s
			.setName("missing")
			.setDescription("Active members the last Guild Duel scan didn't capture"))
		.addSubcommand(s => s
			.setName("add")
			.setDescription("Add or correct one member's Guild Duel row by hand")
			.addStringOption(o => o.setName("name").setDescription("In-game name").setRequired(true).setAutocomplete(true))
			.addIntegerOption(o => o.setName("rank").setDescription("Rank on the Battle Report").setRequired(true).setMinValue(1))
			.addIntegerOption(o => o.setName("crests").setDescription("Crest total").setRequired(true).setMinValue(0))),

	async autocomplete(interaction) {
		const focused = interaction.options.getFocused().toLowerCase();
		const names = db.prepare(
			"SELECT ingame_name FROM members WHERE active = 1 AND pending = 0 ORDER BY ingame_name COLLATE NOCASE"
		).all().map(r => r.ingame_name);
		const filtered = names.filter(n => n.toLowerCase().includes(focused)).slice(0, 25);
		await interaction.respond(filtered.map(n => ({ name: n, value: n })));
	},

	async execute(interaction) {
		const sub = interaction.options.getSubcommand();
		if (!(await enforcePermissions(interaction, "guildduel", sub))) return;
		const period = guildDuelPeriodKey();

		if (sub === "missing") {
			const rows = missingRows(period);
			if (rows.length === 0) {
				return interaction.reply({ content: `✅ Every active member has a Guild Duel row for ${period}.`, flags: MessageFlags.Ephemeral });
			}
			return interaction.reply({
				embeds: [new EmbedBuilder()
					.setTitle(`Missing from Guild Duel (${rows.length})`)
					.setDescription(rows.map(r => `· ${r.ingame_name}`).join("\n").slice(0, 4000))
					.setFooter({ text: `Period ${period} · fix with /guildduel add` })
					.setColor(pickColor())],
				flags: MessageFlags.Ephemeral,
			});
		}

		if (sub === "add") {
			const name = interaction.options.getString("name").trim();
			const rank = interaction.options.getInteger("rank");
			const crests = interaction.options.getInteger("crests");
			const member = db.prepare(
				"SELECT id, ingame_name FROM members WHERE pending = 0 AND ingame_name = ? COLLATE NOCASE"
			).get(name);
			if (!member) {
				return interaction.reply({ content: `❌ No member named **${name}**. Pick from the autocomplete list.`, flags: MessageFlags.Ephemeral });
			}
			db.prepare(`
				INSERT OR REPLACE INTO guild_duel_rankings (member_id, period_start, rank, crests, scanned_at)
				VALUES (?, ?, ?, ?, ?)
			`).run(member.id, period, rank, crests, new Date().toISOString());
			return interaction.reply({
				content: `✅ Saved **${member.ingame_name}**: rank #${rank}, ${crests} crests (period ${period}).`,
				flags: MessageFlags.Ephemeral,
			});
		}
	},
};
