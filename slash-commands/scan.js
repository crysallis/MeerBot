const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require("discord.js");
const { execFile, exec } = require("child_process");
const db = require("../utils/db");
const { enforce } = require("../utils/permissions");

const PYTHON = process.env.SCRAPER_PYTHON || "python";
const SCRAPER = process.env.SCRAPER_SCRIPT;
const INACTIVITY_CHANNEL = process.env.INACTIVITY_ALERT_CHANNEL_ID;
const INACTIVITY_DAYS = 3;

function getLatestSnapshot() {
	return db.prepare("SELECT id FROM snapshots ORDER BY id DESC LIMIT 1").get();
}

async function postInactivityAlert(client) {
	if (!INACTIVITY_CHANNEL) return;

	const snapshot = getLatestSnapshot();
	if (!snapshot) return;

	const cutoff = new Date();
	cutoff.setUTCDate(cutoff.getUTCDate() - INACTIVITY_DAYS);
	const cutoffStr = cutoff.toISOString().slice(0, 19);

	const inactive = db
		.prepare(
			`
        SELECT ms.name, ms.last_active, ms.last_seen_approx, m.discord_id
        FROM member_snapshots ms
        LEFT JOIN members m ON m.id = ms.member_id
        LEFT JOIN member_afk afk ON afk.member_id = ms.member_id
        WHERE ms.snapshot_id = ?
          AND afk.member_id IS NULL
          AND ms.last_seen_approx < ?
        ORDER BY ms.last_seen_approx ASC
    `,
		)
		.all(snapshot.id, cutoffStr);

	if (inactive.length === 0) return;

	const lines = inactive.map((r) => {
		const who = r.discord_id ? `<@${r.discord_id}>` : `**${r.name}**`;
		return `· ${who} · last active ${r.last_active}`;
	});

	const channel = await client.channels.fetch(INACTIVITY_CHANNEL).catch(() => null);
	if (!channel) return;

	await channel.send({
		embeds: [
			new EmbedBuilder()
				.setTitle(`⚠️ ${inactive.length} member${inactive.length === 1 ? "" : "s"} inactive 3+ days`)
				.setDescription(lines.join("\n"))
				.setColor(0xe74c3c)
				.setFooter({ text: "AF AFK members are excluded · speak to a Riff or Raff /afk set to exempt someone" }),
		],
	});
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName("scan")
		.setDescription("Trigger a guild member scan (requires game open on BlueStacks)"),

	async execute(interaction) {
		if (!(await enforce(interaction, "scanUser"))) return;
		if (!SCRAPER) {
			return interaction.reply({
				content: "❌ `SCRAPER_SCRIPT` not set in `.env`.",
				flags: MessageFlags.Ephemeral,
			});
		}

		await interaction.deferReply();

		await new Promise((resolve) => {
			exec("adb devices", (_err, stdout) => {
				if (stdout && stdout.includes("127.0.0.1:5555\tdevice")) return resolve();
				exec("adb connect 127.0.0.1:5555", resolve);
			});
		});

		execFile(PYTHON, [SCRAPER], { cwd: require("path").dirname(SCRAPER) }, async (error, stdout) => {
			if (error) {
				console.error("Scan error:", error);
				return interaction.editReply(`❌ Scan failed:\n\`\`\`${error.message.slice(0, 500)}\`\`\``);
			}

			const lines = stdout.split("\n");
			const done = lines.find((l) => l.includes("Done."));
			const saved = lines.find((l) => l.includes("Saved to DB as snapshot"));
			const reviewLine = lines.find((l) => l.startsWith("REVIEW_NAMES:"));
			const reviewNames = reviewLine ? reviewLine.replace("REVIEW_NAMES:", "").trim() : null;

			let reply = `✅ Scan complete!\n${done || saved || "Snapshot saved."}`;
			if (reviewNames) {
				reply += `\n\n⚠️ **Name review needed** · these were saved as-is (ambiguous OCR characters, no history match):\n\`${reviewNames}\`\nUse \`/rename\` to correct if any look wrong.`;
			}
			await interaction.editReply(reply);

			await postInactivityAlert(interaction.client);
		});
	},
};
