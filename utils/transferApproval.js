const crypto = require('crypto');
const { EmbedBuilder } = require('discord.js');
const db = require('./db');
const { pickColor } = require('./colors');

/**
 * Decide who must approve a warband transfer, or whether it bypasses approval
 * entirely. Precedence:
 *   1. Initiator leads BOTH the source and destination warband → bypass (no
 *      other party has standing to approve; they already have authority over
 *      both sides).
 *   2. Initiator leads exactly one side → the OTHER side's warband leader
 *      approves (pull: initiator leads destination, source approves; push:
 *      initiator leads source, destination approves).
 *   3. Initiator leads neither side → still generates a request
 *      (command_permissions is expected to have already blocked this
 *      initiator from running the command at all; if it somehow didn't, an
 *      eligible approver can simply deny it). Approver defaults to the
 *      destination warband's leader.
 *
 * A guild override role (e.g. Riff/Raff) is deliberately NOT a bypass here —
 * holding one does not skip the request. It instead always adds that guild's
 * override-role holders to the eligible-approver pool alongside the relevant
 * warband leader (see resolveEligibleApprovers), so every transfer generates
 * a real, auditable request even when an override holder is the one who
 * initiates or ultimately approves it.
 */
function resolveApprover({ guildMember, fromWarband, toWarband }) {
    const leadsFrom = fromWarband?.leader_role_id && guildMember.roles.cache.has(fromWarband.leader_role_id);
    const leadsTo = toWarband.leader_role_id && guildMember.roles.cache.has(toWarband.leader_role_id);

    if (leadsFrom && leadsTo) {
        return { bypass: true, direction: null, approvingRoleId: null };
    }

    if (leadsTo) {
        // Pull: initiator leads the destination, source warband must approve.
        return { bypass: false, direction: 'pull', approvingRoleId: fromWarband?.leader_role_id || null };
    }

    if (leadsFrom) {
        // Push: initiator leads the source, destination warband must approve.
        return { bypass: false, direction: 'push', approvingRoleId: toWarband.leader_role_id || null };
    }

    // Initiator leads neither side. Shouldn't normally be reachable (see
    // docstring) — default to the destination warband's leader as approver.
    return { bypass: false, direction: 'push', approvingRoleId: toWarband.leader_role_id || null };
}

/**
 * Resolve the actual Discord members eligible to approve: the approving
 * warband's leader role, UNIONED with the approving guild's override roles —
 * always both, not one as a fallback for the other. An override role is a
 * standing "can also approve" grant, not merely a backstop for a vacant
 * leader seat. discordGuild is the live discord.js Guild (for role member
 * lookups); warband/guild are the DB rows for the approving side. Role.members
 * is cache-derived, so the full member list is fetched first — otherwise a
 * role can read as empty simply because its holders haven't been cached yet.
 */
async function resolveEligibleApprovers(discordGuild, warband, guild) {
    await discordGuild.members.fetch();

    const members = new Map();
    if (warband?.leader_role_id) {
        const role = discordGuild.roles.cache.get(warband.leader_role_id);
        for (const m of (role?.members.values() ?? [])) members.set(m.id, m);
    }
    const overrideIds = guild ? db.getGuildOverrideRoles(guild.id) : [];
    for (const roleId of overrideIds) {
        const role = discordGuild.roles.cache.get(roleId);
        for (const m of (role?.members.values() ?? [])) members.set(m.id, m);
    }

    // approvingRoleId is stored for display/audit only (transfer_approvals.
    // approving_role_id) -- it is NOT the authorization check at click time
    // (that's transfer_approval_eligibility, one row per eligible member).
    const approvingRoleId = warband?.leader_role_id || overrideIds[0] || null;
    return { roleId: approvingRoleId, overrideRoleIds: overrideIds, members: [...members.values()] };
}

function newTransferId() {
    return crypto.randomUUID();
}

/**
 * Build the approval embed, reused for the initial post, DMs, and the
 * resolution edit. overrideRoleIds (only meaningful when status==='requested')
 * lists the approving guild's override roles so the "Waiting on" field can
 * make clear that anyone holding one of those roles may also click Approve,
 * not just the named eligible members already resolved at request time.
 */
function buildApprovalEmbed({ target, fromWarband, toWarband, direction, status, eligibleMembers, overrideRoleIds, approverUserId, requestedByTag }) {
    const embed = new EmbedBuilder()
        .setTitle(`Transfer Approval · ${target.displayName}`)
        .setColor(pickColor())
        .addFields(
            { name: 'From', value: fromWarband?.name ?? '_none_', inline: true },
            { name: 'To', value: toWarband.name, inline: true },
            { name: 'Direction', value: direction === 'pull' ? 'Pull (destination-initiated)' : 'Push (source-initiated)', inline: true },
        )
        .setFooter({ text: `Requested by ${requestedByTag}` });

    if (status === 'requested') {
        const names = eligibleMembers.length
            ? eligibleMembers.map(m => m.displayName).join(', ')
            : '_no eligible approver found_';
        let value = names;
        if (overrideRoleIds?.length) {
            value += `\n_or anyone with: ${overrideRoleIds.map(id => `<@&${id}>`).join(', ')}_`;
        }
        embed.addFields({ name: 'Waiting on', value });
    } else if (status === 'approved') {
        embed.addFields({ name: 'Status', value: `✅ Approved by ${approverUserId ? `<@${approverUserId}>` : 'unknown'}` });
    } else if (status === 'denied') {
        embed.addFields({ name: 'Status', value: `❌ Denied by ${approverUserId ? `<@${approverUserId}>` : 'unknown'}` });
    }

    return embed;
}

module.exports = { resolveApprover, resolveEligibleApprovers, newTransferId, buildApprovalEmbed };
