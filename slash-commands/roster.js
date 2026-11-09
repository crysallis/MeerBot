const { SlashCommandBuilder, EmbedBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { enforcePermissions } = require('../utils/permissions');
const { pickColor } = require('../utils/colors');
const botConfig = require('../utils/botConfig');
const db = require('../utils/db');
const { resolveApprover, resolveEligibleApprovers, newTransferId, buildApprovalEmbed } = require('../utils/transferApproval');
const { entryFromRow } = require('../utils/guildEntries');
const { getGuildById } = require('../utils/guildRegistry');

const WHO_DIS_ROLE_ID = '1330742760306638889';

function guildEntryForDbGuild(dbGuildId) {
    if (!dbGuildId) return null;
    return entryFromRow(getGuildById(db, dbGuildId), key => botConfig.get(key));
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('roster')
        .setDescription('Manage guild membership roles')
        .addSubcommand(s => s
            .setName('add')
            .setDescription('Add a member to a guild')
            .addStringOption(o => o.setName('guild').setDescription('Guild').setRequired(true).setAutocomplete(true))
            .addUserOption(o => o.setName('user').setDescription('Discord member').setRequired(true))
        )
        .addSubcommand(s => s
            .setName('remove')
            .setDescription('Remove a member from a guild')
            .addStringOption(o => o.setName('guild').setDescription('Guild').setRequired(true).setAutocomplete(true))
            .addUserOption(o => o.setName('user').setDescription('Discord member').setRequired(true))
        )
        .addSubcommand(s => s
            .setName('transfer')
            .setDescription('Move a member to a different warband (may require approval)')
            .addUserOption(o => o.setName('user').setDescription('Discord member').setRequired(true))
            .addStringOption(o => o.setName('to_warband').setDescription('Destination warband').setRequired(true).setAutocomplete(true))
        ),

    async autocomplete(interaction) {
        const focusedOption = interaction.options.getFocused(true);
        const focused = String(focusedOption.value).toLowerCase();

        if (focusedOption.name === 'guild') {
            const guilds = db.getGuilds()
                .filter(g => g.guild_role_id && g.name.toLowerCase().includes(focused))
                .slice(0, 25);
            return interaction.respond(guilds.map(g => ({ name: g.name, value: String(g.id) })));
        }

        const filtered = db.getWarbands()
            .filter(w => w.name.toLowerCase().includes(focused))
            .slice(0, 25);
        await interaction.respond(filtered.map(w => ({ name: w.name, value: w.name })));
    },

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        if (!(await enforcePermissions(interaction, 'roster', sub))) return;

        const target = interaction.options.getMember('user');

        if (!target) {
            return interaction.reply({ content: 'That member was not found in this server.', flags: MessageFlags.Ephemeral });
        }

        let guild = null;
        if (sub === 'add' || sub === 'remove') {
            guild = guildEntryForDbGuild(Number(interaction.options.getString('guild')));
            if (!guild) {
                return interaction.reply({ content: 'That guild is not set up for roster roles.', flags: MessageFlags.Ephemeral });
            }
        }

        await interaction.deferReply();

        if (sub === 'add') {
            const added   = [];
            const removed = [];

            if (!target.roles.cache.has(guild.id)) {
                await target.roles.add(guild.id);
                added.push(interaction.guild.roles.cache.get(guild.id)?.name ?? guild.label);
            }

            if (target.roles.cache.has(WHO_DIS_ROLE_ID)) {
                await target.roles.remove(WHO_DIS_ROLE_ID);
                removed.push('Who Dis?');
            }

            const lines = [];
            if (added.length)   lines.push(`**Added:** ${added.join(', ')}`);
            if (removed.length) lines.push(`**Removed:** ${removed.join(', ')}`);
            if (!lines.length)  lines.push('No role changes needed.');

            await interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setTitle(`${guild.label} · ${target.displayName} added`)
                    .setDescription(lines.join('\n'))
                    .setColor(pickColor())
                    .setFooter({ text: `By ${interaction.user.username}` })],
            });

            if (guild.welcomeChannelId) {
                const ch = interaction.guild.channels.cache.get(guild.welcomeChannelId);
                if (ch) {
                    await ch.send(`Welcome to **${guild.label}**, ${target}! :tada:`);
                }
            }

            return;
        }

        if (sub === 'remove') {
            const roleName = interaction.guild.roles.cache.get(guild.id)?.name ?? guild.label;

            if (!target.roles.cache.has(guild.id)) {
                return interaction.editReply({ content: `${target.displayName} does not have the **${roleName}** role.` });
            }

            await target.roles.remove(guild.id);

            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setTitle(`${guild.label} · ${target.displayName} removed`)
                    .setDescription(`**Removed:** ${roleName}`)
                    .setColor(pickColor())
                    .setFooter({ text: `By ${interaction.user.username}` })],
            });
        }

        if (sub === 'transfer') {
            const toWarbandName = interaction.options.getString('to_warband');
            const toWarband = db.getWarbands().find(w => w.name === toWarbandName);
            if (!toWarband) {
                return interaction.editReply({ content: `No warband named **${toWarbandName}**.` });
            }

            const memberRow = db.prepare('SELECT id, warband_id FROM members WHERE discord_id = ?').get(target.id);
            if (!memberRow) {
                return interaction.editReply({ content: `${target.displayName} isn't linked to a roster entry yet — use /link first.` });
            }
            const fromWarband = memberRow.warband_id
                ? db.getWarbands(true).find(w => w.id === memberRow.warband_id)
                : null;

            if (fromWarband?.id === toWarband.id) {
                return interaction.editReply({ content: `${target.displayName} is already in **${toWarband.name}**.` });
            }

            const { bypass, direction } = resolveApprover({ guildMember: interaction.member, fromWarband, toWarband });

            if (bypass) {
                await applyTransferRoles(interaction.guild, target, fromWarband, toWarband);
                return interaction.editReply({
                    embeds: [new EmbedBuilder()
                        .setTitle(`Transfer · ${target.displayName}`)
                        .setDescription(`**From:** ${fromWarband?.name ?? '_none_'}\n**To:** ${toWarband.name}\n\n_No approval needed._`)
                        .setColor(pickColor())
                        .setFooter({ text: `By ${interaction.user.username}` })],
                });
            }

            const fromGuild = fromWarband?.guild_id ? db.getGuilds().find(g => g.id === fromWarband.guild_id) : null;
            const toGuild = toWarband.guild_id ? db.getGuilds().find(g => g.id === toWarband.guild_id) : null;
            const approvingWarband = direction === 'pull' ? fromWarband : toWarband;
            const approvingGuild = direction === 'pull' ? fromGuild : toGuild;

            const { roleId, overrideRoleIds, members: eligibleMembers } = await resolveEligibleApprovers(interaction.guild, approvingWarband, approvingGuild);
            if (!eligibleMembers.length) {
                return interaction.editReply({ content: `No one currently holds the leader or override role needed to approve for **${approvingWarband?.name ?? 'the approving side'}** — set one in the admin panel before requesting this transfer.` });
            }

            const transferId = newTransferId();
            db.createTransferApproval({
                transferId,
                memberId: memberRow.id,
                fromWarbandId: fromWarband?.id ?? null,
                toWarbandId: toWarband.id,
                direction,
                requestedBy: interaction.user.id,
                approvingRoleId: roleId,
            });

            const embed = buildApprovalEmbed({
                target, fromWarband, toWarband, direction, status: 'requested',
                eligibleMembers, overrideRoleIds, requestedByTag: interaction.user.username,
            });
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`transfer_approve:${transferId}`).setLabel('Approve').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`transfer_deny:${transferId}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
            );

            const channelId = botConfig.get('TRANSFER_APPROVAL_CHANNEL_ID');
            const channel = channelId ? interaction.guild.channels.cache.get(channelId) : null;
            if (channel) {
                const posted = await channel.send({ embeds: [embed], components: [row] });
                db.setTransferApprovalMessage(transferId, posted.id);
            }

            for (const approver of eligibleMembers) {
                db.addTransferApprovalEligibility(transferId, approver.id);
                try {
                    const dm = await approver.send({ embeds: [embed], components: [row] });
                    db.setTransferApprovalDmMessage(transferId, approver.id, dm.id);
                } catch {
                    // DMs closed — the channel post + panel remain the fallback,
                    // and they're still recorded as eligible to click there.
                }
            }

            return interaction.editReply({ content: `Transfer request sent — waiting on approval from **${approvingWarband?.name ?? 'the approving side'}**.` });
        }
    },
};

/** Apply the Discord role changes for an approved (or bypassed) transfer. Does not touch guild.db. */
async function applyTransferRoles(discordGuild, target, fromWarband, toWarband) {
    if (fromWarband?.member_role_id && target.roles.cache.has(fromWarband.member_role_id)) {
        await target.roles.remove(fromWarband.member_role_id);
    }
    if (toWarband.member_role_id) {
        await target.roles.add(toWarband.member_role_id);
    }

    const fromGuildEntry = guildEntryForDbGuild(fromWarband?.guild_id);
    const toGuildEntry = guildEntryForDbGuild(toWarband.guild_id);
    if (fromGuildEntry?.id !== toGuildEntry?.id) {
        if (fromGuildEntry && target.roles.cache.has(fromGuildEntry.id)) {
            await target.roles.remove(fromGuildEntry.id);
        }
        if (toGuildEntry) {
            await target.roles.add(toGuildEntry.id);
        }
    }
}

module.exports.applyTransferRoles = applyTransferRoles;
