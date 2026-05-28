const { EmbedBuilder } = require('discord.js');
const db = require('../db');
const { logJobRun } = require('../jobLog');
const botConfig = require('../botConfig');
const { pickColor } = require('../colors');

module.exports = async function handleAfkExpiry(client, job) {
    try {
        const channelId = botConfig.get('INACTIVITY_ALERT_CHANNEL_ID');
        const today = new Date().toISOString().slice(0, 10);

        const expired = db.prepare(`
            SELECT m.ingame_name, afk.reason, afk.return_date, afk.set_by
            FROM member_afk afk
            JOIN members m ON m.id = afk.member_id
            WHERE afk.return_date IS NOT NULL AND afk.return_date < ?
        `).all(today);

        if (expired.length === 0) return;

        db.prepare(`
            DELETE FROM member_afk
            WHERE return_date IS NOT NULL AND return_date < ?
        `).run(today);

        if (!channelId) return;

        const lines = expired.map(r => {
            let line = `· **${r.ingame_name}** · return date was ${r.return_date}`;
            if (r.reason) line += ` · ${r.reason}`;
            return line;
        });

        const channel = await client.channels.fetch(channelId);
        await channel.send({ embeds: [
            new EmbedBuilder()
                .setTitle(`✈️ AFK period ended · ${expired.length} member${expired.length === 1 ? '' : 's'} returned`)
                .setDescription(lines.join('\n'))
                .setFooter({ text: 'AFK status cleared automatically · use /afk set again if still away' })
                .setColor(pickColor()),
        ]});
    } catch (err) {
        console.error('[AfkExpiry] Error:', err);
    } finally {
        logJobRun('afk_expiry');
    }
};
