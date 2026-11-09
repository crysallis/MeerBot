/**
 * Stand up a new Discord-only guild: guild role, leader role, category, five channels,
 * shared-category access, and the ids recorded in guild.db.
 *
 * Dry run by default: prints everything it would create and changes nothing.
 * Pass --apply to actually do it. Safe to re-run after a partial failure.
 *
 * Run with:  node scripts/onboard-guild.js --name Bulls --leader-role "Bull Boss" --emoji 🐂
 *            node scripts/onboard-guild.js --name Bulls --leader-role "Bull Boss" --emoji 🐂 --apply
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const path = require('path');
const { execFileSync } = require('child_process');
const { Client, GatewayIntentBits } = require('discord.js');
const db = require('../utils/db');
const { runOnboarding } = require('../utils/guildOnboarding');
const { makeDiscordAdapter } = require('../utils/guildOnboardingDiscord');

const GUILD_ID = process.env.GUILD_ID;
const TOKEN = process.env.DISCORD_TOKEN;
const APPLY = process.argv.includes('--apply');

function flag(name) {
    const i = process.argv.indexOf(name);
    return i > -1 ? process.argv[i + 1] : undefined;
}

const name = flag('--name');
const leaderRoleName = flag('--leader-role');
const emoji = flag('--emoji');

if (!name || !leaderRoleName || !emoji) {
    console.error('Usage: node scripts/onboard-guild.js --name <Name> --leader-role <Role name> --emoji <emoji> [--apply]');
    process.exit(1);
}
if (!GUILD_ID || !TOKEN) {
    console.error('Missing GUILD_ID or DISCORD_TOKEN in .env');
    process.exit(1);
}

function refreshSnapshots() {
    for (const script of ['show-server-structure.js', 'list-roles.js']) {
        try {
            execFileSync(process.execPath, [path.join(__dirname, script)], { stdio: 'inherit' });
        } catch (err) {
            console.warn(`Warning: ${script} failed (${err.message}). The guild is created; refresh that file by hand.`);
        }
    }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', async () => {
    console.log(`Connected as ${client.user.tag}`);
    console.log(APPLY ? '*** APPLY MODE: roles, channels and permissions will be created ***'
        : 'Dry run: nothing will be created or changed (pass --apply to apply)');

    let result;
    try {
        const guild = await client.guilds.fetch(GUILD_ID);
        result = await runOnboarding({
            input: { name, leaderRoleName, emoji },
            discord: makeDiscordAdapter(guild),
            h: db,
            apply: APPLY,
            log: line => console.log(line),
        });
    } catch (err) {
        console.error(`Failed: ${err.message}`);
        result = { ok: false, warnings: [] };
    }

    for (const w of result.warnings) console.warn(`Warning: ${w}`);
    await client.destroy();

    if (result.ok && APPLY) refreshSnapshots();
    process.exitCode = result.ok ? 0 : 1;
});

client.login(TOKEN);
