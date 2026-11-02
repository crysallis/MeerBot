const { MessageFlags } = require('discord.js');
const db = require('../db');
const botConfig = require('../botConfig');
const { enforcePermissions } = require('../permissions');
const { strikeWarning } = require('../warnings');

const CONFIRM_WINDOW_MS = 60 * 1000;

async function refuse(interaction, content) {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

async function handleWarnStrikeButton(interaction, deps = {}) {
    const {
        h = db,
        enforce = enforcePermissions,
        now = Date.now(),
        logChannelId = botConfig.get('COMMAND_LOG_CHANNEL_ID'),
    } = deps;

    const [action, a, b, c] = interaction.customId.split(':');
    if (action !== 'warn_strike' && action !== 'warn_strike_cancel') return false;

    const ownerId = action === 'warn_strike' ? b : a;
    if (interaction.user.id !== ownerId) {
        await refuse(interaction, 'Only the person who ran this command can answer it.');
        return true;
    }

    if (action === 'warn_strike_cancel') {
        await interaction.update({ content: 'Strike cancelled. Nothing changed.', components: [] });
        return true;
    }

    if (now - Number(c) > CONFIRM_WINDOW_MS) {
        await interaction.update({ content: 'This confirmation timed out. Run /warn strike again.', components: [] });
        return true;
    }

    const warningId = Number(a);
    const row = h.prepare(`SELECT w.member_id, m.ingame_name FROM member_warnings w
                           JOIN members m ON m.id = w.member_id WHERE w.id = ?`).get(warningId);
    if (!row) {
        await interaction.update({ content: 'That warning no longer exists.', components: [] });
        return true;
    }

    if (!(await enforce(interaction, 'warn', 'strike'))) return true;

    strikeWarning(h, warningId, interaction.user.id, new Date(now));
    await interaction.update({ content: `🗑️ Struck warning #${warningId} for **${row.ingame_name}**.`, components: [] });

    if (logChannelId) {
        const channel = interaction.client.channels.cache.get(logChannelId);
        await channel?.send(`🗑️ <@${interaction.user.id}> struck warning #${warningId} for **${row.ingame_name}**.`)
            .catch(err => console.error('[Warn] Strike notice failed:', err.message));
    }
    return true;
}

module.exports = { handleWarnStrikeButton };
