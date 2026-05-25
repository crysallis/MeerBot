const { EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { logJobRun } = require('./jobLog');

const WISHES_PATH = path.join(__dirname, '../data/birthday-wishes.json');

function randomWish() {
    try {
        const wishes = JSON.parse(fs.readFileSync(WISHES_PATH, 'utf8'));
        return wishes[Math.floor(Math.random() * wishes.length)];
    } catch {
        return 'Happy Birthday! 🎂';
    }
}

function fmtPower(val) {
    if (!val) return null;
    if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`;
    return `${(val / 1_000).toFixed(0)}K`;
}


function lastYearPower(memberId, month, day) {
    const now = new Date();
    const year = now.getUTCFullYear() - 1;
    const mm = month.toString().padStart(2, '0');
    const dd = day.toString().padStart(2, '0');
    const target = `${year}-${mm}-${dd}`;
    const windowStart = `${year}-${mm}-${String(day - 14).padStart(2, '0')}`;
    const windowEnd   = `${year}-${mm}-${String(day + 14).padStart(2, '0')}`;

    const row = db.prepare(`
        SELECT ms.combat_power_value
        FROM member_snapshots ms
        JOIN snapshots s ON s.id = ms.snapshot_id
        WHERE ms.member_id = ?
          AND s.scraped_at BETWEEN ? AND ?
        ORDER BY ABS(julianday(s.scraped_at) - julianday(?))
        LIMIT 1
    `).get(memberId, windowStart, windowEnd, target);

    return row?.combat_power_value ?? null;
}

function buildBirthdayEmbed(userId, username, month, day) {
    const guildMember = db.prepare(`
        SELECT m.id, m.ingame_name, m.first_seen,
               ms.combat_power_value,
               (SELECT COUNT(*) + 1 FROM member_snapshots ms2
                WHERE ms2.snapshot_id = ms.snapshot_id
                  AND ms2.combat_power_value > ms.combat_power_value) AS power_rank
        FROM members m
        LEFT JOIN member_snapshots ms ON ms.member_id = m.id
            AND ms.snapshot_id = (SELECT MAX(id) FROM snapshots)
        WHERE m.discord_id = ?
    `).get(userId);

    const displayName = guildMember?.ingame_name ?? username;

    const description = [
        `✨ **${randomWish()}** ✨`,
        ``,
        `Today we celebrate one of our own — <@${userId}>!`,
        `The whole guild is cheering you on! 🥳🎉🎈`,
    ].join('\n');

    const embed = new EmbedBuilder()
        .setTitle(`🎉🎂 Happy Birthday, ${displayName}! 🎂🎉`)
        .setDescription(description)
        .setColor(0xFFD700)
        .setFooter({ text: '🎊 From your entire guild · with love 🎊' })
        .setTimestamp();

    if (guildMember) {
        if (guildMember.ingame_name) {
            embed.addFields({ name: '⚔️ Known In-Game As', value: guildMember.ingame_name, inline: true });
        }

        if (guildMember.combat_power_value) {
            let powerStr = `${fmtPower(guildMember.combat_power_value)} · Rank #${guildMember.power_rank}`;

            if (month && day) {
                const prevPower = lastYearPower(guildMember.id, month, day);
                if (prevPower) {
                    const growth = guildMember.combat_power_value - prevPower;
                    if (growth !== 0) {
                        powerStr += `\n${growth > 0 ? '+' : ''}${fmtPower(growth)} since last birthday`;
                    }
                }
            }

            embed.addFields({ name: '💪 Combat Power', value: powerStr, inline: true });
        }

        if (guildMember.first_seen) {
            embed.addFields({ name: '📅 Guild Member Since', value: guildMember.first_seen.slice(0, 10), inline: true });
        }
    }

    return { content: `<@${userId}>`, embed, displayName };
}

async function checkBirthdays(client) {
    try {
        const today = new Date();
        const month = today.getUTCMonth() + 1;
        const day   = today.getUTCDate();

        const birthdays = db.prepare('SELECT * FROM birthdays WHERE month = ? AND day = ?').all(month, day);

        if (birthdays.length) {
            const channelId = process.env.BIRTHDAY_CHANNEL_ID;
            if (channelId) {
                const channel = await client.channels.fetch(channelId).catch(() => null);
                if (channel?.isTextBased()) {
                    for (const bday of birthdays) {
                        const { content, embed, displayName } = buildBirthdayEmbed(bday.user_id, bday.username, bday.month, bday.day);
                        await channel.send({ content, embeds: [embed] });
                        console.log(`[Birthday] Sent for ${displayName}`);
                    }
                }
            }
        }
    } catch (err) {
        console.error('[Birthday Check] Error:', err);
    } finally {
        logJobRun('birthday_check');
    }
}

function scheduleBirthdayCheck(client) {
    const now = new Date();
    const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    const msUntilMidnight = tomorrow - now;

    console.log(`[Birthday Check] Scheduled in ${Math.round(msUntilMidnight / 1000)}s`);

    setTimeout(() => {
        checkBirthdays(client);
        setInterval(() => checkBirthdays(client), 24 * 60 * 60 * 1000);
    }, msUntilMidnight);
}

module.exports = { checkBirthdays, scheduleBirthdayCheck, buildBirthdayEmbed };
