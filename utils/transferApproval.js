const crypto = require('crypto');
const { EmbedBuilder } = require('discord.js');
const db = require('./db');
const { pickColor } = require('./colors');

/**
 * Decide who must approve a warband transfer, or whether it bypasses approval
 * entirely. Precedence:
 *   1. Initiator holds an override role for a guild the move touches → bypass.
 *   2. Initiator leads BOTH the source and destination warband → bypass (no
 *      other party has standing to approve; they already have authority over
 *      both sides).
 *   3. Initiator leads exactly one side → the OTHER side's warband leader
 *      approves (pull: initiator leads destination, source approves; push:
 *      initiator leads source, destination approves). Falls back to that
 *      side's guild override roles if the warband's leader_role_id is unset
 *      or currently held by nobody.
 *   4. Initiator leads neither side and holds no override role → still
 *      generates a request (command_permissions is expected to have already
 *      blocked this initiator from running the command at all; if it somehow
 *      didn't, an eligible approver can simply deny it). Approver defaults to
 *      the destination warband's leader.
 */
function resolveApprover({ guildMember, fromWarband, toWarband }) {
    const fromGuild = fromWarband?.guild_id ? db.getGuilds().find(g => g.id === fromWarband.guild_id) : null;
    const toGuild = toWarband.guild_id ? db.getGuilds().find(g => g.id === toWarband.guild_id) : null;

    const holdsOverride = (guild) => guild && db.getGuildOverrideRoles(guild.id).some(r => guildMember.roles.cache.has(r));
    if (holdsOverride(fromGuild) || holdsOverride(toGuild)) {
        return { bypass: true, direction: null, approvingRoleId: null };
    }

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
 * Resolve the actual Discord members eligible to approve, applying the
 * vacant-leader-role fallback to the guild's override roles. discordGuild is
 * the live discord.js Guild (for role member lookups); warband/guild are the
 * DB rows for the approving side. Role.members is cache-derived, so the full
 * member list is fetched first — otherwise a role can read as vacant simply
 * because its holders haven't been cached yet, wrongly triggering fallback.
 */
async function resolveEligibleApprovers(discordGuild, warband, guild) {
    await discordGuild.members.fetch();
    if (warband?.leader_role_id) {
        const role = discordGuild.roles.cache.get(warband.leader_role_id);
        const members = role ? [...role.members.values()] : [];
        if (members.length) return { roleId: warband.leader_role_id, members };
    }
    // Vacant (or unset) leader role → fall back to the guild's override roles.
    const overrideIds = guild ? db.getGuildOverrideRoles(guild.id) : [];
    const members = new Map();
    for (const roleId of overrideIds) {
        const role = discordGuild.roles.cache.get(roleId);
        if (!role) continue;
        for (const m of role.members.values()) members.set(m.id, m);
    }
    return { roleId: overrideIds[0] || warband?.leader_role_id || null, members: [...members.values()] };
}

function newTransferId() {
    return crypto.randomUUID();
}

/** Build the approval embed, reused for the initial post, DMs, and the resolution edit. */
function buildApprovalEmbed({ target, fromWarband, toWarband, direction, status, eligibleMembers, approverUserId, requestedByTag }) {
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
        embed.addFields({ name: 'Waiting on', value: names });
    } else if (status === 'approved') {
        embed.addFields({ name: 'Status', value: `✅ Approved by ${approverUserId ? `<@${approverUserId}>` : 'unknown'}` });
    } else if (status === 'denied') {
        embed.addFields({ name: 'Status', value: `❌ Denied by ${approverUserId ? `<@${approverUserId}>` : 'unknown'}` });
    }

    return embed;
}

module.exports = { resolveApprover, resolveEligibleApprovers, newTransferId, buildApprovalEmbed };
