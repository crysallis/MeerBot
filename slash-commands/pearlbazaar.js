const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require("discord.js");
const { execFile, exec } = require("child_process");
const path = require("path");
const db = require("../utils/db");
const { pickColor } = require("../utils/colors");
const { enforcePermissions } = require("../utils/permissions");
const { buildPearlBazaarRows } = require("../utils/pearlBazaar");

const PYTHON = process.env.SCRAPER_PYTHON || "python";
const SCRAPER = process.env.SCRAPER_SCRIPT;

const ROWS_PER_EMBED = 40;

function nameLookupMap() {
	const rows = db.prepare("SELECT ingame_id, ingame_name FROM members WHERE ingame_id IS NOT NULL AND ingame_id != ''").all();
	return new Map(rows.map(r => [r.ingame_id, r.ingame_name]));
}

function buildResultsEmbeds(rows) {
	if (rows.length === 0) {
		return [
			new EmbedBuilder()
				.setTitle("🦪 Today's Pearl Bazaar Prices")
				.setDescription("No sellers with stock remaining were found this run.")
				.setColor(pickColor()),
		];
	}

	const lines = rows.map(r => `\`#${r.rank}\` **${r.label}** · ${r.price} · ${r.sellingCapRemaining} left`);
	const chunks = [];
	for (let i = 0; i < lines.length; i += ROWS_PER_EMBED) {
		chunks.push(lines.slice(i, i + ROWS_PER_EMBED));
	}

	return chunks.map((chunk, i) => {
		const embed = new EmbedBuilder().setColor(pickColor());
		if (i === 0) {
			embed.setTitle("🦪 Today's Pearl Bazaar Prices");
			embed.setDescription(`SA Position | Name/ID | Price | Left to Sell\n${chunk.join("\n")}`);
		} else {
			embed.setDescription(chunk.join("\n"));
		}
		if (i === chunks.length - 1) {
			embed.setFooter({ text: "Sold-out sellers are excluded · left-to-sell changes minute to minute" });
		}
		return embed;
	});
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName("pearlbazaar")
		.setDescription("Scan today's Pearl Bazaar prices across the top 100 Supreme Arena players"),

	async execute(interaction) {
		if (!(await enforcePermissions(interaction, "pearlbazaar", null))) return;
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

		await interaction.reply("⏳ Pearl Bazaar scan started · this walks all 100 ranks and takes a while · results will post here when done.");

		execFile(PYTHON, [SCRAPER, "--pearl-bazaar"], { cwd: path.dirname(SCRAPER) }, async (error, stdout) => {
			if (error) {
				console.error("Pearl Bazaar scan error:", error);
				const lines = stdout ? stdout.split("\n").filter(Boolean) : [];
				const tail = lines.slice(-15).join("\n");
				const tailBlock = tail ? `\n\nLast output before failure:\n\`\`\`${tail.slice(-1500)}\`\`\`` : "";
				return interaction.channel.send(`❌ Pearl Bazaar scan failed:\n\`\`\`${error.message.slice(0, 500)}\`\`\`${tailBlock}`);
			}

			try {
				const dbRows = db.prepare(
					"SELECT rank, ingame_id, price, selling_cap_remaining FROM pearl_bazaar_prices"
				).all();
				const rows = buildPearlBazaarRows(dbRows, nameLookupMap());

				await interaction.channel.send({ embeds: buildResultsEmbeds(rows) });
			} catch (sendError) {
				console.error("Pearl Bazaar results post failed:", sendError);
			}
		});
	},
};
