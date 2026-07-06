/**
 * One-time audit: for each Warband-* Discord role, list members holding that
 * role who are NOT an active member in guild.db (by discord_id), and members
 * holding no Warband role at all but ARE active in guild.db and linked.
 * Read-only -- makes no changes to Discord or the DB.
 *
 * Run with:  node scripts/audit-warband-roles.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { Client, GatewayIntentBits } = require('discord.js');
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../AFKDataMining/guild.db');
const GUILD_ID = process.env.GUILD_ID;
const TOKEN = process.env.DISCORD_TOKEN;

const WARBAND_ROLES = ['Warband-RiffRaff', 'Warband-Kingdom', 'Warband-Sobaquitos'];

if (!GUILD_ID || !TOKEN) {
    console.error('Missing GUILD_ID or DISCORD_TOKEN in .env');
    process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once('clientReady', async () => {
    console.log(`Connected as ${client.user.tag}\n`);

    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.members.fetch();
    const roles = await guild.roles.fetch();
    const roleMap = new Map(roles.map(r => [r.name, r]));

    const activeMembers = db.prepare(`
        SELECT id, ingame_name, discord_id, active
        FROM members WHERE active = 1
    `).all();
    const activeByDiscordId = new Map(
        activeMembers.filter(m => m.discord_id).map(m => [m.discord_id, m])
    );

    console.log(`Active members in guild.db: ${activeMembers.length}`);
    console.log(`  of which linked to Discord: ${activeByDiscordId.size}\n`);

    const roleHolderIds = new Set();

    for (const roleName of WARBAND_ROLES) {
        const role = roleMap.get(roleName);
        if (!role) { console.log(`${roleName}: (role not found)\n`); continue; }

        const members = [...role.members.values()];
        console.log(`${roleName} (${members.length} Discord members):`);

        const notActive = members.filter(m => !activeByDiscordId.has(m.id));
        for (const m of members) roleHolderIds.add(m.id);

        if (notActive.length) {
            console.log(`  Has role but NOT an active guild.db member (${notActive.length}):`);
            notActive.forEach(m => console.log(`    ${m.displayName} (@${m.user.tag}, id=${m.id})`));
        } else {
            console.log('  All role holders match an active member.');
        }
        console.log('');
    }

    const activeNoWarbandRole = activeMembers.filter(
        m => m.discord_id && !roleHolderIds.has(m.discord_id)
    );
    console.log(`Active + linked members with NO Warband-* role (${activeNoWarbandRole.length}):`);
    activeNoWarbandRole.forEach(m => console.log(`  ${m.ingame_name} (discord_id=${m.discord_id})`));

    const activeUnlinked = activeMembers.filter(m => !m.discord_id);
    console.log(`\nActive members with no discord_id linked at all (${activeUnlinked.length}):`);
    activeUnlinked.forEach(m => console.log(`  ${m.ingame_name}`));

    client.destroy();
    process.exit(0);
});

client.login(TOKEN);
