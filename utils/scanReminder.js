const { logJobRun } = require('./jobLog');
const botConfig = require('./botConfig');

function scheduleScanReminder(client) {
    setInterval(async () => {
        const channelId = botConfig.get('SCAN_REMINDER_CHANNEL_ID');
        if (!channelId) return;
        const timeStr = botConfig.get('SCAN_REMINDER_TIME', '20:00');
        const [hours, minutes] = timeStr.split(':').map(Number);
        const now = new Date();
        if (now.getUTCHours() === hours && now.getUTCMinutes() === minutes) {
            try {
                const userId = botConfig.get('SCAN_AUTHORIZED_USER');
                const channel = await client.channels.fetch(channelId);
                const mention = userId ? `<@${userId}>` : '';
                await channel.send(`${mention} ⏰ Daily reminder to run \`/scan\` and grab the latest guild data!`);
            } catch (err) {
                console.error('Scan reminder error:', err);
            } finally {
                logJobRun('scan_reminder');
            }
        }
    }, 60_000);

    console.log('Scan reminder initialized (reads channel/time each tick)');
}

module.exports = { scheduleScanReminder };
