const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require("discord.js");
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const db = require("../utils/db");
const { pickColor } = require("../utils/colors");
const { enforcePermissions } = require("../utils/permissions");
const botConfig = require("../utils/botConfig");

const PYTHON = process.env.SCRAPER_PYTHON || "python";
const SCRAPER = process.env.SCRAPER_SCRIPT;

function getReviewerDiscordId() {
	const row = db.prepare("SELECT discord_id FROM members WHERE id = 6").get();
	return row?.discord_id ?? null;
}

async function downloadAttachment(url, destPath) {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Attachment download failed: ${res.status}`);
	const buf = Buffer.from(await res.arrayBuffer());
	fs.writeFileSync(destPath, buf);
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName("sa-manual")
		.setDescription("Submit a Supreme Arena screenshot for a member outside our server filter")
		.addAttachmentOption(o => o
			.setName("image")
			.setDescription("Screenshot of the Supreme Arena guild-member ranking list")
			.setRequired(true)),

	async execute(interaction) {
		if (!(await enforcePermissions(interaction, "sa-manual", null))) return;

		if (!SCRAPER) {
			return interaction.reply({
				content: "❌ `SCRAPER_SCRIPT` not set in `.env`.",
				flags: MessageFlags.Ephemeral,
			});
		}

		const attachment = interaction.options.getAttachment("image");
		if (!attachment?.contentType?.startsWith("image/")) {
			return interaction.reply({
				content: "❌ Please attach an image file.",
				flags: MessageFlags.Ephemeral,
			});
		}

		await interaction.reply({ content: "⏳ Processing image...", flags: MessageFlags.Ephemeral });

		const ext = path.extname(attachment.name || "") || ".png";
		const tmpPath = path.join(os.tmpdir(), `sa-manual-${interaction.id}${ext}`);

		try {
			await downloadAttachment(attachment.url, tmpPath);
		} catch (err) {
			console.error("sa-manual download error:", err);
			return interaction.editReply("❌ Couldn't download that image. Try again.");
		}

		const srcDir = path.dirname(SCRAPER);
		execFile(
			PYTHON,
			["-m", "modes.manual_scan", tmpPath],
			{ cwd: srcDir },
			async (error, stdout, stderr) => {
				fs.unlink(tmpPath, () => {});

				if (error) {
					console.error("sa-manual scan error:", error, stderr);
					return interaction.editReply(`❌ Scan failed:\n\`\`\`${(stderr || error.message).slice(0, 500)}\`\`\``);
				}

				const lines = stdout.split("\n");
				const saved = lines
					.filter(l => l.startsWith("MANUAL_OK:"))
					.map(l => l.replace("MANUAL_OK:", "").trim());
				const review = lines
					.filter(l => l.startsWith("MANUAL_REVIEW:"))
					.map(l => l.replace("MANUAL_REVIEW:", "").trim());

				if (saved.length === 0 && review.length === 0) {
					return interaction.editReply("⚠️ No Supreme Arena rows could be read from that image. Make sure it's a screenshot of the guild-filtered ranking list.");
				}

				let reply = saved.length
					? `✅ Found and saved ${saved.length} member${saved.length === 1 ? "" : "s"}:\n${saved.map(s => `· ${s}`).join("\n")}`
					: "⚠️ No members could be matched to the roster.";
				if (review.length) {
					reply += `\n\n🕵️ ${review.length} name${review.length === 1 ? "" : "s"} need${review.length === 1 ? "s" : ""} review (not saved): \`${review.join(", ")}\``;
				}
				await interaction.editReply(reply);

				if (review.length) {
					const logChannelId = botConfig.get("COMMAND_LOG_CHANNEL_ID");
					const reviewerId = getReviewerDiscordId();
					const channel = logChannelId
						? await interaction.client.channels.fetch(logChannelId).catch(() => null)
						: null;
					if (channel?.isTextBased()) {
						const mention = reviewerId ? `<@${reviewerId}> ` : "";
						await channel.send({
							content: `${mention}⚠️ \`/sa-manual\` needs review · submitted by ${interaction.user.tag}`,
							embeds: [new EmbedBuilder()
								.setTitle("Unmatched names from manual Supreme Arena scan")
								.setDescription(review.map(n => `· \`${n}\``).join("\n"))
								.setColor(pickColor())],
							files: [attachment.url],
						});
					}
				}
			},
		);
	},
};
