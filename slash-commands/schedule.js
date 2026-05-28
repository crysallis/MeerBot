const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const db = require('../utils/db');
const { pickColor } = require('../utils/colors');

const JOB_META = {
    './handlers/dailyReset':       { display: '📅 Daily Reset Message', logName: 'daily_reset'       },
    './handlers/birthdayCheck':    { display: '🎂 Birthday Check',       logName: 'birthday_check'    },
    './handlers/afkExpiry':        { display: '✈️ AFK Expiry',           logName: 'afk_expiry'        },
    './handlers/scanReminder':     { display: '⏰ Scan Reminder',         logName: 'scan_reminder'     },
    './handlers/weeklySummary':    { display: '📊 Weekly Summary',        logName: 'weekly_summary'    },
    './handlers/anniversaryCheck': { display: '🎉 Anniversary Check',    logName: 'anniversary_check' },
};

function fmtRecurrence(recurrence) {
    const [unit, n] = (recurrence || 'daily:1').split(':');
    const count = parseInt(n || '1', 10);
    if (unit === 'weekly') return count === 1 ? 'Every week' : `Every ${count} weeks`;
    return count === 1 ? 'Every day' : `Every ${count} days`;
}

function humanizeUntil(isoStr) {
    const ms = new Date(isoStr) - Date.now();
    if (ms < 0) return 'overdue';
    const totalMin = Math.round(ms / 60_000);
    const days  = Math.floor(totalMin / 1440);
    const hours = Math.floor((totalMin % 1440) / 60);
    const mins  = totalMin % 60;
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
}

function fmtIso(isoStr) {
    return isoStr.slice(0, 16).replace('T', ' ') + ' UTC';
}

function getLastRun(logName) {
    return db.prepare(
        'SELECT sent_at, late FROM scheduler_log WHERE name = ? ORDER BY sent_at DESC LIMIT 1'
    ).get(logName);
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('schedule')
        .setDescription('View scheduled jobs, last runs, and next runs'),

    async execute(interaction) {
        const systemJobs = db.prepare(`
            SELECT sj.fire_at, sj.recurrence, scj.handler_path
            FROM scheduled_jobs sj
            JOIN script_jobs scj ON scj.job_id = sj.id
            ORDER BY sj.fire_at
        `).all();

        const embed = new EmbedBuilder()
            .setTitle('📅 Scheduled Jobs')
            .setColor(pickColor())
            .setFooter({ text: `${systemJobs.length} system jobs · times in UTC · edit via admin panel` })
            .setTimestamp();

        for (const job of systemJobs) {
            const meta = JOB_META[job.handler_path];
            if (!meta) continue;

            const last = getLastRun(meta.logName);
            const lastStr = last
                ? `${fmtIso(last.sent_at)}${last.late ? ' *(late)*' : ''}`
                : '*never*';
            const nextStr = `${fmtIso(job.fire_at)} · in ${humanizeUntil(job.fire_at)}`;

            embed.addFields({
                name: meta.display,
                value: `\`${fmtRecurrence(job.recurrence)}\`\n**Last:** ${lastStr}\n**Next:** ${nextStr}`,
                inline: false,
            });
        }

        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    },
};
