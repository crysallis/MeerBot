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
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    type          TEXT NOT NULL,
    fire_at       TEXT NOT NULL,
    recurrence    TEXT,
    day_of_month  INTEGER,
    created_at    TEXT NOT NULL,
    enabled       INTEGER NOT NULL DEFAULT 1
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
  -- across every copy of the same logical message: it is the `id` of that message's
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
    created_at               TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_trm_group_msg ON translation_relay_messages(relay_group_message_id);
  CREATE INDEX IF NOT EXISTS idx_trm_message ON translation_relay_messages(message_id);

  CREATE TABLE IF NOT EXISTS translation_usage (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id    TEXT NOT NULL,
    input_tokens  INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    target_count  INTEGER NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

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

        // If the kept row has no Discord link but the dropped one did, carry it over
        if (!keep.discord_id && drop.discord_id) {
            db.prepare('UPDATE members SET discord_id = ?, discord_name = ? WHERE id = ?')
                .run(drop.discord_id, drop.discord_name, keepId);
        }

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
