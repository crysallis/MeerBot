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

// ────────────────────────────────────────────────────────────────────────────

app.listen(PORT, '127.0.0.1', () => {
    console.log(`MeerBot admin panel running at http://127.0.0.1:${PORT}`);
});
