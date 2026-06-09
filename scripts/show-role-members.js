require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Client, GatewayIntentBits } = require('discord.js');

const GUILD_ID = process.env.GUILD_ID;
const TOKEN = process.env.DISCORD_TOKEN;

const LEADER_ROLES = [
    'Riff', 'Raff',
    'Queen of the Frogs', 'Penguin-Admiral',
    'Kingdom-Emperor', 'Sobaquitos-Leader',
];

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once('clientReady', async () => {
    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.members.fetch();

    const roles = await guild.roles.fetch();
    const roleMap = new Map(roles.map(r => [r.name, r]));

    for (const roleName of LEADER_ROLES) {
        const role = roleMap.get(roleName);
        if (!role) { console.log(`\n${roleName}: (role not found)`); continue; }
        const members = [...role.members.values()].map(m => m.displayName).sort();
        console.log(`\n${roleName} (${members.length}):`);
        members.forEach(n => console.log(`  ${n}`));
    }

    client.destroy();
    process.exit(0);
});

client.login(TOKEN);
