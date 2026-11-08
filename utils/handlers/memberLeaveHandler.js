const { EmbedBuilder } = require('discord.js');
const botConfig = require('../botConfig');
const { pickColor } = require('../colors');

function findMemberByDiscordId(h, discordId) {
    return h.prepare(
        `SELECT m.*, w.name AS warband_name
           FROM members m
           LEFT JOIN warbands w ON w.id = m.warband_id
          WHERE m.discord_id = ?`
    ).get(discordId) || null;
}

function roleNames(member) {
    if (member.partial) return null;
    const everyoneId = member.guild?.id;
    const names = [...member.roles.cache.values()]
        .filter(r => r.id !== everyoneId)
        .sort((a, b) => b.position - a.position)
        .map(r => r.name);
    return names;
}

function buildLeaveEmbed(row, member) {
    const user = member.user;
    const names = roleNames(member);

    let roles;
    if (names === null) roles = 'Unknown (member was not cached when they left)';
    else if (names.length === 0) roles = 'None';
    else roles = names.join(', ').slice(0, 1000);

    const discordName = user.globalName && user.globalName !== user.username
        ? `${user.globalName} (${user.username})`
        : user.username;

    const fields = [
        { name: 'Discord', value: `${discordName}\n\`${user.id}\``, inline: true },
        { name: 'In-game name', value: row.ingame_name, inline: true },
        { name: 'Game ID', value: row.ingame_id ? String(row.ingame_id) : '·', inline: true },
        { name: 'Warband', value: row.warband_name || '·', inline: true },
        {
            name: 'Joined server',
            value: member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:D>` : '·',
            inline: true,
        },
        { name: 'First seen in game', value: row.first_seen ? String(row.first_seen).slice(0, 10) : '·', inline: true },
        { name: 'Roles when they left', value: roles },
    ];

    return new EmbedBuilder()
        .setTitle('👋 Member left the server')
        .setColor(pickColor())
        .setThumbnail(user.displayAvatarURL({ size: 128 }))
        .addFields(fields)
        .setTimestamp();
}

async function handleMemberLeave(member, client, deps = {}) {
    const h = deps.h || require('../db');
    const channelId = deps.channelId ?? botConfig.get('COMMAND_LOG_CHANNEL_ID');
    if (!channelId) return;

    try {
        const row = findMemberByDiscordId(h, member.id);
        if (!row) return;

        const channel = client.channels.cache.get(channelId);
        if (!channel?.isTextBased()) return;

        await channel.send({ embeds: [buildLeaveEmbed(row, member)] });
    } catch (err) {
        console.error(`[memberLeave] post failed for ${member.id}: ${err.message}`);
    }
}

module.exports = { handleMemberLeave, buildLeaveEmbed, findMemberByDiscordId };
