const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const db = require('../utils/db');

const JOBS = [
    {
        name: 'daily_reset',
        display: '📅 Daily Reset Message',
        schedule: 'Daily 00:00 UTC',
        kind: 'daily',
        hour: 0,
        minute: 0,
    },
    {
        name: 'birthday_check',
        display: '🎂 Birthday Check',
        schedule: 'Daily 00:00 UTC',
        kind: 'daily',
        hour: 0,
        minute: 0,
    },
    {
        name: 'afk_expiry',
        display: '✈️ AFK Expiry',
        schedule: 'Daily 00:00 UTC',
        kind: 'daily',
        hour: 0,
        minute: 0,
    },
    {
        name: 'scan_reminder',
        display: '⏰ Scan Reminder',
        schedule: `Daily ${process.env.SCAN_REMINDER_TIME || '20:00'} UTC`,
        kind: 'daily',
        ...parseTime(process.env.SCAN_REMINDER_TIME || '20:00'),
    },
    {
        name: 'weekly_summary',
        display: '📊 Weekly Summary',
        schedule: `Mondays ${process.env.WEEKLY_SUMMARY_TIME || '09:00'} UTC`,
        kind: 'weekly',
        weekday: 1, // Monday
        ...parseTime(process.env.WEEKLY_SUMMARY_TIME || '09:00'),
    },
];

function parseTime(hhmm) {
    const [hour, minute] = hhmm.split(':').map(Number);
    return { hour, minute };
}

function nextFire(job) {
    const now = new Date();
    const next = new Date(Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
        job.hour, job.minute, 0
    ));

    if (job.kind === 'daily') {
        if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    } else if (job.kind === 'weekly') {
        // Advance to the requested weekday
        const diff = (job.weekday - next.getUTCDay() + 7) % 7;
        next.setUTCDate(next.getUTCDate() + diff);
        if (next <= now) next.setUTCDate(next.getUTCDate() + 7);
    }
    return next;
}

function humanizeUntil(future) {
    const ms = future - Date.now();
    if (ms < 0) return 'overdue';
    const totalMin = Math.round(ms / 60_000);
    const days = Math.floor(totalMin / 1440);
    const hours = Math.floor((totalMin % 1440) / 60);
    const mins = totalMin % 60;
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
}

function fmtIso(date) {
    return date.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

function getLastRun(name) {
    return db.prepare(
        'SELECT sent_at, late FROM scheduler_log WHERE name = ? ORDER BY sent_at DESC LIMIT 1'
    ).get(name);
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('schedule')
        .setDescription('View scheduled jobs, last runs, and next runs'),

    async execute(interaction) {
        if (interaction.user.id !== process.env.SCAN_AUTHORIZED_USER) {
            return interaction.reply({
                content: 'You are not authorized to run this.',
                flags: MessageFlags.Ephemeral,
            });
        }

        const embed = new EmbedBuilder()
            .setTitle('📅 Scheduled Jobs')
            .setColor(0x4a90e2)
            .setFooter({ text: `${JOBS.length} jobs · times in UTC` })
            .setTimestamp();

        for (const job of JOBS) {
            const last = getLastRun(job.name);
            const next = nextFire(job);

            const lastStr = last
                ? `${fmtIso(new Date(last.sent_at))}${last.late ? ' *(late)*' : ''}`
                : '*never*';
            const nextStr = `${fmtIso(next)} · in ${humanizeUntil(next)}`;

            embed.addFields({
                name: `${job.display}`,
                value: `\`${job.schedule}\`\n**Last:** ${lastStr}\n**Next:** ${nextStr}`,
                inline: false,
            });
        }

        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    },
};
