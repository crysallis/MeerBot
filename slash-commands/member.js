const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const db = require('../utils/db');
const { pickColor, toRgba } = require('../utils/colors');

function fmtPower(val) {
    if (!val) return '·';
    if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`;
    return `${(val / 1_000).toFixed(0)}K`;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('member')
        .setDescription('Look up a guild member\'s stats and history')
        .addStringOption(opt =>
            opt.setName('name')
                .setDescription('In-game name')
                .setRequired(false)
                .setAutocomplete(true)
        )
        .addUserOption(opt =>
            opt.setName('user')
                .setDescription('Discord user (must be linked)')
                .setRequired(false)
        ),

    async autocomplete(interaction) {
        const focused = interaction.options.getFocused().toLowerCase();
        const names = db.prepare(`
            SELECT DISTINCT name FROM member_snapshots
            WHERE snapshot_id = (SELECT MAX(id) FROM snapshots)
        `).all().map(r => r.name);
        const filtered = names.filter(n => n.toLowerCase().includes(focused)).slice(0, 25);
        await interaction.respond(filtered.map(n => ({ name: n, value: n })));
    },

    async execute(interaction) {
        const color = pickColor();
        const name = interaction.options.getString('name');
        const mentionedUser = interaction.options.getUser('user');

        if (!name && !mentionedUser) {
            return interaction.reply({ content: 'Provide a name or mention a linked user.', flags: MessageFlags.Ephemeral });
        }

        let current;
        if (mentionedUser) {
            current = db.prepare(`
                SELECT m.ingame_name, m.discord_id, m.first_seen,
                       ms.last_active, ms.combat_power, ms.combat_power_value,
                       afk.return_date AS afk_until
                FROM member_snapshots ms
                JOIN members m ON m.id = ms.member_id
                LEFT JOIN member_afk afk ON afk.member_id = m.id
                WHERE ms.snapshot_id = (SELECT MAX(id) FROM snapshots)
                  AND m.discord_id = ?
                LIMIT 1
            `).get(mentionedUser.id);
            if (!current) {
                return interaction.reply({ content: `<@${mentionedUser.id}> is not linked to any guild member.`, flags: MessageFlags.Ephemeral });
            }
        } else {
            current = db.prepare(`
                SELECT m.ingame_name, m.discord_id, m.first_seen,
                       ms.last_active, ms.combat_power, ms.combat_power_value,
                       afk.return_date AS afk_until
                FROM member_snapshots ms
                JOIN members m ON m.id = ms.member_id
                LEFT JOIN member_afk afk ON afk.member_id = m.id
                WHERE ms.snapshot_id = (SELECT MAX(id) FROM snapshots)
                  AND m.ingame_name LIKE ?
                LIMIT 1
            `).get(name);
        }

        if (!current) {
            return interaction.reply({ content: `Member **${name}** not found in the latest snapshot.`, flags: MessageFlags.Ephemeral });
        }
        const lookupName = current.ingame_name;

        const history = db.prepare(`
            SELECT s.scraped_at, ms.combat_power_value, ms.last_active
            FROM member_snapshots ms
            JOIN snapshots s ON s.id = ms.snapshot_id
            JOIN members m ON m.id = ms.member_id
            WHERE m.ingame_name = ?
            ORDER BY s.scraped_at DESC
            LIMIT 8
        `).all(lookupName);

        const chronological = [...history].reverse();
        const histLines = history.map(h =>
            `${h.scraped_at.slice(0, 10)} | ${fmtPower(h.combat_power_value).padStart(6)} | ${h.last_active}`
        );

        let powerGrowth = '·';
        if (chronological.length >= 2) {
            const delta = (chronological.at(-1).combat_power_value || 0) - (chronological[0].combat_power_value || 0);
            if (delta !== 0) powerGrowth = `${delta >= 0 ? '▲' : '▼'} ${fmtPower(Math.abs(delta))}`;
        }

        const afkValue = current.afk_until ? `AFK until ${current.afk_until}` : '·';

        const embed = new EmbedBuilder()
            .setTitle(`👤 ${current.ingame_name}`)
            .addFields(
                { name: 'Combat Power', value: current.combat_power || '·', inline: true },
                { name: 'Last Active', value: current.last_active || '·', inline: true },
                { name: 'Discord', value: current.discord_id ? `<@${current.discord_id}>` : 'Not linked', inline: true },
                { name: 'First Seen', value: current.first_seen?.slice(0, 10) || '·', inline: true },
                { name: 'Power Growth', value: powerGrowth, inline: true },
                { name: 'AF AFK', value: afkValue, inline: true },
            )
            .setColor(color);

        if (histLines.length) {
            const header = `${'Date'.padEnd(10)} | ${'Power'.padStart(6)} | Last Active`;
            embed.setDescription('**Snapshot History**\n```\n' + header + '\n' + histLines.join('\n') + '\n```');
        }

        if (chronological.length >= 2) {
            const config = {
                type: 'line',
                data: {
                    labels: chronological.map(h => h.scraped_at.slice(0, 10)),
                    datasets: [{
                        data: chronological.map(h => +((h.combat_power_value || 0) / 1_000_000).toFixed(2)),
                        borderColor: toRgba(color),
                        backgroundColor: toRgba(color, 0.15),
                        fill: true,
                        tension: 0.3,
                        pointRadius: 4,
                        pointBackgroundColor: toRgba(color),
                    }],
                },
                options: {
                    title: { display: true, text: `${current.ingame_name} · Power Growth`, fontColor: '#dbdee1' },
                    legend: { display: false },
                    scales: {
                        xAxes: [{ ticks: { fontColor: '#b5bac1' }, gridLines: { color: 'rgba(255,255,255,0.06)' } }],
                        yAxes: [{
                            ticks: { fontColor: '#b5bac1' },
                            gridLines: { color: 'rgba(255,255,255,0.06)' },
                            scaleLabel: { display: true, labelString: 'Power (M)', fontColor: '#b5bac1' },
                        }],
                    },
                },
            };

            await interaction.deferReply();
            const res = await fetch('https://quickchart.io/chart/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chart: config, width: 700, height: 300, backgroundColor: '#1e1f22' }),
            });
            const json = await res.json();
            console.log('[member chart] QuickChart response:', json);
            embed.setImage(json.url);
            return interaction.editReply({ embeds: [embed] });
        }

        await interaction.reply({ embeds: [embed] });
    },
};
