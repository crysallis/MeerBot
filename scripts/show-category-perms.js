require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Client, GatewayIntentBits, ChannelType } = require('discord.js');

const GUILD_ID = process.env.GUILD_ID;
const TOKEN = process.env.DISCORD_TOKEN;
const TARGET = process.argv[2] ?? '';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', async () => {
    const guild = await client.guilds.fetch(GUILD_ID);
    const channels = await guild.channels.fetch();
    const roles = await guild.roles.fetch();

    const roleMap = new Map(roles.map(r => [r.id, r.name]));

    const categories = [...channels.values()].filter(c => c?.type === ChannelType.GuildCategory);
    const match = TARGET
        ? categories.find(c => c.name.toLowerCase().includes(TARGET.toLowerCase()))
        : null;

    const targets = match ? [match] : categories;

    for (const cat of targets) {
        console.log(`\nCategory: ${cat.name} (${cat.id})`);
        if (!cat.permissionOverwrites.cache.size) {
            console.log('  (no overwrites -- inherits from @everyone defaults)');
            continue;
        }
        for (const [id, overwrite] of cat.permissionOverwrites.cache) {
            const name = overwrite.type === 0 ? `@${roleMap.get(id) ?? id}` : `user:${id}`;
            const allowed = overwrite.allow.toArray();
            const denied = overwrite.deny.toArray();
            console.log(`  ${name}`);
            if (allowed.length) console.log(`    ALLOW: ${allowed.join(', ')}`);
            if (denied.length)  console.log(`    DENY:  ${denied.join(', ')}`);
        }

        // Also list child channels and whether they're synced
        const children = [...channels.values()]
            .filter(c => c?.parentId === cat.id)
            .sort((a, b) => a.position - b.position);
        if (children.length) {
            console.log('  Channels:');
            for (const ch of children) {
                const synced = ch.permissionsLocked ?? false;
                console.log(`    ${synced ? '[synced]' : '[CUSTOM]'} ${ch.name} (${ch.id})`);
            }
        }
    }

    client.destroy();
    process.exit(0);
});

client.login(TOKEN);
