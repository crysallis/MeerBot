const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../utils/db');

const upsertCorrection = db.prepare(`
    INSERT OR REPLACE INTO name_corrections (ocr_name, correct_name, source)
    VALUES (?, ?, 'player')
`);

function linkMember(discordId, discordName, ingameName) {
    const now = new Date().toISOString();
    const existing = db.prepare('SELECT id FROM members WHERE ingame_name = ?').get(ingameName);
    if (existing) {
        db.prepare(`
            UPDATE members SET discord_id = ?, discord_name = ? WHERE id = ?
        `).run(discordId, discordName, existing.id);
    } else {
        db.prepare(`
            INSERT INTO members (ingame_name, discord_id, discord_name, first_seen)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(discord_id) DO UPDATE SET
                ingame_name  = excluded.ingame_name,
                discord_name = excluded.discord_name
        `).run(ingameName, discordId, discordName, now);
    }
    upsertCorrection.run(ingameName.toLowerCase(), ingameName);
}

function getLatestIngameNames() {
    return db.prepare(`
        SELECT DISTINCT name FROM member_snapshots
        WHERE snapshot_id = (SELECT MAX(id) FROM snapshots)
    `).all().map(r => r.name);
}

async function autocomplete(interaction) {
    const focused = interaction.options.getFocused().toLowerCase();
    const names = getLatestIngameNames();
    const filtered = names
        .filter(n => n.toLowerCase().includes(focused))
        .slice(0, 25);
    await interaction.respond(filtered.map(n => ({ name: n, value: n })));
}

module.exports = {
    autocomplete,
    data: new SlashCommandBuilder()
        .setName('link')
        .setDescription('Link your Discord account to your in-game name')
        .addStringOption(opt =>
            opt.setName('ingame_name')
                .setDescription('Your exact in-game name')
                .setRequired(true)
                .setAutocomplete(true)
        )
        .addUserOption(opt =>
            opt.setName('user')
                .setDescription('(Admin) Link a different member')
                .setRequired(false)
        ),

    async execute(interaction) {
        try {
            const ingameName = interaction.options.getString('ingame_name').trim();
            const targetUser = interaction.options.getUser('user');

            // Only admins can link other users
            if (targetUser && targetUser.id !== interaction.user.id) {
                const member = await interaction.guild.members.fetch(interaction.user.id);
                if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
                    return interaction.reply({
                        content: 'You need **Manage Server** permission to link other members.',
                        ephemeral: true
                    });
                }
            }

            const linkTarget = targetUser ?? interaction.user;

            // Warn if name not found in latest snapshot (but still allow)
            const knownNames = getLatestIngameNames();
            const found = knownNames.some(n => n.toLowerCase() === ingameName.toLowerCase());
            if (!found) {
                await interaction.reply({
                    content: `⚠️ **${ingameName}** wasn't found in the latest guild snapshot — double-check the spelling. Linked anyway.`,
                    ephemeral: true
                });
            }

            linkMember(linkTarget.id, linkTarget.username, ingameName);

            const who = targetUser ? `<@${linkTarget.id}>` : 'You';
            const msg = found
                ? `✅ ${who} linked to in-game name **${ingameName}**.`
                : `⚠️ ${who} linked to **${ingameName}** (not in latest snapshot — verify spelling).`;

            if (interaction.replied) {
                await interaction.followUp({ content: msg, ephemeral: true });
            } else {
                await interaction.reply({ content: msg, ephemeral: true });
            }
        } catch (err) {
            console.error('Link command error:', err);
            const msg = 'Failed to link account.';
            if (!interaction.replied) await interaction.reply({ content: msg, ephemeral: true });
            else await interaction.editReply(msg);
        }
    }
};
