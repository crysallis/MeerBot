const { PermissionFlagsBits, MessageFlags } = require('discord.js');
const botConfig = require('./botConfig');

// Role IDs from data/discord-roles.json · refresh with `node scripts/list-roles.js`
const ROLES = {
    RIFF: '1229572649651404830',
    RAFF: '1229554049788018808',
};

/**
 * Permission rules · single source of truth for both /help display and
 * runtime enforcement. Each rule has:
 *   - label: human-readable string shown in /help
 *   - check(interaction): returns true if the caller is allowed
 *
 * Add new entries here as needed. Commands reference them by string key.
 */
const PERMS = {
    everyone: {
        label: 'Anyone',
        check: () => true,
    },
    admin: {
        label: 'Admin (Manage Server)',
        check: i => i.member?.permissions?.has(PermissionFlagsBits.ManageGuild) ?? false,
    },
    scanUser: {
        label: 'Authorized scan user',
        check: i => i.user.id === botConfig.get('SCAN_AUTHORIZED_USER'),
    },
};

// Composite: scan user OR admin
PERMS.scanOrAdmin = {
    label: 'Scan user or Admin',
    check: i => PERMS.scanUser.check(i) || PERMS.admin.check(i),
};

PERMS.riffOrRaff = {
    label: 'Riff or Raff role',
    check: i => {
        const roles = i.member?.roles?.cache;
        return roles?.has(ROLES.RIFF) || roles?.has(ROLES.RAFF) || false;
    },
};

function getPerm(name) {
    return PERMS[name] ?? PERMS.everyone;
}

/**
 * Runtime gate. If the caller doesn't satisfy `permName`, replies with an
 * ephemeral rejection and returns false. Otherwise returns true.
 *
 * Usage:
 *   if (!(await enforce(interaction, 'admin'))) return;
 */
async function enforce(interaction, permName) {
    const perm = getPerm(permName);
    if (perm.check(interaction)) return true;
    await interaction.reply({
        content: `❌ You don't have permission to run this. Requires: **${perm.label}**.`,
        flags: MessageFlags.Ephemeral,
    });
    return false;
}

/**
 * Build a role-based perm rule on the fly. Use when a specific role gates
 * something (e.g. requireRole('1229554049788018808', 'Raff')).
 */
function requireRole(roleId, label) {
    return {
        label,
        check: i => i.member?.roles?.cache?.has(roleId) ?? false,
    };
}

async function enforcePermissions(interaction, command, subcommand = null) {
    const db = require('./db');

    const roleRows = db.prepare(
        `SELECT value_id FROM command_permissions
         WHERE command = ? AND subcommand IS ? AND type = 'role'`
    ).all(command, subcommand);

    if (roleRows.length > 0) {
        const memberRoles = interaction.member?.roles?.cache;
        const hasRole = roleRows.some(r => memberRoles?.has(r.value_id));
        if (!hasRole) {
            await interaction.reply({ content: "You don't have permission to use this command.", flags: MessageFlags.Ephemeral });
            return false;
        }
    }

    const channelRows = db.prepare(
        `SELECT value_id FROM command_permissions
         WHERE command = ? AND subcommand IS ? AND type = 'channel'`
    ).all(command, subcommand);

    if (channelRows.length > 0) {
        if (!channelRows.some(r => r.value_id === interaction.channelId)) {
            await interaction.reply({ content: "This command can't be used in this channel.", flags: MessageFlags.Ephemeral });
            return false;
        }
    }

    return true;
}

module.exports = { PERMS, getPerm, enforce, requireRole, enforcePermissions };
