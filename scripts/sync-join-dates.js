/**
 * One-time script: for every linked guild member, update first_seen in the
 * DB to the Discord server join date if that date is earlier than what we have.
 *
 * Run after all members are linked via /link:
 *   node scripts/sync-join-dates.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { Client, GatewayIntentBits } = require('discord.js');
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../AFKDataMining/guild.db');
const GUILD_ID = process.env.GUILD_ID;
const TOKEN = process.env.DISCORD_TOKEN;

if (!GUILD_ID || !TOKEN) {
    console.error('Missing GUILD_ID or DISCORD_TOKEN in .env');
    process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.once('clientReady', async () => {
    console.log(`Connected as ${client.user.tag}`);

    const guild = await client.guilds.fetch(GUILD_ID);
    const discordMembers = await guild.members.fetch();

    console.log(`Fetched ${discordMembers.size} Discord server members.\n`);

    const linked = db.prepare(`
        SELECT id, ingame_name, discord_id, first_seen
        FROM members
        WHERE discord_id IS NOT NULL
    `).all();

    console.log(`${linked.length} linked members in DB:\n`);

    let updated = 0;
    let already_good = 0;
    let not_in_server = 0;

    for (const member of linked) {
        const dm = discordMembers.get(member.discord_id);

        if (!dm) {
            console.log(`  ⚠  ${member.ingame_name} · discord_id ${member.discord_id} not found in server`);
            not_in_server++;
            continue;
        }

        const joinedAt = dm.joinedAt?.toISOString() ?? null;
        if (!joinedAt) {
            console.log(`  ?  ${member.ingame_name} · no joinedAt date available`);
            continue;
        }

        if (joinedAt < member.first_seen) {
            db.prepare('UPDATE members SET first_seen = ? WHERE id = ?').run(joinedAt, member.id);
            console.log(`  +  ${member.ingame_name.padEnd(20)} ${member.first_seen.slice(0, 10)} -> ${joinedAt.slice(0, 10)}`);
            updated++;
        } else {
            console.log(`  =  ${member.ingame_name.padEnd(20)} already correct (${member.first_seen.slice(0, 10)})`);
            already_good++;
        }
    }

    console.log(`\nDone. Updated: ${updated}  Already correct: ${already_good}  Not in server: ${not_in_server}`);

    client.destroy();
    db.close();
    process.exit(0);
});

client.login(TOKEN);
