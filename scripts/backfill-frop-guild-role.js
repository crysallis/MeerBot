/**
 * One-time backfill: add "RKF Frop (Guild)" to everyone currently holding
 * Penguins or Frog (the two RKF Frop warbands), since that guild role was
 * just created and nobody has it yet -- per the invariant "anyone with a
 * warband role must also hold that warband's guild's top-level guild role."
 *
 * Dry-run by default: prints who WOULD be affected, makes no changes.
 * Pass --apply to actually add the role.
 *
 * Run with:  node scripts/backfill-frop-guild-role.js          (dry run)
 *            node scripts/backfill-frop-guild-role.js --apply  (applies)
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { Client, GatewayIntentBits } = require('discord.js');

const GUILD_ID = process.env.GUILD_ID;
const TOKEN = process.env.DISCORD_TOKEN;
const APPLY = process.argv.includes('--apply');

const FROP_GUILD_ROLE_ID = '1533951415633051688';
const FROP_WARBAND_ROLE_IDS = {
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
    console.log(APPLY ? '*** APPLY MODE — roles will be added ***' : 'Dry run — no changes will be made (pass --apply to apply)');

    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.members.fetch();

    const fropGuildRole = guild.roles.cache.get(FROP_GUILD_ROLE_ID);
    if (!fropGuildRole) {
        console.error(`Role ${FROP_GUILD_ROLE_ID} (RKF Frop (Guild)) not found in this guild.`);
        process.exit(1);
    }

    const toAdd = new Map(); // member.id -> { member, warbandLabels: [] }
    for (const [warbandRoleId, warbandLabel] of Object.entries(FROP_WARBAND_ROLE_IDS)) {
        const role = guild.roles.cache.get(warbandRoleId);
        if (!role) {
            console.log(`Warning: warband role ${warbandRoleId} (${warbandLabel}) not found — skipping.`);
            continue;
        }
        for (const member of role.members.values()) {
            if (member.roles.cache.has(FROP_GUILD_ROLE_ID)) continue; // already has it
            if (!toAdd.has(member.id)) toAdd.set(member.id, { member, warbandLabels: [] });
            toAdd.get(member.id).warbandLabels.push(warbandLabel);
        }
    }

    const list = [...toAdd.values()];
    console.log(`\n${list.length} member(s) would receive "RKF Frop (Guild)":\n`);
    for (const { member, warbandLabels } of list) {
        console.log(`- ${member.displayName} (<@${member.id}>) [${warbandLabels.join(', ')}]`);
    }

    if (!APPLY) {
        console.log('\nDry run only — nothing changed. Re-run with --apply to add the role.');
        client.destroy();
        process.exit(0);
    }

    console.log('\nApplying...\n');
    let ok = 0, failed = 0;
    for (const { member } of list) {
        try {
            await member.roles.add(FROP_GUILD_ROLE_ID);
            console.log(`  added -> ${member.displayName}`);
            ok++;
        } catch (err) {
            console.error(`  FAILED -> ${member.displayName}: ${err.message}`);
            failed++;
        }
    }
    console.log(`\nDone. ${ok} succeeded, ${failed} failed.`);

    client.destroy();
    process.exit(0);
});

client.login(TOKEN);
