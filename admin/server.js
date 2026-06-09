'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express = require('express');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const botConfig = require('../utils/botConfig');
const db = require('../utils/db');

const VALID_PATTERN_TYPES  = ['contains', 'exact', 'regex', 'mention'];
const VALID_RESPONSE_TYPES = ['reply', 'message', 'emoji', 'dm'];

const PORT = process.env.ADMIN_PORT || 3001;
const app = express();

// Localhost-only guard. The server binds to 127.0.0.1, but a webpage open in a
// local browser can still fire cross-origin POSTs at it (CSRF) and DNS rebinding
// can spoof the address — so verify the Host and (when present) Origin headers
// actually point at this machine before touching anything.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
app.use((req, res, next) => {
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    if (!LOCAL_HOSTS.has(host)) return res.status(403).json({ error: 'Forbidden' });
    const origin = req.headers.origin;
    if (origin) {
        try {
            if (!LOCAL_HOSTS.has(new URL(origin).hostname)) {
                return res.status(403).json({ error: 'Forbidden' });
            }
        } catch {
            return res.status(403).json({ error: 'Forbidden' });
        }
    }
    next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// GET /api/config — all config values with source badges
app.get('/api/config', (req, res) => {
    try {
        res.json(botConfig.getAll());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/config/:key — set a DB override
app.put('/api/config/:key', (req, res) => {
    const { key } = req.params;
    if (!Object.prototype.hasOwnProperty.call(botConfig.CONFIG_META, key)) {
        return res.status(400).json({ error: `Unknown config key: ${key}` });
    }
    try {
        botConfig.set(key, req.body.value ?? '');
        res.json({ ok: true, key, value: req.body.value });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/config/:key — remove DB override, revert to ENV or DEFAULT
app.delete('/api/config/:key', (req, res) => {
    const { key } = req.params;
    if (!Object.prototype.hasOwnProperty.call(botConfig.CONFIG_META, key)) {
        return res.status(400).json({ error: `Unknown config key: ${key}` });
    }
    try {
        botConfig.set(key, null);
        res.json({ ok: true, key });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/roles — role list from discord-roles.json
app.get('/api/roles', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/discord-roles.json'), 'utf8'));
        res.json({ roles: data.roles ?? [], fetched_at: data.fetched_at ?? null });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/channels — flattened text channel list from discord-channels.json
app.get('/api/channels', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/discord-channels.json'), 'utf8'));
        const flat = [];
        for (const cat of data.categories ?? []) {
            for (const ch of cat.channels ?? []) {
                if (ch.type === 'text' || ch.type === 'announce') {
                    flat.push({ id: ch.id, name: ch.name, category: cat.name });
                }
            }
        }
        res.json({ channels: flat, fetched_at: data.fetched_at ?? null });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/refresh-discord-data — re-run list-channels + list-roles scripts
app.post('/api/refresh-discord-data', (req, res) => {
    const root = path.join(__dirname, '..');
    exec('node scripts/list-channels.js', { cwd: root }, (err1, stdout1, stderr1) => {
        if (err1) {
            console.error('list-channels failed:', stderr1);
            return res.status(500).json({ error: 'list-channels failed: ' + (stderr1 || err1.message) });
        }
        exec('node scripts/list-roles.js', { cwd: root }, (err2, stdout2, stderr2) => {
            if (err2) {
                console.error('list-roles failed:', stderr2);
                return res.status(500).json({ error: 'list-roles failed: ' + (stderr2 || err2.message) });
            }
            res.json({ ok: true });
        });
    });
});

// GET /api/bot-status — pm2 status for meerbot process
app.get('/api/bot-status', (req, res) => {
    exec('pm2 jlist', (err, stdout) => {
        if (err) return res.status(500).json({ error: err.message });
        try {
            const list    = JSON.parse(stdout);
            const proc    = list.find(p => p.name === 'meerbot');
            if (!proc) return res.json({ status: 'not found' });
            const uptimeMs = proc.pm2_env?.pm_uptime ? Date.now() - proc.pm2_env.pm_uptime : null;
            res.json({
                status:    proc.pm2_env?.status ?? 'unknown',
                cpu:       proc.monit?.cpu   ?? 0,
                memory:    proc.monit?.memory ?? 0,
                uptime_ms: uptimeMs,
            });
        } catch (e) {
            res.status(500).json({ error: 'Failed to parse pm2 output' });
        }
    });
});

// POST /api/bot/restart — pm2 restart meerbot --update-env
app.post('/api/bot/restart', (req, res) => {
    exec('pm2 restart meerbot --update-env', (err, stdout, stderr) => {
        if (err) {
            console.error('PM2 restart failed:', stderr);
            return res.status(500).json({ error: stderr || err.message });
        }
        res.json({ ok: true, output: stdout });
    });
});

const JOB_DISPLAY = {
    './handlers/scanReminder':     'Scan Reminder',
    './handlers/weeklySummary':    'Weekly Summary',
    './handlers/anniversaryCheck': 'Anniversary Check',
    './handlers/afkExpiry':        'AFK Expiry',
    './handlers/birthdayCheck':    'Birthday Check',
    './handlers/dailyReset':       'Daily Reset',
};

// GET /api/scheduled-jobs — system job schedule config
app.get('/api/scheduled-jobs', (req, res) => {
    try {
        const rows = db.prepare(`
            SELECT sj.id, sj.fire_at, sj.recurrence, sj.enabled, scj.handler_path
            FROM scheduled_jobs sj
            JOIN script_jobs scj ON scj.job_id = sj.id
            ORDER BY sj.fire_at
        `).all();
        res.json(rows.map(r => ({
            id:           r.id,
            display:      JOB_DISPLAY[r.handler_path] ?? r.handler_path,
            handler_path: r.handler_path,
            fire_at:      r.fire_at,
            recurrence:   r.recurrence ?? 'daily:1',
            enabled:      r.enabled ?? 1,
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/scheduled-jobs/:id — update fire_at and/or recurrence
app.put('/api/scheduled-jobs/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { fire_at, recurrence, enabled } = req.body;

    if (fire_at) {
        const d = new Date(fire_at);
        if (isNaN(d)) return res.status(400).json({ error: 'Invalid fire_at datetime' });
    }

    if (recurrence) {
        const [unit, n] = recurrence.split(':');
        const count = parseInt(n || '1', 10);
        if (!['daily', 'weekly'].includes(unit) || isNaN(count) || count < 1) {
            return res.status(400).json({ error: 'recurrence must be daily:N or weekly:N (N >= 1)' });
        }
    }

    try {
        const exists = db.prepare('SELECT 1 FROM scheduled_jobs WHERE id = ? AND type = ?').get(id, 'script_job');
        if (!exists) return res.status(404).json({ error: 'Job not found' });

        if (enabled !== undefined) {
            db.prepare('UPDATE scheduled_jobs SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
        }
        if (fire_at && recurrence) {
            db.prepare('UPDATE scheduled_jobs SET fire_at = ?, recurrence = ? WHERE id = ?').run(fire_at, recurrence, id);
        } else if (fire_at) {
            db.prepare('UPDATE scheduled_jobs SET fire_at = ? WHERE id = ?').run(fire_at, id);
        } else if (recurrence) {
            db.prepare('UPDATE scheduled_jobs SET recurrence = ? WHERE id = ?').run(recurrence, id);
        }

        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/jobs — recent scheduler_log entries
app.get('/api/jobs', (req, res) => {
    try {
        const rows = db.prepare(
            'SELECT name, sent_date, sent_at, late FROM scheduler_log ORDER BY sent_at DESC LIMIT 50'
        ).all();
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Message Reactions CRUD ──────────────────────────────────────────────────

// GET /api/message-reactions — list all rules
app.get('/api/message-reactions', (req, res) => {
    try {
        const rows = db.prepare('SELECT * FROM message_reactions ORDER BY enabled DESC, id').all();
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/message-reactions — create a rule
app.post('/api/message-reactions', (req, res) => {
    const { name, pattern, pattern_type, ignore_case, channel_filter, require_mention,
            response_type, response_content, response_channel, cooldown_seconds, enabled,
            embed_title, embed_description, embed_color } = req.body;

    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (!VALID_PATTERN_TYPES.includes(pattern_type)) return res.status(400).json({ error: `pattern_type must be one of: ${VALID_PATTERN_TYPES.join(', ')}` });
    if (!VALID_RESPONSE_TYPES.includes(response_type)) return res.status(400).json({ error: `response_type must be one of: ${VALID_RESPONSE_TYPES.join(', ')}` });

    const hasContent = response_content && response_content.trim();
    const hasEmbed   = embed_title || embed_description;
    if (!hasContent && !hasEmbed && response_type !== 'emoji') {
        return res.status(400).json({ error: 'Provide response text, an embed, or both' });
    }

    if (pattern_type === 'regex') {
        try { new RegExp(pattern); } catch { return res.status(400).json({ error: 'Invalid regex pattern' }); }
    }

    if (pattern_type === 'mention') {
        const existing = db.prepare(`SELECT id FROM message_reactions WHERE pattern_type = 'mention'`).get();
        if (existing) return res.status(400).json({ error: 'Only one @mention rule is allowed' });
    }

    try {
        const result = db.prepare(`
            INSERT INTO message_reactions
                (name, pattern, pattern_type, ignore_case, channel_filter, require_mention,
                 response_type, response_content, response_channel, cooldown_seconds, enabled,
                 embed_title, embed_description, embed_color)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            name.trim(),
            pattern || '',
            pattern_type || 'contains',
            ignore_case !== false ? 1 : 0,
            channel_filter || null,
            require_mention ? 1 : 0,
            response_type,
            response_content || '',
            response_channel || null,
            cooldown_seconds != null ? parseInt(cooldown_seconds, 10) : 60,
            enabled !== false ? 1 : 0,
            embed_title || null,
            embed_description || null,
            embed_color || null,
        );
        res.json({ ok: true, id: result.lastInsertRowid });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/message-reactions/:id — update a rule
app.put('/api/message-reactions/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const existing = db.prepare('SELECT * FROM message_reactions WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Rule not found' });

    const { name, pattern, pattern_type, ignore_case, channel_filter, require_mention,
            response_type, response_content, response_channel, cooldown_seconds, enabled,
            embed_title, embed_description, embed_color } = req.body;

    if (pattern_type && !VALID_PATTERN_TYPES.includes(pattern_type)) return res.status(400).json({ error: `pattern_type must be one of: ${VALID_PATTERN_TYPES.join(', ')}` });
    if (response_type && !VALID_RESPONSE_TYPES.includes(response_type)) return res.status(400).json({ error: `response_type must be one of: ${VALID_RESPONSE_TYPES.join(', ')}` });

    if (pattern_type === 'regex' && pattern) {
        try { new RegExp(pattern); } catch { return res.status(400).json({ error: 'Invalid regex pattern' }); }
    }

    if (pattern_type === 'mention') {
        const clash = db.prepare(`SELECT id FROM message_reactions WHERE pattern_type = 'mention' AND id != ?`).get(id);
        if (clash) return res.status(400).json({ error: 'Only one @mention rule is allowed' });
    }

    try {
        db.prepare(`
            UPDATE message_reactions SET
                name             = COALESCE(?, name),
                pattern          = COALESCE(?, pattern),
                pattern_type     = COALESCE(?, pattern_type),
                ignore_case      = COALESCE(?, ignore_case),
                channel_filter   = ?,
                require_mention  = COALESCE(?, require_mention),
                response_type    = COALESCE(?, response_type),
                response_content = COALESCE(?, response_content),
                response_channel = ?,
                cooldown_seconds = COALESCE(?, cooldown_seconds),
                enabled          = COALESCE(?, enabled),
                embed_title      = ?,
                embed_description = ?,
                embed_color      = ?
            WHERE id = ?
        `).run(
            name?.trim() ?? null,
            pattern ?? null,
            pattern_type ?? null,
            ignore_case != null ? (ignore_case ? 1 : 0) : null,
            channel_filter !== undefined ? (channel_filter || null) : existing.channel_filter,
            require_mention != null ? (require_mention ? 1 : 0) : null,
            response_type ?? null,
            response_content ?? null,
            response_channel !== undefined ? (response_channel || null) : existing.response_channel,
            cooldown_seconds != null ? parseInt(cooldown_seconds, 10) : null,
            enabled != null ? (enabled ? 1 : 0) : null,
            embed_title !== undefined ? (embed_title || null) : existing.embed_title,
            embed_description !== undefined ? (embed_description || null) : existing.embed_description,
            embed_color !== undefined ? (embed_color || null) : existing.embed_color,
            id,
        );
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/message-reactions/:id — delete a rule
app.delete('/api/message-reactions/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
        const result = db.prepare('DELETE FROM message_reactions WHERE id = ?').run(id);
        if (result.changes === 0) return res.status(404).json({ error: 'Rule not found' });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/message-reactions/reload — signal bot to reload its rule cache
// The admin panel runs in a separate process from the bot, so we write a flag
// file that the bot's 5-min cache refresh will pick up on next poll.
// For an immediate reload, restart the bot via /api/bot/restart.
app.post('/api/message-reactions/reload', (req, res) => {
    res.json({ ok: true, note: 'Cache auto-refreshes every 5 min. Use Restart Bot for immediate effect.' });
});

// ── Members management ──────────────────────────────────────────────────────

// GET /api/members — roster with latest power/warband, pending flagged first
app.get('/api/members', (req, res) => {
    try {
        const rows = db.prepare(`
            SELECT m.id, m.ingame_name, m.discord_id, m.discord_name, m.active, m.pending,
                   m.warband_id, w.name AS warband,
                   ms.combat_power, ms.last_active
            FROM members m
            LEFT JOIN warbands w ON w.id = m.warband_id
            LEFT JOIN member_snapshots ms
                   ON ms.member_id = m.id AND ms.snapshot_id = (SELECT MAX(id) FROM snapshots)
            ORDER BY m.pending DESC, m.active DESC, m.ingame_name COLLATE NOCASE
        `).all();
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/members/:id — rename (merges if the new name already exists)
app.put('/api/members/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const newName = (req.body.ingame_name || '').trim();
    if (!newName) return res.status(400).json({ error: 'ingame_name is required' });
    try {
        const member = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
        if (!member) return res.status(404).json({ error: 'Member not found' });
        const collision = db.prepare('SELECT id FROM members WHERE ingame_name = ? AND id != ?').get(newName, id);
        if (collision) {
            db.mergeMembers(collision.id, id);
            return res.json({ ok: true, merged: true, into: collision.id });
        }
        const now = new Date().toISOString();
        db.prepare('UPDATE members SET ingame_name = ?, pending = 0 WHERE id = ?').run(newName, id);
        db.prepare('INSERT INTO member_name_history (member_id, old_name, new_name, changed_at) VALUES (?, ?, ?, ?)')
            .run(id, member.ingame_name, newName, now);
        db.prepare("INSERT OR REPLACE INTO name_corrections (ocr_name, correct_name, source) VALUES (?, ?, 'admin')")
            .run(member.ingame_name.toLowerCase(), newName);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/members/:id/link — set or clear the Discord link
app.post('/api/members/:id/link', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const discordId = (req.body.discord_id || '').trim() || null;
    const discordName = (req.body.discord_name || '').trim() || null;
    try {
        const member = db.prepare('SELECT id FROM members WHERE id = ?').get(id);
        if (!member) return res.status(404).json({ error: 'Member not found' });
        if (discordId) {
            const clash = db.prepare('SELECT ingame_name FROM members WHERE discord_id = ? AND id != ?').get(discordId, id);
            if (clash) return res.status(400).json({ error: `That Discord ID is already linked to ${clash.ingame_name}` });
        }
        db.prepare('UPDATE members SET discord_id = ?, discord_name = ? WHERE id = ?').run(discordId, discordName, id);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/members/:id/approve — clear the pending flag
app.post('/api/members/:id/approve', (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
        const result = db.prepare('UPDATE members SET pending = 0 WHERE id = ?').run(id);
        if (result.changes === 0) return res.status(404).json({ error: 'Member not found' });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/members/merge — { keepId, dropId }
app.post('/api/members/merge', (req, res) => {
    const keepId = parseInt(req.body.keepId, 10);
    const dropId = parseInt(req.body.dropId, 10);
    try {
        db.mergeMembers(keepId, dropId);
        res.json({ ok: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/members/:id/warband — { warband_id } (null/empty to clear) · manual override
app.post('/api/members/:id/warband', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const warbandId = req.body.warband_id ? parseInt(req.body.warband_id, 10) : null;
    try {
        const member = db.prepare('SELECT id FROM members WHERE id = ?').get(id);
        if (!member) return res.status(404).json({ error: 'Member not found' });
        db.setMemberWarband(id, warbandId);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Warbands ────────────────────────────────────────────────────────────────

// GET /api/warbands — list with current member counts
app.get('/api/warbands', (req, res) => {
    try {
        const rows = db.prepare(`
            SELECT w.id, w.name, w.sort_order, w.archived,
                   (SELECT COUNT(*) FROM members m WHERE m.warband_id = w.id AND m.active = 1) AS members
            FROM warbands w
            ORDER BY w.archived, w.sort_order, w.name COLLATE NOCASE
        `).all();
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/warbands — { name }
app.post('/api/warbands', (req, res) => {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Warband name required' });
    try {
        const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM warbands').get().m;
        const r = db.prepare('INSERT INTO warbands (name, sort_order) VALUES (?, ?)').run(name, max + 1);
        res.json({ ok: true, id: r.lastInsertRowid });
    } catch (err) {
        res.status(err.message.includes('UNIQUE') ? 400 : 500)
           .json({ error: err.message.includes('UNIQUE') ? 'That warband already exists' : err.message });
    }
});

// PUT /api/warbands/:id — rename (propagates everywhere via renameWarband)
app.put('/api/warbands/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
        db.renameWarband(id, req.body.name);
        res.json({ ok: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/warbands/:id/archive — { archived: 0|1 }
app.post('/api/warbands/:id/archive', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const archived = req.body.archived ? 1 : 0;
    try {
        const r = db.prepare('UPDATE warbands SET archived = ? WHERE id = ?').run(archived, id);
        if (r.changes === 0) return res.status(404).json({ error: 'Warband not found' });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Seasons ──────────────────────────────────────────────────────────────────

// GET /api/seasons — list with server counts
app.get('/api/seasons', (req, res) => {
    try {
        const rows = db.prepare(`
            SELECT s.id, s.name, s.active,
                   COUNT(sv.id) AS server_count
            FROM ally_seasons s
            LEFT JOIN ally_servers sv ON sv.season_id = s.id
            GROUP BY s.id
            ORDER BY s.id DESC
        `).all();
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/seasons — create
app.post('/api/seasons', (req, res) => {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Season name required' });
    try {
        const r = db.prepare('INSERT INTO ally_seasons (name, active) VALUES (?, 0)').run(name);
        res.json({ ok: true, id: r.lastInsertRowid });
    } catch (err) {
        res.status(err.message.includes('UNIQUE') ? 400 : 500)
           .json({ error: err.message.includes('UNIQUE') ? 'That season already exists' : err.message });
    }
});

// PUT /api/seasons/:id — rename or toggle active
app.put('/api/seasons/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { name, active } = req.body;
    try {
        const season = db.prepare('SELECT id FROM ally_seasons WHERE id = ?').get(id);
        if (!season) return res.status(404).json({ error: 'Season not found' });
        if (name !== undefined) {
            const n = name.trim();
            if (!n) return res.status(400).json({ error: 'Name cannot be empty' });
            db.prepare('UPDATE ally_seasons SET name = ? WHERE id = ?').run(n, id);
        }
        if (active !== undefined) {
            db.prepare('UPDATE ally_seasons SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
        }
        res.json({ ok: true });
    } catch (err) {
        res.status(err.message.includes('UNIQUE') ? 400 : 500)
           .json({ error: err.message.includes('UNIQUE') ? 'That season name already exists' : err.message });
    }
});

// DELETE /api/seasons/:id — nullify recruitment refs first, then cascade-delete
app.delete('/api/seasons/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
        const season = db.prepare('SELECT id FROM ally_seasons WHERE id = ?').get(id);
        if (!season) return res.status(404).json({ error: 'Season not found' });
        db.transaction(() => {
            db.prepare(`
                UPDATE recruitment SET server_id = NULL
                WHERE server_id IN (SELECT id FROM ally_servers WHERE season_id = ?)
            `).run(id);
            db.prepare('DELETE FROM ally_seasons WHERE id = ?').run(id);
        })();
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/seasons/:id/servers — sorted list of server numbers
app.get('/api/seasons/:id/servers', (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
        const season = db.prepare('SELECT id FROM ally_seasons WHERE id = ?').get(id);
        if (!season) return res.status(404).json({ error: 'Season not found' });
        const rows = db.prepare('SELECT server_number FROM ally_servers WHERE season_id = ? ORDER BY server_number').all(id);
        res.json(rows.map(r => r.server_number));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/seasons/:id/servers — bulk add { numbers: [1,2,3,...] }
app.post('/api/seasons/:id/servers', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const numbers = req.body.numbers;
    if (!Array.isArray(numbers) || numbers.length === 0) {
        return res.status(400).json({ error: 'numbers must be a non-empty array' });
    }
    try {
        const season = db.prepare('SELECT id FROM ally_seasons WHERE id = ?').get(id);
        if (!season) return res.status(404).json({ error: 'Season not found' });
        const insert = db.prepare('INSERT OR IGNORE INTO ally_servers (server_number, season_id) VALUES (?, ?)');
        let added = 0;
        db.transaction(() => {
            for (const n of numbers) {
                added += insert.run(n, id).changes;
            }
        })();
        res.json({ ok: true, added, skipped: numbers.length - added });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/seasons/:id/servers — bulk remove { numbers: [1,2,...] }
app.delete('/api/seasons/:id/servers', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const numbers = req.body.numbers;
    if (!Array.isArray(numbers) || numbers.length === 0) {
        return res.status(400).json({ error: 'numbers must be a non-empty array' });
    }
    try {
        const del = db.prepare('DELETE FROM ally_servers WHERE server_number = ? AND season_id = ?');
        let removed = 0;
        db.transaction(() => {
            for (const n of numbers) {
                removed += del.run(n, id).changes;
            }
        })();
        res.json({ ok: true, removed });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ────────────────────────────────────────────────────────────────────────────

app.listen(PORT, '127.0.0.1', () => {
    console.log(`MeerBot admin panel running at http://127.0.0.1:${PORT}`);
});
