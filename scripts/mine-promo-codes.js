/**
 * Fetches all messages from the promo codes channel and attempts to extract
 * AFK Journey promo codes. Prints a clean list + raw message context.
 *
 * Run with:  node scripts/mine-promo-codes.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { Client, GatewayIntentBits } = require('discord.js');

const GUILD_ID = process.env.GUILD_ID;
const TOKEN    = process.env.DISCORD_TOKEN;
const PROMO_CHANNEL_ID = '1229551249209430066';

if (!GUILD_ID || !TOKEN) {
    console.error('Missing GUILD_ID or DISCORD_TOKEN in .env');
    process.exit(1);
}

// AFK Journey promo codes: typically 8-20 char alphanumeric (may include hyphens/underscores),
// often ALL CAPS or mixed, found in code blocks, bold, or standing alone.
// We pick up anything that looks like a short code token from the message text.
const CODE_RE = /\b([A-Z0-9]{4,6}(?:[_\-]?[A-Z0-9]{2,8}){1,4})\b/g;

function extractCodes(text) {
    const raw = text.toUpperCase();
    const hits = new Set();
    for (const m of raw.matchAll(CODE_RE)) {
        const code = m[1];
        // Skip obvious non-codes: pure numbers, very common words, Discord snowflakes (>15 digits)
        if (/^\d+$/.test(code)) continue;
        if (/^(HTTPS|HTTP|WWW|THE|AND|FOR)$/.test(code)) continue;
        hits.add(code);
    }
    return [...hits];
}

async function fetchAllMessages(channel) {
    const messages = [];
    let before = undefined;
    while (true) {
        const batch = await channel.messages.fetch({ limit: 100, before });
        if (batch.size === 0) break;
        for (const [, msg] of batch) messages.push(msg);
        before = batch.last().id;
        if (batch.size < 100) break;
    }
    return messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.once('clientReady', async () => {
    console.log(`Connected as ${client.user.tag}\n`);

    const channel = await client.channels.fetch(PROMO_CHANNEL_ID);
    if (!channel) { console.error('Channel not found'); process.exit(1); }

    console.log(`Fetching messages from #${channel.name}...\n`);
    const messages = await fetchAllMessages(channel);
    console.log(`Fetched ${messages.length} messages.\n`);

    const allCodes = new Set();

    for (const msg of messages) {
        if (!msg.content && !msg.embeds.length) continue;

        // Combine message text + embed titles/descriptions
        const parts = [msg.content];
        for (const e of msg.embeds) {
            if (e.title)       parts.push(e.title);
            if (e.description) parts.push(e.description);
            for (const f of (e.fields ?? [])) parts.push(f.name + ' ' + f.value);
        }
        const fullText = parts.filter(Boolean).join('\n');

        const codes = extractCodes(fullText);
        if (!codes.length) continue;

        const date = msg.createdAt.toISOString().slice(0, 10);
        console.log(`[${date}] ${msg.author.username}`);
        console.log(`  Content: ${msg.content.slice(0, 120).replace(/\n/g, ' ')}`);
        console.log(`  Codes:   ${codes.join(', ')}`);
        console.log();

        for (const c of codes) allCodes.add(c);
    }

    console.log('='.repeat(60));
    console.log(`UNIQUE CODES FOUND (${allCodes.size}):`);
    console.log('='.repeat(60));
    for (const code of [...allCodes].sort()) console.log(`  ${code}`);

    client.destroy();
    process.exit(0);
});

client.login(TOKEN);
