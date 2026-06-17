'use strict';

// Authentication + role-based access for the admin panel.
//
// Three tiers, ranked read < manage < local:
//   read   · view everything, no edits                     (RiffRaffian role, remote)
//   manage · day-to-day edits, no reserved infra ops       (Riff/Raff roles, remote)
//   local  · everything, including reserved destructive ops (only the physical PC)
//
// Remote users authenticate with Discord OAuth2; their tier comes from their roles
// in our guild (panel_roles table). The `local` tier is granted by request ORIGIN,
// not by any role — see isLocalRequest — so even a logged-in Riff/Raff cannot reach
// the reserved ops from off the machine.

const crypto = require('crypto');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const db = require('../utils/db');
const botConfig = require('../utils/botConfig');

const DISCORD_API = 'https://discord.com/api/v10';
const GUILD_ID = process.env.GUILD_ID;
// Discord's OAuth2 Client ID is the same value as the Application ID · reuse it so
// only the (separate) Client Secret needs adding to .env.
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || process.env.APPLICATION_ID;

const TIER_RANK = { read: 1, manage: 2, local: 3 };
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Seed the role -> tier map once (idempotent · editable later via panel_roles).
const ROLE_TIER_SEED = [
    ['1229572649651404830', 'manage'], // Riff
    ['1229554049788018808', 'manage'], // Raff
    ['1401783863960666143', 'read'],   // RiffRaffians
];
{
    const seed = db.prepare('INSERT OR IGNORE INTO panel_roles (role_id, tier) VALUES (?, ?)');
    for (const [roleId, tier] of ROLE_TIER_SEED) seed.run(roleId, tier);
}

// Operation registry · one entry per editable action, tagged with the tab it lives
// in (`group`) and a default required tier. New tabs add their operations here and
// they automatically appear in the Access tab. Per-op tiers are overridable at
// runtime via the panel_op_access table (see opTier). `match(req)` identifies a
// mutating request; GETs are always `read`.
function cfgKey(req) {
    const m = req.path.match(/^\/api\/config\/(.+)$/);
    return m ? decodeURIComponent(m[1]) : null;
}
function cfgCategory(req) {
    const key = cfgKey(req);
    return key ? botConfig.CONFIG_META[key]?.category : null;
}

const OPERATIONS = [
    { key: 'bot.restart',     group: 'Bot',            label: 'Restart bot',              defaultTier: 'local',  match: r => r.method === 'POST' && r.path === '/api/bot/restart' },
    { key: 'discord.refresh', group: 'Bot',            label: 'Refresh Discord data',     defaultTier: 'local',  match: r => r.method === 'POST' && r.path === '/api/refresh-discord-data' },
    { key: 'config.scan_auth',group: 'Permissions',    label: 'Edit scan-authorized user',defaultTier: 'local',  match: r => cfgKey(r) === 'SCAN_AUTHORIZED_USER' },
    { key: 'config.scan_modes',group:'Scan Modes',     label: 'Toggle scan modes',        defaultTier: 'local',  match: r => cfgCategory(r) === 'scan_modes' },
    { key: 'config.channels', group: 'Channels',       label: 'Edit channels',            defaultTier: 'manage', match: r => cfgCategory(r) === 'channels' },
    { key: 'config.thresholds',group:'Thresholds',     label: 'Edit thresholds',          defaultTier: 'manage', match: r => cfgCategory(r) === 'thresholds' },
    { key: 'permissions',     group: 'Permissions',    label: 'Edit command permissions', defaultTier: 'manage', match: r => /^\/api\/permissions/.test(r.path) },
    { key: 'scheduled_jobs',  group: 'Scheduled Jobs', label: 'Edit scheduled jobs',      defaultTier: 'manage', match: r => /^\/api\/scheduled-jobs/.test(r.path) },
    { key: 'reactions',       group: 'Reactions',      label: 'Edit message reactions',   defaultTier: 'manage', match: r => /^\/api\/message-reactions/.test(r.path) },
    { key: 'members',         group: 'Members',        label: 'Edit members',             defaultTier: 'manage', match: r => /^\/api\/members/.test(r.path) },
    { key: 'warbands',        group: 'Warbands',       label: 'Edit warbands',            defaultTier: 'manage', match: r => /^\/api\/warbands/.test(r.path) },
    { key: 'dream_bosses',    group: 'DR Bosses',      label: 'Edit Dream Realm bosses',  defaultTier: 'manage', match: r => /^\/api\/dream-realm-bosses/.test(r.path) },
    { key: 'seasons',         group: 'Seasons',        label: 'Edit seasons & servers',   defaultTier: 'manage', match: r => /^\/api\/seasons/.test(r.path) },
];
const OP_BY_KEY = new Map(OPERATIONS.map(op => [op.key, op]));

// Resolved required tier for an operation: DB override wins over the code default.
function opTier(key) {
    const row = db.prepare('SELECT tier FROM panel_op_access WHERE op_key = ?').get(key);
    return row?.tier || OP_BY_KEY.get(key)?.defaultTier || 'manage';
}

// Best avatar URL for a logged-in user: guild-specific avatar > account avatar >
// Discord's default. Animated hashes (a_...) are served as gif.
function avatarUrl(user, member) {
    const ext = h => (h.startsWith('a_') ? 'gif' : 'png');
    if (member?.avatar) {
        return `https://cdn.discordapp.com/guilds/${GUILD_ID}/users/${user.id}/avatars/${member.avatar}.${ext(member.avatar)}?size=64`;
    }
    if (user.avatar) {
        return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext(user.avatar)}?size=64`;
    }
    const idx = Number((BigInt(user.id) >> 22n) % 6n);
    return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}

function highestTierForRoles(roleIds) {
    const rows = db.prepare('SELECT role_id, tier FROM panel_roles').all();
    const map = new Map(rows.map(r => [r.role_id, r.tier]));
    let best = null;
    for (const id of roleIds || []) {
        const t = map.get(id);
        if (t && (!best || TIER_RANK[t] > TIER_RANK[best])) best = t;
    }
    return best;
}

// A request is "local" only when it hits us directly on loopback with NO Cloudflare
// tunnel headers. Tunnel traffic always carries cf-* headers and the public host, so
// it can never satisfy this. cloudflared connects from 127.0.0.1 too, which is why the
// Host (not just remoteAddress) is the real discriminator.
function isLocalRequest(req) {
    const host = (req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    if (!LOCAL_HOSTS.has(host)) return false;
    if (req.headers['cf-connecting-ip'] || req.headers['cf-ray']) return false;
    return true;
}

function effectiveTier(req) {
    if (isLocalRequest(req)) return 'local';
    return req.session?.tier || null;
}

// Minimum tier required for a given request.
function requiredTier(req) {
    // Access management is always local-only and not overridable · no remote lockout.
    if (/^\/api\/access(\/|$)/.test(req.path)) return 'local';
    if (req.method === 'GET' || req.method === 'HEAD') return 'read';
    const op = OPERATIONS.find(o => o.match(req));
    return op ? opTier(op.key) : 'manage';
}

function renderDenied(message) {
    return `<!doctype html><meta charset="utf-8"><title>Access denied</title>
<body style="font-family:system-ui;background:#1a1a1a;color:#eee;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1>Access denied</h1><p>${message}</p>
<p><a href="/auth/login" style="color:#7aa2f7">Try a different account</a></p></div></body>`;
}

function sessionMiddleware() {
    const secret = process.env.SESSION_SECRET;
    if (!secret) console.warn('[auth] SESSION_SECRET not set · using a random secret (sessions drop on restart)');
    return session({
        store: new SqliteStore({ client: db, expired: { clear: true, intervalMs: 15 * 60 * 1000 } }),
        secret: secret || crypto.randomBytes(32).toString('hex'),
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            sameSite: 'lax',
            secure: process.env.ADMIN_INSECURE_COOKIE !== 'true', // off only for explicit local-http testing
            maxAge: 7 * 24 * 60 * 60 * 1000,
        },
    });
}

function registerRoutes(app) {
    app.get('/auth/login', (req, res) => {
        const state = crypto.randomBytes(16).toString('hex');
        req.session.oauthState = state;
        const params = new URLSearchParams({
            client_id: CLIENT_ID,
            redirect_uri: process.env.ADMIN_OAUTH_REDIRECT,
            response_type: 'code',
            scope: 'identify',
            state,
        });
        res.redirect(`${DISCORD_API}/oauth2/authorize?${params}`);
    });

    app.get('/auth/callback', async (req, res) => {
        const { code, state } = req.query;
        if (!code || !state || state !== req.session.oauthState) {
            return res.status(400).send('Invalid OAuth state · please retry the login.');
        }
        delete req.session.oauthState;
        try {
            const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: CLIENT_ID,
                    client_secret: process.env.DISCORD_CLIENT_SECRET,
                    grant_type: 'authorization_code',
                    code,
                    redirect_uri: process.env.ADMIN_OAUTH_REDIRECT,
                }),
            });
            if (!tokenRes.ok) throw new Error('token exchange failed');
            const token = await tokenRes.json();

            const userRes = await fetch(`${DISCORD_API}/users/@me`, {
                headers: { Authorization: `Bearer ${token.access_token}` },
            });
            if (!userRes.ok) throw new Error('user lookup failed');
            const user = await userRes.json();

            // Read the user's roles in OUR guild via the bot token (not the user token,
            // which only carries `identify`).
            const memberRes = await fetch(`${DISCORD_API}/guilds/${GUILD_ID}/members/${user.id}`, {
                headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` },
            });
            if (memberRes.status === 404) return res.status(403).send(renderDenied('You are not a member of this server.'));
            if (!memberRes.ok) throw new Error('member lookup failed');
            const member = await memberRes.json();

            const tier = highestTierForRoles(member.roles);
            if (!tier) return res.status(403).send(renderDenied('Your roles do not grant panel access.'));

            req.session.regenerate(err => {
                if (err) { console.error('[auth] session regenerate failed:', err); return res.status(500).send('Session error'); }
                req.session.user = {
                    id: user.id,
                    name: member.nick || user.global_name || user.username,
                    avatar: avatarUrl(user, member),
                };
                // `local` is granted by request origin only · a remote session can never
                // exceed `manage`, even if a role is mis-mapped to local in panel_roles.
                req.session.tier = tier === 'local' ? 'manage' : tier;
                req.session.csrf = crypto.randomBytes(32).toString('hex');
                try {
                    db.prepare('INSERT INTO panel_audit (discord_id, action, target, at) VALUES (?, ?, ?, ?)')
                        .run(user.id, 'LOGIN', `${req.session.user.name} (${req.session.tier})`, new Date().toISOString());
                } catch (e) { console.error('[audit] login log failed:', e.message); }
                res.redirect('/');
            });
        } catch (err) {
            console.error('[auth] callback error:', err);
            res.status(500).send('Login failed · check the server logs.');
        }
    });

    app.post('/auth/logout', (req, res) => {
        req.session.destroy(() => res.json({ ok: true }));
    });

    // Who am I + what may I do · the SPA calls this on load.
    app.get('/auth/me', (req, res) => {
        const tier = effectiveTier(req);
        if (!tier) return res.status(401).json({ error: 'Not authenticated' });
        res.json({
            tier,
            user: isLocalRequest(req) ? { id: 'local', name: 'Local (this PC)' } : req.session.user,
            csrf: isLocalRequest(req) ? null : (req.session?.csrf || null),
        });
    });
}

// Gate every /api request: authenticate, enforce the minimum tier, and require a
// CSRF token on remote mutations. Fails closed.
function authorize(req, res, next) {
    const tier = effectiveTier(req);
    if (!tier) return res.status(401).json({ error: 'Not authenticated' });

    const need = requiredTier(req);
    if (TIER_RANK[tier] < TIER_RANK[need]) {
        return res.status(403).json({ error: 'Insufficient access for this action' });
    }

    const mutating = req.method !== 'GET' && req.method !== 'HEAD';
    if (mutating && !isLocalRequest(req)) {
        const token = req.headers['x-csrf-token'];
        if (!token || token !== req.session?.csrf) {
            return res.status(403).json({ error: 'Invalid or missing CSRF token' });
        }
    }

    req.tier = tier;
    req.actor = isLocalRequest(req) ? 'local' : (req.session?.user?.id || 'unknown');
    next();
}

// Record every successful mutation. Mounted after authorize on /api.
function audit(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    res.on('finish', () => {
        if (res.statusCode >= 400) return;
        try {
            db.prepare('INSERT INTO panel_audit (discord_id, action, target, at) VALUES (?, ?, ?, ?)')
                .run(req.actor || 'unknown', `${req.method} ${req.path}`,
                     JSON.stringify(req.body || {}).slice(0, 500), new Date().toISOString());
        } catch (e) {
            console.error('[audit] failed to record:', e.message);
        }
    });
    next();
}

// ── Access-tab helpers (consumed by /api/access in server.js) ──────────────────

// Operations grouped by tab, with default + effective (override-applied) tiers.
function listOperations() {
    const overrides = new Map(
        db.prepare('SELECT op_key, tier FROM panel_op_access').all().map(r => [r.op_key, r.tier])
    );
    return OPERATIONS.map(op => ({
        key: op.key,
        group: op.group,
        label: op.label,
        defaultTier: op.defaultTier,
        tier: overrides.get(op.key) || op.defaultTier,
        overridden: overrides.has(op.key),
    }));
}

// Set or clear a per-operation tier override (null/'' or matching default clears it).
function setOperationTier(opKey, tier) {
    if (!OP_BY_KEY.has(opKey)) throw new Error('Unknown operation');
    if (!tier || tier === OP_BY_KEY.get(opKey).defaultTier) {
        db.prepare('DELETE FROM panel_op_access WHERE op_key = ?').run(opKey);
        return;
    }
    if (!TIER_RANK[tier]) throw new Error('Invalid tier');
    db.prepare(`INSERT INTO panel_op_access (op_key, tier) VALUES (?, ?)
                ON CONFLICT(op_key) DO UPDATE SET tier = excluded.tier`).run(opKey, tier);
}

function listRoleTiers() {
    return db.prepare('SELECT role_id, tier FROM panel_roles ORDER BY tier DESC').all();
}

// Roles may be read or manage only · `local` is origin-based and never role-grantable.
function setRoleTier(roleId, tier) {
    if (!roleId) throw new Error('role_id required');
    if (tier === null || tier === '' || tier === 'none') {
        db.prepare('DELETE FROM panel_roles WHERE role_id = ?').run(roleId);
        return;
    }
    if (tier !== 'read' && tier !== 'manage') throw new Error('Role tier must be read or manage');
    db.prepare(`INSERT INTO panel_roles (role_id, tier) VALUES (?, ?)
                ON CONFLICT(role_id) DO UPDATE SET tier = excluded.tier`).run(roleId, tier);
}

function recentAudit(limit = 100) {
    return db.prepare('SELECT discord_id, action, target, at FROM panel_audit ORDER BY id DESC LIMIT ?')
             .all(Math.min(Number(limit) || 100, 500));
}

// ── Presence (who's actively viewing) ──────────────────────────────────────────

// Record a heartbeat for the requester. Returns the actor id (for "is this me?").
function markPresence(req) {
    let id, name, avatar = null;
    if (isLocalRequest(req)) { id = 'local'; name = 'Local (this PC)'; }
    else if (req.session?.user) { ({ id, name, avatar } = req.session.user); }
    else return null;
    db.prepare(`INSERT INTO panel_presence (discord_id, name, avatar, last_seen) VALUES (?, ?, ?, ?)
                ON CONFLICT(discord_id) DO UPDATE SET name = excluded.name, avatar = excluded.avatar, last_seen = excluded.last_seen`)
        .run(id, name, avatar || null, new Date().toISOString());
    return id;
}

// Users seen within the window (default 2 min). Prunes stale rows opportunistically.
function activePresence(windowSec = 120) {
    const cutoff = new Date(Date.now() - windowSec * 1000).toISOString();
    db.prepare('DELETE FROM panel_presence WHERE last_seen < ?')
        .run(new Date(Date.now() - 24 * 3600 * 1000).toISOString());
    return db.prepare('SELECT discord_id, name, avatar, last_seen FROM panel_presence WHERE last_seen >= ? ORDER BY last_seen DESC')
             .all(cutoff);
}

module.exports = {
    sessionMiddleware, registerRoutes, authorize, audit, LOCAL_HOSTS, TIER_RANK,
    listOperations, setOperationTier, listRoleTiers, setRoleTier, recentAudit,
    markPresence, activePresence,
};
