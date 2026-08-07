/**
 * One-time audit: check Discord's actual role holders against the invariant
 * "anyone holding a warband role must also hold that warband's guild's
 * top-level guild role" (RKF RiffRaff (Guild) / RKF Frop (Guild)). The
 * reverse is NOT required -- holding a guild role with no warband role is
 * valid (guild membership is broader than warband membership). Checks live
 * Discord role membership directly, not guild.db's warband_id column, since
 * that column can lag behind or omit members who are still real holders of a
 * warband role in Discord. Read-only -- reports mismatches, changes nothing.
 *
 * Written after discovering roster.js's GUILDS map pointed at the wrong role
 * IDs (warband roles instead of the real top-level guild roles) for an
 * unknown period, meaning /roster add, /roster remove, and /roster transfer
 * could all have left members missing their guild-level role. Fixed in
 * roster.js 2026-08-03; this script finds anyone left in a bad state.
 *
 * Run with:  node scripts/audit-guild-roles.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { Client, GatewayIntentBits } = require('discord.js');
const { GUILDS } = require('../slash-commands/roster');

const GUILD_ID = process.env.GUILD_ID;
const TOKEN = process.env.DISCORD_TOKEN;

const RIFFRAFF_GUILD_ROLE_ID = GUILDS.riffraff.id;
const FROP_GUILD_ROLE_ID     = GUILDS.frop.id;

// Warband roles that require RKF RiffRaff (Guild).
const RIFFRAFF_WARBAND_ROLES = {
    '1401783863960666143': 'RiffRaff (Warband)',
    '1434417743616147557': 'Kingdom (Warband)',
    '1509752237193429104': 'Sobaquitos (Warband)',
};

// Warband roles that require RKF Frop (Guild).
const FROP_WARBAND_ROLES = {
    '1482484067965599846': 'Penguins',
    '1299596817402695680': 'Frog',
};

if (!GUILD_ID || !TOKEN) {
    console.error('Missing GUILD_ID or DISCORD_TOKEN in .env');
    process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once('clientReady', async () => {
    console.log(`Connected as ${client.user.tag}`);
    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.members.fetch(); // populate role caches

    const mismatches = [];

    function checkGroup(warbandRoles, requiredGuildRoleId, requiredGuildLabel) {
        for (const [warbandRoleId, warbandLabel] of Object.entries(warbandRoles)) {
            const role = guild.roles.cache.get(warbandRoleId);
            if (!role) {
                console.log(`Warning: warband role ${warbandRoleId} (${warbandLabel}) not found in this guild -- skipping.`);
                continue;
            }
            for (const member of role.members.values()) {
                if (!member.roles.cache.has(requiredGuildRoleId)) {
                    mismatches.push({
                        name: member.displayName, discord_id: member.id,
                        issue: `holds "${warbandLabel}" but is missing "${requiredGuildLabel}"`,
                    });
                }
            }
        }
    }

    checkGroup(RIFFRAFF_WARBAND_ROLES, RIFFRAFF_GUILD_ROLE_ID, 'RKF RiffRaff (Guild)');
    checkGroup(FROP_WARBAND_ROLES, FROP_GUILD_ROLE_ID, 'RKF Frop (Guild)');

    console.log(`\nChecked all holders of warband roles across both guilds.\n`);
    if (!mismatches.length) {
        console.log('No mismatches found -- everyone with a warband role also holds the correct guild role.');
    } else {
        console.log(`Found ${mismatches.length} mismatch(es):\n`);
        for (const mm of mismatches) {
            console.log(`- ${mm.name} (<@${mm.discord_id}>)`);
            console.log(`    ${mm.issue}`);
        }
    }

    client.destroy();
    process.exit(0);
});

client.login(TOKEN);
