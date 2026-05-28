const { logJobRun } = require('../jobLog');
const botConfig = require('../botConfig');

module.exports = async function handleScanReminder(client, job) {
    const channelId = botConfig.get('SCAN_REMINDER_CHANNEL_ID');
    if (!channelId) return;
    try {
        const userId = botConfig.get('SCAN_AUTHORIZED_USER');
        const channel = await client.channels.fetch(channelId);
        const mention = userId ? `<@${userId}>` : '';
        await channel.send(`${mention} ⏰ Daily reminder to run \`/scan\` and grab the latest guild data!`);
    } catch (err) {
        console.error('[ScanReminder] Error:', err);
    } finally {
        logJobRun('scan_reminder');
    }
};
