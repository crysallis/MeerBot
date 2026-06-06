const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, MessageFlags } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../utils/db');
const { pickColor } = require('../utils/colors');

const NEWSLETTER_CHANNEL_ID = process.env.NEWSLETTER_CHANNEL_ID || '1303788137876684931';

const anthropic = new Anthropic();

function lastNewsletterDate() {
    const row = db.prepare('SELECT MAX(posted_at) AS d FROM newsletters').get();
    return row?.d ?? '1970-01-01T00:00:00.000Z';
}

function isNMonthsLater(from, today, n) {
    const targetMonth = (from.getUTCMonth() + n) % 12;
    const targetYear = from.getUTCFullYear() + Math.floor((from.getUTCMonth() + n) / 12);
    const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
    const targetDay = Math.min(from.getUTCDate(), lastDay);
    return today.getUTCFullYear() === targetYear
        && today.getUTCMonth() === targetMonth
        && today.getUTCDate() === targetDay;
}

function milestoneFor(firstSeenIso, today) {
    const from = new Date(firstSeenIso);
    if (isNaN(from)) return null;
    if (isNMonthsLater(from, today, 1)) return '1 month';
    if (isNMonthsLater(from, today, 3)) return '3 months';
    if (isNMonthsLater(from, today, 6)) return '6 months';
    if (today.getUTCMonth() === from.getUTCMonth()
        && today.getUTCDate() === from.getUTCDate()
        && today.getUTCFullYear() > from.getUTCFullYear()) {
        const years = today.getUTCFullYear() - from.getUTCFullYear();
        return `${years} year${years === 1 ? '' : 's'}`;
    }
    return null;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('newsletter')
        .setDescription('Guild newsletter tools')
        .addSubcommandGroup(g => g
            .setName('note')
            .setDescription('Manage newsletter notes')
            .addSubcommand(s => s
                .setName('add')
                .setDescription('Add a note or memory for the next newsletter')
                .addStringOption(o => o.setName('text').setDescription('What happened?').setRequired(true))
                .addStringOption(o => o
                    .setName('category')
                    .setDescription('Category (default: other)')
                    .setRequired(false)
                    .addChoices(
                        { name: 'event', value: 'event' },
                        { name: 'member', value: 'member' },
                        { name: 'season', value: 'season' },
                        { name: 'other', value: 'other' },
                    )))
            .addSubcommand(s => s
                .setName('list')
                .setDescription('Show notes since the last newsletter'))
            .addSubcommand(s => s
                .setName('remove')
                .setDescription('Delete a note')
                .addStringOption(o => o
                    .setName('id')
                    .setDescription('Note to remove')
                    .setRequired(true)
                    .setAutocomplete(true))))
        .addSubcommand(s => s
            .setName('generate')
            .setDescription('Generate a draft newsletter using Claude'))
        .addSubcommand(s => s
            .setName('seed')
            .setDescription('Import past newsletters from the newsletter channel')),

    async autocomplete(interaction) {
        const sub = interaction.options.getSubcommand();
        if (sub === 'remove') {
            const notes = db.prepare('SELECT id, note_text FROM newsletter_notes ORDER BY created_at DESC').all();
            const focused = interaction.options.getFocused().toLowerCase();
            const filtered = notes
                .filter(n => String(n.id).includes(focused) || n.note_text.toLowerCase().includes(focused))
                .slice(0, 25);
            await interaction.respond(filtered.map(n => ({
                name: `#${n.id} · ${n.note_text.slice(0, 60)}`,
                value: String(n.id),
            })));
        }
    },

    async execute(interaction) {
        const group = interaction.options.getSubcommandGroup(false);
        const sub = interaction.options.getSubcommand();

        if (group === 'note') {
            if (sub === 'add') return handleNoteAdd(interaction);
            if (sub === 'list') return handleNoteList(interaction);
            if (sub === 'remove') return handleNoteRemove(interaction);
        }
        if (sub === 'generate') return handleGenerate(interaction);
        if (sub === 'seed') return handleSeed(interaction);
    },
};

async function handleNoteAdd(interaction) {
    const text = interaction.options.getString('text');
    const category = interaction.options.getString('category') ?? 'other';
    db.prepare('INSERT INTO newsletter_notes (note_text, category) VALUES (?, ?)').run(text, category);
    await interaction.reply({
        content: `✅ Note added [${category}]: ${text}`,
        flags: MessageFlags.Ephemeral,
    });
}

async function handleNoteList(interaction) {
    const since = lastNewsletterDate();
    const notes = db.prepare(
        'SELECT id, note_text, category, created_at FROM newsletter_notes WHERE created_at > ? ORDER BY created_at ASC'
    ).all(since);

    if (notes.length === 0) {
        return interaction.reply({ content: 'No notes yet since the last newsletter.', flags: MessageFlags.Ephemeral });
    }

    const lines = notes.map(n =>
        `\`#${n.id}\` [${n.category}] **${n.note_text}** · <t:${Math.floor(new Date(n.created_at).getTime() / 1000)}:R>`
    );

    const sinceLabel = since === '1970-01-01T00:00:00.000Z' ? 'all time' : `<t:${Math.floor(new Date(since).getTime() / 1000)}:D>`;

    await interaction.reply({
        embeds: [
            new EmbedBuilder()
                .setTitle(`📝 Newsletter Notes (since ${sinceLabel})`)
                .setDescription(lines.join('\n'))
                .setColor(pickColor()),
        ],
        flags: MessageFlags.Ephemeral,
    });
}

async function handleNoteRemove(interaction) {
    const id = parseInt(interaction.options.getString('id'), 10);
    const note = db.prepare('SELECT id, note_text FROM newsletter_notes WHERE id = ?').get(id);
    if (!note) {
        return interaction.reply({ content: `No note found with ID #${id}.`, flags: MessageFlags.Ephemeral });
    }
    db.prepare('DELETE FROM newsletter_notes WHERE id = ?').run(id);
    await interaction.reply({ content: `🗑️ Removed note #${id}: ${note.note_text}`, flags: MessageFlags.Ephemeral });
}

async function handleGenerate(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const since = lastNewsletterDate();
    const today = new Date();
    const sinceDate = new Date(since);

    // Notes since last newsletter
    const notes = db.prepare(
        'SELECT note_text, category FROM newsletter_notes WHERE created_at > ? ORDER BY created_at ASC'
    ).all(since);

    // New members since last newsletter
    const newMembers = db.prepare(
        'SELECT ingame_name, first_seen FROM members WHERE active = 1 AND first_seen > ? ORDER BY first_seen ASC'
    ).all(since);

    // Members who left since last newsletter
    const departed = db.prepare(
        'SELECT ingame_name FROM members WHERE active = 0 AND pending = 0 AND last_scanned_at > ? ORDER BY last_scanned_at ASC'
    ).all(since);

    // Anniversaries since last newsletter (check each active member)
    const allActive = db.prepare('SELECT ingame_name, first_seen FROM members WHERE active = 1').all();
    const anniversaries = [];
    for (const m of allActive) {
        if (!m.first_seen) continue;
        const checkDate = new Date(sinceDate);
        while (checkDate <= today) {
            const milestone = milestoneFor(m.first_seen, checkDate);
            if (milestone) anniversaries.push({ name: m.ingame_name, milestone, date: checkDate.toISOString().slice(0, 10) });
            checkDate.setUTCDate(checkDate.getUTCDate() + 1);
        }
    }

    // Active season
    const season = db.prepare('SELECT name FROM ally_seasons WHERE active = 1 LIMIT 1').get();

    // Issue number
    const issueCount = db.prepare('SELECT COUNT(*) AS n FROM newsletters').get().n + 1;

    // Latest scan date
    const latestScan = db.prepare('SELECT scraped_at FROM snapshots ORDER BY id DESC LIMIT 1').get();

    // All past newsletters for style reference
    const pastNewsletters = db.prepare('SELECT volume, title, content, posted_at FROM newsletters ORDER BY posted_at ASC').all();

    // ── Build material section (shown at top of file for Kit to review) ──
    const sinceLabel = since === '1970-01-01T00:00:00.000Z' ? 'the beginning' : since.slice(0, 10);
    const materialLines = [
        '════════════════════════════════',
        '  NEWSLETTER MATERIAL',
        '════════════════════════════════',
        `Issue:          #${issueCount}`,
        `Generated:      ${today.toISOString().slice(0, 10)}`,
        `Period covered: since ${sinceLabel}`,
        `Current season: ${season?.name ?? 'unknown'}`,
        `Latest scan:    ${latestScan?.scraped_at?.slice(0, 10) ?? 'unknown'}`,
        '',
        `NEW MEMBERS (${newMembers.length})`,
        newMembers.length > 0
            ? newMembers.map(m => `  · ${m.ingame_name} (joined ${m.first_seen.slice(0, 10)})`).join('\n')
            : '  None',
        '',
        `DEPARTURES (${departed.length})`,
        departed.length > 0
            ? departed.map(m => `  · ${m.ingame_name}`).join('\n')
            : '  None',
        '',
        `ANNIVERSARIES (${anniversaries.length})`,
        anniversaries.length > 0
            ? anniversaries.map(a => `  · ${a.name}: ${a.milestone} (${a.date})`).join('\n')
            : '  None',
        '',
        `NOTES (${notes.length})`,
        notes.length > 0
            ? notes.map(n => `  [${n.category}] ${n.note_text}`).join('\n')
            : '  No notes added',
        '',
        '════════════════════════════════',
        '  DRAFT',
        '════════════════════════════════',
        '',
    ];

    // ── Build Claude prompt ──
    const factLines = [
        `Today's date: ${today.toISOString().slice(0, 10)}`,
        `Period covered: since ${sinceLabel}`,
        `Current season: ${season?.name ?? 'unknown'}`,
        `Issue number: #${issueCount}`,
        '',
        '=== NEW MEMBERS ===',
        newMembers.length > 0
            ? newMembers.map(m => `- ${m.ingame_name} (joined ${m.first_seen.slice(0, 10)})`).join('\n')
            : 'None',
        '',
        '=== DEPARTURES ===',
        departed.length > 0
            ? departed.map(m => `- ${m.ingame_name}`).join('\n')
            : 'None',
        '',
        '=== ANNIVERSARIES ===',
        anniversaries.length > 0
            ? anniversaries.map(a => `- ${a.name}: ${a.milestone}`).join('\n')
            : 'None',
        '',
        '=== NOTES / EVENTS ===',
        notes.length > 0
            ? notes.map(n => `[${n.category}] ${n.note_text}`).join('\n')
            : 'No notes added',
    ];

    const styleSection = pastNewsletters.length > 0
        ? [
            '',
            '=== PAST NEWSLETTERS (style reference, chronological) ===',
            ...pastNewsletters.map((nl, i) =>
                `--- Issue ${i + 1}${nl.volume ? ` (${nl.volume}${nl.title ? ` · ${nl.title}` : ''})` : ''} · ${nl.posted_at.slice(0, 10)} ---\n${nl.content}`
            ),
        ]
        : ['', '=== PAST NEWSLETTERS ===', 'None yet.'];

    const userMessage = [
        'Here is the context for the next RiffRaff newsletter:',
        '',
        ...factLines,
        ...styleSection,
        '',
        '=== INSTRUCTIONS ===',
        'Write a full draft newsletter body in Kit\'s voice, matching the style and structure of past issues.',
        'Weave the facts in naturally -- do not just list them.',
        'Skip sections where there is nothing to report (e.g. no departures, no anniversaries).',
        'Do NOT include a sign-off -- this is a draft that Kit will edit and personalise before posting.',
        'Output only the newsletter body, ready to paste into Discord.',
    ].join('\n');

    let draft;
    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 1500,
            system: [
                'You are helping write a newsletter for RiffRaff, a competitive AFK Journey guild on Discord.',
                'The newsletter is written by Kit, the guild leader (Riff of RiffRaff).',
                'Tone: warm, community-focused, casual but not cringe. Never corporate.',
                'Never use em dashes. Use · as a separator when needed.',
                'Do not use hashtags or filler openers like "Congrats!".',
                'Do not add a sign-off -- Kit will add that herself.',
                'Output only the newsletter body -- no subject line, no quotes around it.',
            ].join(' '),
            messages: [{ role: 'user', content: userMessage }],
        });
        draft = response.content[0].text.trim();
    } catch (err) {
        console.error('[Newsletter] Claude generation failed:', err.message);
        return interaction.editReply({ content: '❌ Claude generation failed. Check bot logs.' });
    }

    const fullOutput = materialLines.join('\n') + draft;
    const attachment = new AttachmentBuilder(Buffer.from(fullOutput, 'utf8'), { name: 'newsletter-draft.txt' });
    await interaction.editReply({
        content: `📰 Issue #${issueCount} · ${newMembers.length} new · ${departed.length} left · ${anniversaries.length} anniversary/ies · ${notes.length} note(s)`,
        files: [attachment],
    });
}

async function handleSeed(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const channel = await interaction.client.channels.fetch(NEWSLETTER_CHANNEL_ID).catch(() => null);
    if (!channel?.isTextBased()) {
        return interaction.editReply({ content: '❌ Could not fetch the newsletter channel.' });
    }

    const existing = new Set(
        db.prepare('SELECT posted_at FROM newsletters').all().map(r => r.posted_at)
    );

    const insert = db.prepare('INSERT INTO newsletters (content, posted_at) VALUES (?, ?)');

    let imported = 0;
    let skipped = 0;
    let lastId = undefined;

    while (true) {
        const fetchOpts = { limit: 100 };
        if (lastId) fetchOpts.before = lastId;

        const batch = await channel.messages.fetch(fetchOpts);
        if (batch.size === 0) break;

        for (const msg of batch.values()) {
            if (msg.author.bot || msg.content.length < 300) continue;
            const ts = msg.createdAt.toISOString();
            if (existing.has(ts)) { skipped++; continue; }
            insert.run(msg.content, ts);
            existing.add(ts);
            imported++;
        }

        lastId = batch.last()?.id;
        if (batch.size < 100) break;
    }

    await interaction.editReply({
        content: `✅ Seed complete · **${imported}** imported · **${skipped}** duplicate(s) skipped`,
    });
}
