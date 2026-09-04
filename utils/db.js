const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.GUILD_DB_PATH || path.join(__dirname, '../../AFKDataMining/guild.db');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// Schema ownership: the bot owns its BOT-ONLY tables below. The shared scan +
// member-identity tables (members, snapshots, member_snapshots, name_corrections,
// member_name_history) are owned and created by the miner (AFKDataMining/src/db.py)
// · the bot reads and writes them but never defines them. guilds and warbands are
// bot-owned (Discord role/membership management is a bot concern, not a mining
// concern) even though the miner still reads warbands to resolve OCR'd names.
// CREATE statements always reflect the CURRENT shape: when the schema changes, run
// the ALTER once against guild.db and fold the column in here · no migration trail
// replayed on startup.
const sharedReady = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'members'").get();
if (!sharedReady) {
    console.warn('[DB] Shared schema missing (members/snapshots) · it is owned by the AFKDataMining scraper · run a scan (or db.py init_db) to create it.');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS guilds (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT NOT NULL UNIQUE,
    override_role_ids TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS warbands (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL UNIQUE,
    sort_order     INTEGER NOT NULL DEFAULT 0,
    archived       INTEGER NOT NULL DEFAULT 0,
    guild_id       INTEGER REFERENCES guilds(id),
    leader_role_id TEXT,
    member_role_id TEXT
  );
`);

// warbands may already exist (created by the miner pre-migration) without the
// guild_id/leader_role_id/member_role_id columns · SQLite has no ADD COLUMN IF
// NOT EXISTS, so check first. Safe to run every startup.
const warbandCols = new Set(db.prepare("PRAGMA table_info(warbands)").all().map(c => c.name));
for (const [col, ddl] of [
    ['guild_id', 'ALTER TABLE warbands ADD COLUMN guild_id INTEGER REFERENCES guilds(id)'],
    ['leader_role_id', 'ALTER TABLE warbands ADD COLUMN leader_role_id TEXT'],
    ['member_role_id', 'ALTER TABLE warbands ADD COLUMN member_role_id TEXT'],
]) {
    if (!warbandCols.has(col)) db.exec(ddl);
}

// Seed guilds + backfill the known warbands' guild_id (idempotent). RKF Frop's
// own warbands aren't seeded here since the miner can't scan that guild to
// discover them · add via the admin panel once known.
const SEED_GUILDS = ['RKF RiffRaff', 'RKF Frop'];
for (const name of SEED_GUILDS) {
    db.prepare('INSERT OR IGNORE INTO guilds (name) VALUES (?)').run(name);
}
const riffRaffGuildId = db.prepare('SELECT id FROM guilds WHERE name = ?').get('RKF RiffRaff')?.id;
const SEED_WARBANDS = ['RKF RiffRaff', 'RKF Kings', 'Sobaquitos'];
if (riffRaffGuildId) {
    for (const name of SEED_WARBANDS) {
        db.prepare('INSERT OR IGNORE INTO warbands (name, sort_order) VALUES (?, ?)')
            .run(name, SEED_WARBANDS.indexOf(name));
        db.prepare('UPDATE warbands SET guild_id = ? WHERE name = ? AND guild_id IS NULL')
            .run(riffRaffGuildId, name);
    }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS birthdays (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       TEXT NOT NULL,
    username      TEXT,
    month         INTEGER NOT NULL,
    day           INTEGER NOT NULL,
    guild_id      TEXT NOT NULL,
    registered_at TEXT NOT NULL,
    set_by        TEXT,
    UNIQUE(user_id, guild_id)
  );
  CREATE INDEX IF NOT EXISTS idx_bd_guild     ON birthdays(guild_id);
  CREATE INDEX IF NOT EXISTS idx_bd_month_day ON birthdays(month, day);

  CREATE TABLE IF NOT EXISTS scheduled_jobs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    type            TEXT NOT NULL,
    fire_at         TEXT NOT NULL,
    recurrence      TEXT,
    day_of_month    INTEGER,
    last_day_offset INTEGER,
    created_at      TEXT NOT NULL,
    enabled         INTEGER NOT NULL DEFAULT 1
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

  CREATE TABLE IF NOT EXISTS text_jobs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id       INTEGER NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    channel_id   TEXT NOT NULL,
    title        TEXT,
    body         TEXT NOT NULL,
    mentions     TEXT NOT NULL DEFAULT '[]',
    days_of_week TEXT,
    log_name     TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS ally_seasons (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    name   TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS ally_servers (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    server_number INTEGER NOT NULL,
    season_id     INTEGER NOT NULL REFERENCES ally_seasons(id) ON DELETE CASCADE,
    UNIQUE(server_number, season_id)
  );
  CREATE INDEX IF NOT EXISTS idx_ally_servers_season ON ally_servers(season_id);

  CREATE TABLE IF NOT EXISTS recruitment (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL,
    power          INTEGER NOT NULL,
    server_id      INTEGER REFERENCES ally_servers(id),
    dr_rank        INTEGER,
    sup_arena_rank INTEGER,
    lab_rank       INTEGER,
    dual_rank      INTEGER,
    interest       TEXT NOT NULL DEFAULT 'unknown',
    response       TEXT NOT NULL DEFAULT 'first_contact',
    contacted_at   TEXT NOT NULL,
    created_by     TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'scouting'
  );

  CREATE TABLE IF NOT EXISTS recruitment_followups (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id         INTEGER NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
    user_id        TEXT NOT NULL,
    recruitment_id INTEGER NOT NULL,
    channel_id     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS wishlist (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    item         TEXT NOT NULL,
    priority     TEXT NOT NULL DEFAULT 'medium',
    submitted_by TEXT NOT NULL,
    submitted_at TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'not started'
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
    late      INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS scan_timings (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    mode            TEXT NOT NULL,
    status          TEXT NOT NULL,
    duration_ms     INTEGER NOT NULL,
    run_started_at  TEXT NOT NULL,
    scanned_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bot_config (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

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
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    embed_title      TEXT,
    embed_description TEXT,
    embed_color      TEXT,
    embed_image_url     TEXT,
    embed_thumbnail_url TEXT,
    embed_footer_text   TEXT,
    embed_footer_icon_url TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_mr_one_mention ON message_reactions(pattern_type) WHERE pattern_type = 'mention';

  CREATE TABLE IF NOT EXISTS newsletters (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    volume    TEXT,
    title     TEXT,
    content   TEXT NOT NULL,
    posted_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS newsletter_notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    note_text  TEXT NOT NULL,
    category   TEXT NOT NULL DEFAULT 'other',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS command_permissions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    command    TEXT NOT NULL,
    subcommand TEXT,
    type       TEXT NOT NULL CHECK(type IN ('role', 'channel')),
    value_id   TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(command, subcommand, type, value_id)
  );
  CREATE INDEX IF NOT EXISTS idx_cp_lookup ON command_permissions(command, subcommand, type);

  CREATE TABLE IF NOT EXISTS auto_delete_rules (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    scope            TEXT NOT NULL CHECK(scope IN ('command', 'reaction_rule')),
    command          TEXT,
    subcommand       TEXT,
    reaction_rule_id INTEGER,
    enabled          INTEGER NOT NULL DEFAULT 1,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(scope, command, subcommand, reaction_rule_id)
  );
  CREATE INDEX IF NOT EXISTS idx_adr_lookup ON auto_delete_rules(scope, command, subcommand);

  CREATE TABLE IF NOT EXISTS panel_roles (
    role_id TEXT PRIMARY KEY,
    tier    TEXT NOT NULL CHECK(tier IN ('read', 'manage', 'local'))
  );

  CREATE TABLE IF NOT EXISTS panel_audit (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT NOT NULL,
    action     TEXT NOT NULL,
    target     TEXT,
    at         TEXT NOT NULL,
    site       TEXT NOT NULL DEFAULT 'admin'
  );
  CREATE INDEX IF NOT EXISTS idx_panel_audit_at ON panel_audit(at);

  CREATE TABLE IF NOT EXISTS panel_op_access (
    op_key TEXT PRIMARY KEY,
    tier   TEXT NOT NULL CHECK(tier IN ('read', 'manage', 'local'))
  );

  CREATE TABLE IF NOT EXISTS panel_presence (
    site       TEXT NOT NULL DEFAULT 'admin',
    discord_id TEXT NOT NULL,
    name       TEXT,
    avatar     TEXT,
    last_seen  TEXT NOT NULL,
    PRIMARY KEY (site, discord_id)
  );

  CREATE TABLE IF NOT EXISTS promo_codes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    code       TEXT NOT NULL UNIQUE,
    posted_at  TEXT NOT NULL,
    message_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_promo_codes_posted ON promo_codes(posted_at);

  CREATE TABLE IF NOT EXISTS transfer_approvals (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    transfer_id       TEXT NOT NULL UNIQUE,
    member_id         INTEGER NOT NULL REFERENCES members(id),
    from_warband_id   INTEGER REFERENCES warbands(id),
    to_warband_id     INTEGER NOT NULL REFERENCES warbands(id),
    direction         TEXT NOT NULL CHECK(direction IN ('pull', 'push')),
    requested_by      TEXT NOT NULL,
    approving_role_id TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested', 'approved', 'denied')),
    approver_user_id  TEXT,
    acted_at          TEXT,
    message_id        TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ta_status ON transfer_approvals(status);

  -- One row per Discord user determined eligible to approve/deny a transfer
  -- request, whether or not their DM actually sent (message_id is NULL if it
  -- didn't). This is also the authorization source for button clicks: whoever
  -- was eligible when the request was created may act on it, checked by user
  -- id rather than re-deriving role membership at click time.
  CREATE TABLE IF NOT EXISTS transfer_approval_eligibility (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    transfer_id  TEXT NOT NULL REFERENCES transfer_approvals(transfer_id),
    user_id      TEXT NOT NULL,
    message_id   TEXT,
    UNIQUE(transfer_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_tae_transfer ON transfer_approval_eligibility(transfer_id);

  CREATE TABLE IF NOT EXISTS translation_relay_channels (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id    TEXT NOT NULL UNIQUE,
    language      TEXT NOT NULL,
    flag_emoji    TEXT NOT NULL,
    relay_group   TEXT NOT NULL DEFAULT 'default',
    webhook_id    TEXT,
    webhook_token TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_trc_group ON translation_relay_channels(relay_group);

  -- One row per relayed copy of a message, INCLUDING the original (channel_id = source
  -- channel, message_id = the original message's own id). relay_group_message_id is shared
  -- across every copy of the same logical message: it is the id of that message's
  -- first-inserted row (the source copy), looked up via whichever message a reply references.
  CREATE TABLE IF NOT EXISTS translation_relay_messages (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    relay_group_message_id INTEGER NOT NULL,
    channel_id              TEXT NOT NULL,
    message_id               TEXT NOT NULL UNIQUE,
    author_id                TEXT NOT NULL,
    author_display_name      TEXT NOT NULL,
    language                 TEXT NOT NULL,
    text                     TEXT NOT NULL,
    batch_message_ids        TEXT NOT NULL DEFAULT '[]',
    last_line_text           TEXT NOT NULL DEFAULT '',
    created_at               TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_trm_group_msg ON translation_relay_messages(relay_group_message_id);
  CREATE INDEX IF NOT EXISTS idx_trm_message ON translation_relay_messages(message_id);

  -- One row per successful Claude API call, across every feature that makes
  -- one -- translation relay (feature='translation') and Ask MeerBot DM
  -- answers (feature='ask') today. ref_id is feature-specific: the source
  -- message id for translation, the asking user's Discord id for ask. Not
  -- logged on failure. One shared table so total/breakdown-by-feature cost
  -- is a single query instead of unioning per-feature tables by hand.
  -- target_count is translation-only (how many languages that batch
  -- translated to) -- NULL for every other feature.
  CREATE TABLE IF NOT EXISTS claude_usage (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    feature       TEXT NOT NULL,
    ref_id        TEXT NOT NULL,
    input_tokens  INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    target_count  INTEGER,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- One row per Ask MeerBot DM exchange worth a leader's attention -- either
  -- the model itself declined to answer (source='auto', it self-reports via
  -- the flagged field in its own JSON response) or a member reacted on the
  -- bot's reply to flag it (source='reported'). Deliberately NOT a full
  -- transcript of every DM -- normal answered exchanges are never written
  -- here, only ones with a specific reason to look at them. See
  -- utils/handlers/askHandler.js and docs/superpowers/specs/2026-08-16-ask-moderation-design.md.
  CREATE TABLE IF NOT EXISTS ask_flags (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL,
    question   TEXT NOT NULL,
    answer     TEXT NOT NULL,
    source     TEXT NOT NULL CHECK(source IN ('auto', 'reported')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- One row per open /glory cta or /glory confirm post, looked up by message_id
  -- from the messageReactionAdd guard on every reaction add (so this needs to stay
  -- a fast, indexed lookup -- UNIQUE gives that for free). kind distinguishes the
  -- two: 'cta' is /glory cta's timed two-option vote (job_id set, row deleted once
  -- the tally job fires); 'confirm' is /glory confirm's untimed three-option
  -- (yes/no/maybe) check-in (job_id NULL -- no timer, no auto-tally; /glory count
  -- reads its reactions live and the row is never auto-deleted, by design -- see
  -- docs/superpowers/specs/2026-08-13-glory-confirm-count-design.md). emoji_c/
  -- label_c are only populated for 'confirm' rows (the third, "maybe" option);
  -- NULL for 'cta' rows, which only ever have two options.
  CREATE TABLE IF NOT EXISTS glorycta_polls (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT NOT NULL DEFAULT 'cta' CHECK(kind IN ('cta', 'confirm')),
    job_id     INTEGER REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL UNIQUE,
    channel_id TEXT NOT NULL,
    emoji_a    TEXT NOT NULL,
    emoji_b    TEXT NOT NULL,
    emoji_c    TEXT,
    label_a    TEXT NOT NULL,
    label_b    TEXT NOT NULL,
    label_c    TEXT,
    fire_at_a  TEXT,
    fire_at_b  TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS member_checkin_dms (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id             INTEGER NOT NULL REFERENCES members(id),
    discord_id            TEXT NOT NULL,
    dm_message_id         TEXT,
    sent_at               TEXT NOT NULL,
    days_inactive_at_send INTEGER NOT NULL,
    status                TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'responded_text', 'responded_reaction', 'dm_failed')),
    response_text         TEXT,
    response_emoji        TEXT,
    responded_at          TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_checkin_message ON member_checkin_dms(dm_message_id);
  CREATE INDEX IF NOT EXISTS idx_checkin_member_status ON member_checkin_dms(member_id, status);
`);

// translation_relay_messages may already exist (shipped pre-batching) without the
// batch_message_ids/last_line_text columns · SQLite has no ADD COLUMN IF NOT
// EXISTS, so check first. Safe to run every startup.
const relayMessageCols = new Set(db.prepare("PRAGMA table_info(translation_relay_messages)").all().map(c => c.name));
for (const [col, ddl] of [
    ['batch_message_ids', "ALTER TABLE translation_relay_messages ADD COLUMN batch_message_ids TEXT NOT NULL DEFAULT '[]'"],
    ['last_line_text', "ALTER TABLE translation_relay_messages ADD COLUMN last_line_text TEXT NOT NULL DEFAULT ''"],
]) {
    if (!relayMessageCols.has(col)) db.exec(ddl);
}

// scheduled_jobs may already exist (shipped pre-offset-qualifier) without the
// last_day_offset column · SQLite has no ADD COLUMN IF NOT EXISTS, so check
// first. Safe to run every startup.
const scheduledJobCols = new Set(db.prepare("PRAGMA table_info(scheduled_jobs)").all().map(c => c.name));
for (const [col, ddl] of [
    ['last_day_offset', 'ALTER TABLE scheduled_jobs ADD COLUMN last_day_offset INTEGER'],
]) {
    if (!scheduledJobCols.has(col)) db.exec(ddl);
}

// glorycta_polls originally had job_id NOT NULL and no kind/emoji_c/label_c
// columns (cta-only shape). /glory confirm needs job_id nullable (no timer/tally
// job) plus the extra columns for its third yes/no/maybe option -- SQLite's
// ADD COLUMN can't relax an existing NOT NULL, so this rebuilds the table via the
// standard SQLite recipe (new table, copy, drop, rename) rather than ALTERing in
// place. Guarded on the OLD shape specifically (job_id still NOT NULL) so it only
// ever runs once, is a no-op after that, and never touches a fresh install (which
// gets the new shape directly from the CREATE TABLE above).
const gloryctaPollsInfo = db.prepare("PRAGMA table_info(glorycta_polls)").all();
const jobIdCol = gloryctaPollsInfo.find(c => c.name === 'job_id');
if (jobIdCol && jobIdCol.notnull === 1) {
    db.exec(`
        ALTER TABLE glorycta_polls RENAME TO glorycta_polls_old;
        CREATE TABLE glorycta_polls (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            kind       TEXT NOT NULL DEFAULT 'cta' CHECK(kind IN ('cta', 'confirm')),
            job_id     INTEGER REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
            message_id TEXT NOT NULL UNIQUE,
            channel_id TEXT NOT NULL,
            emoji_a    TEXT NOT NULL,
            emoji_b    TEXT NOT NULL,
            emoji_c    TEXT,
            label_a    TEXT NOT NULL,
            label_b    TEXT NOT NULL,
            label_c    TEXT,
            fire_at_a  TEXT,
            fire_at_b  TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO glorycta_polls (id, kind, job_id, message_id, channel_id, emoji_a, emoji_b, label_a, label_b, fire_at_a, fire_at_b, created_at)
            SELECT id, 'cta', job_id, message_id, channel_id, emoji_a, emoji_b, label_a, label_b, fire_at_a, fire_at_b, created_at FROM glorycta_polls_old;
        DROP TABLE glorycta_polls_old;
    `);
    console.log('[DB] Migrated glorycta_polls to nullable job_id + kind/emoji_c/label_c columns.');
}

// v3: batch_message_ids shape changed from string[] (message IDs only) to
// {messageId, text}[] (ID + that line's own source text), needed for precise
// edit/delete sync on one line of a multi-message batch. Rewrite any row still
// in the old flat-string shape. Safe to run every startup -- a no-op once migrated.
function runRelayMessageMigration() {
    const rows = db.prepare('SELECT id, message_id, text, batch_message_ids FROM translation_relay_messages').all();
    const update = db.prepare('UPDATE translation_relay_messages SET batch_message_ids = ? WHERE id = ?');
    for (const row of rows) {
        let parsed;
        try {
            parsed = JSON.parse(row.batch_message_ids);
        } catch {
            continue; // corrupt/unreadable, leave as-is rather than guess
        }
        if (!Array.isArray(parsed) || parsed.length === 0) continue;
        if (typeof parsed[0] === 'object' && parsed[0] !== null && 'messageId' in parsed[0]) continue; // already migrated
        const lines = row.text.split('\n');
        const rebuilt = parsed.length === lines.length
            ? parsed.map((messageId, i) => ({ messageId, text: lines[i] }))
            : parsed.map(messageId => ({ messageId, text: row.text })); // count mismatch: fall back to whole text per id, best effort
        update.run(JSON.stringify(rebuilt), row.id);
    }
}
runRelayMessageMigration();

// One-time consolidation: translation_usage (and the short-lived ask_usage,
// added and dropped in the same feature wave) merge into claude_usage so
// cost across every Claude-calling feature is one table, one query, instead
// of unioning per-feature usage tables by hand. Guarded on translation_usage
// still existing -- a no-op after the first run, never touches a fresh
// install (which never creates translation_usage at all).
const usageTables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('translation_usage', 'ask_usage')"
).all().map(r => r.name);
if (usageTables.includes('translation_usage')) {
    db.exec(`
        INSERT INTO claude_usage (feature, ref_id, input_tokens, output_tokens, target_count, created_at)
            SELECT 'translation', message_id, input_tokens, output_tokens, target_count, created_at FROM translation_usage;
        DROP TABLE translation_usage;
    `);
    console.log('[DB] Migrated translation_usage rows into claude_usage.');
}
if (usageTables.includes('ask_usage')) {
    db.exec(`
        INSERT INTO claude_usage (feature, ref_id, input_tokens, output_tokens, created_at)
            SELECT 'ask', user_id, input_tokens, output_tokens, created_at FROM ask_usage;
        DROP TABLE ask_usage;
    `);
    console.log('[DB] Migrated ask_usage rows into claude_usage.');
}

/**
 * Merge duplicate members: repoint all of dropId's data onto keepId, alias the
 * dropped name, and delete the dropped row. Used to collapse OCR phantom dupes
 * and by /rename + admin merge when a rename would collide with an existing name.
 * Returns the kept member's id.
 */
function mergeMembers(keepId, dropId) {
    keepId = Number(keepId);
    dropId = Number(dropId);
    if (!keepId || !dropId || keepId === dropId) {
        throw new Error('mergeMembers needs two distinct member ids');
    }
    const keep = db.prepare('SELECT * FROM members WHERE id = ?').get(keepId);
    const drop = db.prepare('SELECT * FROM members WHERE id = ?').get(dropId);
    if (!keep || !drop) throw new Error('mergeMembers: member not found');

    const tx = db.transaction(() => {
        // Keep only one AFK row (UNIQUE on member_id) — prefer the kept member's
        const keepHasAfk = db.prepare('SELECT 1 FROM member_afk WHERE member_id = ?').get(keepId);
        if (keepHasAfk) {
            db.prepare('DELETE FROM member_afk WHERE member_id = ?').run(dropId);
        } else {
            db.prepare('UPDATE member_afk SET member_id = ? WHERE member_id = ?').run(keepId, dropId);
        }

        // Collapse snapshot rows: if the keeper already has a row in a scan, drop the
        // duplicate (same person can't appear twice in one snapshot); repoint the rest.
        db.prepare(`DELETE FROM member_snapshots
                    WHERE member_id = ?
                      AND snapshot_id IN (SELECT snapshot_id FROM member_snapshots WHERE member_id = ?)`)
            .run(dropId, keepId);
        db.prepare('UPDATE member_snapshots   SET member_id = ? WHERE member_id = ?').run(keepId, dropId);
        db.prepare('UPDATE member_notes       SET member_id = ? WHERE member_id = ?').run(keepId, dropId);
        db.prepare('UPDATE member_name_history SET member_id = ? WHERE member_id = ?').run(keepId, dropId);
        db.prepare('UPDATE member_checkin_dms SET member_id = ? WHERE member_id = ?').run(keepId, dropId);

        // This hand-maintained table list will drift as the miner adds new ranking tables
        // (each one FK-referencing members(id) will break the DELETE below if missed here).
        // To regenerate the full list: SELECT sql FROM sqlite_master WHERE type='table'
        // AND sql LIKE '%REFERENCES members%'

        // Single-row-per-member ranking tables (member_id is PRIMARY KEY) — both rows are
        // scan-derived, so unlike member_afk (human-set) the freshest scanned_at wins,
        // not "keeper wins": a merge target is often stale/inactive while the dropped
        // row is the fresh scan read that surfaced this duplicate in the first place.
        for (const table of ['arena_rankings', 'honor_duel_rankings', 'clashfronts_signups']) {
            const keepRow = db.prepare(`SELECT scanned_at FROM ${table} WHERE member_id = ?`).get(keepId);
            const dropRow = db.prepare(`SELECT scanned_at FROM ${table} WHERE member_id = ?`).get(dropId);
            if (keepRow && dropRow) {
                if (dropRow.scanned_at > keepRow.scanned_at) {
                    db.prepare(`DELETE FROM ${table} WHERE member_id = ?`).run(keepId);
                    db.prepare(`UPDATE ${table} SET member_id = ? WHERE member_id = ?`).run(keepId, dropId);
                } else {
                    db.prepare(`DELETE FROM ${table} WHERE member_id = ?`).run(dropId);
                }
            } else if (dropRow) {
                db.prepare(`UPDATE ${table} SET member_id = ? WHERE member_id = ?`).run(keepId, dropId);
            }
        }

        // Multi-row ranking tables keyed by (member_id, period) — same collapse
        // pattern as member_snapshots: drop overlapping periods, repoint the rest.
        for (const { table, periodCol } of [
            { table: 'afk_stage_rankings', periodCol: 'season, phase' },
            { table: 'supreme_arena_rankings', periodCol: 'period_start' },
            { table: 'guild_duel_rankings', periodCol: 'period_start' },
        ]) {
            db.prepare(`DELETE FROM ${table}
                        WHERE member_id = ?
                          AND (${periodCol}) IN (SELECT ${periodCol} FROM ${table} WHERE member_id = ?)`)
                .run(dropId, keepId);
            db.prepare(`UPDATE ${table} SET member_id = ? WHERE member_id = ?`).run(keepId, dropId);
        }

        // transfer_approvals: historical log, just repoint, no collision possible (transfer_id is unique per row).
        db.prepare('UPDATE transfer_approvals SET member_id = ? WHERE member_id = ?').run(keepId, dropId);

        // If the kept row has no Discord link but the dropped one did, carry it over
        if (!keep.discord_id && drop.discord_id) {
            db.prepare('UPDATE members SET discord_id = ?, discord_name = ? WHERE id = ?')
                .run(drop.discord_id, drop.discord_name, keepId);
        }

        // Merging into a member means they're a real, current identity — reactivate
        // even if they'd been marked inactive (missed) by a prior scan.
        db.prepare('UPDATE members SET active = 1 WHERE id = ?').run(keepId);

        // Alias the dropped OCR name to the kept canonical name for future scans
        db.prepare(`INSERT OR REPLACE INTO name_corrections (ocr_name, correct_name, source)
                    VALUES (?, ?, 'merge')`).run(drop.ingame_name.toLowerCase(), keep.ingame_name);
        db.prepare('INSERT INTO member_name_history (member_id, old_name, new_name, changed_at) VALUES (?, ?, ?, ?)')
            .run(keepId, drop.ingame_name, keep.ingame_name, new Date().toISOString());

        db.prepare('DELETE FROM members WHERE id = ?').run(dropId);
    });
    tx();
    return keepId;
}

/** List warbands (active first, by sort order). */
function getWarbands(includeArchived = false) {
    return db.prepare(`SELECT * FROM warbands ${includeArchived ? '' : 'WHERE archived = 0'}
                       ORDER BY archived, sort_order, name COLLATE NOCASE`).all();
}

/** List guilds. */
function getGuilds() {
    return db.prepare('SELECT * FROM guilds ORDER BY name COLLATE NOCASE').all();
}

/** Discord role IDs allowed to bypass transfer approval for this guild. */
function getGuildOverrideRoles(guildId) {
    const row = db.prepare('SELECT override_role_ids FROM guilds WHERE id = ?').get(guildId);
    if (!row) return [];
    try {
        return JSON.parse(row.override_role_ids);
    } catch {
        return [];
    }
}

function setGuildOverrideRoles(guildId, roleIds) {
    db.prepare('UPDATE guilds SET override_role_ids = ? WHERE id = ?')
        .run(JSON.stringify(roleIds), guildId);
}

/** Set a warband's leader role (must approve transfers into/out of the warband). */
function setWarbandLeaderRole(warbandId, roleId) {
    db.prepare('UPDATE warbands SET leader_role_id = ? WHERE id = ?').run(roleId || null, warbandId);
}

/** Set a warband's member role (granted/removed on transfer). */
function setWarbandMemberRole(warbandId, roleId) {
    db.prepare('UPDATE warbands SET member_role_id = ? WHERE id = ?').run(roleId || null, warbandId);
}

/**
 * Rename a warband in one place. Updates the canonical row and re-syncs the
 * denormalized text cache on member_snapshots so every view follows immediately.
 */
function renameWarband(id, newName) {
    newName = String(newName || '').trim();
    if (!newName) throw new Error('Warband name required');
    const clash = db.prepare('SELECT id FROM warbands WHERE name = ? AND id != ?').get(newName, id);
    if (clash) throw new Error('A warband with that name already exists');
    const tx = db.transaction(() => {
        db.prepare('UPDATE warbands SET name = ? WHERE id = ?').run(newName, id);
        db.prepare('UPDATE member_snapshots SET warband = ? WHERE warband_id = ?').run(newName, id);
    });
    tx();
}

/**
 * Set a member's current warband (manual override). Also stamps their latest
 * snapshot row so /guild views reflect it without waiting for a re-scan.
 * Pass warbandId = null to clear.
 */
function setMemberWarband(memberId, warbandId) {
    warbandId = warbandId ? Number(warbandId) : null;
    const name = warbandId ? (db.prepare('SELECT name FROM warbands WHERE id = ?').get(warbandId)?.name ?? '') : '';
    const latest = db.prepare('SELECT MAX(id) AS id FROM snapshots').get()?.id;
    const tx = db.transaction(() => {
        db.prepare('UPDATE members SET warband_id = ? WHERE id = ?').run(warbandId, memberId);
        if (latest) {
            db.prepare('UPDATE member_snapshots SET warband_id = ?, warband = ? WHERE member_id = ? AND snapshot_id = ?')
                .run(warbandId, name, memberId, latest);
        }
    });
    tx();
}

/** Create a pending transfer_approvals row. Returns the row. */
function createTransferApproval({ transferId, memberId, fromWarbandId, toWarbandId, direction, requestedBy, approvingRoleId }) {
    db.prepare(`INSERT INTO transfer_approvals
        (transfer_id, member_id, from_warband_id, to_warband_id, direction, requested_by, approving_role_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(transferId, memberId, fromWarbandId, toWarbandId, direction, requestedBy, approvingRoleId);
    return getTransferApproval(transferId);
}

function getTransferApproval(transferId) {
    return db.prepare('SELECT * FROM transfer_approvals WHERE transfer_id = ?').get(transferId);
}

function setTransferApprovalMessage(transferId, messageId) {
    db.prepare('UPDATE transfer_approvals SET message_id = ? WHERE transfer_id = ?').run(messageId, transferId);
}

/** Resolve a pending transfer (approve/deny). No-op (returns false) if already resolved. */
function resolveTransferApproval(transferId, status, approverUserId) {
    const r = db.prepare(`UPDATE transfer_approvals
        SET status = ?, approver_user_id = ?, acted_at = datetime('now')
        WHERE transfer_id = ? AND status = 'requested'`)
        .run(status, approverUserId, transferId);
    return r.changes > 0;
}

/** Record a user as eligible to approve/deny this transfer (regardless of DM delivery). */
function addTransferApprovalEligibility(transferId, userId) {
    db.prepare('INSERT OR IGNORE INTO transfer_approval_eligibility (transfer_id, user_id) VALUES (?, ?)')
        .run(transferId, userId);
}

function setTransferApprovalDmMessage(transferId, userId, messageId) {
    db.prepare('UPDATE transfer_approval_eligibility SET message_id = ? WHERE transfer_id = ? AND user_id = ?')
        .run(messageId, transferId, userId);
}

function isTransferApprovalEligible(transferId, userId) {
    return !!db.prepare('SELECT 1 FROM transfer_approval_eligibility WHERE transfer_id = ? AND user_id = ?').get(transferId, userId);
}

function getTransferApprovalDms(transferId) {
    return db.prepare('SELECT user_id, message_id FROM transfer_approval_eligibility WHERE transfer_id = ? AND message_id IS NOT NULL').all(transferId);
}

/** List relay channels in a group, ordered by id (stable for iteration). */
function getRelayChannels(relayGroup = 'default') {
    return db.prepare('SELECT * FROM translation_relay_channels WHERE relay_group = ? ORDER BY id')
        .all(relayGroup);
}

function getRelayChannelByChannelId(channelId) {
    return db.prepare('SELECT * FROM translation_relay_channels WHERE channel_id = ?').get(channelId);
}

function addRelayChannel({ channelId, language, flagEmoji, relayGroup = 'default' }) {
    const r = db.prepare(`INSERT INTO translation_relay_channels (channel_id, language, flag_emoji, relay_group)
        VALUES (?, ?, ?, ?)`).run(channelId, language, flagEmoji, relayGroup);
    return r.lastInsertRowid;
}

function removeRelayChannel(id) {
    db.prepare('DELETE FROM translation_relay_channels WHERE id = ?').run(id);
}

function setRelayChannelWebhook(id, webhookId, webhookToken) {
    db.prepare('UPDATE translation_relay_channels SET webhook_id = ?, webhook_token = ? WHERE id = ?')
        .run(webhookId, webhookToken, id);
}

function insertRelayMessage({ relayGroupMessageId, channelId, messageId, authorId, authorDisplayName, language, text, batchMessageIds, lastLineText }) {
    const r = db.prepare(`INSERT INTO translation_relay_messages
        (relay_group_message_id, channel_id, message_id, author_id, author_display_name, language, text, batch_message_ids, last_line_text)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(relayGroupMessageId, channelId, messageId, authorId, authorDisplayName, language, text,
             JSON.stringify(batchMessageIds ?? [{ messageId, text }]), lastLineText ?? text);
    return r.lastInsertRowid;
}

function getRelayMessageByMessageId(messageId) {
    // The `value LIKE '{%'` guard skips any still-legacy-shaped entry (a flat string like
    // "id1", which never starts with "{") before json_extract runs on it -- json_extract
    // throws SQLITE_ERROR: malformed JSON on a bare string, and since this EXISTS subquery
    // scans every row's batch_message_ids array, one still-poisoned row anywhere in the
    // table would otherwise break lookups for every OTHER, correctly-shaped row too.
    return db.prepare(`
        SELECT * FROM translation_relay_messages
        WHERE message_id = ?
           OR EXISTS (
               SELECT 1 FROM json_each(batch_message_ids)
               WHERE value LIKE '{%' AND json_extract(value, '$.messageId') = ?
           )
    `).get(messageId, messageId);
}

function getRelayMessagesByGroupId(relayGroupMessageId) {
    return db.prepare('SELECT * FROM translation_relay_messages WHERE relay_group_message_id = ?')
        .all(relayGroupMessageId);
}

function insertClaudeUsage({ feature, refId, inputTokens, outputTokens, targetCount = null }) {
    db.prepare(`INSERT INTO claude_usage (feature, ref_id, input_tokens, output_tokens, target_count)
        VALUES (?, ?, ?, ?, ?)`).run(feature, refId, inputTokens, outputTokens, targetCount);
}

function insertTranslationUsage({ messageId, inputTokens, outputTokens, targetCount }) {
    insertClaudeUsage({ feature: 'translation', refId: messageId, inputTokens, outputTokens, targetCount });
}

function insertAskUsage({ userId, inputTokens, outputTokens }) {
    insertClaudeUsage({ feature: 'ask', refId: userId, inputTokens, outputTokens });
}

function insertAskFlag({ userId, question, answer, source }) {
    db.prepare(`INSERT INTO ask_flags (user_id, question, answer, source)
        VALUES (?, ?, ?, ?)`).run(userId, question, answer, source);
}

function setRelayMessageGroupId(id, relayGroupMessageId) {
    db.prepare('UPDATE translation_relay_messages SET relay_group_message_id = ? WHERE id = ?')
        .run(relayGroupMessageId, id);
}

function updateRelayMessageText(id, { text, batchMessageIds, lastLineText }) {
    db.prepare('UPDATE translation_relay_messages SET text = ?, batch_message_ids = ?, last_line_text = ? WHERE id = ?')
        .run(text, JSON.stringify(batchMessageIds), lastLineText, id);
}

function deleteRelayMessagesByGroupId(relayGroupMessageId) {
    db.prepare('DELETE FROM translation_relay_messages WHERE relay_group_message_id = ?').run(relayGroupMessageId);
}

function createGloryctaPoll({ kind = 'cta', jobId = null, messageId, channelId, emojiA, emojiB, emojiC = null, labelA, labelB, labelC = null, fireAtA = null, fireAtB = null }) {
    db.prepare(`INSERT INTO glorycta_polls
        (kind, job_id, message_id, channel_id, emoji_a, emoji_b, emoji_c, label_a, label_b, label_c, fire_at_a, fire_at_b)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(kind, jobId, messageId, channelId, emojiA, emojiB, emojiC, labelA, labelB, labelC, fireAtA, fireAtB);
    return db.prepare('SELECT * FROM glorycta_polls WHERE message_id = ?').get(messageId);
}

function getGloryctaPollByMessageId(messageId) {
    return db.prepare('SELECT * FROM glorycta_polls WHERE message_id = ?').get(messageId);
}

function deleteGloryctaPoll(id) {
    db.prepare('DELETE FROM glorycta_polls WHERE id = ?').run(id);
}

function createCheckinDm({ memberId, discordId, dmMessageId, sentAt, daysInactiveAtSend, status }) {
    const result = db.prepare(
        `INSERT INTO member_checkin_dms
         (member_id, discord_id, dm_message_id, sent_at, days_inactive_at_send, status)
         VALUES (?, ?, ?, ?, ?, ?)`
    ).run(memberId, discordId, dmMessageId, sentAt, daysInactiveAtSend, status);
    return result.lastInsertRowid;
}

function getPendingCheckinByMessageId(messageId) {
    return db.prepare(
        "SELECT * FROM member_checkin_dms WHERE dm_message_id = ? AND status = 'pending'"
    ).get(messageId);
}

function getPendingCheckinByDiscordId(discordId) {
    return db.prepare(
        "SELECT * FROM member_checkin_dms WHERE discord_id = ? AND status = 'pending'"
    ).get(discordId);
}

function resolveCheckinResponse(id, { status, responseText, responseEmoji, respondedAt }) {
    db.prepare(
        `UPDATE member_checkin_dms
         SET status = ?, response_text = ?, response_emoji = ?, responded_at = ?
         WHERE id = ?`
    ).run(status, responseText || null, responseEmoji || null, respondedAt, id);
}

// Eligible: 4+ days inactive per the latest snapshot, no active AFK record,
// and either never checked in before, or their most recent check-in row's
// sent_at predates a LATER snapshot showing them active again (a fresh
// absence). member_snapshots' last_active text format ("Nd ago" / "Online" /
// "Xm ago" / "Xh ago") is the same field postInactivityAlert already parses
// in scan.js -- this mirrors that regex rather than introducing a new one.
function getMembersEligibleForCheckin(inactivityDays) {
    const snapshot = db.prepare('SELECT id FROM snapshots ORDER BY id DESC LIMIT 1').get();
    if (!snapshot) return [];

    const rows = db.prepare(`
        SELECT ms.name, ms.last_active, m.id as member_id, m.discord_id
        FROM member_snapshots ms
        LEFT JOIN members m ON m.id = ms.member_id
        LEFT JOIN member_afk afk ON afk.member_id = ms.member_id
        WHERE ms.snapshot_id = ?
          AND m.active = 1
          AND afk.member_id IS NULL
    `).all(snapshot.id);

    const inactive = rows.filter(r => {
        const match = r.last_active && r.last_active.match(/^(\d+)d\s*ago$/i);
        return match && parseInt(match[1], 10) >= inactivityDays;
    });

    const eligible = [];
    for (const r of inactive) {
        const lastCheckin = db.prepare(
            'SELECT sent_at FROM member_checkin_dms WHERE member_id = ? ORDER BY id DESC LIMIT 1'
        ).get(r.member_id);

        if (!lastCheckin) {
            eligible.push(r);
            continue;
        }

        const activeSince = db.prepare(`
            SELECT 1
            FROM member_snapshots ms2
            JOIN snapshots s2 ON s2.id = ms2.snapshot_id
            WHERE ms2.member_id = ?
              AND s2.scraped_at > ?
              AND ms2.last_active NOT LIKE '%d ago'
            LIMIT 1
        `).get(r.member_id, lastCheckin.sent_at);

        if (activeSince) eligible.push(r);
    }

    return eligible.map(r => ({
        id: r.member_id,
        ingame_name: r.name,
        discord_id: r.discord_id,
        days_inactive: parseInt(r.last_active.match(/^(\d+)/)[1], 10),
    }));
}

function getRecentlyResolvedCheckin(discordId, withinMs = 5 * 60 * 1000) {
    const row = db.prepare(
        `SELECT * FROM member_checkin_dms
         WHERE discord_id = ? AND status IN ('responded_text', 'responded_reaction')
         ORDER BY id DESC LIMIT 1`
    ).get(discordId);
    if (!row || !row.responded_at) return null;
    const age = Date.now() - new Date(row.responded_at).getTime();
    return age <= withinMs ? row : null;
}

function getMemberIngameName(memberId) {
    const row = db.prepare('SELECT ingame_name FROM members WHERE id = ?').get(memberId);
    return row ? row.ingame_name : null;
}

module.exports = db;
module.exports.mergeMembers = mergeMembers;
module.exports.getWarbands = getWarbands;
module.exports.renameWarband = renameWarband;
module.exports.setMemberWarband = setMemberWarband;
module.exports.getGuilds = getGuilds;
module.exports.getGuildOverrideRoles = getGuildOverrideRoles;
module.exports.setGuildOverrideRoles = setGuildOverrideRoles;
module.exports.setWarbandLeaderRole = setWarbandLeaderRole;
module.exports.setWarbandMemberRole = setWarbandMemberRole;
module.exports.createTransferApproval = createTransferApproval;
module.exports.getTransferApproval = getTransferApproval;
module.exports.setTransferApprovalMessage = setTransferApprovalMessage;
module.exports.resolveTransferApproval = resolveTransferApproval;
module.exports.addTransferApprovalEligibility = addTransferApprovalEligibility;
module.exports.setTransferApprovalDmMessage = setTransferApprovalDmMessage;
module.exports.isTransferApprovalEligible = isTransferApprovalEligible;
module.exports.getTransferApprovalDms = getTransferApprovalDms;
module.exports.getRelayChannels = getRelayChannels;
module.exports.getRelayChannelByChannelId = getRelayChannelByChannelId;
module.exports.addRelayChannel = addRelayChannel;
module.exports.removeRelayChannel = removeRelayChannel;
module.exports.setRelayChannelWebhook = setRelayChannelWebhook;
module.exports.insertRelayMessage = insertRelayMessage;
module.exports.getRelayMessageByMessageId = getRelayMessageByMessageId;
module.exports.getRelayMessagesByGroupId = getRelayMessagesByGroupId;
module.exports.insertClaudeUsage = insertClaudeUsage;
module.exports.insertTranslationUsage = insertTranslationUsage;
module.exports.insertAskUsage = insertAskUsage;
module.exports.insertAskFlag = insertAskFlag;
module.exports.setRelayMessageGroupId = setRelayMessageGroupId;
module.exports.updateRelayMessageText = updateRelayMessageText;
module.exports.deleteRelayMessagesByGroupId = deleteRelayMessagesByGroupId;
module.exports.createGloryctaPoll = createGloryctaPoll;
module.exports.getGloryctaPollByMessageId = getGloryctaPollByMessageId;
module.exports.deleteGloryctaPoll = deleteGloryctaPoll;
module.exports.createCheckinDm = createCheckinDm;
module.exports.getPendingCheckinByMessageId = getPendingCheckinByMessageId;
module.exports.getPendingCheckinByDiscordId = getPendingCheckinByDiscordId;
module.exports.resolveCheckinResponse = resolveCheckinResponse;
module.exports.getMembersEligibleForCheckin = getMembersEligibleForCheckin;
module.exports.getRecentlyResolvedCheckin = getRecentlyResolvedCheckin;
module.exports.getMemberIngameName = getMemberIngameName;
module.exports.__runRelayMessageMigration = runRelayMessageMigration;
module.exports.__testRawDb = db;
