const db = require('./db');

const RETENTION_DAYS = 90;
let lastPruneDate = null;

/**
 * Deletes scheduler_log rows older than RETENTION_DAYS. Runs at most once per
 * calendar day (guarded by lastPruneDate) since logJobRun fires many times a
 * day and a DELETE scan on every call would be wasted work.
 */
function pruneOldLogs() {
    const today = new Date().toISOString().slice(0, 10);
    if (lastPruneDate === today) return;
    lastPruneDate = today;

    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('DELETE FROM scheduler_log WHERE sent_at < ?').run(cutoff);
}

/**
 * Records that a scheduled job ran. Writes to scheduler_log so /schedule
 * can show last-fire times. Every call inserts a new row, including repeat
 * fires of the same job on the same day -- a job firing more often than
 * expected (e.g. an edited fire_at causing a same-day resend) is exactly the
 * kind of thing this log should surface, not silently absorb.
 */
function logJobRun(name, late = false) {
    const now = new Date();
    db.prepare(
        'INSERT INTO scheduler_log (name, sent_date, sent_at, late) VALUES (?, ?, ?, ?)'
    ).run(name, now.toISOString().slice(0, 10), now.toISOString(), late ? 1 : 0);
    pruneOldLogs();
}

module.exports = { logJobRun };
