const db = require('../db');
const { pickRows } = require('../permissions');

// Per command, describe whether this member can run it and (if restricted)
// where. Read-only against command_permissions -- mirrors the precedence
// enforcePermissions itself uses (pickRows: specific-if-any-else-general,
// decided independently per type) but never calls enforcePermissions, since
// this is describing capability, not gating execution.
function describeCommand(command, memberRoleIds) {
    const allRoleRows = db.prepare(
        `SELECT subcommand, value_id FROM command_permissions WHERE command = ? AND type = 'role'`
    ).all(command);
    const allChannelRows = db.prepare(
        `SELECT subcommand, value_id FROM command_permissions WHERE command = ? AND type = 'channel'`
    ).all(command);

    const roleRows = pickRows(allRoleRows, null);
    const channelRows = pickRows(allChannelRows, null);

    const lines = [];

    if (roleRows.length === 0) {
        lines.push('no role restriction');
    } else {
        const hasRole = roleRows.some(r => memberRoleIds.has(r.value_id));
        lines.push(hasRole
            ? 'you CAN use this (you hold a required role)'
            : "you CANNOT use this (requires a role you don't have)");
    }

    if (channelRows.length > 0) {
        lines.push(`only usable in these channel IDs: ${channelRows.map(r => r.value_id).join(', ')}`);
    } else {
        lines.push('usable in any channel');
    }

    return lines.join('; ');
}

function buildCapabilitySummary(member, commands) {
    const memberRoleIds = new Set(member.roles.cache.keys());
    const out = [];
    for (const [name, info] of Object.entries(commands)) {
        out.push(`/${name}: ${describeCommand(name, memberRoleIds)}`);
    }
    return out.join('\n');
}

module.exports = { buildCapabilitySummary };
