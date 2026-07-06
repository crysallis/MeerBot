const { EmbedBuilder } = require('discord.js');
const { logJobRun } = require('../jobLog');
const botConfig = require('../botConfig');
const { pickColor } = require('../colors');

const MAX_LATE_MINUTES = 120;

module.exports = async function handleDailyReset(client, job) {
    const lateMs = Date.now() - new Date(job.fire_at).getTime();
    const lateMinutes = Math.round(lateMs / 60_000);

    if (lateMinutes > MAX_LATE_MINUTES) {
        console.log(`[DailyReset] Skipped (${lateMinutes} min late, max ${MAX_LATE_MINUTES})`);
        logJobRun('daily_reset');
        return;
    }

    const channelId = botConfig.get('GENERAL_CHANNEL_ID');
    if (!channelId) return;

    const LATE_THRESHOLD = Number(botConfig.get('LATE_WARNING_MINUTES', '30'));
    const isLate = lateMinutes > LATE_THRESHOLD;

    try {
        const embed = new EmbedBuilder()
            .setTitle('Daily Reset for Guild Duel')
            .setDescription(
                "It's server reset, hop on and knock out some Duel Quests! " +
                "Not everyone needs to do all of them, so check the list and pitch in wherever you can:\n" +
                "• Run Arcane Lab\n" +
                "• Run Honor Duel\n" +
                "• Push AFK Stages\n" +
                "• Finish 20 Homestead requests\n" +
                "• Collect materials\n" +
                "• Jump into Arena / Supreme Arena / Dream Realm\n\n" +
                "Every bit helps the guild!"
            )
            .setColor(pickColor());

        if (isLate) {
            embed.setFooter({
                text: `⚠️ Fired ${lateMinutes} min late · the bot was offline at reset time · better late than never!`,
            });
        }

        const channel = await client.channels.fetch(channelId);
        await channel.send({ embeds: [embed] });
        logJobRun('daily_reset', isLate);
        console.log(`[DailyReset] Sent${isLate ? ` (${lateMinutes} min late)` : ''}`);
    } catch (err) {
        console.error('[DailyReset] Error:', err);
    }
};
