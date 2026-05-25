const { logJobRun } = require('./jobLog');

function scheduleScanReminder(client) {
    const channelId = process.env.SCAN_REMINDER_CHANNEL_ID;
    const userId = process.env.SCAN_AUTHORIZED_USER;
    const timeStr = process.env.SCAN_REMINDER_TIME || '20:00'; // HH:MM UTC

    if (!channelId) {
        console.log('SCAN_REMINDER_CHANNEL_ID not set — scan reminder disabled.');
        return;
    }

    const [hours, minutes] = timeStr.split(':').map(Number);

    setInterval(async () => {
        const now = new Date();
        if (now.getUTCHours() === hours && now.getUTCMinutes() === minutes) {
            try {
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

    console.log(`Scan reminder scheduled daily at ${timeStr} UTC`);
}

module.exports = { scheduleScanReminder };
