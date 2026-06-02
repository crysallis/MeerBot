const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const db = require('../utils/db');
const botConfig = require('../utils/botConfig');
const { pickColor } = require('../utils/colors');

const INTEREST_EMOJI = { possible: '🟢', undecided: '🟡', unknown: '❓', none: '🔴' };
const STATUS_EMOJI   = { scouting: '🔍', invited: '📨', joined: '✅', declined: '❌' };

const STATUS_CHOICES = [
    { name: '🔍 Scouting',  value: 'scouting'  },
    { name: '📨 Invited',   value: 'invited'   },
    { name: '✅ Joined',    value: 'joined'    },
    { name: '❌ Declined',  value: 'declined'  },
];

const INTEREST_CHOICES = [
    { name: '🟢 Possible',  value: 'possible'  },
    { name: '🟡 Undecided', value: 'undecided' },
    { name: '❓ Unknown',   value: 'unknown'   },
    { name: '🔴 None',      value: 'none'      },
];

const RESPONSE_CHOICES = [
    { name: 'First Contact', value: 'first_contact' },
    { name: 'No Response',   value: 'no_response'   },
];

function activeServerNumbers() {
    return db.prepare(`
        SELECT DISTINCT als.server_number
        FROM ally_servers als
        JOIN ally_seasons asn ON asn.id = als.season_id AND asn.active = 1
        ORDER BY als.server_number ASC
    `).all().map(r => r.server_number);
}

function recruitmentNames() {
    return db.prepare('SELECT name FROM recruitment ORDER BY name ASC').all().map(r => r.name);
}

function getServerIdForNumber(num) {
    const row = db.prepare(`
        SELECT als.id FROM ally_servers als
        JOIN ally_seasons asn ON asn.id = als.season_id AND asn.active = 1
        WHERE als.server_number = ?
        LIMIT 1
    `).get(num);
    return row?.id ?? null;
}

function fmtPower(val) {
    if (!val) return '—';
    if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`;
    return `${Math.round(val / 1000)}K`;
}

module.exports = {
    async autocomplete(interaction) {
        const focused = interaction.options.getFocused(true);

        if (focused.name === 'server') {
            const nums = activeServerNumbers();
            const filtered = nums.filter(n => n.toString().includes(focused.value.toString())).slice(0, 25);
            return interaction.respond(filtered.map(n => ({ name: String(n), value: n })));
        }

        if (focused.name === 'name') {
            const query = focused.value.toLowerCase();
            const names = recruitmentNames().filter(n => n.toLowerCase().includes(query)).slice(0, 25);
            return interaction.respond(names.map(n => ({ name: n, value: n })));
        }
    },

    data: new SlashCommandBuilder()
        .setName('recruitment')
        .setDescription('Manage guild recruitment prospects')
        .addSubcommand(s => s
            .setName('add')
            .setDescription('Add a new prospect')
            .addStringOption(o => o.setName('name').setDescription('In-game name').setRequired(true).setMaxLength(100))
            .addIntegerOption(o => o.setName('power').setDescription('Combat power (e.g. 85000000)').setRequired(true).setMinValue(1))
            .addStringOption(o => o.setName('contacted').setDescription('Date of first contact (YYYY-MM-DD)').setRequired(true))
            .addIntegerOption(o => o.setName('server').setDescription('Ally server number').setRequired(true).setAutocomplete(true))
            .addIntegerOption(o => o.setName('dr').setDescription('Dream Realm rank (1-100)').setRequired(false).setMinValue(1).setMaxValue(100))
            .addIntegerOption(o => o.setName('sup_arena').setDescription('Supreme Arena rank (1-100)').setRequired(false).setMinValue(1).setMaxValue(100))
            .addIntegerOption(o => o.setName('lab').setDescription('Labyrinth rank (1-100)').setRequired(false).setMinValue(1).setMaxValue(100))
            .addIntegerOption(o => o.setName('dual').setDescription('Dual rank (1-100)').setRequired(false).setMinValue(1).setMaxValue(100))
            .addStringOption(o => o.setName('interest').setDescription('Interest level').setRequired(false).addChoices(...INTEREST_CHOICES))
            .addStringOption(o => o.setName('response').setDescription('Contact response').setRequired(false).addChoices(...RESPONSE_CHOICES))
            .addStringOption(o => o.setName('status').setDescription('Recruitment status (default: scouting)').setRequired(false).addChoices(...STATUS_CHOICES))
        )
        .addSubcommand(s => s
            .setName('list')
            .setDescription('View prospects (defaults to scouting + invited)')
            .addStringOption(o => o.setName('status').setDescription('Filter by status (default: scouting + invited)').setRequired(false).addChoices(...STATUS_CHOICES))
            .addStringOption(o => o.setName('interest').setDescription('Filter by interest').setRequired(false).addChoices(...INTEREST_CHOICES))
            .addIntegerOption(o => o.setName('server').setDescription('Filter by server number').setRequired(false).setMinValue(1))
            .addStringOption(o => o.setName('date').setDescription('Filter by contacted date ±14 days (YYYY-MM-DD)').setRequired(false))
        )
        .addSubcommand(s => s
            .setName('update')
            .setDescription('Update a prospect\'s details')
            .addStringOption(o => o.setName('name').setDescription('Prospect name').setRequired(true).setAutocomplete(true))
            .addStringOption(o => o.setName('status').setDescription('Recruitment status').setRequired(false).addChoices(...STATUS_CHOICES))
            .addStringOption(o => o.setName('interest').setDescription('Interest level').setRequired(false).addChoices(...INTEREST_CHOICES))
            .addStringOption(o => o.setName('response').setDescription('Contact response').setRequired(false).addChoices(...RESPONSE_CHOICES))
            .addIntegerOption(o => o.setName('power').setDescription('Updated combat power').setRequired(false).setMinValue(1))
            .addIntegerOption(o => o.setName('server').setDescription('Updated server number').setRequired(false).setAutocomplete(true))
            .addStringOption(o => o.setName('contacted').setDescription('Updated contact date (YYYY-MM-DD)').setRequired(false))
            .addIntegerOption(o => o.setName('dr').setDescription('Dream Realm rank (1-100)').setRequired(false).setMinValue(1).setMaxValue(100))
            .addIntegerOption(o => o.setName('sup_arena').setDescription('Supreme Arena rank (1-100)').setRequired(false).setMinValue(1).setMaxValue(100))
            .addIntegerOption(o => o.setName('lab').setDescription('Labyrinth rank (1-100)').setRequired(false).setMinValue(1).setMaxValue(100))
            .addIntegerOption(o => o.setName('dual').setDescription('Dual rank (1-100)').setRequired(false).setMinValue(1).setMaxValue(100))
        )
        .addSubcommand(s => s
            .setName('remove')
            .setDescription('Remove a prospect')
            .addStringOption(o => o.setName('name').setDescription('Prospect name').setRequired(true).setAutocomplete(true))
        ),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        if (sub === 'add') {
            const name     = interaction.options.getString('name').trim();
            const power    = interaction.options.getInteger('power');
            const contacted = interaction.options.getString('contacted').trim();
            const serverNum = interaction.options.getInteger('server');
            const dr       = interaction.options.getInteger('dr');
            const supArena = interaction.options.getInteger('sup_arena');
            const lab      = interaction.options.getInteger('lab');
            const dual     = interaction.options.getInteger('dual');
            const interest = interaction.options.getString('interest') ?? 'unknown';
            const response = interaction.options.getString('response') ?? 'first_contact';
            const status   = interaction.options.getString('status') ?? 'scouting';

            if (!/^\d{4}-\d{2}-\d{2}$/.test(contacted)) {
                return interaction.reply({ content: 'Invalid date format. Use YYYY-MM-DD.', flags: MessageFlags.Ephemeral });
            }

            const serverId = getServerIdForNumber(serverNum);
            if (!serverId) {
                return interaction.reply({ content: `Server **${serverNum}** is not in the active season. Add it with \`/season allyadd\`.`, flags: MessageFlags.Ephemeral });
            }

            const now = new Date().toISOString();
            const result = db.prepare(`
                INSERT INTO recruitment (name, power, server_id, dr_rank, sup_arena_rank, lab_rank, dual_rank, interest, response, status, contacted_at, created_by, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(name, power, serverId, dr, supArena, lab, dual, interest, response, status, contacted, interaction.user.id, now);

            const channelId = botConfig.get('RECRUITMENT_REMINDER_CHANNEL_ID');
            if (channelId) {
                const fireAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
                const sj = db.prepare(
                    "INSERT INTO scheduled_jobs (type, fire_at, recurrence, created_at) VALUES ('recruitment_followup', ?, null, ?)"
                ).run(fireAt, now);
                db.prepare(
                    'INSERT INTO recruitment_followups (job_id, user_id, recruitment_id, channel_id) VALUES (?, ?, ?, ?)'
                ).run(sj.lastInsertRowid, interaction.user.id, result.lastInsertRowid, channelId);
            }

            return interaction.reply({
                content: `${STATUS_EMOJI[status]} **${name}** added to prospects.${channelId ? ' 2-day follow-up reminder scheduled.' : ''}`,
                flags: MessageFlags.Ephemeral,
            });
        }

        if (sub === 'list') {
            const filterStatus   = interaction.options.getString('status');
            const filterInterest = interaction.options.getString('interest');
            const filterServer   = interaction.options.getInteger('server');
            const filterDate     = interaction.options.getString('date');

            if (filterDate && !/^\d{4}-\d{2}-\d{2}$/.test(filterDate)) {
                return interaction.reply({ content: 'Invalid date format. Use YYYY-MM-DD.', flags: MessageFlags.Ephemeral });
            }

            let query = `
                SELECT r.id, r.name, r.power, r.interest, r.response, r.status, r.contacted_at,
                       als.server_number
                FROM recruitment r
                LEFT JOIN ally_servers als ON als.id = r.server_id
                WHERE 1=1
            `;
            const params = [];

            if (filterStatus) {
                query += ' AND r.status = ?';
                params.push(filterStatus);
            } else {
                query += " AND r.status IN ('scouting', 'invited')";
            }

            if (filterInterest) {
                query += ' AND r.interest = ?';
                params.push(filterInterest);
            }

            if (filterServer) {
                query += ' AND als.server_number = ?';
                params.push(filterServer);
            }

            if (filterDate) {
                query += " AND date(r.contacted_at) BETWEEN date(?, '-14 days') AND date(?, '+14 days')";
                params.push(filterDate, filterDate);
            }

            query += `
                ORDER BY CASE r.status WHEN 'invited' THEN 1 WHEN 'scouting' THEN 2 WHEN 'joined' THEN 3 ELSE 4 END,
                         CASE r.interest WHEN 'possible' THEN 1 WHEN 'undecided' THEN 2 WHEN 'unknown' THEN 3 ELSE 4 END,
                         r.power DESC
                LIMIT 21
            `;

            const rows = db.prepare(query).all(...params);
            const overLimit = rows.length > 20;
            const display = rows.slice(0, 20);

            if (display.length === 0) {
                return interaction.reply({ content: 'No prospects match those filters.', flags: MessageFlags.Ephemeral });
            }

            const fields = display.map(r => {
                const ranks = [
                    r.dr_rank != null ? `DR:${r.dr_rank}` : null,
                    r.sup_arena_rank != null ? `SA:${r.sup_arena_rank}` : null,
                    r.lab_rank != null ? `Lab:${r.lab_rank}` : null,
                    r.dual_rank != null ? `Dual:${r.dual_rank}` : null,
                ].filter(Boolean).join(' · ');

                const responseLabel = r.response === 'first_contact' ? 'First Contact' : 'No Response';
                const serverLabel   = r.server_number != null ? `Svr ${r.server_number}` : '—';
                const value = `${STATUS_EMOJI[r.status]} ${r.status} · ${INTEREST_EMOJI[r.interest]} ${r.interest} · ${fmtPower(r.power)} · ${serverLabel} · ${responseLabel} · ${r.contacted_at}${ranks ? `\n${ranks}` : ''}`;

                return { name: r.name, value, inline: false };
            });

            const activeFilters = [
                filterStatus  ? `status: ${filterStatus}`       : 'status: scouting+invited',
                filterInterest ? `interest: ${filterInterest}`  : null,
                filterServer  ? `server: ${filterServer}`       : null,
                filterDate    ? `date: ±14d of ${filterDate}`   : null,
            ].filter(Boolean).join(' · ');

            const embed = new EmbedBuilder()
                .setTitle('⚔️ Recruitment Prospects')
                .setDescription(`Filters: ${activeFilters}`)
                .addFields(fields)
                .setColor(pickColor());

            if (overLimit) embed.setFooter({ text: `Showing 20 of ${rows.length - 1}+ · add filters to narrow results` });

            return interaction.reply({ embeds: [embed] });
        }

        if (sub === 'update') {
            const name = interaction.options.getString('name').trim();
            const existing = db.prepare('SELECT * FROM recruitment WHERE name = ?').get(name);
            if (!existing) return interaction.reply({ content: `Prospect **${name}** not found.`, flags: MessageFlags.Ephemeral });

            const updates = {};
            const power    = interaction.options.getInteger('power');
            const serverNum = interaction.options.getInteger('server');
            const contacted = interaction.options.getString('contacted');
            const dr       = interaction.options.getInteger('dr');
            const supArena = interaction.options.getInteger('sup_arena');
            const lab      = interaction.options.getInteger('lab');
            const dual     = interaction.options.getInteger('dual');
            const interest = interaction.options.getString('interest');
            const response = interaction.options.getString('response');
            const status   = interaction.options.getString('status');

            if (power != null)    updates.power = power;
            if (dr != null)       updates.dr_rank = dr;
            if (supArena != null) updates.sup_arena_rank = supArena;
            if (lab != null)      updates.lab_rank = lab;
            if (dual != null)     updates.dual_rank = dual;
            if (interest)         updates.interest = interest;
            if (response)         updates.response = response;
            if (status)           updates.status = status;

            if (contacted) {
                if (!/^\d{4}-\d{2}-\d{2}$/.test(contacted)) {
                    return interaction.reply({ content: 'Invalid date format. Use YYYY-MM-DD.', flags: MessageFlags.Ephemeral });
                }
                updates.contacted_at = contacted;
            }

            if (serverNum != null) {
                const serverId = getServerIdForNumber(serverNum);
                if (!serverId) {
                    return interaction.reply({ content: `Server **${serverNum}** is not in the active season.`, flags: MessageFlags.Ephemeral });
                }
                updates.server_id = serverId;
            }

            if (Object.keys(updates).length === 0) {
                return interaction.reply({ content: 'No fields provided to update.', flags: MessageFlags.Ephemeral });
            }

            const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
            db.prepare(`UPDATE recruitment SET ${setClauses} WHERE id = ?`).run(...Object.values(updates), existing.id);

            return interaction.reply({ content: `✅ **${name}** updated.`, flags: MessageFlags.Ephemeral });
        }

        if (sub === 'remove') {
            const name = interaction.options.getString('name').trim();
            const existing = db.prepare('SELECT id FROM recruitment WHERE name = ?').get(name);
            if (!existing) return interaction.reply({ content: `Prospect **${name}** not found.`, flags: MessageFlags.Ephemeral });
            db.prepare('DELETE FROM recruitment WHERE id = ?').run(existing.id);
            return interaction.reply({ content: `🗑️ **${name}** removed from prospects.`, flags: MessageFlags.Ephemeral });
        }
    },
};
