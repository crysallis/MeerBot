const db = require('../utils/db');

const Birthday = {
    upsert(userId, username, month, day, year, guildId) {
        return db.prepare(`
            INSERT INTO birthdays (user_id, username, month, day, year, guild_id, registered_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, guild_id) DO UPDATE SET
                username      = excluded.username,
                month         = excluded.month,
                day           = excluded.day,
                year          = excluded.year,
                registered_at = excluded.registered_at
        `).run(userId, username, month, day, year ?? null, guildId, new Date().toISOString());
    },

    findByGuild(guildId) {
        return db.prepare(
            'SELECT * FROM birthdays WHERE guild_id = ? ORDER BY month, day'
        ).all(guildId);
    },

    findToday() {
        const today = new Date();
        return db.prepare(
            'SELECT * FROM birthdays WHERE month = ? AND day = ?'
        ).all(today.getMonth() + 1, today.getDate());
    },
};

module.exports = Birthday;
