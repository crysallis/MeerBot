const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.GUILD_DB_PATH || path.join(__dirname, '../../AFKDataMining/guild.db');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS birthdays (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       TEXT NOT NULL,
    username      TEXT,
    month         INTEGER NOT NULL,
    day           INTEGER NOT NULL,
    year          INTEGER,
    guild_id      TEXT NOT NULL,
    registered_at TEXT NOT NULL,
    UNIQUE(user_id, guild_id)
  );
  CREATE INDEX IF NOT EXISTS idx_bd_guild     ON birthdays(guild_id);
  CREATE INDEX IF NOT EXISTS idx_bd_month_day ON birthdays(month, day);

  CREATE TABLE IF NOT EXISTS members (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ingame_name   TEXT NOT NULL UNIQUE,
    discord_id    TEXT UNIQUE,
    discord_name  TEXT,
    first_seen    TEXT NOT NULL,
    notes         TEXT
  );

  CREATE TABLE IF NOT EXISTS member_name_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id   INTEGER NOT NULL REFERENCES members(id),
    old_name    TEXT NOT NULL,
    new_name    TEXT NOT NULL,
    changed_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS name_corrections (
    ocr_name     TEXT PRIMARY KEY,
    correct_name TEXT NOT NULL,
    source       TEXT NOT NULL DEFAULT 'ocr'
  );
`);

module.exports = db;
