/**
 * One-time backfill: walks every thread (active + archived) under the easter-eggs
 * forum channel, scans every message for a [Title] post, and seeds title_posts.
 * Safe to re-run (upsert on message_id UNIQUE).
 *
 * Run with:  node scripts/backfill-title-posts.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { Client, GatewayIntentBits } = require('discord.js');
const db = require('../utils/db');
const { extractTitle } = require('../utils/handlers/titlePostHandler');

const EASTER_EGGS_FORUM_ID = '1376292444211118111';
const TOKEN = process.env.DISCORD_TOKEN;

if (!TOKEN) { console.error('Missing DISCORD_TOKEN in .env'); process.exit(1); }

const upsertTitlePost = db.prepare(`
    INSERT INTO title_posts (title, message_id, thread_id, message_url, posted_by, posted_at)
    VALUES (@title, @message_id, @thread_id, @message_url, @posted_by, @posted_at)
    ON CONFLICT(message_id) DO UPDATE SET
        title = excluded.title,
        message_url = excluded.message_url
`);

async function fetchAllThreadMessages(thread) {
    const messages = [];
    let before;
    while (true) {
        const batch = await thread.messages.fetch({ limit: 100, before });
        if (batch.size === 0) break;
        for (const [, msg] of batch) messages.push(msg);
        before = batch.last().id;
        if (batch.size < 100) break;
    }
    return messages;
}

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.once('clientReady', async () => {
    console.log(`Connected as ${client.user.tag}`);
    const forum = await client.channels.fetch(EASTER_EGGS_FORUM_ID);
    console.log(`Scanning threads under #${forum.name}...`);

    const active = await forum.threads.fetchActive();
    const archived = await forum.threads.fetchArchived();
    const threads = [...active.threads.values(), ...archived.threads.values()];
    console.log(`Found ${threads.length} threads (${active.threads.size} active, ${archived.threads.size} archived).\n`);

    let saved = 0;
    let skipped = 0;

    for (const thread of threads) {
        console.log(`--- ${thread.name} (${thread.id}) ---`);
        const messages = await fetchAllThreadMessages(thread);
        console.log(`  ${messages.length} messages`);

        for (const msg of messages) {
            const title = extractTitle(msg.content);
            if (!title) continue;

            const result = upsertTitlePost.run({
                title,
                message_id: msg.id,
                thread_id: thread.id,
                message_url: msg.url,
                posted_by: msg.author?.id ?? null,
                posted_at: msg.createdAt.toISOString(),
            });
            if (result.changes > 0) {
                console.log(`  + [${title}] by ${msg.author?.tag ?? 'unknown'} (${msg.createdAt.toISOString().slice(0, 10)})`);
                saved++;
            } else {
                skipped++;
            }
        }
    }

    console.log(`\nDone. ${saved} title posts saved/updated, ${skipped} unchanged.`);

    const total = db.prepare('SELECT COUNT(*) AS n FROM title_posts').get().n;
    const distinctTitles = db.prepare('SELECT COUNT(DISTINCT title) AS n FROM title_posts').get().n;
    console.log(`Total rows in DB: ${total} (${distinctTitles} distinct titles)`);

    client.destroy();
    process.exit(0);
});

client.login(TOKEN);
