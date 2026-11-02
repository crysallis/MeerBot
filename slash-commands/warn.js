const {
    SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits,
    ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const db = require('../utils/db');
const { pickColor } = require('../utils/colors');
const { enforcePermissions, evaluatePermissions } = require('../utils/permissions');
const W = require('../utils/warnings');
const { buildReport, reportLines, historyLines, chunkLines } = require('../utils/warningReport');

const EXPIRY_HELP = 'Expiry must be a real future date as YYYY-MM-DD (to end a warning now, use /warn expire).';
const NOT_FOUND_WARNING = (name) => `That warning was not found for **${name}**.`;

function findMember(h, name) {
    return h.prepare('SELECT id, ingame_name FROM members WHERE ingame_name = ? COLLATE NOCASE').get(String(name ?? '').trim());
}

function memberChoices(h, focused) {
    const needle = String(focused ?? '').toLowerCase();
    return h.prepare('SELECT ingame_name FROM members WHERE active = 1 AND pending = 0 ORDER BY ingame_name COLLATE NOCASE')
        .all()
        .map(r => r.ingame_name)
        .filter(n => n.toLowerCase().includes(needle))
        .slice(0, 25)
        .map(n => ({ name: n, value: n }));
}

function warningChoices(h, memberName, mode, focused, now = new Date()) {
    const member = findMember(h, memberName);
    if (!member) return [];
    const needle = String(focused ?? '').toLowerCase();
    return W.pickerWarnings(h, member.id, mode, now)
        .map(w => {
            const label = `#${w.id} · ${w.created_at.slice(0, 10)} · ${w.reason}`;
            const suffix = ` (${w.status === 'ended' ? 'ended early' : w.status})`;
            return { name: label.slice(0, 100 - suffix.length) + suffix, value: String(w.id), reason: w.reason };
        })
        .filter(c => c.name.toLowerCase().includes(needle) || c.reason.toLowerCase().includes(needle))
        .slice(0, 25)
        .map(({ name, value }) => ({ name, value }));
}

function resolveWarning(h, member, warningId) {
    const id = Number(warningId);
    if (!Number.isInteger(id)) return null;
    return h.prepare('SELECT * FROM member_warnings WHERE id = ? AND member_id = ?').get(id, member.id) ?? null;
}

function addCommand(h, { name, reason, expires, actor, now }) {
    const member = findMember(h, name);
    if (!member) return `Member **${name}** not found.`;
    const text = String(reason ?? '').trim();
    if (!text) return 'A reason is required.';
    let expiresAt;
    if (expires) {
        expiresAt = W.parseExpiryDate(expires, now);
        if (!expiresAt) return EXPIRY_HELP;
    }
    const id = W.addWarning(h, { memberId: member.id, reason: text, createdBy: actor, expiresAt, now });
    const row = h.prepare('SELECT expires_at FROM member_warnings WHERE id = ?').get(id);
    return `⚠️ Warning #${id} added for **${member.ingame_name}** · expires ${row.expires_at.slice(0, 10)} · ${W.countActive(h, member.id, now)} active.`;
}

function editCommand(h, { name, warningId, reason, expires, actor, now }) {
    const member = findMember(h, name);
    if (!member) return `Member **${name}** not found.`;
    const warning = resolveWarning(h, member, warningId);
    if (!warning) return NOT_FOUND_WARNING(member.ingame_name);
    const changes = {};
    if (reason != null && String(reason).trim()) changes.reason = String(reason).trim();
    if (expires) {
        const expiresAt = W.parseExpiryDate(expires, now);
        if (!expiresAt) return EXPIRY_HELP;
        changes.expiresAt = expiresAt;
    }
    if (!Object.keys(changes).length) return 'Nothing to change: give a new reason, a new expiry, or both.';
    return W.editWarning(h, warning.id, changes, actor, now)
        ? `✏️ Warning #${warning.id} for **${member.ingame_name}** updated.`
        : `Warning #${warning.id} already has those values.`;
}

function expireCommand(h, { name, warningId, note, actor, now }) {
    const member = findMember(h, name);
    if (!member) return `Member **${name}** not found.`;
    const warning = resolveWarning(h, member, warningId);
    if (!warning) return NOT_FOUND_WARNING(member.ingame_name);
    return W.expireWarning(h, warning.id, actor, note, now)
        ? `⏹️ Warning #${warning.id} for **${member.ingame_name}** ended early. It stays in their history.`
        : `Warning #${warning.id} was already ended.`;
}

function strikePrompt(h, { name, warningId, userId, now }) {
    const member = findMember(h, name);
    if (!member) return { content: `Member **${name}** not found.` };
    const warning = resolveWarning(h, member, warningId);
    if (!warning) return { content: NOT_FOUND_WARNING(member.ingame_name) };
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`warn_strike:${warning.id}:${userId}:${now.getTime()}`).setLabel('Strike it').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`warn_strike_cancel:${userId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );
    return {
        content: `Strike warning **#${warning.id}** for **${member.ingame_name}**? This deletes it permanently. Only a log entry that it was struck, and by whom, remains.`,
        components: [row],
    };
}

async function replyChunks(interaction, title, header, chunks, footer) {
    const embeds = chunks.map((chunk, i) => {
        const embed = new EmbedBuilder().setColor(pickColor()).setDescription(i === 0 && header ? `${header}\n\n${chunk}` : chunk);
        if (i === 0) embed.setTitle(title);
        if (i === chunks.length - 1 && footer) embed.setFooter({ text: footer });
        return embed;
    });
    await interaction.reply({ embeds: embeds.slice(0, 1), flags: MessageFlags.Ephemeral });
    for (const embed of embeds.slice(1)) await interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('warn')
        .setDescription('Member warnings')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(s => s
            .setName('add')
            .setDescription('Add a warning to a member')
            .addStringOption(o => o.setName('member').setDescription('Member name').setRequired(true).setAutocomplete(true))
            .addStringOption(o => o.setName('reason').setDescription('What the warning is for').setRequired(true).setMaxLength(500))
            .addStringOption(o => o.setName('expires').setDescription('Expiry date YYYY-MM-DD (default 3 months)')))
        .addSubcommand(s => s
            .setName('edit')
            .setDescription('Change a warning\'s reason or expiry')
            .addStringOption(o => o.setName('member').setDescription('Member name').setRequired(true).setAutocomplete(true))
            .addStringOption(o => o.setName('warning').setDescription('Which warning').setRequired(true).setAutocomplete(true))
            .addStringOption(o => o.setName('reason').setDescription('New reason').setMaxLength(500))
            .addStringOption(o => o.setName('expires').setDescription('New expiry date YYYY-MM-DD')))
        .addSubcommand(s => s
            .setName('expire')
            .setDescription('End a warning now (it stays in history)')
            .addStringOption(o => o.setName('member').setDescription('Member name').setRequired(true).setAutocomplete(true))
            .addStringOption(o => o.setName('warning').setDescription('Which warning').setRequired(true).setAutocomplete(true))
            .addStringOption(o => o.setName('note').setDescription('Why it was ended (kept in the log)').setMaxLength(200)))
        .addSubcommand(s => s
            .setName('strike')
            .setDescription('Delete a warning permanently')
            .addStringOption(o => o.setName('member').setDescription('Member name').setRequired(true).setAutocomplete(true))
            .addStringOption(o => o.setName('warning').setDescription('Which warning').setRequired(true).setAutocomplete(true)))
        .addSubcommand(s => s
            .setName('list')
            .setDescription('A member\'s full warning history')
            .addStringOption(o => o.setName('member').setDescription('Member name').setRequired(true).setAutocomplete(true)))
        .addSubcommand(s => s
            .setName('report')
            .setDescription('Members with active warnings')
            .addBooleanOption(o => o.setName('include_expired').setDescription('Also list members whose warnings have all lapsed'))),

    memberChoices,
    warningChoices,
    addCommand,
    editCommand,
    expireCommand,
    strikePrompt,

    async autocomplete(interaction, { evaluate = evaluatePermissions } = {}) {
        const mode = interaction.options.getSubcommand();
        if (!evaluate(interaction, 'warn', mode).allowed) return interaction.respond([]);
        const focused = interaction.options.getFocused(true);
        if (focused.name === 'member') return interaction.respond(memberChoices(db, focused.value));
        const name = interaction.options.getString('member');
        await interaction.respond(warningChoices(db, name, mode, focused.value));
    },

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        if (!(await enforcePermissions(interaction, 'warn', sub))) return;
        const now = new Date();
        const actor = interaction.user.id;
        const reply = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
        const get = (n) => interaction.options.getString(n);

        if (sub === 'add') return reply(addCommand(db, { name: get('member'), reason: get('reason'), expires: get('expires'), actor, now }));
        if (sub === 'edit') return reply(editCommand(db, { name: get('member'), warningId: get('warning'), reason: get('reason'), expires: get('expires'), actor, now }));
        if (sub === 'expire') return reply(expireCommand(db, { name: get('member'), warningId: get('warning'), note: get('note'), actor, now }));

        if (sub === 'strike') {
            const prompt = strikePrompt(db, { name: get('member'), warningId: get('warning'), userId: actor, now });
            return interaction.reply({ ...prompt, flags: MessageFlags.Ephemeral });
        }

        if (sub === 'list') {
            const member = findMember(db, get('member'));
            if (!member) return reply(`Member **${get('member')}** not found.`);
            const warnings = W.listWarnings(db, member.id, now);
            if (!warnings.length) return reply(`**${member.ingame_name}** has no warnings.`);
            const active = warnings.filter(w => w.status === 'active').length;
            const chunks = chunkLines(historyLines(warnings), 3500, '\n\n');
            return replyChunks(interaction, `⚠️ Warnings · ${member.ingame_name}`, `**${active} active** · ${warnings.length} total`, chunks);
        }

        if (sub === 'report') {
            const includeExpired = interaction.options.getBoolean('include_expired') ?? false;
            const rows = db.prepare(`SELECT w.*, m.ingame_name AS name FROM member_warnings w
                                     JOIN members m ON m.id = w.member_id`).all();
            const entries = buildReport(rows, { includeExpired }, now);
            if (!entries.length) {
                return reply(includeExpired ? 'No member has any warnings.' : 'No member has an active warning.');
            }
            const chunks = chunkLines(reportLines(entries, { includeExpired }), 3800);
            const footer = includeExpired ? 'Includes members whose warnings have all lapsed' : 'Active warnings only · add include_expired to see everyone';
            return replyChunks(interaction, '⚠️ Warnings report', null, chunks, footer);
        }
    },
};
