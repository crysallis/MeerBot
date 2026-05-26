const { PermissionFlagsBits, MessageFlags } = require('discord.js');

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
        check: i => i.user.id === process.env.SCAN_AUTHORIZED_USER,
    },
};

// Composite: scan user OR admin
PERMS.scanOrAdmin = {
    label: 'Scan user or Admin',
    check: i => PERMS.scanUser.check(i) || PERMS.admin.check(i),
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

module.exports = { PERMS, getPerm, enforce, requireRole };
