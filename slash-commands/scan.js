const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require("discord.js");
const { execFile, exec } = require("child_process");
const db = require("../utils/db");
const { pickColor } = require("../utils/colors");
const { enforce, enforcePermissions } = require("../utils/permissions");
const botConfig = require("../utils/botConfig");

const PYTHON = process.env.SCRAPER_PYTHON || "python";
const SCRAPER = process.env.SCRAPER_SCRIPT;

const MODE_FLAGS = {
	SCAN_DREAM_REALM: "--dream-realm",
	SCAN_AFK_STAGES: "--afk-stages",
	SCAN_ARENA: "--arena",
	SCAN_SUPREME_ARENA: "--supreme-arena",
	SCAN_HONOR_DUEL: "--honor-duel",
	SCAN_ARCANE_LAB: "--arcane-lab",
};

function enabledModeFlags() {
	return Object.entries(MODE_FLAGS)
		.filter(([key]) => botConfig.get(key) === "true")
		.map(([, flag]) => flag);
}

function getLatestSnapshot() {
	return db.prepare("SELECT id FROM snapshots ORDER BY id DESC LIMIT 1").get();
}

async function postInactivityAlert(client) {
	const INACTIVITY_CHANNEL = botConfig.get('INACTIVITY_ALERT_CHANNEL_ID');
	const INACTIVITY_DAYS = Number(botConfig.get('INACTIVITY_DAYS', '3'));
	if (!INACTIVITY_CHANNEL) return;

	const snapshot = getLatestSnapshot();
	if (!snapshot) return;

	const rows = db
		.prepare(
			`
        SELECT ms.name, ms.last_active, m.discord_id
        FROM member_snapshots ms
        LEFT JOIN members m ON m.id = ms.member_id
        LEFT JOIN member_afk afk ON afk.member_id = ms.member_id
        WHERE ms.snapshot_id = ?
          AND m.active = 1
          AND afk.member_id IS NULL
    `,
		)
		.all(snapshot.id);

	const inactive = rows.filter(r => {
		const m = r.last_active && r.last_active.match(/^(\d+)d\s*ago$/i);
		return m && parseInt(m[1], 10) >= INACTIVITY_DAYS;
	}).sort((a, b) => {
		const daysA = parseInt(a.last_active.match(/^(\d+)/)[1], 10);
		const daysB = parseInt(b.last_active.match(/^(\d+)/)[1], 10);
		return daysB - daysA;
	});

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
				.setTitle(`⚠️ ${inactive.length} member${inactive.length === 1 ? "" : "s"} inactive ${INACTIVITY_DAYS}+ days`)
				.setDescription(lines.join("\n"))
				.setColor(pickColor())
				.setFooter({ text: "AF AFK members are excluded · see a guild leader to set an /afk exemption" }),
		],
	});
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName("scan")
		.setDescription("Trigger a guild member scan (requires game open on BlueStacks)"),

	async execute(interaction) {
		if (!(await enforcePermissions(interaction, 'scan', null))) return;
		if (!(await enforce(interaction, "scanUser"))) return;
		if (!SCRAPER) {
			return interaction.reply({
				content: "❌ `SCRAPER_SCRIPT` not set in `.env`.",
				flags: MessageFlags.Ephemeral,
			});
		}

		await new Promise((resolve) => {
			exec("adb devices", (_err, stdout) => {
				if (stdout && stdout.includes("127.0.0.1:5555\tdevice")) return resolve();
				exec("adb connect 127.0.0.1:5555", resolve);
			});
		});

		const modeFlags = enabledModeFlags();
		const modeList = modeFlags.length ? ` + ${modeFlags.length} mode scan(s)` : "";
		await interaction.reply(`⏳ Scan started (guild${modeList}) · results will be posted here when done.`);

		execFile(PYTHON, [SCRAPER, "--guild", ...modeFlags], { cwd: require("path").dirname(SCRAPER) }, async (error, stdout) => {
			if (error) {
				console.error("Scan error:", error);
				return interaction.channel.send(`❌ Scan failed:\n\`\`\`${error.message.slice(0, 500)}\`\`\``);
			}

			const lines = stdout.split("\n");
			const done = lines.find((l) => l.includes("Done."));
			const saved = lines.find((l) => l.includes("Saved to DB as snapshot"));
			const reviewNames = [...new Set(
				lines.filter((l) => l.startsWith("REVIEW_NAMES:"))
					.flatMap((l) => l.replace("REVIEW_NAMES:", "").split(","))
					.map((n) => n.trim())
					.filter(Boolean),
			)].join(", ");
			const modeResults = lines.filter((l) =>
				/^(DREAM_REALM|AFK_STAGES|ARENA|SUPREME_ARENA|HONOR_DUEL|ARCANE_LAB|MODE_FAILED):/.test(l));

			let reply = `✅ Scan complete!\n${done || saved || "Snapshot saved."}`;
			if (modeResults.length) {
				reply += `\n${modeResults.map((l) => `· ${l.trim()}`).join("\n")}`;
			}
			if (reviewNames) {
				reply += `\n\n⚠️ **Name review needed** · these were saved as-is (ambiguous OCR characters, no history match):\n\`${reviewNames}\`\nUse \`/rename\` to correct if any look wrong.`;
			}
			await interaction.channel.send(reply);

			await postInactivityAlert(interaction.client);
		});
	},
};
