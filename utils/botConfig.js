'use strict';
require('dotenv').config();
const db = require('./db');

const CONFIG_META = {
    // --- Channels ---
    BIRTHDAY_CHANNEL_ID:         { label: 'Birthday Channel',          description: 'Channel for birthday posts',              category: 'channels',    default: '' },
    ANNIVERSARY_CHANNEL_ID:      { label: 'Anniversary Channel',       description: 'Channel for anniversary posts',           category: 'channels',    default: '' },
    GENERAL_CHANNEL_ID:          { label: 'General Channel',           description: 'Channel for daily reset messages',        category: 'channels',    default: '' },
    COMMAND_LOG_CHANNEL_ID:      { label: 'Command Log Channel',       description: 'Channel for command audit log',           category: 'channels',    default: '' },
    INACTIVITY_ALERT_CHANNEL_ID: { label: 'Inactivity Alert Channel',  description: 'Channel for inactivity alerts post-scan', category: 'channels',    default: '' },
    SCAN_REMINDER_CHANNEL_ID:    { label: 'Scan Reminder Channel',     description: 'Channel for daily scan reminder',         category: 'channels',    default: '' },
    WEEKLY_SUMMARY_CHANNEL_ID:   { label: 'Weekly Summary Channel',    description: 'Channel for Monday power summary',        category: 'channels',    default: '' },
    // --- Thresholds ---
    INACTIVITY_DAYS:             { label: 'Inactivity Days',           description: 'Days before flagging a member inactive',  category: 'thresholds',  default: '3' },
    LATE_WARNING_MINUTES:        { label: 'Late Warning Minutes',      description: 'Minutes late before adding a late footer',category: 'thresholds',  default: '30' },
    // --- Permissions ---
    SCAN_AUTHORIZED_USER:        { label: 'Scan Authorized User',      description: 'Discord user ID allowed to run /scan',    category: 'permissions', default: '' },
};

function get(key, fallback = '') {
    const row = db.prepare('SELECT value FROM bot_config WHERE key = ?').get(key);
    if (row) return row.value;
    if (process.env[key]) return process.env[key];
    return CONFIG_META[key]?.default ?? fallback;
}

function set(key, value) {
    if (value === null || value === '') {
        db.prepare('DELETE FROM bot_config WHERE key = ?').run(key);
    } else {
        db.prepare(`
            INSERT INTO bot_config (key, value, updated_at) VALUES (?, ?, datetime('now'))
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).run(key, String(value));
    }
}

function getAll() {
    const dbMap = Object.fromEntries(
        db.prepare('SELECT key, value, updated_at FROM bot_config').all().map(r => [r.key, r])
    );
    return Object.entries(CONFIG_META).map(([key, meta]) => {
        const dbRow = dbMap[key];
        let value, source;
        if (dbRow)               { value = dbRow.value;      source = 'DB';      }
        else if (process.env[key]) { value = process.env[key]; source = 'ENV';     }
        else                     { value = meta.default;     source = 'DEFAULT'; }
        return {
            key,
            value,
            source,
            label: meta.label,
            description: meta.description,
            category: meta.category,
            updated_at: dbRow?.updated_at ?? null,
        };
    });
}

module.exports = { get, set, getAll, CONFIG_META };
