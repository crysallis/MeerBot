const db = require('../db');
const { pickRows } = require('../permissions');
const botConfig = require('../botConfig');

const MANAGE_SERVER = 32n;

// Commands whose execute() calls enforce(interaction, 'scanUser'): usable only by
// SCAN_AUTHORIZED_USER, whatever the command_permissions rows say.
const SCAN_USER_ONLY = new Set(['scan', 'review', 'pearlbazaar']);

// '/guildduel add name: crests:' -> 'add'. A second token ending in ':' is an
// option ('/member name:'), not a subcommand, so that entry is command-wide.
function subcommandOf(entry) {
    const token = entry.name.trim().split(/\s+/)[1];
    return token && !token.endsWith(':') ? token : null;
}

// Discord-side default permission a slash command is registered with
// (setDefaultMemberPermissions), e.g. /guildduel -> Manage Server. Not stored
// in command_permissions, so it has to be read off the command definition.
function loadDefaultPermissions(commands) {
    const out = {};
    for (const name of Object.keys(commands)) {
        try {
            const bits = require(`../../slash-commands/${name}.js`).data?.default_member_permissions;
            if (bits != null) out[name] = BigInt(bits);
        } catch { /* no command file for this name */ }
    }
    return out;
}

function roleRowsFor(command, subcommand) {
    const rows = db.prepare(
        `SELECT subcommand, value_id FROM command_permissions WHERE command = ? AND type = 'role'`
    ).all(command);
    return pickRows(rows, subcommand);
}

function channelRowsFor(command, subcommand) {
    const rows = db.prepare(
        `SELECT subcommand, value_id FROM command_permissions WHERE command = ? AND type = 'channel'`
    ).all(command);
    return pickRows(rows, subcommand);
}

// Read-only against command_permissions -- mirrors the precedence
// enforcePermissions itself uses (pickRows: specific-if-any-else-general,
// decided independently per type) but never calls enforcePermissions, since
// this is describing capability, not gating execution.
function canUse(member, command, subcommand, defaults) {
    if (SCAN_USER_ONLY.has(command) && member.id !== botConfig.get('SCAN_AUTHORIZED_USER')) {
        return { allowed: false, reason: 'only the authorized scan user' };
    }
    const needed = defaults[command];
    if (needed && !member.permissions?.has?.(needed)) {
        return { allowed: false, reason: needed === MANAGE_SERVER ? 'requires Manage Server' : 'requires a Discord permission you do not have' };
    }
    const roleRows = roleRowsFor(command, subcommand);
    if (roleRows.length > 0 && !roleRows.some(r => member.roles.cache.has(r.value_id))) {
        return { allowed: false, reason: "requires a role you don't have" };
    }
    return { allowed: true, restricted: roleRows.length > 0 };
}

function describe(member, command, subcommand, defaults) {
    const verdict = canUse(member, command, subcommand, defaults);
    const lines = [];

    if (!verdict.allowed) {
        lines.push(`you CANNOT use this (${verdict.reason})`);
    } else {
        lines.push(verdict.restricted ? 'you CAN use this (you hold a required role)' : 'no role restriction');
    }

    const channelRows = channelRowsFor(command, subcommand);
    lines.push(channelRows.length > 0
        ? `only usable in these channel IDs: ${channelRows.map(r => r.value_id).join(', ')}`
        : 'usable in any channel');

    return lines.join('; ');
}

function buildCapabilitySummary(member, commands, defaults = loadDefaultPermissions(commands)) {
    const out = [];
    for (const [name, info] of Object.entries(commands)) {
        const subs = [...new Set(info.subcommands.map(subcommandOf))];
        const described = subs.map(sub => [sub, describe(member, name, sub, defaults)]);
        if (new Set(described.map(([, text]) => text)).size <= 1) {
            out.push(`/${name}: ${described[0]?.[1] ?? describe(member, name, null, defaults)}`);
        } else {
            for (const [sub, text] of described) out.push(`/${name}${sub ? ` ${sub}` : ''}: ${text}`);
        }
    }
    return out.join('\n');
}

// The command list shown to the model for THIS member: subcommands they cannot
// run are left out so they are never recommended. Channel limits do not hide a
// command, the capability summary says where it works.
function visibleCommands(member, commands, defaults = loadDefaultPermissions(commands)) {
    const out = {};
    for (const [name, info] of Object.entries(commands)) {
        const subcommands = info.subcommands.filter(s => canUse(member, name, subcommandOf(s), defaults).allowed);
        if (subcommands.length > 0) out[name] = { ...info, subcommands };
    }
    return out;
}

module.exports = { buildCapabilitySummary, visibleCommands };
