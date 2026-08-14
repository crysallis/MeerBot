const { PermissionFlagsBits, MessageFlags } = require('discord.js');
const botConfig = require('./botConfig');

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

// A saved rule with subcommand = NULL means "whole command" (the admin panel's own
// label for it) -- it must apply to every subcommand that doesn't have its OWN more
// specific rule of the same type. Picking specific-if-any-else-general independently
// per type (not once for the whole lookup) matters: a subcommand-specific ROLE rule
// must not silently disable a command-wide CHANNEL rule, or vice versa -- that would
// just be this same class of bug one layer down.
function pickRows(rows, subcommand) {
    const specific = rows.filter(r => r.subcommand === subcommand);
    return specific.length > 0 ? specific : rows.filter(r => r.subcommand === null);
}

async function enforcePermissions(interaction, command, subcommand = null) {
    const db = require('./db');

    let roleRows, channelRows;
    try {
        const allRoleRows = db.prepare(
            `SELECT subcommand, value_id FROM command_permissions
             WHERE command = ? AND (subcommand IS ? OR subcommand IS NULL) AND type = 'role'`
        ).all(command, subcommand);
        roleRows = pickRows(allRoleRows, subcommand);

        const allChannelRows = db.prepare(
            `SELECT subcommand, value_id FROM command_permissions
             WHERE command = ? AND (subcommand IS ? OR subcommand IS NULL) AND type = 'channel'`
        ).all(command, subcommand);
        channelRows = pickRows(allChannelRows, subcommand);
    } catch (err) {
        console.error(`[permissions] DB read failed for ${command}/${subcommand ?? 'null'}: ${err.message}`);
        await interaction.reply({ content: 'Bot is temporarily unavailable. Try again in a moment.', flags: MessageFlags.Ephemeral });
        return false;
    }

    if (roleRows.length > 0) {
        const memberRoles = interaction.member?.roles?.cache;
        const hasRole = roleRows.some(r => memberRoles?.has(r.value_id));
        if (!hasRole) {
            await interaction.reply({ content: "You don't have permission to use this command.", flags: MessageFlags.Ephemeral });
            return false;
        }
    }

    if (channelRows.length > 0) {
        if (!channelRows.some(r => r.value_id === interaction.channelId)) {
            await interaction.reply({ content: "This command can't be used in this channel.", flags: MessageFlags.Ephemeral });
            return false;
        }
    }

    return true;
}

module.exports = { PERMS, getPerm, enforce, enforcePermissions };
