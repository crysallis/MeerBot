const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.GUILD_DB_PATH || path.join(__dirname, '../../AFKDataMining/guild.db');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS birthdays (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       TEXT NOT NULL,
    username      TEXT,
    month         INTEGER NOT NULL,
    day           INTEGER NOT NULL,
    guild_id      TEXT NOT NULL,
    registered_at TEXT NOT NULL,
    UNIQUE(user_id, guild_id)
  );
  CREATE INDEX IF NOT EXISTS idx_bd_guild     ON birthdays(guild_id);
  CREATE INDEX IF NOT EXISTS idx_bd_month_day ON birthdays(month, day);

  CREATE TABLE IF NOT EXISTS scheduled_jobs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    type          TEXT NOT NULL,
    fire_at       TEXT NOT NULL,
    recurrence    TEXT,
    created_at    TEXT NOT NULL,
    last_fired_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sj_fire_at ON scheduled_jobs(fire_at);

  CREATE TABLE IF NOT EXISTS remindme_jobs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id     INTEGER NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    guild_id   TEXT NOT NULL,
    message    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS script_jobs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id       INTEGER NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
    handler_path TEXT NOT NULL,
    args         TEXT
  );

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
try { db.exec('ALTER TABLE birthdays DROP COLUMN year'); } catch {}
try { db.exec('ALTER TABLE birthdays ADD COLUMN set_by TEXT'); } catch {}
try { db.exec('ALTER TABLE scheduled_jobs DROP COLUMN last_fired_at'); } catch {}

// bot_config table — admin-panel overrides for env/hardcoded values
try { db.exec(`
    CREATE TABLE IF NOT EXISTS bot_config (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
`); } catch {}

// message_reactions table — auto-response rules for chat messages
try { db.exec(`
    CREATE TABLE IF NOT EXISTS message_reactions (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        name             TEXT NOT NULL,
        pattern          TEXT NOT NULL DEFAULT '',
        pattern_type     TEXT NOT NULL DEFAULT 'contains',
        ignore_case      INTEGER NOT NULL DEFAULT 1,
        channel_filter   TEXT,
        require_mention  INTEGER NOT NULL DEFAULT 0,
        response_type    TEXT NOT NULL DEFAULT 'reply',
        response_content TEXT NOT NULL DEFAULT '',
        response_channel TEXT,
        cooldown_seconds INTEGER NOT NULL DEFAULT 60,
        enabled          INTEGER NOT NULL DEFAULT 1,
        created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    )
`); } catch {}

// Only one mention-type rule allowed
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mr_one_mention ON message_reactions(pattern_type) WHERE pattern_type = 'mention'`); } catch {}

// Enable/disable flag for scheduled jobs
try { db.exec('ALTER TABLE scheduled_jobs ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1'); } catch {}

// Embed support on message reactions
try { db.exec(`ALTER TABLE message_reactions ADD COLUMN embed_title TEXT`); } catch {}
try { db.exec(`ALTER TABLE message_reactions ADD COLUMN embed_description TEXT`); } catch {}
try { db.exec(`ALTER TABLE message_reactions ADD COLUMN embed_color TEXT`); } catch {}

// Idempotent migrations for scheduler_log
for (const sql of [
    'ALTER TABLE scheduler_log ADD COLUMN id INTEGER',
    'ALTER TABLE scheduler_log ADD COLUMN sent_at TEXT NOT NULL DEFAULT \'\'',
    'ALTER TABLE scheduler_log ADD COLUMN late INTEGER NOT NULL DEFAULT 0',
]) {
    try { db.exec(sql); } catch { /* column already exists */ }
}

module.exports = db;
