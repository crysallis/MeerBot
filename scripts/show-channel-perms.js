require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Client, GatewayIntentBits } = require('discord.js');

const GUILD_ID = process.env.GUILD_ID;
const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.argv[2];

if (!CHANNEL_ID) { console.error('Usage: node show-channel-perms.js <channelId>'); process.exit(1); }

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', async () => {
    const guild = await client.guilds.fetch(GUILD_ID);
    const roles = await guild.roles.fetch();
    const roleMap = new Map(roles.map(r => [r.id, r.name]));

    const channel = await guild.channels.fetch(CHANNEL_ID);
    console.log(`\n#${channel.name} (${channel.id})`);
    console.log(`Synced to category: ${channel.permissionsLocked ?? false}`);

    if (!channel.permissionOverwrites.cache.size) {
        console.log('(no overwrites)');
    } else {
        for (const [id, ow] of channel.permissionOverwrites.cache) {
            const name = ow.type === 0 ? `@${roleMap.get(id) ?? id}` : `user:${id}`;
            const allowed = ow.allow.toArray();
            const denied  = ow.deny.toArray();
            console.log(`\n  ${name}`);
            if (allowed.length) console.log(`    ALLOW: ${allowed.join(', ')}`);
            if (denied.length)  console.log(`    DENY:  ${denied.join(', ')}`);
        }
    }

    client.destroy();
    process.exit(0);
});

client.login(TOKEN);
