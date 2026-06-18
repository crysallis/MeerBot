/**
 * One-time script: fetch every role in the guild and dump them to
 * data/discord-roles.json (sorted by position, highest first). Also
 * prints a markdown reference for pasting into CLAUDE.md.
 *
 * Run with:  node scripts/list-roles.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits } = require('discord.js');

const GUILD_ID = process.env.GUILD_ID;
const TOKEN = process.env.DISCORD_TOKEN;

if (!GUILD_ID || !TOKEN) {
    console.error('Missing GUILD_ID or DISCORD_TOKEN in .env');
    process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once('clientReady', async () => {
    console.log(`Connected as ${client.user.tag}`);
    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.members.fetch(); // populate role member caches
    const roles = await guild.roles.fetch();

    const list = [...roles.values()]
        .sort((a, b) => b.position - a.position) // highest first
        .map(r => ({
            id: r.id,
            name: r.name,
            color: r.hexColor,
            position: r.position,
            mentionable: r.mentionable,
            hoist: r.hoist,
            managed: r.managed, // true = managed by integration (bots, boosters)
            member_count: r.members.size,
        }));

    const json = {
        fetched_at: new Date().toISOString(),
        guild_id: GUILD_ID,
        roles: list,
    };
    const outPath = path.join(__dirname, '..', 'data', 'discord-roles.json');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(json, null, 2));
    console.log(`\nWrote ${outPath}\n`);

    console.log('## Discord Roles (paste into CLAUDE.md)\n');
    console.log('| ID | Name | Members | Notes |');
    console.log('|---|---|---|---|');
    for (const r of list) {
        const notes = [
            r.managed ? 'managed' : null,
            r.mentionable ? 'mentionable' : null,
            r.hoist ? 'hoist' : null,
        ].filter(Boolean).join(', ');
        const safeName = r.name.replace(/[|`\\]/g, '\\$&');
        console.log(`| \`${r.id}\` | ${safeName} | ${r.member_count} | ${notes || '-'} |`);
    }

    client.destroy();
    process.exit(0);
});

client.login(TOKEN);
