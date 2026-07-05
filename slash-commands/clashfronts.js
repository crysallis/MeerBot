const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require("discord.js");
const db = require("../utils/db");
const botConfig = require("../utils/botConfig");
const { pickColor } = require("../utils/colors");
const { enforcePermissions } = require("../utils/permissions");

function signedUpRows() {
	return db.prepare(`
		SELECT m.ingame_name, m.discord_id, cs.selected
		FROM clashfronts_signups cs
		JOIN members m ON m.id = cs.member_id
		ORDER BY cs.selected DESC, m.ingame_name COLLATE NOCASE
	`).all();
}

function notSignedUpRows() {
	return db.prepare(`
		SELECT m.ingame_name, m.discord_id
		FROM members m
		LEFT JOIN clashfronts_signups cs ON cs.member_id = m.id
		LEFT JOIN member_afk afk ON afk.member_id = m.id
		WHERE m.active = 1 AND cs.member_id IS NULL AND afk.member_id IS NULL
		ORDER BY m.ingame_name COLLATE NOCASE
	`).all();
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName("clashfronts")
		.setDescription("Clashfronts sign-up tracking")
		.addSubcommand(s => s
			.setName("signedup")
			.setDescription("List members who signed up for Clashfronts"))
		.addSubcommand(s => s
			.setName("notsigned")
			.setDescription("List active members who have NOT signed up"))
		.addSubcommand(s => s
			.setName("remind")
			.setDescription("Post a reminder pinging everyone not yet signed up")),

	async execute(interaction) {
		const sub = interaction.options.getSubcommand();
		if (!(await enforcePermissions(interaction, "clashfronts", sub))) return;

		if (sub === "signedup") {
			const rows = signedUpRows();
			if (rows.length === 0) {
				return interaction.reply({ content: "No one has signed up for Clashfronts yet.", flags: MessageFlags.Ephemeral });
			}
			const lines = rows.map(r => `· ${r.selected ? "✅" : "🚫"} ${r.ingame_name}`);
			return interaction.reply({
				embeds: [new EmbedBuilder()
					.setTitle(`Clashfronts Sign-Ups (${rows.length})`)
					.setDescription(lines.join("\n").slice(0, 4000))
					.setFooter({ text: "✅ selected · 🚫 signed up, not yet selected" })
					.setColor(pickColor())],
				flags: MessageFlags.Ephemeral,
			});
		}

		if (sub === "notsigned") {
			const rows = notSignedUpRows();
			if (rows.length === 0) {
				return interaction.reply({ content: "✅ Every active member has signed up.", flags: MessageFlags.Ephemeral });
			}
			const lines = rows.map(r => `· ${r.ingame_name}`);
			return interaction.reply({
				embeds: [new EmbedBuilder()
					.setTitle(`Not Signed Up (${rows.length})`)
					.setDescription(lines.join("\n").slice(0, 4000))
					.setColor(pickColor())],
				flags: MessageFlags.Ephemeral,
			});
		}

		if (sub === "remind") {
			const channelId = botConfig.get("CLASHFRONTS_REMINDER_CHANNEL_ID");
			if (!channelId) {
				return interaction.reply({ content: "❌ `CLASHFRONTS_REMINDER_CHANNEL_ID` not set. Configure it in the admin panel first.", flags: MessageFlags.Ephemeral });
			}
			const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
			if (!channel?.isTextBased()) {
				return interaction.reply({ content: "❌ Reminder channel not found or not text-based.", flags: MessageFlags.Ephemeral });
			}

			const rows = notSignedUpRows();
			if (rows.length === 0) {
				return interaction.reply({ content: "✅ Every active member has signed up, nothing to remind.", flags: MessageFlags.Ephemeral });
			}

			const linked = rows.filter(r => r.discord_id);
			const unlinked = rows.filter(r => !r.discord_id);

			// Discord caps message content at 2000 chars and allowedMentions.users
			// at 100 IDs per message -- chunk pings into batches of 50 to stay
			// well under both limits (mentions are short but bold names/embeds
			// elsewhere in this command run long, so leave headroom).
			const CHUNK = 50;
			for (let i = 0; i < linked.length; i += CHUNK) {
				const batch = linked.slice(i, i + CHUNK);
				const header = i === 0 ? "⚔️ **Clashfronts sign-ups are still open!** The following members haven't signed up yet:\n" : "";
				await channel.send({
					content: `${header}${batch.map(r => `· <@${r.discord_id}>`).join("\n")}`,
					allowedMentions: { users: batch.map(r => r.discord_id) },
				});
			}
			if (linked.length === 0) {
				await channel.send("⚔️ **Clashfronts sign-ups are still open!** (remaining members aren't linked to Discord, see below)");
			}

			if (unlinked.length) {
				const unlinkedLines = unlinked.map(r => `· **${r.ingame_name}** (not linked)`);
				await channel.send({
					embeds: [new EmbedBuilder()
						.setTitle("Not linked to Discord (can't be pinged)")
						.setDescription(unlinkedLines.join("\n").slice(0, 4000))
						.setColor(pickColor())],
				});
			}

			return interaction.reply({ content: `✅ Reminder posted in <#${channelId}> (${linked.length} pinged, ${unlinked.length} unlinked).`, flags: MessageFlags.Ephemeral });
		}
	},
};
