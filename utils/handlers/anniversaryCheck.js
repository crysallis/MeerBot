const { EmbedBuilder } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db');
const { logJobRun } = require('../jobLog');
const botConfig = require('../botConfig');
const { pickColor } = require('../colors');

const OG_ROLE_ID = '1502845579661672478';
const OG_THRESHOLD_YEARS = 2;
const anthropic = new Anthropic();

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

async function grantOgRole(client, discordId, ingameName) {
    try {
        const guildId = process.env.GUILD_ID;
        if (!guildId || !discordId) return false;
        const guild = await client.guilds.fetch(guildId);
        const member = await guild.members.fetch(discordId);
        if (member.roles.cache.has(OG_ROLE_ID)) return false; // already has it
        await member.roles.add(OG_ROLE_ID);
        return true;
    } catch (err) {
        console.error(`[AnniversaryCheck] Failed to grant OG role to ${ingameName}:`, err);
        return false;
    }
}

async function generateOgMessage(ingameName, years, mention) {
    const yearLabel = `${years} year${years === 1 ? '' : 's'}`;
    try {
        const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 300,
            messages: [{
                role: 'user',
                content: `Write a short Discord announcement for a guild member reaching ${yearLabel} in an AFK Journey guild called RiffRaff. Their name is ${ingameName}.

Rules:
- 3-4 short paragraphs max
- Casual, warm guild tone -- not corporate, not cringe
- Must include the line ✨ **OG RIFFRAFF** ✨ on its own line as the centrepiece
- End with: Welcome to a very short list. 🦡
- Reference their name naturally, but do NOT include a Discord mention tag -- just use their name
- No em dashes
- No hashtags, no "congrats!" filler openers
- Vary the angle each time: could be about loyalty, longevity, showing up, being part of the fabric of the guild, etc.
- Output only the message body, no title, no quotes around it`,
            }],
        });
        const raw = response.content[0].text.trim();
        return raw.replace(ingameName, mention);
    } catch (err) {
        console.error('[AnniversaryCheck] Claude generation failed, using fallback:', err.message);
        const yearLabel2 = `${years} year${years === 1 ? '' : 's'}`;
        return [
            `${yearLabel2} in RiffRaff. That's not nothing.`,
            ``,
            `${mention} has been here through the chaos, the patches, and everything in between. Still standing. Still showing up.`,
            ``,
            `✨ **OG RIFFRAFF** ✨`,
            ``,
            `Welcome to a very short list. 🦡`,
        ].join('\n');
    }
}

async function postOgAnnouncement(channel, m, years, today) {
    const mention = m.discord_id ? `<@${m.discord_id}>` : `**${m.ingame_name}**`;
    const desc = await generateOgMessage(m.ingame_name, years, mention);

    await channel.send({ embeds: [
        new EmbedBuilder()
            .setTitle(`🏅 OG RiffRaff · ${m.ingame_name}`)
            .setDescription(desc)
            .setColor(0xFFFF00)
            .setFooter({ text: today.toISOString().slice(0, 10) }),
    ]});
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
        const ogMembers = [];

        for (const m of members) {
            const label = milestoneFor(m.first_seen, today);
            if (!label) continue;
            matches.push({ ...m, label });

            const from = new Date(m.first_seen);
            const years = today.getUTCFullYear() - from.getUTCFullYear();
            if (
                years >= OG_THRESHOLD_YEARS
                && today.getUTCMonth() === from.getUTCMonth()
                && today.getUTCDate() === from.getUTCDate()
            ) {
                ogMembers.push({ ...m, years });
            }
        }

        const channel = await client.channels.fetch(channelId);

        if (matches.length > 0) {
            const lines = matches.map(m => {
                const mention = m.discord_id ? `<@${m.discord_id}> / ` : '';
                return `· ${mention}**${m.ingame_name}** · ${m.label} with the guild`;
            });
            await channel.send({ embeds: [
                new EmbedBuilder()
                    .setTitle(`🎉 Guild Anniversaries · ${today.toISOString().slice(0, 10)}`)
                    .setDescription(lines.join('\n') + '\n\nThanks for being part of the guild! 🦡')
                    .setColor(pickColor()),
            ]});
        }

        for (const m of ogMembers) {
            await grantOgRole(client, m.discord_id, m.ingame_name);
            await postOgAnnouncement(channel, m, m.years, today);
        }
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
module.exports.generateOgMessage = generateOgMessage;
