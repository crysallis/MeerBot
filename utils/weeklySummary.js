const { EmbedBuilder } = require('discord.js');
const db = require('./db');

function fmtPower(val) {
    if (!val) return '—';
    if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`;
    return `${(val / 1_000).toFixed(0)}K`;
}

function scheduleWeeklySummary(client) {
    const channelId = process.env.WEEKLY_SUMMARY_CHANNEL_ID;
    const timeStr = process.env.WEEKLY_SUMMARY_TIME || '09:00'; // HH:MM UTC, Monday morning after Sunday reset

    if (!channelId) {
        console.log('WEEKLY_SUMMARY_CHANNEL_ID not set — weekly summary disabled.');
        return;
    }

    const [hours, minutes] = timeStr.split(':').map(Number);

    setInterval(async () => {
        const now = new Date();
        // getUTCDay(): 0=Sun, 1=Mon
        if (now.getUTCDay() === 1 && now.getUTCHours() === hours && now.getUTCMinutes() === minutes) {
            await postWeeklySummary(client, channelId);
        }
    }, 60_000);

    console.log(`Weekly summary scheduled every Monday at ${timeStr} UTC`);
}

async function postWeeklySummary(client, channelId) {
    try {
        const latest = db.prepare('SELECT id, scraped_at FROM snapshots ORDER BY id DESC LIMIT 1').get();
        if (!latest) return;

        const prev = db.prepare('SELECT id FROM snapshots WHERE id < ? ORDER BY id DESC LIMIT 1').get(latest.id);

        const rows = prev
            ? db.prepare(`
                SELECT ms2.name, ms2.combat_power_value, ms2.activeness,
                       (ms2.combat_power_value - COALESCE(ms1.combat_power_value, 0)) AS growth
                FROM member_snapshots ms2
                LEFT JOIN member_snapshots ms1 ON ms1.member_id = ms2.member_id AND ms1.snapshot_id = ?
                WHERE ms2.snapshot_id = ?
                ORDER BY growth DESC, ms2.combat_power_value DESC
              `).all(prev.id, latest.id)
            : db.prepare(`
                SELECT name, combat_power_value, activeness, 0 AS growth
                FROM member_snapshots WHERE snapshot_id = ?
                ORDER BY combat_power_value DESC
              `).all(latest.id);

        const lines = rows.map((r, i) => {
            const g = r.growth || 0;
            const growthStr = g > 0 ? `+${fmtPower(g)}` : '+0';
            return `${String(i + 1).padStart(2)}. ${r.name.padEnd(20)} ${fmtPower(r.combat_power_value).padStart(7)}  ${growthStr.padStart(7)}  ${String(r.activeness).padStart(4)}`;
        });

        const weekOf = latest.scraped_at.slice(0, 10);
        const embed = new EmbedBuilder()
            .setTitle(`📊 Weekly Guild Summary — ${weekOf}`)
            .setDescription('```\n #  Name                   Power    Growth   Act\n' + lines.join('\n') + '\n```')
            .setColor(0x9b59b6);

        const channel = await client.channels.fetch(channelId);
        await channel.send({ embeds: [embed] });
    } catch (err) {
        console.error('Weekly summary error:', err);
    }
}

module.exports = { scheduleWeeklySummary, postWeeklySummary };
