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
