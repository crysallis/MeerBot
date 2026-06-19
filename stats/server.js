'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express   = require('express');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const path      = require('path');
const db        = require('../utils/db');
const auth      = require('./auth');

const PORT = process.env.STATS_PORT || 3002;
const app  = express();

app.set('trust proxy', 1);

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc:     ["'self'"],
            scriptSrc:      ["'self'"],
            styleSrc:       ["'self'", "'unsafe-inline'"],
            imgSrc:         ["'self'", "data:", "https://cdn.discordapp.com"],
            connectSrc:     ["'self'"],
            fontSrc:        ["'self'"],
            objectSrc:      ["'none'"],
            frameAncestors: ["'none'"],
        },
    },
}));

const ALLOWED_HOSTS = new Set(auth.LOCAL_HOSTS);
if (process.env.STATS_PUBLIC_HOST) ALLOWED_HOSTS.add(process.env.STATS_PUBLIC_HOST.toLowerCase());
app.use((req, res, next) => {
    const host = (req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    if (!ALLOWED_HOSTS.has(host)) return res.status(403).json({ error: 'Forbidden' });
    const origin = req.headers.origin;
    if (origin) {
        try {
            if (!ALLOWED_HOSTS.has(new URL(origin).hostname.toLowerCase())) {
                return res.status(403).json({ error: 'Forbidden' });
            }
        } catch { return res.status(403).json({ error: 'Forbidden' }); }
    }
    next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'dist')));

app.use(auth.sessionMiddleware());
app.use('/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 30 }));
auth.registerRoutes(app);

app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 300 }));
app.use('/api', auth.requireMember);

// GET /api/members — active roster with latest power + warband
app.get('/api/members', (req, res) => {
    try {
        const latestSnap = db.prepare('SELECT MAX(id) as id, MAX(scraped_at) as scraped_at FROM snapshots').get();
        const members = db.prepare(`
            SELECT m.id, m.ingame_name, m.discord_id, m.warband_id,
                   w.name as warband_name,
                   ms.combat_power, ms.combat_power_value, ms.activeness
            FROM members m
            LEFT JOIN warbands w ON w.id = m.warband_id
            LEFT JOIN member_snapshots ms ON ms.member_id = m.id AND ms.snapshot_id = ?
            WHERE m.active = 1 AND m.pending = 0
            ORDER BY ms.combat_power_value DESC NULLS LAST
        `).all(latestSnap?.id ?? 0);
        res.json({ members, lastScan: latestSnap?.scraped_at ?? null });
    } catch (err) {
        console.error('[stats] /api/members error:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// GET /api/warbands
app.get('/api/warbands', (req, res) => {
    try {
        const warbands = db.prepare(
            'SELECT id, name, sort_order FROM warbands WHERE archived = 0 ORDER BY sort_order, name'
        ).all();
        res.json(warbands);
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

// GET /api/power-history — all snapshots with per-member power values
app.get('/api/power-history', (req, res) => {
    try {
        const snapshots = db.prepare('SELECT id, scraped_at FROM snapshots ORDER BY scraped_at').all();
        const rows = db.prepare(`
            SELECT m.id as member_id, m.ingame_name, m.warband_id, w.name as warband_name,
                   ms.snapshot_id, ms.combat_power_value
            FROM members m
            LEFT JOIN warbands w ON w.id = m.warband_id
            JOIN member_snapshots ms ON ms.member_id = m.id
            WHERE m.active = 1 AND m.pending = 0
            ORDER BY m.ingame_name, ms.snapshot_id
        `).all();
        res.json({ snapshots, rows });
    } catch (err) {
        console.error('[stats] /api/power-history error:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// GET /api/dream-realm?boss_id=N — boss list + scores
app.get('/api/dream-realm', (req, res) => {
    try {
        const bosses = db.prepare(
            'SELECT id, name, season, sort_order FROM dream_realm_bosses ORDER BY sort_order, name'
        ).all();
        const args   = req.query.boss_id ? [req.query.boss_id] : [];
        const filter = req.query.boss_id ? ' AND s.boss_id = ?' : '';
        const scores = db.prepare(`
            SELECT s.boss_id, s.boss_name, s.scan_date, s.rank, s.score, s.tier,
                   m.id as member_id, m.ingame_name
            FROM dream_realm_scores s
            JOIN members m ON m.id = s.member_id
            WHERE 1=1${filter}
            ORDER BY s.boss_id, s.scan_date, s.rank
        `).all(...args);
        res.json({ bosses, scores });
    } catch (err) {
        console.error('[stats] /api/dream-realm error:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// GET /api/arena — arena + supreme arena rankings
app.get('/api/arena', (req, res) => {
    try {
        const arena = db.prepare(`
            SELECT m.id, m.ingame_name, m.warband_id, w.name as warband_name,
                   ar.rank, ar.points, ar.scanned_at
            FROM arena_rankings ar
            JOIN members m ON m.id = ar.member_id
            LEFT JOIN warbands w ON w.id = m.warband_id
            ORDER BY ar.rank
        `).all();
        const supArena = db.prepare(`
            SELECT m.id, m.ingame_name, sar.period_start, sar.rank, sar.scanned_at
            FROM supreme_arena_rankings sar
            JOIN members m ON m.id = sar.member_id
            ORDER BY sar.period_start DESC, sar.rank
        `).all();
        res.json({ arena, supArena });
    } catch (err) {
        console.error('[stats] /api/arena error:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// GET /api/honor — honor duel rankings
app.get('/api/honor', (req, res) => {
    try {
        const honor = db.prepare(`
            SELECT m.id, m.ingame_name, m.warband_id, w.name as warband_name,
                   h.rank, h.honor_points, h.scanned_at
            FROM honor_duel_rankings h
            JOIN members m ON m.id = h.member_id
            LEFT JOIN warbands w ON w.id = m.warband_id
            ORDER BY h.rank
        `).all();
        res.json(honor);
    } catch (err) {
        console.error('[stats] /api/honor error:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// GET /api/lab — arcane lab rankings
app.get('/api/lab', (req, res) => {
    try {
        const lab = db.prepare(`
            SELECT m.id, m.ingame_name, m.warband_id, w.name as warband_name,
                   l.rank, l.difficulty, l.floor, l.points, l.scanned_at
            FROM arcane_lab_rankings l
            JOIN members m ON m.id = l.member_id
            LEFT JOIN warbands w ON w.id = m.warband_id
            ORDER BY l.rank
        `).all();
        res.json(lab);
    } catch (err) {
        console.error('[stats] /api/lab error:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// SPA fallback
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, '127.0.0.1', () => {
    console.log(`[stats] Server running on http://127.0.0.1:${PORT}`);
});
