'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const botConfig = require('../utils/botConfig');
const db = require('../utils/db');
const auth = require('./auth');

const VALID_PATTERN_TYPES  = ['contains', 'exact', 'regex', 'mention'];
const VALID_RESPONSE_TYPES = ['reply', 'message', 'emoji', 'dm'];

const PORT = process.env.ADMIN_PORT || 3001;
const app = express();

// Behind the Cloudflare tunnel cloudflared connects from loopback and sets
// x-forwarded-proto · trust that one hop so secure cookies and req.secure work.
app.set('trust proxy', 1);

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc:     ["'self'"],
            scriptSrc:      ["'self'", "'unsafe-inline'"],
            styleSrc:       ["'self'", "'unsafe-inline'"],
            imgSrc:         ["'self'", "data:", "https://cdn.discordapp.com"],
            connectSrc:     ["'self'"],
            fontSrc:        ["'self'"],
            objectSrc:      ["'none'"],
            frameAncestors: ["'none'"],
        },
    },
}));

// Host/Origin guard · allow loopback plus the public tunnel host, reject everything
// else. Blocks DNS rebinding and cross-origin POSTs in both local and remote modes.
const ALLOWED_HOSTS = new Set(auth.LOCAL_HOSTS);
if (process.env.ADMIN_PUBLIC_HOST) ALLOWED_HOSTS.add(process.env.ADMIN_PUBLIC_HOST.toLowerCase());
app.use((req, res, next) => {
    const host = (req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    if (!ALLOWED_HOSTS.has(host)) return res.status(403).json({ error: 'Forbidden' });
    const origin = req.headers.origin;
    if (origin) {
        try {
            if (!ALLOWED_HOSTS.has(new URL(origin).hostname.toLowerCase())) {
                return res.status(403).json({ error: 'Forbidden' });
            }
        } catch {
            return res.status(403).json({ error: 'Forbidden' });
        }
    }
    next();
});

app.use(express.json());
app.use('/shared', express.static(path.join(__dirname, '..', 'shared')));
app.use(express.static(path.join(__dirname, 'public')));

// Sessions + Discord OAuth · login routes are public, /auth is rate limited.
app.use(auth.sessionMiddleware());
app.use('/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 30 }));
auth.registerRoutes(app);

// Everything under /api requires authentication, tier authorization, and is audited.
app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 300 }));
app.use('/api', auth.authorize);
app.use('/api', auth.audit);

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

const DISCORD_API = 'https://discord.com/api/v10';

// GET /api/roles — live from Discord
app.get('/api/roles', async (req, res) => {
    try {
        const r = await fetch(`${DISCORD_API}/guilds/${process.env.GUILD_ID}/roles`, {
            headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` },
        });
        const roles = await r.json();
        const filtered = roles
            .filter(role => !role.managed && role.id !== process.env.GUILD_ID)
            .sort((a, b) => b.position - a.position)
            .map(({ id, name, color, position }) => ({ id, name, color, position }));
        res.json({ roles: filtered });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/channels — live from Discord (text channels only)
app.get('/api/channels', async (req, res) => {
    try {
        const r = await fetch(`${DISCORD_API}/guilds/${process.env.GUILD_ID}/channels`, {
            headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` },
        });
        const channels = await r.json();
        const filtered = channels
            .filter(ch => ch.type === 0)
            .sort((a, b) => a.position - b.position)
            .map(({ id, name, position, parent_id }) => ({ id, name, position, parent_id }));
        res.json({ channels: filtered });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/commands — derive command+subcommand map from slash-command files
app.get('/api/commands', (req, res) => {
    const dir = path.join(__dirname, '../slash-commands');
    const result = {};
    try {
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
        for (const file of files) {
            try {
                const mod = require(path.join(dir, file));
                if (!mod.data) continue;
                const json = mod.data.toJSON();
                result[json.name] = (json.options || [])
                    .filter(o => o.type === 1 || o.type === 2)
                    .map(o => o.name);
            } catch { /* skip malformed command files */ }
        }
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/permissions — all rules, optionally filtered by command
app.get('/api/permissions', (req, res) => {
    const { command } = req.query;
    const rows = command
        ? db.prepare('SELECT * FROM command_permissions WHERE command = ? ORDER BY command, subcommand, type').all(command)
        : db.prepare('SELECT * FROM command_permissions ORDER BY command, subcommand, type').all();
    res.json(rows);
});

// POST /api/permissions — add a rule
app.post('/api/permissions', (req, res) => {
    const { command, subcommand, type, value_id } = req.body;
    if (!command?.trim()) return res.status(400).json({ error: 'command is required' });
    if (!['role', 'channel'].includes(type)) return res.status(400).json({ error: 'type must be role or channel' });
    if (!value_id?.trim()) return res.status(400).json({ error: 'value_id is required' });
    try {
        const r = db.prepare(
            `INSERT INTO command_permissions (command, subcommand, type, value_id) VALUES (?, ?, ?, ?)`
        ).run(command.trim(), subcommand?.trim() || null, type, value_id.trim());
        res.json({ ok: true, id: r.lastInsertRowid });
    } catch (err) {
        if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'That rule already exists' });
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/permissions/:id — remove a rule
app.delete('/api/permissions/:id', (req, res) => {
    const r = db.prepare('DELETE FROM command_permissions WHERE id = ?').run(parseInt(req.params.id, 10));
    if (r.changes === 0) return res.status(404).json({ error: 'Rule not found' });
    res.json({ ok: true });
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
        if (pattern.length > 30) return res.status(400).json({ error: 'Regex pattern too long (max 30 characters)' });
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
        if (pattern.length > 30) return res.status(400).json({ error: 'Regex pattern too long (max 30 characters)' });
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
                   m.ingame_id,
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

// POST /api/members/:id/ingame-id — set or clear the in-game User ID
app.post('/api/members/:id/ingame-id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const raw = req.body.ingame_id;
    const ingame_id = (raw != null && raw !== '') ? parseInt(raw, 10) : null;
    if (ingame_id !== null && (isNaN(ingame_id) || ingame_id <= 0)) {
        return res.status(400).json({ error: 'ingame_id must be a positive integer' });
    }
    try {
        const member = db.prepare('SELECT id FROM members WHERE id = ?').get(id);
        if (!member) return res.status(404).json({ error: 'Member not found' });
        db.prepare('UPDATE members SET ingame_id = ? WHERE id = ?').run(ingame_id, id);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
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

// ── Dream Realm Bosses ───────────────────────────────────────────────────────

app.get('/api/dream-realm-bosses', (req, res) => {
    try {
        const rows = db.prepare(`
            SELECT b.id, b.name, b.sort_order, b.season,
                   s.name AS season_name
            FROM dream_realm_bosses b
            LEFT JOIN ally_seasons s ON s.id = b.season
            ORDER BY b.season, b.sort_order, b.name COLLATE NOCASE
        `).all();
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/dream-realm-bosses', (req, res) => {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Boss name required' });
    const sort_order = req.body.sort_order != null ? parseInt(req.body.sort_order, 10) : null;
    const season = req.body.season != null ? parseInt(req.body.season, 10) : null;
    try {
        const r = db.prepare(
            'INSERT INTO dream_realm_bosses (name, sort_order, season) VALUES (?, ?, ?)'
        ).run(name, sort_order, season);
        res.json({ ok: true, id: r.lastInsertRowid });
    } catch (err) {
        res.status(err.message.includes('UNIQUE') ? 400 : 500)
           .json({ error: err.message.includes('UNIQUE') ? 'That boss already exists for this season' : err.message });
    }
});

app.put('/api/dream-realm-bosses/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const name = (req.body.name || '').trim() || null;
    const sort_order = req.body.sort_order != null ? parseInt(req.body.sort_order, 10) : undefined;
    const season = req.body.season != null ? parseInt(req.body.season, 10) : undefined;
    try {
        const existing = db.prepare('SELECT id FROM dream_realm_bosses WHERE id = ?').get(id);
        if (!existing) return res.status(404).json({ error: 'Boss not found' });
        if (name) db.prepare('UPDATE dream_realm_bosses SET name = ? WHERE id = ?').run(name, id);
        if (sort_order !== undefined) db.prepare('UPDATE dream_realm_bosses SET sort_order = ? WHERE id = ?').run(sort_order, id);
        if (season !== undefined) db.prepare('UPDATE dream_realm_bosses SET season = ? WHERE id = ?').run(season, id);
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/dream-realm-bosses/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
        const r = db.prepare('DELETE FROM dream_realm_bosses WHERE id = ?').run(id);
        if (r.changes === 0) return res.status(404).json({ error: 'Boss not found' });
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
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

// GET /api/presence — heartbeat + who else is active (read tier · all logged-in users)
app.get('/api/presence', (req, res) => {
    try {
        const me = auth.markPresence(req);
        res.json({ me, users: auth.activePresence() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Access control (local-only · see auth.requiredTier) ───────────────────────

// GET /api/access — operations (grouped by tab) + role->tier map + recent audit log
app.get('/api/access', (req, res) => {
    try {
        res.json({
            tiers: ['read', 'manage', 'local'],
            operations: auth.listOperations(),
            roles: auth.listRoleTiers(),
            audit: auth.recentAudit(100),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/access/op — { op_key, tier } (tier '' or default clears the override)
app.put('/api/access/op', (req, res) => {
    try {
        auth.setOperationTier(req.body.op_key, req.body.tier ?? '');
        res.json({ ok: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// PUT /api/access/role — { role_id, tier } (tier 'none'/'' removes the grant)
app.put('/api/access/role', (req, res) => {
    try {
        auth.setRoleTier(req.body.role_id, req.body.tier ?? '');
        res.json({ ok: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ────────────────────────────────────────────────────────────────────────────

// Ensure dream_realm_bosses.sort_order exists (added after initial schema creation)
try { db.exec('ALTER TABLE dream_realm_bosses ADD COLUMN sort_order INTEGER'); } catch {}

app.listen(PORT, '127.0.0.1', () => {
    console.log(`MeerBot admin panel running at http://127.0.0.1:${PORT}`);
});
