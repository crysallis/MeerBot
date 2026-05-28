const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const db = require('../utils/db');
const { milestoneFor } = require('../utils/handlers/anniversaryCheck');
const { pickColor } = require('../utils/colors');

/**
 * Returns the next upcoming milestone for a member, or null if first_seen
 * is invalid. Considers 1/3/6 month milestones (only if still in the future)
 * and the next yearly anniversary, picking whichever comes soonest.
 */
function nextAnniversary(firstSeenIso, fromDate) {
    const from = new Date(firstSeenIso);
    if (isNaN(from)) return null;

    const candidates = [];

    for (const months of [1, 3, 6]) {
        const targetMonth = (from.getUTCMonth() + months) % 12;
        const targetYear = from.getUTCFullYear() + Math.floor((from.getUTCMonth() + months) / 12);
        const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
        const targetDay = Math.min(from.getUTCDate(), lastDay);
        const date = new Date(Date.UTC(targetYear, targetMonth, targetDay));
        if (date >= fromDate) candidates.push({ date, label: `${months} month${months > 1 ? 's' : ''}` });
    }

    for (let yearsAhead = 1; yearsAhead <= 100; yearsAhead++) {
        const targetYear = from.getUTCFullYear() + yearsAhead;
        const date = new Date(Date.UTC(targetYear, from.getUTCMonth(), from.getUTCDate()));
        if (date >= fromDate) {
            candidates.push({ date, label: `${yearsAhead} year${yearsAhead > 1 ? 's' : ''}` });
            break;
        }
    }

    candidates.sort((a, b) => a.date - b.date);
    return candidates[0] || null;
}

function findMatches(today) {
    const members = db.prepare(`
        SELECT ingame_name, discord_id, first_seen
        FROM members
        WHERE active = 1 AND first_seen IS NOT NULL
    `).all();

    return members
        .map(m => ({ ...m, label: milestoneFor(m.first_seen, today) }))
        .filter(m => m.label);
}

function buildEmbed(matches, date, isPreview) {
    const lines = matches.map(m => {
        const mention = m.discord_id ? `<@${m.discord_id}> / ` : '';
        return `· ${mention}**${m.ingame_name}** · ${m.label} with the guild`;
    });

    const title = `🎉 Guild Anniversaries · ${date.toISOString().slice(0, 10)}${isPreview ? ' (preview)' : ''}`;
    return new EmbedBuilder()
        .setTitle(title)
        .setDescription(lines.join('\n') + '\n\nThanks for being part of the guild! 🦡')
        .setColor(pickColor());
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('anniversary')
        .setDescription('Guild anniversary tools')
        .addSubcommand(s => s
            .setName('test')
            .setDescription('Preview the anniversary embed for a date (defaults to today). Posts in current channel.')
            .addStringOption(o => o
                .setName('date')
                .setDescription('YYYY-MM-DD (default: today). Try a future date to preview upcoming.')
                .setRequired(false)
            )
        )
        .addSubcommand(s => s
            .setName('list')
            .setDescription('Show the next N upcoming anniversaries (default 5)')
            .addIntegerOption(o => o
                .setName('count')
                .setDescription('How many to show (1-20)')
                .setMinValue(1)
                .setMaxValue(20)
                .setRequired(false)
            )
        )
        .addSubcommand(s => s
            .setName('upcoming')
            .setDescription('Show all anniversaries in the next N days (default 30)')
            .addIntegerOption(o => o
                .setName('days')
                .setDescription('Days to look ahead (1-365)')
                .setMinValue(1)
                .setMaxValue(365)
                .setRequired(false)
            )
        ),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        if (sub === 'test') {
            const dateStr = interaction.options.getString('date');
            const date = dateStr ? new Date(`${dateStr}T00:00:00Z`) : new Date();
            if (isNaN(date)) {
                return interaction.reply({ content: '❌ Invalid date. Use `YYYY-MM-DD`.', flags: MessageFlags.Ephemeral });
            }

            const matches = findMatches(date);
            if (matches.length === 0) {
                return interaction.reply({
                    content: `No anniversaries on ${date.toISOString().slice(0, 10)}.`,
                    flags: MessageFlags.Ephemeral,
                });
            }

            // Suppress pings in preview so test runs don't notify members
            return interaction.reply({
                embeds: [buildEmbed(matches, date, true)],
                allowedMentions: { parse: [] },
            });
        }

        if (sub === 'list') {
            const count = interaction.options.getInteger('count') ?? 5;
            const now = new Date();
            const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

            const members = db.prepare(`
                SELECT ingame_name, discord_id, first_seen
                FROM members WHERE active = 1 AND first_seen IS NOT NULL
            `).all();

            const all = [];
            for (const m of members) {
                const next = nextAnniversary(m.first_seen, today);
                if (next) all.push({ ...m, ...next });
            }
            all.sort((a, b) => a.date - b.date);
            const top = all.slice(0, count);

            if (top.length === 0) {
                return interaction.reply({ content: 'No upcoming anniversaries found.', flags: MessageFlags.Ephemeral });
            }

            const lines = top.map(m => {
                const days = Math.round((m.date - today) / 86_400_000);
                const when = days === 0 ? '**today!**' : days === 1 ? 'tomorrow' : `in ${days} days`;
                return `· **${m.date.toISOString().slice(0, 10)}** · ${m.ingame_name} · ${m.label} (${when})`;
            });

            return interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle(`📆 Next ${top.length} Anniversaries`)
                        .setDescription(lines.join('\n'))
                        .setColor(pickColor()),
                ],
                flags: MessageFlags.Ephemeral,
            });
        }

        if (sub === 'upcoming') {
            const days = interaction.options.getInteger('days') ?? 30;
            const now = new Date();
            const found = [];

            for (let i = 0; i < days; i++) {
                const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + i));
                const matches = findMatches(d);
                for (const m of matches) {
                    found.push({ date: d.toISOString().slice(0, 10), ...m });
                }
            }

            if (found.length === 0) {
                return interaction.reply({
                    content: `No anniversaries in the next ${days} days.`,
                    flags: MessageFlags.Ephemeral,
                });
            }

            const lines = found.map(m => `**${m.date}** · ${m.ingame_name} · ${m.label}`);

            return interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle(`📆 Upcoming Anniversaries · next ${days} days`)
                        .setDescription(lines.join('\n'))
                        .setColor(pickColor()),
                ],
                flags: MessageFlags.Ephemeral,
            });
        }
    },
};
