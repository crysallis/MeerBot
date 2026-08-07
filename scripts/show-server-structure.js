/**
 * One-time script: connect to Discord, walk every category and channel,
 * and dump the full category > channel > role-overwrite structure to
 * data/discord-structure.json.
 *
 * For each channel:
 *   - synced: whether its overwrites exactly match its category's (Discord's
 *     own "synced" concept, via permissionsLocked -- NOT "has zero overwrites",
 *     since a synced channel under a category WITH overwrites still carries
 *     them copied down onto the channel)
 *   - everyoneCanView: fully resolved (channel overwrite > category overwrite
 *     > base role perms) via permissionsFor(), not just the channel's own
 *     @everyone overwrite in isolation
 *   - overwrites: role/user allow+deny lists (present regardless of synced)
 *
 * Run with:  node scripts/show-server-structure.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, ChannelType, PermissionsBitField } = require('discord.js');

const GUILD_ID = process.env.GUILD_ID;
const TOKEN = process.env.DISCORD_TOKEN;

if (!GUILD_ID || !TOKEN) {
    console.error('Missing GUILD_ID or DISCORD_TOKEN in .env');
    process.exit(1);
}

const TYPE_LABEL = {
    [ChannelType.GuildText]: 'text',
    [ChannelType.GuildVoice]: 'voice',
    [ChannelType.GuildAnnouncement]: 'announce',
    [ChannelType.GuildStageVoice]: 'stage',
    [ChannelType.GuildForum]: 'forum',
    [ChannelType.GuildMedia]: 'media',
};

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

function describeChannel(ch, roleMap, everyone) {
    const overwrites = [...ch.permissionOverwrites.cache.values()];
    // permissionsFor() resolves the full chain (channel overwrite > category
    // overwrite > base role perms), unlike checking the channel's own
    // @everyone overwrite in isolation -- a channel with no @everyone entry
    // of its own still inherits a deny from its category.
    const everyoneCanView = ch.permissionsFor(everyone).has(PermissionsBitField.Flags.ViewChannel);

    return {
        id: ch.id,
        name: ch.name,
        type: TYPE_LABEL[ch.type] ?? `unknown(${ch.type})`,
        position: ch.position ?? 0,
        // permissionsLocked does a deep compare against the parent category's
        // overwrites -- NOT "has zero overwrites of its own". A synced channel
        // under a category that has overwrites will still show a non-empty
        // overwrites array below (Discord copies them down), so don't use
        // overwrites.length as a synced signal.
        synced: ch.permissionsLocked,
        everyoneCanView,
        overwrites: overwrites.map(ow => {
            const isRole = ow.type === 0;
            return {
                kind: isRole ? 'role' : 'user',
                id: ow.id,
                name: isRole ? (roleMap.get(ow.id) ?? ow.id) : ow.id,
                allow: ow.allow.toArray(),
                deny: ow.deny.toArray(),
            };
        }),
    };
}

client.once('clientReady', async () => {
    console.log(`Connected as ${client.user.tag}`);
    const guild = await client.guilds.fetch(GUILD_ID);
    const everyone = guild.roles.everyone;

    const roles = await guild.roles.fetch();
    const roleMap = new Map(roles.map(r => [r.id, r.name]));

    const channels = await guild.channels.fetch();

    const categories = new Map();
    const orphans = [];

    for (const [, ch] of channels) {
        if (!ch) continue;
        if (ch.type === ChannelType.GuildCategory) {
            const entry = describeChannel(ch, roleMap, everyone);
            entry.channels = categories.get(ch.id)?.channels ?? [];
            categories.set(ch.id, entry);
            continue;
        }
        const entry = describeChannel(ch, roleMap, everyone);
        if (ch.parentId) {
            if (!categories.has(ch.parentId)) categories.set(ch.parentId, { name: '(pending)', position: 0, channels: [] });
            categories.get(ch.parentId).channels.push(entry);
        } else {
            orphans.push(entry);
        }
    }

    for (const cat of categories.values()) cat.channels.sort((a, b) => a.position - b.position);
    const orderedCats = [...categories.values()].sort((a, b) => a.position - b.position);
    orphans.sort((a, b) => a.position - b.position);

    const json = {
        fetched_at: new Date().toISOString(),
        guild_id: GUILD_ID,
        categories: orderedCats,
        uncategorised: orphans,
    };

    const outPath = path.join(__dirname, '..', 'data', 'discord-structure.json');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(json, null, 2));
    console.log(`\nWrote ${outPath}`);

    client.destroy();
    process.exit(0);
});

client.login(TOKEN);
