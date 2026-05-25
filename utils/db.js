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

  CREATE TABLE IF NOT EXISTS member_notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id   INTEGER NOT NULL REFERENCES members(id),
    note        TEXT NOT NULL,
    created_by  TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_notes_member ON member_notes(member_id);

  CREATE TABLE IF NOT EXISTS member_afk (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id   INTEGER NOT NULL UNIQUE REFERENCES members(id),
    reason      TEXT,
    return_date TEXT,
    set_by      TEXT NOT NULL,
    set_at      TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS scheduler_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL,
    sent_date TEXT NOT NULL,
    sent_at   TEXT NOT NULL DEFAULT '',
    late      INTEGER NOT NULL DEFAULT 0,
    UNIQUE(name, sent_date)
  );
`);

// Idempotent migrations
try { db.exec('ALTER TABLE members ADD COLUMN active INTEGER NOT NULL DEFAULT 0'); } catch {}

// Idempotent migrations for scheduler_log
for (const sql of [
    'ALTER TABLE scheduler_log ADD COLUMN id INTEGER',
    'ALTER TABLE scheduler_log ADD COLUMN sent_at TEXT NOT NULL DEFAULT \'\'',
    'ALTER TABLE scheduler_log ADD COLUMN late INTEGER NOT NULL DEFAULT 0',
]) {
    try { db.exec(sql); } catch { /* column already exists */ }
}

module.exports = db;
