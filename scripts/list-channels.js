/**
 * One-time script: connect to Discord, fetch every channel in the guild,
 * and dump them to data/discord-channels.json (sorted by category > position).
 * Also prints a markdown table to stdout for pasting into CLAUDE.md.
 *
 * Run with:  node scripts/list-channels.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, ChannelType } = require('discord.js');

const GUILD_ID = process.env.GUILD_ID;
const TOKEN = process.env.DISCORD_TOKEN;

if (!GUILD_ID || !TOKEN) {
    console.error('Missing GUILD_ID or DISCORD_TOKEN in .env');
    process.exit(1);
}

const TYPE_LABEL = {
    [ChannelType.GuildText]: 'text',
    [ChannelType.GuildVoice]: 'voice',
    [ChannelType.GuildCategory]: 'category',
    [ChannelType.GuildAnnouncement]: 'announce',
    [ChannelType.GuildStageVoice]: 'stage',
    [ChannelType.GuildForum]: 'forum',
    [ChannelType.GuildMedia]: 'media',
};

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', async () => {
    console.log(`Connected as ${client.user.tag}`);
    const guild = await client.guilds.fetch(GUILD_ID);
    const channels = await guild.channels.fetch();

    // Group by category for nicer output
    const categories = new Map();
    const orphans = [];

    for (const [, ch] of channels) {
        if (!ch) continue;
        if (ch.type === ChannelType.GuildCategory) {
            if (!categories.has(ch.id)) categories.set(ch.id, { name: ch.name, position: ch.position, items: [] });
            else { categories.get(ch.id).name = ch.name; categories.get(ch.id).position = ch.position; }
            continue;
        }
        const entry = {
            id: ch.id,
            name: ch.name,
            type: TYPE_LABEL[ch.type] ?? `unknown(${ch.type})`,
            position: ch.position ?? 0,
        };
        if (ch.parentId) {
            if (!categories.has(ch.parentId)) categories.set(ch.parentId, { name: '(pending)', position: 0, items: [] });
            categories.get(ch.parentId).items.push(entry);
        } else {
            orphans.push(entry);
        }
    }

    // Sort items inside each category and order categories
    for (const cat of categories.values()) cat.items.sort((a, b) => a.position - b.position);
    const orderedCats = [...categories.values()].sort((a, b) => a.position - b.position);

    // JSON output
    const json = {
        fetched_at: new Date().toISOString(),
        guild_id: GUILD_ID,
        categories: orderedCats.map(c => ({
            name: c.name,
            channels: c.items.map(({ id, name, type }) => ({ id, name, type })),
        })),
        uncategorised: orphans.map(({ id, name, type }) => ({ id, name, type })),
    };
    const outPath = path.join(__dirname, '..', 'data', 'discord-channels.json');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(json, null, 2));
    console.log(`\nWrote ${outPath}\n`);

    // Markdown table to stdout
    console.log('## Discord Channels (paste into CLAUDE.md)\n');
    for (const cat of orderedCats) {
        if (!cat.items.length) continue;
        console.log(`**${cat.name}**`);
        for (const item of cat.items) {
            console.log(`- \`${item.id}\` · ${item.name} (${item.type})`);
        }
        console.log();
    }
    if (orphans.length) {
        console.log('**(no category)**');
        for (const item of orphans) console.log(`- \`${item.id}\` · ${item.name} (${item.type})`);
    }

    client.destroy();
    process.exit(0);
});

client.login(TOKEN);
