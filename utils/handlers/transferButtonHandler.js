const { MessageFlags } = require('discord.js');
const db = require('../db');
const botConfig = require('../botConfig');
const { buildApprovalEmbed } = require('../transferApproval');
const { applyTransferRoles } = require('../../slash-commands/roster');

/**
 * Handles transfer_approve:<id> / transfer_deny:<id> button clicks. Clickable
 * from either the-not-so-round-table or a DM — a DM interaction has no
 * interaction.guild, so the bot's one managed guild is resolved explicitly via
 * GUILD_ID rather than relying on interaction context.
 *
 * Authorization is by recorded eligibility (transfer_approval_eligibility),
 * not a live role re-check: everyone who was DM'd (or would have been, had
 * their DMs been open) for this specific request may act on it. This keeps
 * the DM'd set and the "who can click" set identical by construction, instead
 * of re-deriving eligibility from a single stored role at click time.
 */
async function handleTransferButton(interaction) {
    const [action, transferId] = interaction.customId.split(':');
    if (action !== 'transfer_approve' && action !== 'transfer_deny') return false;

    const row = db.getTransferApproval(transferId);
    if (!row) {
        await interaction.reply({ content: 'This transfer request no longer exists.', flags: MessageFlags.Ephemeral });
        return true;
    }
    if (row.status !== 'requested') {
        await interaction.reply({ content: `This request was already ${row.status}.`, flags: MessageFlags.Ephemeral });
        return true;
    }
    if (!db.isTransferApprovalEligible(transferId, interaction.user.id)) {
        await interaction.reply({ content: "You don't hold the role required to approve this request.", flags: MessageFlags.Ephemeral });
        return true;
    }

    const status = action === 'transfer_approve' ? 'approved' : 'denied';
    const resolved = db.resolveTransferApproval(transferId, status, interaction.user.id);
    if (!resolved) {
        await interaction.reply({ content: 'Someone else already resolved this request.', flags: MessageFlags.Ephemeral });
        return true;
    }

    // Ack immediately — role edits + several REST fetches below can exceed
    // Discord's 3s interaction deadline.
    await interaction.deferUpdate();

    const guild = interaction.client.guilds.cache.get(process.env.GUILD_ID);
    const warbands = db.getWarbands(true);
    const fromWarband = row.from_warband_id ? warbands.find(w => w.id === row.from_warband_id) : null;
    const toWarband = warbands.find(w => w.id === row.to_warband_id);

    const memberRow = db.prepare('SELECT discord_id FROM members WHERE id = ?').get(row.member_id);
    const target = memberRow?.discord_id ? await guild.members.fetch(memberRow.discord_id).catch(() => null) : null;

    if (status === 'approved' && target) {
        await applyTransferRoles(guild, target, fromWarband, toWarband);
    }

    const requester = await interaction.client.users.fetch(row.requested_by).catch(() => null);
    const embed = buildApprovalEmbed({
        target: target ?? { displayName: 'Unknown member' },
        fromWarband, toWarband, direction: row.direction, status,
        approverUserId: interaction.user.id,
        requestedByTag: requester?.username ?? row.requested_by,
    });

    // Edit whichever message was clicked, then sync every other surviving copy
    // (channel post + every eligible approver's DM) to the resolved state.
    await interaction.editReply({ embeds: [embed], components: [] }).catch(() => {});

    const editTargets = [];
    const channelId = botConfig.get('TRANSFER_APPROVAL_CHANNEL_ID');
    if (row.message_id && channelId) {
        editTargets.push(async () => {
            const channel = guild.channels.cache.get(channelId);
            const msg = channel && channel.id !== interaction.channelId
                ? await channel.messages.fetch(row.message_id).catch(() => null)
                : null;
            if (msg) await msg.edit({ embeds: [embed], components: [] }).catch(() => {});
        });
    }
    for (const dm of db.getTransferApprovalDms(transferId)) {
        if (dm.message_id === interaction.message?.id) continue;
        editTargets.push(async () => {
            const user = await interaction.client.users.fetch(dm.user_id).catch(() => null);
            const dmChannel = user ? await user.createDM().catch(() => null) : null;
            const msg = dmChannel ? await dmChannel.messages.fetch(dm.message_id).catch(() => null) : null;
            if (msg) await msg.edit({ embeds: [embed], components: [] }).catch(() => {});
        });
    }
    await Promise.all(editTargets.map(fn => fn()));

    return true;
}

module.exports = { handleTransferButton };
