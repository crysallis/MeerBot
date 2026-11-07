const { SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits } = require("discord.js");
const db = require("../utils/db");
const { pickColor } = require("../utils/colors");
const { enforcePermissions } = require("../utils/permissions");
const { eventDates, participantsFor, nonParticipantsFor, memberLine } = require("../utils/hornRally");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function fitLines(lines, limit) {
	let out = "";
	for (const line of lines) {
		if (out.length + line.length + 1 > limit) return `${out}\n...`;
		out += (out ? "\n" : "") + line;
	}
	return out;
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName("hornrally")
		.setDescription("Horn Rally attendance")
		.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
		.addSubcommand(s => s
			.setName("list")
			.setDescription("List who did or did not take part in a Horn Rally")
			.addStringOption(o => o.setName("participated").setDescription("Show members who took part, or who did not").setRequired(true)
				.addChoices({ name: "yes", value: "yes" }, { name: "no", value: "no" }))
			.addStringOption(o => o.setName("date").setDescription("Event date, YYYY-MM-DD (empty = latest Horn Rally)").setAutocomplete(true))),

	async autocomplete(interaction) {
		const focused = String(interaction.options.getFocused()).toLowerCase();
		const dates = eventDates(db)
			.filter(d => d.event_date.includes(focused))
			.slice(0, 25);
		await interaction.respond(dates.map(d => ({ name: `${d.event_date} (${d.attended} took part)`, value: d.event_date })));
	},

	async execute(interaction) {
		const sub = interaction.options.getSubcommand();
		if (!(await enforcePermissions(interaction, "hornrally", sub))) return;

		const dates = eventDates(db);
		if (dates.length === 0) {
			return interaction.reply({ content: "No Horn Rally has been scanned yet.", flags: MessageFlags.Ephemeral });
		}
		const raw = (interaction.options.getString("date") || "").trim();
		const eventDate = raw || dates[0].event_date;
		if (!DATE_RE.test(eventDate) || !dates.some(d => d.event_date === eventDate)) {
			return interaction.reply({
				content: `No Horn Rally data for **${eventDate}**. Recorded dates: ${dates.slice(0, 5).map(d => d.event_date).join(", ")}.`,
				flags: MessageFlags.Ephemeral,
			});
		}

		const took = interaction.options.getString("participated") === "yes";
		const rows = took ? participantsFor(db, eventDate) : nonParticipantsFor(db, eventDate);
		const afkCount = rows.filter(r => r.afk).length;
		const head = took ? "Took part" : "Did not take part";
		const footer = took
			? `${rows.length} of ${dates.find(d => d.event_date === eventDate).attended} recorded`
			: `Active members not on the list${afkCount ? ` · ${afkCount} AFK` : ""}`;
		return interaction.reply({
			embeds: [new EmbedBuilder()
				.setTitle(`🎺 Horn Rally ${eventDate} · ${head} (${rows.length})`)
				.setDescription(rows.length ? fitLines(rows.map(memberLine), 4000) : "Nobody.")
				.setFooter({ text: footer })
				.setColor(pickColor())],
			flags: MessageFlags.Ephemeral,
		});
	},
};
