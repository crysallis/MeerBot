/**
 * One-time backfill: fetches all historical messages from the promo codes channel
 * and seeds the promo_codes table. Safe to re-run (INSERT OR IGNORE on code UNIQUE).
 *
 * Run with:  node scripts/backfill-promo-codes.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { Client, GatewayIntentBits } = require('discord.js');
const db = require('../utils/db');
const { extractCodes } = require('../utils/handlers/promoCodeHandler');

const PROMO_CHANNEL_ID = '1229551249209430066';
const TOKEN = process.env.DISCORD_TOKEN;

if (!TOKEN) { console.error('Missing DISCORD_TOKEN in .env'); process.exit(1); }

const insertCode = db.prepare(
    `INSERT OR IGNORE INTO promo_codes (code, posted_at, message_id) VALUES (?, ?, ?)`
);

async function fetchAllMessages(channel) {
    const messages = [];
    let before;
    while (true) {
        const batch = await channel.messages.fetch({ limit: 100, before });
        if (batch.size === 0) break;
        for (const [, msg] of batch) messages.push(msg);
        before = batch.last().id;
        if (batch.size < 100) break;
    }
    return messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.once('clientReady', async () => {
    console.log(`Connected as ${client.user.tag}`);
    const channel = await client.channels.fetch(PROMO_CHANNEL_ID);
    console.log(`Fetching messages from #${channel.name}...`);
    const messages = await fetchAllMessages(channel);
    console.log(`Fetched ${messages.length} messages.\n`);

    let saved = 0;
    let skipped = 0;

    for (const msg of messages) {
        const parts = [msg.content || ''];
        for (const e of msg.embeds) {
            if (e.title)       parts.push(e.title);
            if (e.description) parts.push(e.description);
            for (const f of (e.fields ?? [])) parts.push(f.value);
        }
        const fullText = parts.join('\n');
        if (!fullText.trim()) continue;

        const codes = extractCodes(fullText);
        const postedAt = msg.createdAt.toISOString();

        for (const code of codes) {
            const result = insertCode.run(code, postedAt, msg.id);
            if (result.changes > 0) {
                console.log(`  + ${code}  (${postedAt.slice(0, 10)})`);
                saved++;
            } else {
                skipped++;
            }
        }
    }

    console.log(`\nDone. ${saved} codes inserted, ${skipped} already existed or skipped.`);

    const total = db.prepare('SELECT COUNT(*) AS n FROM promo_codes').get().n;
    console.log(`Total codes in DB: ${total}`);

    client.destroy();
    process.exit(0);
});

client.login(TOKEN);
