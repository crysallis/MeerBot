const { EmbedBuilder } = require('discord.js');
const db = require('./db');
const { logJobRun } = require('./jobLog');
const botConfig = require('./botConfig');
const { pickColor } = require('./colors');

function fmtPower(val) {
    if (!val) return '—';
    if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`;
    return `${(val / 1_000).toFixed(0)}K`;
}

function scheduleWeeklySummary(client) {
    setInterval(async () => {
        const channelId = botConfig.get('WEEKLY_SUMMARY_CHANNEL_ID');
        if (!channelId) return;
        const timeStr = botConfig.get('WEEKLY_SUMMARY_TIME', '09:00');
        const [hours, minutes] = timeStr.split(':').map(Number);
        const now = new Date();
        // getUTCDay(): 0=Sun, 1=Mon
        if (now.getUTCDay() === 1 && now.getUTCHours() === hours && now.getUTCMinutes() === minutes) {
            await postWeeklySummary(client, channelId);
        }
    }, 60_000);

    console.log('Weekly summary initialized (reads channel/time each tick)');
}

async function postWeeklySummary(client, channelId) {
    try {
        const latest = db.prepare('SELECT id, scraped_at FROM snapshots ORDER BY id DESC LIMIT 1').get();
        if (!latest) return;

        const cutoff = new Date(latest.scraped_at);
        cutoff.setUTCDate(cutoff.getUTCDate() - 7);

        // Oldest scan from this week's window (start-of-week baseline)
        let prev = db.prepare(
            'SELECT id, scraped_at FROM snapshots WHERE scraped_at >= ? AND id < ? ORDER BY id ASC LIMIT 1'
        ).get(cutoff.toISOString(), latest.id);

        // Fallback: if only one scan exists this week, use the scan before the window
        if (!prev) {
            prev = db.prepare(
                'SELECT id, scraped_at FROM snapshots WHERE id < ? ORDER BY id DESC LIMIT 1'
            ).get(latest.id);
        }

        const rows = prev
            ? db.prepare(`
                SELECT ms2.name, ms2.combat_power_value, ms2.activeness,
                       (ms2.combat_power_value - COALESCE(ms1.combat_power_value, 0)) AS growth
                FROM member_snapshots ms2
                JOIN members m ON m.id = ms2.member_id AND m.active = 1
                LEFT JOIN member_snapshots ms1 ON ms1.member_id = ms2.member_id AND ms1.snapshot_id = ?
                WHERE ms2.snapshot_id = ?
                ORDER BY growth DESC, ms2.combat_power_value DESC
              `).all(prev.id, latest.id)
            : db.prepare(`
                SELECT ms.name, ms.combat_power_value, ms.activeness, 0 AS growth
                FROM member_snapshots ms
                JOIN members m ON m.id = ms.member_id AND m.active = 1
                WHERE ms.snapshot_id = ?
                ORDER BY ms.combat_power_value DESC
              `).all(latest.id);

        const lines = rows.map((r, i) => {
            const g = r.growth || 0;
            const growthStr = g > 0 ? `+${fmtPower(g)}` : '+0';
            return `${String(i + 1).padStart(2)}. ${r.name.padEnd(20)} ${fmtPower(r.combat_power_value).padStart(7)}  ${growthStr.padStart(7)}  ${String(r.activeness).padStart(4)}`;
        });

        const weekOf = latest.scraped_at.slice(0, 10);
        const since = prev ? prev.scraped_at.slice(0, 10) : null;
        const embed = new EmbedBuilder()
            .setTitle(`📊 Weekly Guild Summary — ${weekOf}`)
            .setFooter({ text: since ? `Growth since ${since}` : 'No prior week baseline found' })
            .setDescription('```\n #  Name                   Power    Growth   Act\n' + lines.join('\n') + '\n```')
            .setColor(pickColor());

        const channel = await client.channels.fetch(channelId);
        await channel.send({ embeds: [embed] });
    } catch (err) {
        console.error('Weekly summary error:', err);
    } finally {
        logJobRun('weekly_summary');
    }
}

module.exports = { scheduleWeeklySummary, postWeeklySummary };
