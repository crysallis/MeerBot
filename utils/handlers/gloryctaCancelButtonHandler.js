const { MessageFlags } = require('discord.js');
const db = require('../db');
const { enforcePermissions } = require('../permissions');

/**
 * Handles glorycta_cancel:<glorycta_polls.id> button clicks -- currently only
 * attached to /glory cta polls (job_id set); a /glory confirm post has no
 * button at all, but job_id is guarded as nullable here defensively rather
 * than assuming that never changes. Permission is the same rule as running
 * /glory cta itself -- enforcePermissions reads interaction.member/
 * interaction.channelId identically for a button click as it does for a
 * slash command, so no separate rule is needed.
 */
async function handleGloryctaCancelButton(interaction) {
    const [action, pollIdRaw] = interaction.customId.split(':');
    if (action !== 'glorycta_cancel') return false;

    const pollId = Number(pollIdRaw);
    const poll = db.prepare('SELECT * FROM glorycta_polls WHERE id = ?').get(pollId);
    if (!poll) {
        await interaction.reply({ content: 'This vote no longer exists or was already resolved.', flags: MessageFlags.Ephemeral });
        return true;
    }

    if (!(await enforcePermissions(interaction, 'glory', 'cta'))) return true;

    if (poll.job_id) db.prepare('DELETE FROM scheduled_jobs WHERE id = ?').run(poll.job_id);
    db.deleteGloryctaPoll(poll.id);

    await interaction.reply({ content: '🗑️ Vote cancelled.', flags: MessageFlags.Ephemeral });
    await interaction.message.delete().catch(err => console.error('[Glorycta] Failed to delete cancelled poll message:', err.message));

    return true;
}

module.exports = { handleGloryctaCancelButton };
