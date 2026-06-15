const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const db = require('../utils/db');
const { pickColor } = require('../utils/colors');
const { enforcePermissions } = require('../utils/permissions');

const MIN_MS = 60 * 60 * 1000;             // 1 hour
const MAX_MS = 90 * 24 * 60 * 60 * 1000;  // 90 days

function parseDuration(str) {
    const match = str.trim().match(/^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/);
    if (!match || (!match[1] && !match[2] && !match[3])) return null;
    const d = parseInt(match[1] || 0);
    const h = parseInt(match[2] || 0);
    const m = parseInt(match[3] || 0);
    return (d * 24 * 60 + h * 60 + m) * 60_000;
}

function fmtDuration(ms) {
    const totalMin = Math.round(ms / 60_000);
    const d = Math.floor(totalMin / (24 * 60));
    const h = Math.floor((totalMin % (24 * 60)) / 60);
    const m = totalMin % 60;
    const parts = [];
    if (d) parts.push(`${d} day${d === 1 ? '' : 's'}`);
    if (h) parts.push(`${h} hour${h === 1 ? '' : 's'}`);
    if (m) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
    return parts.join(' ');
}

function sanitizeMessage(str) {
    return str
        .replace(/@everyone/gi, '@​everyone')
        .replace(/@here/gi, '@​here')
        .trim();
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('remindme')
        .setDescription('Set, view, or cancel personal reminders')
        .addSubcommand(s => s
            .setName('set')
            .setDescription('Set a reminder')
            .addStringOption(o => o
                .setName('time')
                .setDescription('Duration: e.g. 2h, 1d12h, 45m (min 1h · max 90d)')
                .setRequired(true)
            )
            .addStringOption(o => o
                .setName('message')
                .setDescription('What to remind you about')
                .setRequired(true)
            )
        )
        .addSubcommand(s => s
            .setName('list')
            .setDescription('List your pending reminders')
        )
        .addSubcommand(s => s
            .setName('cancel')
            .setDescription('Cancel a pending reminder')
            .addIntegerOption(o => o
                .setName('id')
                .setDescription('Reminder ID (from /remindme list)')
                .setRequired(true)
            )
        ),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        if (!(await enforcePermissions(interaction, 'remindme', sub))) return;

        if (sub === 'set') {
            const timeStr  = interaction.options.getString('time');
            const rawMsg   = interaction.options.getString('message');

            const ms = parseDuration(timeStr);
            if (ms === null) {
                return interaction.reply({ content: '❌ Could not parse that duration. Use formats like `2h`, `1d12h`, `45m`.', flags: MessageFlags.Ephemeral });
            }
            if (ms < MIN_MS) {
                return interaction.reply({ content: '❌ Minimum reminder time is **1 hour**.', flags: MessageFlags.Ephemeral });
            }
            if (ms > MAX_MS) {
                return interaction.reply({ content: '❌ Maximum reminder time is **90 days**.', flags: MessageFlags.Ephemeral });
            }

            const message = sanitizeMessage(rawMsg);
            if (!message) {
                return interaction.reply({ content: '❌ Message cannot be empty.', flags: MessageFlags.Ephemeral });
            }
            if (message.length > 1024) {
                return interaction.reply({ content: `❌ Message too long (${message.length}/1024 chars).`, flags: MessageFlags.Ephemeral });
            }

            const fireAt = new Date(Date.now() + ms).toISOString();
            const now    = new Date().toISOString();

            const result = db.prepare(
                'INSERT INTO scheduled_jobs (type, fire_at, recurrence, created_at) VALUES (?, ?, ?, ?)'
            ).run('remindme', fireAt, null, now);

            db.prepare(
                'INSERT INTO remindme_jobs (job_id, user_id, channel_id, guild_id, message) VALUES (?, ?, ?, ?, ?)'
            ).run(result.lastInsertRowid, interaction.user.id, interaction.channelId, interaction.guildId, message);

            return interaction.reply({
                content: `⏰ Got it! I'll remind you in **${fmtDuration(ms)}**.`,
                flags: MessageFlags.Ephemeral,
            });
        }

        if (sub === 'list') {
            const rows = db.prepare(`
                SELECT sj.id, sj.fire_at, rj.message
                FROM scheduled_jobs sj
                JOIN remindme_jobs rj ON rj.job_id = sj.id
                WHERE rj.user_id = ? AND sj.type = 'remindme'
                ORDER BY sj.fire_at
            `).all(interaction.user.id);

            if (!rows.length) {
                return interaction.reply({ content: 'You have no pending reminders.', flags: MessageFlags.Ephemeral });
            }

            const now = Date.now();
            const lines = rows.map(r => {
                const remaining = fmtDuration(new Date(r.fire_at) - now);
                return `**#${r.id}** · in ${remaining} · ${r.message}`;
            });

            return interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('⏰ Your Reminders')
                        .setDescription(lines.join('\n'))
                        .setColor(pickColor()),
                ],
                flags: MessageFlags.Ephemeral,
            });
        }

        if (sub === 'cancel') {
            const id = interaction.options.getInteger('id');

            const owns = db.prepare(
                'SELECT 1 FROM scheduled_jobs sj JOIN remindme_jobs rj ON rj.job_id = sj.id WHERE sj.id = ? AND rj.user_id = ?'
            ).get(id, interaction.user.id);

            if (!owns) {
                return interaction.reply({ content: `❌ No reminder #${id} found (or it's not yours).`, flags: MessageFlags.Ephemeral });
            }

            db.prepare('DELETE FROM scheduled_jobs WHERE id = ?').run(id);
            return interaction.reply({ content: `🗑️ Reminder #${id} cancelled.`, flags: MessageFlags.Ephemeral });
        }
    },
};
