'use strict';
const db = require('./db');
const botConfig = require('./botConfig');
const { pickRows } = require('./permissions');

function getDelayMs() {
    return Number(botConfig.get('AUTO_DELETE_SECONDS')) * 1000;
}

function isCommandAutoDeleteEnabled(command, subcommand) {
    const rows = db.prepare(
        `SELECT subcommand, enabled FROM auto_delete_rules
         WHERE scope = 'command' AND command = ? AND (subcommand IS ? OR subcommand IS NULL)`
    ).all(command, subcommand);
    const picked = pickRows(rows, subcommand);
    return picked.length > 0 && picked.some(r => r.enabled);
}

function isReactionAutoDeleteEnabled(ruleId) {
    const row = db.prepare(
        `SELECT enabled FROM auto_delete_rules WHERE scope = 'reaction_rule' AND reaction_rule_id = ?`
    ).get(ruleId);
    return !!row?.enabled;
}

function scheduleCommandAutoDelete(interaction, command, subcommand) {
    if (!interaction.replied && !interaction.deferred) return;
    let enabled;
    try {
        enabled = isCommandAutoDeleteEnabled(command, subcommand);
    } catch (err) {
        // A DB read failure here must never bubble into index.js's command dispatch
        // try/catch -- that catch calls interaction.editReply() on any thrown error,
        // which would silently overwrite this command's already-successful reply
        // with a generic error message. Swallow and skip auto-delete instead.
        console.error(`[autoDelete] lookup failed for ${command}/${subcommand ?? 'null'}: ${err.message}`);
        return;
    }
    if (!enabled) return;
    setTimeout(() => {
        interaction.deleteReply().catch(() => {});
    }, getDelayMs());
}

function scheduleReactionAutoDelete(message, ruleId) {
    if (!message) return;
    let enabled;
    try {
        enabled = isReactionAutoDeleteEnabled(ruleId);
    } catch (err) {
        console.error(`[autoDelete] reaction rule lookup failed for rule ${ruleId}: ${err.message}`);
        return;
    }
    if (!enabled) return;
    setTimeout(() => {
        message.delete().catch(() => {});
    }, getDelayMs());
}

module.exports = {
    isCommandAutoDeleteEnabled,
    isReactionAutoDeleteEnabled,
    scheduleCommandAutoDelete,
    scheduleReactionAutoDelete,
};
