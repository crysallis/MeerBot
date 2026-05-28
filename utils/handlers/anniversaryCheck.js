const { EmbedBuilder } = require('discord.js');
const db = require('../db');
const { logJobRun } = require('../jobLog');
const botConfig = require('../botConfig');
const { pickColor } = require('../colors');

function isNMonthsLater(from, today, n) {
    const targetMonth = (from.getUTCMonth() + n) % 12;
    const targetYear = from.getUTCFullYear() + Math.floor((from.getUTCMonth() + n) / 12);
    const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
    const targetDay = Math.min(from.getUTCDate(), lastDay);

    return today.getUTCFullYear() === targetYear
        && today.getUTCMonth() === targetMonth
        && today.getUTCDate() === targetDay;
}

function milestoneFor(firstSeenIso, today) {
    const from = new Date(firstSeenIso);
    if (isNaN(from)) return null;

    if (isNMonthsLater(from, today, 1)) return '1 month';
    if (isNMonthsLater(from, today, 3)) return '3 months';
    if (isNMonthsLater(from, today, 6)) return '6 months';

    if (today.getUTCMonth() === from.getUTCMonth()
        && today.getUTCDate() === from.getUTCDate()
        && today.getUTCFullYear() > from.getUTCFullYear()) {
        const years = today.getUTCFullYear() - from.getUTCFullYear();
        return `${years} year${years === 1 ? '' : 's'}`;
    }
    return null;
}

async function checkAnniversaries(client) {
    try {
        const channelId = botConfig.get('ANNIVERSARY_CHANNEL_ID');
        if (!channelId) return;

        const members = db.prepare(`
            SELECT ingame_name, discord_id, first_seen
            FROM members
            WHERE active = 1 AND first_seen IS NOT NULL
        `).all();

        const today = new Date();
        const matches = [];
        for (const m of members) {
            const label = milestoneFor(m.first_seen, today);
            if (label) matches.push({ ...m, label });
        }

        if (matches.length === 0) return;

        const lines = matches.map(m => {
            const mention = m.discord_id ? `<@${m.discord_id}> / ` : '';
            return `· ${mention}**${m.ingame_name}** · ${m.label} with the guild`;
        });

        const channel = await client.channels.fetch(channelId);
        await channel.send({ embeds: [
            new EmbedBuilder()
                .setTitle(`🎉 Guild Anniversaries · ${today.toISOString().slice(0, 10)}`)
                .setDescription(lines.join('\n') + '\n\nThanks for being part of the guild! 🦡')
                .setColor(pickColor()),
        ]});
    } catch (err) {
        console.error('[AnniversaryCheck] Error:', err);
    } finally {
        logJobRun('anniversary_check');
    }
}

module.exports = async function handleAnniversaryCheck(client, job) {
    await checkAnniversaries(client);
};

module.exports.milestoneFor = milestoneFor;
module.exports.checkAnniversaries = checkAnniversaries;
