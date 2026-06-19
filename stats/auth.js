'use strict';

const crypto  = require('crypto');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const db = require('../utils/db');

const DISCORD_API = 'https://discord.com/api/v10';
const GUILD_ID    = process.env.GUILD_ID;
const CLIENT_ID   = process.env.DISCORD_CLIENT_ID || process.env.APPLICATION_ID;

const MEMBER_ROLES = new Set([
    '1401783863960666143', // RiffRaffians
    '1482484067965599846', // Penguins
]);

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function hasMemberRole(roleIds) {
    return (roleIds || []).some(id => MEMBER_ROLES.has(id));
}

function avatarUrl(user, member) {
    const ext = h => h.startsWith('a_') ? 'gif' : 'png';
    if (member?.avatar) {
        return `https://cdn.discordapp.com/guilds/${GUILD_ID}/users/${user.id}/avatars/${member.avatar}.${ext(member.avatar)}?size=64`;
    }
    if (user.avatar) {
        return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext(user.avatar)}?size=64`;
    }
    const idx = Number((BigInt(user.id) >> 22n) % 6n);
    return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}

function renderDenied(msg) {
    return `<!doctype html><meta charset="utf-8"><title>Access denied</title>
<body style="font-family:system-ui;background:#0f1117;color:#e8e9f0;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1 style="color:#f0a500">Access Denied</h1><p>${msg}</p>
<p><a href="/auth/login" style="color:#f0a500">Try a different account</a></p></div></body>`;
}

function sessionMiddleware() {
    const secret = process.env.SESSION_SECRET;
    if (!secret) console.warn('[stats/auth] SESSION_SECRET not set -- sessions drop on restart');
    return session({
        store: new SqliteStore({
            client: db,
            expired: { clear: true, intervalMs: 15 * 60 * 1000 },
            tableName: 'stats_sessions',
        }),
        name: 'stats.sid',
        secret: secret || crypto.randomBytes(32).toString('hex'),
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            sameSite: 'lax',
            secure: process.env.STATS_INSECURE_COOKIE !== 'true',
            maxAge: 7 * 24 * 60 * 60 * 1000,
        },
    });
}

function registerRoutes(app) {
    app.get('/auth/login', (req, res) => {
        const state = crypto.randomBytes(16).toString('hex');
        req.session.oauthState = state;
        const params = new URLSearchParams({
            client_id:     CLIENT_ID,
            redirect_uri:  process.env.STATS_OAUTH_REDIRECT,
            response_type: 'code',
            scope:         'identify',
            state,
        });
        res.redirect(`${DISCORD_API}/oauth2/authorize?${params}`);
    });

    app.get('/auth/callback', async (req, res) => {
        const { code, state } = req.query;
        if (!code || !state || state !== req.session.oauthState) {
            return res.status(400).send('Invalid OAuth state -- please retry login.');
        }
        delete req.session.oauthState;
        try {
            const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id:     CLIENT_ID,
                    client_secret: process.env.DISCORD_CLIENT_SECRET,
                    grant_type:    'authorization_code',
                    code,
                    redirect_uri:  process.env.STATS_OAUTH_REDIRECT,
                }),
            });
            if (!tokenRes.ok) throw new Error('token exchange failed');
            const token = await tokenRes.json();

            const userRes = await fetch(`${DISCORD_API}/users/@me`, {
                headers: { Authorization: `Bearer ${token.access_token}` },
            });
            if (!userRes.ok) throw new Error('user fetch failed');
            const user = await userRes.json();

            const memberRes = await fetch(`${DISCORD_API}/guilds/${GUILD_ID}/members/${user.id}`, {
                headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` },
            });
            if (memberRes.status === 404) return res.status(403).send(renderDenied('You are not a member of this server.'));
            if (!memberRes.ok) throw new Error('member fetch failed');
            const member = await memberRes.json();

            if (!hasMemberRole(member.roles)) {
                return res.status(403).send(renderDenied('You need a guild member role to view these stats.'));
            }

            // Match to in-game member for personal highlights
            const dbMember = db.prepare('SELECT id, ingame_name FROM members WHERE discord_id = ? AND active = 1').get(user.id);

            req.session.regenerate(err => {
                if (err) { console.error('[stats/auth] session regenerate error:', err); return res.status(500).send('Session error'); }
                req.session.user = {
                    id:     user.id,
                    name:   member.nick || user.global_name || user.username,
                    avatar: avatarUrl(user, member),
                };
                if (dbMember) {
                    req.session.memberId   = dbMember.id;
                    req.session.ingameName = dbMember.ingame_name;
                }
                res.redirect('/');
            });
        } catch (err) {
            console.error('[stats/auth] callback error:', err);
            res.status(500).send('Login failed -- check the server logs.');
        }
    });

    app.post('/auth/logout', (req, res) => {
        req.session.destroy(() => res.json({ ok: true }));
    });

    app.get('/auth/me', (req, res) => {
        if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
        res.json({
            user:       req.session.user,
            memberId:   req.session.memberId   ?? null,
            ingameName: req.session.ingameName ?? null,
        });
    });
}

function requireMember(req, res, next) {
    if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
    next();
}

module.exports = { sessionMiddleware, registerRoutes, requireMember, LOCAL_HOSTS };
