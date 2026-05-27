const { EmbedBuilder } = require('discord.js');
const db = require('./db');
const botConfig = require('./botConfig');

// Add new timed messages here — utcHour/utcMinute are when to fire (UTC)
const MESSAGES = [
    {
        name: 'daily_reset',
        channelEnv: 'GENERAL_CHANNEL_ID',
        utcHour: 0,
        utcMinute: 0,
        maxLateMinutes: 120, // skip entirely if more than 2 hours past scheduled time
        build: () => new EmbedBuilder()
            .setTitle('Daily Reset for DR and Guild Supremacy')
            .setDescription(
                "It's server reset, hop on if you can, let's take down that Supremacy boss... " +
                "or get the our daily activity in so we can get the next boss!"
            )
            .setColor(0xf39c12),
    },
];

function alreadySentToday(name) {
    const today = new Date().toISOString().slice(0, 10);
    return !!db.prepare('SELECT 1 FROM scheduler_log WHERE name = ? AND sent_date = ?').get(name, today);
}

function markSent(name, late) {
    const now = new Date();
    db.prepare(
        'INSERT OR IGNORE INTO scheduler_log (name, sent_date, sent_at, late) VALUES (?, ?, ?, ?)'
    ).run(name, now.toISOString().slice(0, 10), now.toISOString(), late ? 1 : 0);
}

async function checkScheduledMessages(client) {
    const now = new Date();
    const utcH = now.getUTCHours();
    const utcM = now.getUTCMinutes();
    const LATE_THRESHOLD_MS = Number(botConfig.get('LATE_WARNING_MINUTES', '30')) * 60_000;

    for (const msg of MESSAGES) {
        // Only fire if we're at or past the scheduled time today (UTC)
        const pastScheduledTime = utcH > msg.utcHour || (utcH === msg.utcHour && utcM >= msg.utcMinute);
        if (!pastScheduledTime) continue;
        if (alreadySentToday(msg.name)) continue;

        // How many minutes past the scheduled time are we?
        const scheduledMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), msg.utcHour, msg.utcMinute);
        const lateMs = Date.now() - scheduledMs;
        const lateMinutes = Math.round(lateMs / 60_000);
        const isLate = lateMs > LATE_THRESHOLD_MS;

        // Skip entirely if past the max-late window — message is no longer relevant
        if (msg.maxLateMinutes && lateMinutes > msg.maxLateMinutes) {
            console.log(`Scheduled message skipped (${lateMinutes} min late, max is ${msg.maxLateMinutes}): ${msg.name}`);
            markSent(msg.name, false); // mark as handled so we don't retry all day
            continue;
        }

        const channelId = botConfig.get(msg.channelEnv);
        if (!channelId) {
            console.warn(`Scheduled message '${msg.name}': env var ${msg.channelEnv} not set`);
            continue;
        }

        try {
            const embed = msg.build();
            if (isLate) {
                embed.setFooter({
                    text: `⚠️ Fired ${lateMinutes} min late · the bot was offline at reset time · better late than never!`,
                });
            }

            const channel = await client.channels.fetch(channelId);
            await channel.send({ embeds: [embed] });
            markSent(msg.name, isLate);
            console.log(`Scheduled message sent: ${msg.name}${isLate ? ` (${lateMinutes} min late)` : ''}`);
        } catch (err) {
            console.error(`Scheduled message '${msg.name}' failed:`, err);
        }
    }
}

function scheduleMessages(client) {
    // Run on startup — catches any messages missed while the bot was down today
    checkScheduledMessages(client);
    setInterval(() => checkScheduledMessages(client), 60_000);
    console.log('Scheduled messages initialized');
}

module.exports = { scheduleMessages };
