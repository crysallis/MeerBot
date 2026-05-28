'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express = require('express');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const botConfig = require('../utils/botConfig');
const db = require('../utils/db');

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
            SELECT sj.id, sj.fire_at, sj.recurrence, scj.handler_path
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
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/scheduled-jobs/:id — update fire_at and/or recurrence
app.put('/api/scheduled-jobs/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { fire_at, recurrence } = req.body;

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

app.listen(PORT, '127.0.0.1', () => {
    console.log(`MeerBot admin panel running at http://127.0.0.1:${PORT}`);
});
