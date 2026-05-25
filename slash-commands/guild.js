const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const db = require('../utils/db');

function fmtPower(val) {
    if (!val) return '0';
    if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`;
    return `${(val / 1_000).toFixed(0)}K`;
}

function getLatestSnapshot() {
    return db.prepare('SELECT id, scraped_at, member_count FROM snapshots ORDER BY id DESC LIMIT 1').get();
}

function getPrevSnapshotId(latestId) {
    return db.prepare('SELECT id FROM snapshots WHERE id < ? ORDER BY id DESC LIMIT 1').get(latestId)?.id ?? null;
}

function snapshotDate(snapshot) {
    return snapshot.scraped_at.slice(0, 16).replace('T', ' ') + ' UTC';
}

function currentWeekStart() {
    const now = new Date();
    const dayOfWeek = now.getUTCDay(); // 0=Sun
    const daysSinceMonday = (dayOfWeek + 6) % 7;
    const monday = new Date(now);
    monday.setUTCDate(now.getUTCDate() - daysSinceMonday);
    monday.setUTCHours(0, 0, 0, 0);
    return monday.toISOString().slice(0, 19);
}

function newMemberIds(snapshotId) {
    const weekStart = currentWeekStart();
    const rows = db.prepare(`
        SELECT ms.member_id FROM member_snapshots ms
        JOIN members m ON m.id = ms.member_id
        WHERE ms.snapshot_id = ? AND m.first_seen >= ?
    `).all(snapshotId, weekStart);
    return new Set(rows.map(r => r.member_id));
}

function afkMemberIds() {
    const rows = db.prepare('SELECT member_id FROM member_afk').all();
    return new Set(rows.map(r => r.member_id));
}

function badge(memberId, newIds, afkIds) {
    let b = '';
    if (afkIds.has(memberId)) b += ' ✈️';
    if (newIds.has(memberId)) b += ' 🆕';
    return b;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('guild')
        .setDescription('Guild member statistics')
        .addSubcommand(s => s.setName('power').setDescription('Members ranked by combat power'))
        .addSubcommand(s => s
            .setName('top')
            .setDescription('Top N members by combat power')
            .addIntegerOption(o => o.setName('number').setDescription('How many to show (default 10)').setMinValue(1).setMaxValue(50).setRequired(false))
        )
        .addSubcommand(s => s.setName('inactive').setDescription('Members ranked by inactivity (longest offline first)'))
        .addSubcommand(s => s.setName('activeness').setDescription('Members ranked by activeness (lowest first)'))
        .addSubcommand(s => s.setName('growth').setDescription('Top 5 power growth since last snapshot'))
        .addSubcommand(s => s.setName('status').setDescription('Guild summary'))
        .addSubcommand(s => s.setName('newcomers').setDescription('Members not in the previous snapshot'))
        .addSubcommand(s => s.setName('nogrowth').setDescription('Members with no power growth since last snapshot'))
        .addSubcommand(s => s
            .setName('chart')
            .setDescription('Power growth over time for current members (last 10 scans)')
            .addIntegerOption(o => o.setName('number').setDescription('Limit to top N by power (default: all current members)').setMinValue(1).setMaxValue(30).setRequired(false))
        ),

    async execute(interaction) {
        const snapshot = getLatestSnapshot();
        if (!snapshot) {
            return interaction.reply({ content: 'No snapshot data yet · run `/scan` first.', flags: MessageFlags.Ephemeral });
        }

        switch (interaction.options.getSubcommand()) {
            case 'power':      return handlePower(interaction, snapshot);
            case 'top':        return handleTop(interaction, snapshot);
            case 'inactive':   return handleInactive(interaction, snapshot);
            case 'activeness': return handleActiveness(interaction, snapshot);
            case 'growth':     return handleGrowth(interaction, snapshot);
            case 'status':     return handleStatus(interaction, snapshot);
            case 'newcomers':  return handleNewcomers(interaction, snapshot);
            case 'nogrowth':   return handleNoGrowth(interaction, snapshot);
            case 'chart':      return handleChart(interaction, snapshot);
        }
    },
};

async function handlePower(interaction, snapshot) {
    const rows = db.prepare(`
        SELECT ms.member_id, ms.name, ms.combat_power_value
        FROM member_snapshots ms WHERE ms.snapshot_id = ?
        ORDER BY ms.combat_power_value DESC
    `).all(snapshot.id);

    const newIds = newMemberIds(snapshot.id);
    const afkIds = afkMemberIds();
    const lines = rows.map((r, i) =>
        `\`${String(i + 1).padStart(2)}.\` **${r.name}**${badge(r.member_id, newIds, afkIds)} · ${fmtPower(r.combat_power_value)}`
    );

    await interaction.reply({ embeds: [
        new EmbedBuilder()
            .setTitle('⚔️ Guild Power Rankings')
            .setDescription(lines.join('\n'))
            .setFooter({ text: snapshotDate(snapshot) })
            .setColor(0xf4a400),
    ]});
}

async function handleTop(interaction, snapshot) {
    const n = interaction.options.getInteger('number') ?? 10;
    const rows = db.prepare(`
        SELECT ms.member_id, ms.name, ms.combat_power_value
        FROM member_snapshots ms WHERE ms.snapshot_id = ?
        ORDER BY ms.combat_power_value DESC
        LIMIT ?
    `).all(snapshot.id, n);

    const newIds = newMemberIds(snapshot.id);
    const afkIds = afkMemberIds();
    const lines = rows.map((r, i) =>
        `\`${String(i + 1).padStart(2)}.\` **${r.name}**${badge(r.member_id, newIds, afkIds)} · ${fmtPower(r.combat_power_value)}`
    );

    await interaction.reply({ embeds: [
        new EmbedBuilder()
            .setTitle(`⚔️ Top ${n} by Power`)
            .setDescription(lines.join('\n'))
            .setFooter({ text: snapshotDate(snapshot) })
            .setColor(0xf4a400),
    ]});
}

async function handleInactive(interaction, snapshot) {
    const rows = db.prepare(`
        SELECT ms.member_id, ms.name, ms.last_active, ms.activeness
        FROM member_snapshots ms WHERE ms.snapshot_id = ?
        ORDER BY ms.last_seen_approx ASC
    `).all(snapshot.id);

    const newIds = newMemberIds(snapshot.id);
    const afkIds = afkMemberIds();
    const lines = rows.map((r, i) =>
        `\`${String(i + 1).padStart(2)}.\` **${r.name}**${badge(r.member_id, newIds, afkIds)} · ${r.last_active} · ${r.activeness} act`
    );

    await interaction.reply({ embeds: [
        new EmbedBuilder()
            .setTitle('💤 Guild Inactivity')
            .setDescription(lines.join('\n'))
            .setFooter({ text: snapshotDate(snapshot) })
            .setColor(0x888888),
    ]});
}

async function handleActiveness(interaction, snapshot) {
    const rows = db.prepare(`
        SELECT ms.member_id, ms.name, ms.activeness, ms.last_active
        FROM member_snapshots ms WHERE ms.snapshot_id = ?
        ORDER BY ms.activeness ASC
    `).all(snapshot.id);

    const newIds = newMemberIds(snapshot.id);
    const afkIds = afkMemberIds();
    const lines = rows.map((r, i) =>
        `\`${String(i + 1).padStart(2)}.\` **${r.name}**${badge(r.member_id, newIds, afkIds)} · ${r.activeness} act · ${r.last_active}`
    );

    await interaction.reply({ embeds: [
        new EmbedBuilder()
            .setTitle('📊 Guild Activeness')
            .setDescription(lines.join('\n'))
            .setFooter({ text: snapshotDate(snapshot) })
            .setColor(0x3498db),
    ]});
}

async function handleGrowth(interaction, snapshot) {
    const prevId = getPrevSnapshotId(snapshot.id);
    if (!prevId) {
        return interaction.reply({ content: 'Need at least 2 snapshots to show growth.', flags: MessageFlags.Ephemeral });
    }

    const rows = db.prepare(`
        SELECT ms2.name,
               ms2.combat_power_value  AS current_power,
               ms1.combat_power_value  AS prev_power,
               (ms2.combat_power_value - COALESCE(ms1.combat_power_value, 0)) AS growth
        FROM member_snapshots ms2
        LEFT JOIN member_snapshots ms1 ON ms1.member_id = ms2.member_id AND ms1.snapshot_id = ?
        WHERE ms2.snapshot_id = ?
        ORDER BY growth DESC
        LIMIT 5
    `).all(prevId, snapshot.id);

    const medals = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
    const embed = new EmbedBuilder()
        .setTitle('📈 Top 5 Power Growth')
        .setFooter({ text: 'Compared to previous snapshot' })
        .setColor(0x2ecc71);

    rows.forEach((r, i) => {
        const g = r.growth || 0;
        const growthStr = g > 0 ? `+${fmtPower(g)}` : g < 0 ? `-${fmtPower(Math.abs(g))}` : '+0';
        embed.addFields({
            name: `${medals[i]} ${r.name}`,
            value: `${growthStr}  →  **${fmtPower(r.current_power)}**`,
            inline: false,
        });
    });

    await interaction.reply({ embeds: [embed] });
}

async function handleStatus(interaction, snapshot) {
    const s = db.prepare(`
        SELECT COUNT(*) AS total,
               SUM(combat_power_value) AS total_power,
               SUM(CASE WHEN last_seen_approx >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS active_today,
               SUM(CASE WHEN activeness > 0 THEN 1 ELSE 0 END) AS active_week
        FROM member_snapshots WHERE snapshot_id = ?
    `).get(snapshot.id);

    await interaction.reply({ embeds: [
        new EmbedBuilder()
            .setTitle('🏰 Guild Status')
            .addFields(
                { name: 'Members',          value: `${s.total}`,              inline: true },
                { name: 'Total Power',      value: fmtPower(s.total_power),   inline: true },
                { name: 'Active Today',     value: `${s.active_today}`,       inline: true },
                { name: 'Active This Week', value: `${s.active_week}`,        inline: true },
                { name: 'Last Scan',        value: snapshotDate(snapshot),    inline: true },
            )
            .setColor(0x9b59b6),
    ]});
}

async function handleNoGrowth(interaction, snapshot) {
    const prevId = getPrevSnapshotId(snapshot.id);
    if (!prevId) {
        return interaction.reply({ content: 'Need at least 2 snapshots to show growth data.', flags: MessageFlags.Ephemeral });
    }

    const rows = db.prepare(`
        SELECT ms2.member_id,
               ms2.name,
               ms2.combat_power_value AS current_power,
               (ms2.combat_power_value - ms1.combat_power_value) AS growth
        FROM member_snapshots ms2
        JOIN member_snapshots ms1 ON ms1.member_id = ms2.member_id AND ms1.snapshot_id = ?
        WHERE ms2.snapshot_id = ?
          AND (ms2.combat_power_value - ms1.combat_power_value) <= 0
        ORDER BY growth ASC
    `).all(prevId, snapshot.id);

    if (rows.length === 0) {
        return interaction.reply({ content: '✅ Everyone grew this week!', ephemeral: false });
    }

    const newIds = newMemberIds(snapshot.id);
    const afkIds = afkMemberIds();
    const lines = rows.map((r, i) =>
        `\`${String(i + 1).padStart(2)}.\` **${r.name}**${badge(r.member_id, newIds, afkIds)} · ${fmtPower(r.current_power)}`
    );

    await interaction.reply({ embeds: [
        new EmbedBuilder()
            .setTitle('📉 No Power Growth')
            .setDescription(lines.join('\n'))
            .setFooter({ text: 'Compared to previous snapshot' })
            .setColor(0xe74c3c),
    ]});
}

const CHART_COLORS = [
    'rgb(255,99,132)',  'rgb(54,162,235)',  'rgb(255,205,86)',  'rgb(75,192,192)',
    'rgb(153,102,255)', 'rgb(255,159,64)',  'rgb(0,200,100)',   'rgb(255,80,80)',
    'rgb(0,180,255)',   'rgb(255,140,0)',   'rgb(180,0,255)',   'rgb(0,220,180)',
    'rgb(200,200,0)',   'rgb(255,60,180)',  'rgb(80,200,80)',   'rgb(100,100,255)',
    'rgb(255,120,120)', 'rgb(0,160,160)',   'rgb(200,100,0)',   'rgb(120,80,200)',
    'rgb(255,200,100)', 'rgb(60,200,255)',  'rgb(200,60,60)',   'rgb(0,180,100)',
    'rgb(200,180,0)',   'rgb(100,200,255)', 'rgb(255,100,200)', 'rgb(60,160,60)',
    'rgb(255,180,60)',  'rgb(160,60,255)',
];

async function handleChart(interaction, snapshot) {
    const n = interaction.options.getInteger('number') ?? 999;

    // Current active members only — whoever is in the latest snapshot
    const topMembers = db.prepare(`
        SELECT ms.member_id, m.ingame_name
        FROM member_snapshots ms
        JOIN members m ON m.id = ms.member_id
        WHERE ms.snapshot_id = ?
        ORDER BY ms.combat_power_value DESC
        LIMIT ?
    `).all(snapshot.id, n);

    if (topMembers.length === 0) {
        return interaction.reply({ content: 'No snapshot data yet · run `/scan` first.', flags: MessageFlags.Ephemeral });
    }

    // Last 10 scans in chronological order
    const allSnapshots = db.prepare(
        'SELECT id, scraped_at FROM snapshots ORDER BY scraped_at DESC LIMIT 10'
    ).all().reverse();
    const labels = allSnapshots.map(s => s.scraped_at.slice(0, 10));

    const datasets = topMembers.map((member, i) => {
        const rows = db.prepare(
            'SELECT snapshot_id, combat_power_value FROM member_snapshots WHERE member_id = ?'
        ).all(member.member_id);
        const bySnapshot = Object.fromEntries(rows.map(r => [r.snapshot_id, r.combat_power_value]));

        return {
            label: member.ingame_name,
            data: allSnapshots.map(s => bySnapshot[s.id] != null ? +((bySnapshot[s.id]) / 1_000_000).toFixed(2) : null),
            borderColor: CHART_COLORS[i % CHART_COLORS.length],
            backgroundColor: 'rgba(0,0,0,0)',
            fill: false,
            spanGaps: true,
            tension: 0.3,
            pointRadius: 4,
        };
    });

    const config = {
        type: 'line',
        data: { labels, datasets },
        options: {
            title: { display: true, text: `Guild Power · Last ${allSnapshots.length} Scans`, fontSize: 15 },
            scales: {
                yAxes: [{ scaleLabel: { display: true, labelString: 'Power (M)' } }],
            },
            elements: { line: { borderWidth: 2 } },
        },
    };

    await interaction.deferReply();

    const res = await fetch('https://quickchart.io/chart/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chart: config, width: 800, height: 450, backgroundColor: 'white' }),
    });
    const { url } = await res.json();

    await interaction.editReply({ embeds: [
        new EmbedBuilder()
            .setTitle(`📈 Guild Power Growth · Last ${allSnapshots.length} Scans`)
            .setImage(url)
            .setFooter({ text: snapshotDate(snapshot) })
            .setColor(0xf4a400),
    ]});
}

async function handleNewcomers(interaction, snapshot) {
    const prevId = getPrevSnapshotId(snapshot.id);
    if (!prevId) {
        return interaction.reply({ content: 'Need at least 2 snapshots to show newcomers.', flags: MessageFlags.Ephemeral });
    }

    const rows = db.prepare(`
        SELECT ms2.name, ms2.combat_power, ms2.activeness
        FROM member_snapshots ms2
        WHERE ms2.snapshot_id = ?
          AND ms2.member_id IS NOT NULL
          AND ms2.member_id NOT IN (
              SELECT member_id FROM member_snapshots
              WHERE snapshot_id = ? AND member_id IS NOT NULL
          )
    `).all(snapshot.id, prevId);

    if (rows.length === 0) {
        return interaction.reply({ content: '✅ No new members since the previous snapshot.', ephemeral: false });
    }

    const lines = rows.map(r => `• **${r.name}** · ${r.combat_power} | ${r.activeness} act`);

    await interaction.reply({ embeds: [
        new EmbedBuilder()
            .setTitle('🆕 New Members')
            .setDescription(lines.join('\n'))
            .setFooter({ text: snapshotDate(snapshot) })
            .setColor(0x1abc9c),
    ]});
}
