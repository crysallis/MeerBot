const db = require('./db');

/**
 * Records that a scheduled job ran. Writes to scheduler_log so /schedule
 * can show last-fire times. UNIQUE(name, sent_date) constraint silently
 * dedups same-day re-runs (e.g. interval ticks that fire twice in a minute).
 */
function logJobRun(name, late = false) {
    const now = new Date();
    db.prepare(
        'INSERT OR IGNORE INTO scheduler_log (name, sent_date, sent_at, late) VALUES (?, ?, ?, ?)'
    ).run(name, now.toISOString().slice(0, 10), now.toISOString(), late ? 1 : 0);
}

module.exports = { logJobRun };
