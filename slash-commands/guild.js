const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const db = require('../utils/db');
const { pickColor } = require('../utils/colors');
const { autoDelete } = require('../utils/autoDelete');

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
    const dayOfWeek = now.getUTCDay();
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

// Build a warband filter clause + params for prepared statements
function warbandFilter(warband) {
    return warband
        ? { clause: 'AND ms.warband = ?', extra: [warband] }
        : { clause: '', extra: [] };
}

const WARBAND_OPTION = o => o
    .setName('warband')
    .setDescription('Filter to a specific warband')
    .setAutocomplete(true)
    .setRequired(false);

module.exports = {
    data: new SlashCommandBuilder()
        .setName('guild')
        .setDescription('Guild member statistics')
        .addSubcommand(s => s
            .setName('power')
            .setDescription('Members ranked by combat power')
            .addStringOption(WARBAND_OPTION))
        .addSubcommand(s => s
            .setName('top')
            .setDescription('Top N members by combat power')
            .addIntegerOption(o => o.setName('number').setDescription('How many to show (default 10)').setMinValue(1).setMaxValue(50).setRequired(false))
            .addStringOption(WARBAND_OPTION))
        .addSubcommand(s => s
            .setName('inactive')
            .setDescription('Members ranked by inactivity (longest offline first)')
            .addStringOption(WARBAND_OPTION))
        .addSubcommand(s => s
            .setName('activeness')
            .setDescription('Members ranked by activeness (lowest first)')
            .addStringOption(WARBAND_OPTION))
        .addSubcommand(s => s
            .setName('growth')
            .setDescription('Top 5 power growth since last snapshot')
            .addStringOption(WARBAND_OPTION))
        .addSubcommand(s => s
            .setName('status')
            .setDescription('Guild summary')
            .addStringOption(WARBAND_OPTION))
        .addSubcommand(s => s
            .setName('newcomers')
            .setDescription('Members not in the previous snapshot')
            .addStringOption(WARBAND_OPTION))
        .addSubcommand(s => s
            .setName('nogrowth')
            .setDescription('Members with no power growth since last snapshot')
            .addStringOption(WARBAND_OPTION))
        .addSubcommand(s => s
            .setName('chart')
            .setDescription('Power growth over time for current members (last 10 scans)')
            .addIntegerOption(o => o.setName('number').setDescription('Limit to top N by power (default: all current members)').setMinValue(1).setMaxValue(30).setRequired(false))
            .addStringOption(WARBAND_OPTION))
        .addSubcommand(s => s
            .setName('warbands')
            .setDescription('List all warbands with member counts and stats')),

    async autocomplete(interaction) {
        const focused = interaction.options.getFocused().toLowerCase();
        const filtered = db.getWarbands()
            .filter(w => w.name.toLowerCase().includes(focused))
            .slice(0, 25);
        await interaction.respond(filtered.map(w => ({ name: w.name, value: w.name })));
    },

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
            case 'warbands':   return handleWarbands(interaction, snapshot);
        }
    },
};

async function handlePower(interaction, snapshot) {
    const warband = interaction.options.getString('warband') || null;
    const { clause, extra } = warbandFilter(warband);
    const rows = db.prepare(`
        SELECT ms.member_id, COALESCE(m.ingame_name, ms.name) AS name, ms.combat_power_value
        FROM member_snapshots ms
        JOIN members m ON m.id = ms.member_id AND m.active = 1
        WHERE ms.snapshot_id = ? ${clause}
        ORDER BY ms.combat_power_value DESC
    `).all(snapshot.id, ...extra);

    const newIds = newMemberIds(snapshot.id);
    const afkIds = afkMemberIds();
    const scope = warband ? `${warband} · ` : '';
    const lines = rows.map((r, i) =>
        `\`${String(i + 1).padStart(2)}.\` **${r.name}**${badge(r.member_id, newIds, afkIds)} · ${fmtPower(r.combat_power_value)}`
    );

    await interaction.reply({ embeds: [
        new EmbedBuilder()
            .setTitle(`⚔️ ${scope}Power Rankings`)
            .setDescription(lines.join('\n'))
            .setFooter({ text: snapshotDate(snapshot) })
            .setColor(pickColor()),
    ]});
    autoDelete(interaction);
}

async function handleTop(interaction, snapshot) {
    const n = interaction.options.getInteger('number') ?? 10;
    const warband = interaction.options.getString('warband') || null;
    const { clause, extra } = warbandFilter(warband);
    const rows = db.prepare(`
        SELECT ms.member_id, COALESCE(m.ingame_name, ms.name) AS name, ms.combat_power_value
        FROM member_snapshots ms
        JOIN members m ON m.id = ms.member_id AND m.active = 1
        WHERE ms.snapshot_id = ? ${clause}
        ORDER BY ms.combat_power_value DESC
        LIMIT ?
    `).all(snapshot.id, ...extra, n);

    const newIds = newMemberIds(snapshot.id);
    const afkIds = afkMemberIds();
    const scope = warband ? `${warband} · ` : '';
    const lines = rows.map((r, i) =>
        `\`${String(i + 1).padStart(2)}.\` **${r.name}**${badge(r.member_id, newIds, afkIds)} · ${fmtPower(r.combat_power_value)}`
    );

    await interaction.reply({ embeds: [
        new EmbedBuilder()
            .setTitle(`⚔️ ${scope}Top ${n} by Power`)
            .setDescription(lines.join('\n'))
            .setFooter({ text: snapshotDate(snapshot) })
            .setColor(pickColor()),
    ]});
    autoDelete(interaction);
}

async function handleInactive(interaction, snapshot) {
    const warband = interaction.options.getString('warband') || null;
    const { clause, extra } = warbandFilter(warband);
    const rows = db.prepare(`
        SELECT ms.member_id, COALESCE(m.ingame_name, ms.name) AS name, ms.last_active, ms.activeness
        FROM member_snapshots ms
        JOIN members m ON m.id = ms.member_id AND m.active = 1
        WHERE ms.snapshot_id = ? ${clause}
        ORDER BY ms.last_seen_approx ASC
    `).all(snapshot.id, ...extra);

    const newIds = newMemberIds(snapshot.id);
    const afkIds = afkMemberIds();
    const scope = warband ? `${warband} · ` : '';
    const lines = rows.map((r, i) =>
        `\`${String(i + 1).padStart(2)}.\` **${r.name}**${badge(r.member_id, newIds, afkIds)} · ${r.last_active} · ${r.activeness} act`
    );

    await interaction.reply({ embeds: [
        new EmbedBuilder()
            .setTitle(`💤 ${scope}Inactivity`)
            .setDescription(lines.join('\n'))
            .setFooter({ text: snapshotDate(snapshot) })
            .setColor(pickColor()),
    ]});
    autoDelete(interaction);
}

async function handleActiveness(interaction, snapshot) {
    const warband = interaction.options.getString('warband') || null;
    const { clause, extra } = warbandFilter(warband);
    const rows = db.prepare(`
        SELECT ms.member_id, COALESCE(m.ingame_name, ms.name) AS name, ms.activeness, ms.last_active
        FROM member_snapshots ms
        JOIN members m ON m.id = ms.member_id AND m.active = 1
        WHERE ms.snapshot_id = ? ${clause}
        ORDER BY ms.activeness ASC
    `).all(snapshot.id, ...extra);

    const newIds = newMemberIds(snapshot.id);
    const afkIds = afkMemberIds();
    const scope = warband ? `${warband} · ` : '';
    const lines = rows.map((r, i) =>
        `\`${String(i + 1).padStart(2)}.\` **${r.name}**${badge(r.member_id, newIds, afkIds)} · ${r.activeness} act · ${r.last_active}`
    );

    await interaction.reply({ embeds: [
        new EmbedBuilder()
            .setTitle(`📊 ${scope}Activeness`)
            .setDescription(lines.join('\n'))
            .setFooter({ text: snapshotDate(snapshot) })
            .setColor(pickColor()),
    ]});
    autoDelete(interaction);
}

async function handleGrowth(interaction, snapshot) {
    const prevId = getPrevSnapshotId(snapshot.id);
    if (!prevId) {
        return interaction.reply({ content: 'Need at least 2 snapshots to show growth.', flags: MessageFlags.Ephemeral });
    }

    const warband = interaction.options.getString('warband') || null;
    const warbandClause = warband ? 'AND ms2.warband = ?' : '';
    const params = warband ? [prevId, snapshot.id, warband] : [prevId, snapshot.id];

    const rows = db.prepare(`
        SELECT COALESCE(m.ingame_name, ms2.name) AS name,
               ms2.combat_power_value  AS current_power,
               ms1.combat_power_value  AS prev_power,
               (ms2.combat_power_value - COALESCE(ms1.combat_power_value, 0)) AS growth
        FROM member_snapshots ms2
        JOIN members m ON m.id = ms2.member_id AND m.active = 1
        LEFT JOIN member_snapshots ms1 ON ms1.member_id = ms2.member_id AND ms1.snapshot_id = ?
        WHERE ms2.snapshot_id = ? ${warbandClause}
        ORDER BY growth DESC
        LIMIT 5
    `).all(...params);

    const scope = warband ? `${warband} · ` : '';
    const medals = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
    const embed = new EmbedBuilder()
        .setTitle(`📈 ${scope}Top 5 Power Growth`)
        .setFooter({ text: 'Compared to previous snapshot' })
        .setColor(pickColor());

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
    autoDelete(interaction);
}

async function handleStatus(interaction, snapshot) {
    const warband = interaction.options.getString('warband') || null;
    const { clause, extra } = warbandFilter(warband);
    const s = db.prepare(`
        SELECT COUNT(*) AS total,
               SUM(combat_power_value) AS total_power,
               SUM(CASE WHEN ms.last_active = 'Online' OR ms.last_active LIKE '%h ago' OR ms.last_active LIKE '%m ago' THEN 1 ELSE 0 END) AS active_today,
               SUM(CASE WHEN activeness > 0 THEN 1 ELSE 0 END) AS active_week
        FROM member_snapshots ms
        JOIN members m ON m.id = ms.member_id AND m.active = 1
        WHERE ms.snapshot_id = ? ${clause}
    `).get(snapshot.id, ...extra);

    const scope = warband ? `${warband} · ` : '';
    await interaction.reply({ embeds: [
        new EmbedBuilder()
            .setTitle(`🏰 ${scope}Status`)
            .addFields(
                { name: 'Members',          value: `${s.total}`,              inline: true },
                { name: 'Total Power',      value: fmtPower(s.total_power),   inline: true },
                { name: 'Active Today',     value: `${s.active_today}`,       inline: true },
                { name: 'Active This Week', value: `${s.active_week}`,        inline: true },
                { name: 'Last Scan',        value: snapshotDate(snapshot),    inline: true },
            )
            .setColor(pickColor()),
    ]});
    autoDelete(interaction);
}

async function handleNoGrowth(interaction, snapshot) {
    const prevId = getPrevSnapshotId(snapshot.id);
    if (!prevId) {
        return interaction.reply({ content: 'Need at least 2 snapshots to show growth data.', flags: MessageFlags.Ephemeral });
    }

    const warband = interaction.options.getString('warband') || null;
    const warbandClause = warband ? 'AND ms2.warband = ?' : '';
    const params = warband ? [prevId, snapshot.id, warband] : [prevId, snapshot.id];

    const rows = db.prepare(`
        SELECT ms2.member_id,
               COALESCE(m.ingame_name, ms2.name) AS name,
               ms2.combat_power_value AS current_power,
               (ms2.combat_power_value - ms1.combat_power_value) AS growth
        FROM member_snapshots ms2
        JOIN members m ON m.id = ms2.member_id AND m.active = 1
        JOIN member_snapshots ms1 ON ms1.member_id = ms2.member_id AND ms1.snapshot_id = ?
        WHERE ms2.snapshot_id = ?
          AND (ms2.combat_power_value - ms1.combat_power_value) <= 0
          ${warbandClause}
        ORDER BY growth ASC
    `).all(...params);

    if (rows.length === 0) {
        await interaction.reply({ content: '✅ Everyone grew this week!' });
        autoDelete(interaction);
        return;
    }

    const newIds = newMemberIds(snapshot.id);
    const afkIds = afkMemberIds();
    const scope = warband ? `${warband} · ` : '';
    const lines = rows.map((r, i) =>
        `\`${String(i + 1).padStart(2)}.\` **${r.name}**${badge(r.member_id, newIds, afkIds)} · ${fmtPower(r.current_power)}`
    );

    await interaction.reply({ embeds: [
        new EmbedBuilder()
            .setTitle(`📉 ${scope}No Power Growth`)
            .setDescription(lines.join('\n'))
            .setFooter({ text: 'Compared to previous snapshot' })
            .setColor(pickColor()),
    ]});
    autoDelete(interaction);
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
    const warband = interaction.options.getString('warband') || null;
    const { clause, extra } = warbandFilter(warband);

    const topMembers = db.prepare(`
        SELECT ms.member_id, m.ingame_name
        FROM member_snapshots ms
        JOIN members m ON m.id = ms.member_id
        WHERE ms.snapshot_id = ? AND m.active = 1 ${clause}
        ORDER BY ms.combat_power_value DESC
        LIMIT ?
    `).all(snapshot.id, ...extra, n);

    if (topMembers.length === 0) {
        return interaction.reply({ content: 'No snapshot data yet · run `/scan` first.', flags: MessageFlags.Ephemeral });
    }

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

    const scope = warband ? `${warband} · ` : '';
    const config = {
        type: 'line',
        data: { labels, datasets },
        options: {
            title: { display: true, text: `${scope}Power · Last ${allSnapshots.length} Scans`, fontSize: 15 },
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
            .setTitle(`📈 ${scope}Power Growth · Last ${allSnapshots.length} Scans`)
            .setImage(url)
            .setFooter({ text: snapshotDate(snapshot) })
            .setColor(pickColor()),
    ]});
    autoDelete(interaction);
}

async function handleNewcomers(interaction, snapshot) {
    const prevId = getPrevSnapshotId(snapshot.id);
    if (!prevId) {
        return interaction.reply({ content: 'Need at least 2 snapshots to show newcomers.', flags: MessageFlags.Ephemeral });
    }

    const warband = interaction.options.getString('warband') || null;
    const warbandClause = warband ? 'AND ms2.warband = ?' : '';
    const params = warband ? [snapshot.id, prevId, warband] : [snapshot.id, prevId];

    const rows = db.prepare(`
        SELECT COALESCE(m.ingame_name, ms2.name) AS name, ms2.combat_power, ms2.activeness
        FROM member_snapshots ms2
        JOIN members m ON m.id = ms2.member_id AND m.active = 1
        WHERE ms2.snapshot_id = ?
          AND ms2.member_id NOT IN (
              SELECT member_id FROM member_snapshots
              WHERE snapshot_id = ? AND member_id IS NOT NULL
          )
          ${warbandClause}
    `).all(...params);

    if (rows.length === 0) {
        await interaction.reply({ content: '✅ No new members since the previous snapshot.' });
        autoDelete(interaction);
        return;
    }

    const scope = warband ? `${warband} · ` : '';
    const lines = rows.map(r => `• **${r.name}** · ${r.combat_power} | ${r.activeness} act`);

    await interaction.reply({ embeds: [
        new EmbedBuilder()
            .setTitle(`🆕 ${scope}New Members`)
            .setDescription(lines.join('\n'))
            .setFooter({ text: snapshotDate(snapshot) })
            .setColor(pickColor()),
    ]});
    autoDelete(interaction);
}

async function handleWarbands(interaction, snapshot) {
    const rows = db.prepare(`
        SELECT ms.warband,
               COUNT(*) AS member_count,
               SUM(ms.combat_power_value) AS total_power,
               ROUND(AVG(ms.activeness)) AS avg_activeness
        FROM member_snapshots ms
        JOIN members m ON m.id = ms.member_id AND m.active = 1
        WHERE ms.snapshot_id = ? AND ms.warband != ''
        GROUP BY ms.warband
        ORDER BY total_power DESC
    `).all(snapshot.id);

    if (rows.length === 0) {
        return interaction.reply({ content: 'No warband data in latest snapshot · run `/scan` first.', flags: MessageFlags.Ephemeral });
    }

    const embed = new EmbedBuilder()
        .setTitle('⚔️ Warbands')
        .setFooter({ text: snapshotDate(snapshot) })
        .setColor(pickColor());

    for (const r of rows) {
        embed.addFields({
            name: r.warband,
            value: `**${r.member_count}** members · **${fmtPower(r.total_power)}** total · **${r.avg_activeness}** avg act`,
            inline: false,
        });
    }

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    autoDelete(interaction);
}
