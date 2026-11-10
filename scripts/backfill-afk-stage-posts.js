/**
 * One-time backfill: reads every message in the AFK stages channel and stores the
 * ones that carry a stage label like [127] or [P127]. Safe to re-run: a message's
 * rows are replaced, never duplicated.
 *
 * Run with:  node scripts/backfill-afk-stage-posts.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { Client, GatewayIntentBits } = require('discord.js');
const db = require('../utils/db');
const stages = require('../utils/afkStages');
const { AFK_STAGES_CHANNEL_ID } = require('../utils/handlers/afkStagePostHandler');

const TOKEN = process.env.DISCORD_TOKEN;

if (!TOKEN) { console.error('Missing DISCORD_TOKEN in .env'); process.exit(1); }

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
    return messages;
}

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.once('clientReady', async () => {
    console.log(`Connected as ${client.user.tag}`);
    const channel = await client.channels.fetch(AFK_STAGES_CHANNEL_ID);
    console.log(`Scanning #${channel.name}...`);

    const messages = await fetchAllMessages(channel);
    console.log(`${messages.length} messages\n`);

    let saved = 0;
    for (const msg of messages.reverse()) {
        const labels = stages.extractLabels(msg.content);
        if (!labels.length) continue;

        stages.savePost(db, {
            message_id: msg.id,
            message_url: msg.url,
            posted_by: msg.author?.id ?? null,
            posted_at: msg.createdAt.toISOString(),
        }, labels);
        console.log(`  + ${labels.map(l => `[${l}]`).join(' ')} by ${msg.author?.tag ?? 'unknown'} (${msg.createdAt.toISOString().slice(0, 10)})`);
        saved++;
    }

    const known = stages.getKnownLabels(db);
    console.log(`\nDone. ${saved} posts saved/updated. ${known.length} distinct labels in the DB.`);

    client.destroy();
    process.exit(0);
});

client.login(TOKEN);
