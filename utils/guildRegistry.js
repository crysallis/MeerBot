const GUILD_COLUMNS = ['guild_role_id', 'leader_role_id', 'category_id', 'main_channel_id'];

const KNOWN_GUILDS = {
    'RKF RiffRaff': {
        guild_role_id: '1523580372208717964',
        category_id: '1510145205582692393',
        main_channel_id: '1303421884687192174',
    },
    'RKF Frop': {
        guild_role_id: '1533951415633051688',
        leader_role_id: '1303422881002426398',
        category_id: '1510143019951849492',
        main_channel_id: '1482485945675550720',
    },
};

const ID_COLUMN = {
    guildRoleId: 'guild_role_id',
    leaderRoleId: 'leader_role_id',
    categoryId: 'category_id',
    mainChannelId: 'main_channel_id',
};

function ensureGuildSchema(h) {
    const have = new Set(h.prepare('PRAGMA table_info(guilds)').all().map(c => c.name));
    for (const col of GUILD_COLUMNS) {
        if (!have.has(col)) h.exec(`ALTER TABLE guilds ADD COLUMN ${col} TEXT`);
    }
    h.exec(`
        CREATE TABLE IF NOT EXISTS guild_channels (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id   INTEGER NOT NULL REFERENCES guilds(id),
            kind       TEXT NOT NULL CHECK(kind IN ('channel','shared_grant')),
            key        TEXT NOT NULL,
            discord_id TEXT NOT NULL,
            UNIQUE(guild_id, kind, discord_id)
        )
    `);
}

function getGuildById(h, id) {
    return h.prepare('SELECT * FROM guilds WHERE id = ?').get(id);
}

function getGuildByName(h, name) {
    return h.prepare('SELECT * FROM guilds WHERE name = ?').get(name);
}

function createGuild(h, name) {
    h.prepare('INSERT OR IGNORE INTO guilds (name) VALUES (?)').run(name);
    return getGuildByName(h, name);
}

function setGuildDiscordIds(h, guildId, ids) {
    for (const [key, col] of Object.entries(ID_COLUMN)) {
        if (ids[key] === undefined) continue;
        h.prepare(`UPDATE guilds SET ${col} = ? WHERE id = ?`).run(ids[key], guildId);
    }
}

function addOverrideRole(h, guildId, roleId) {
    const row = getGuildById(h, guildId);
    if (!row) return;
    let roles;
    try {
        roles = JSON.parse(row.override_role_ids);
    } catch {
        roles = [];
    }
    if (roles.includes(roleId)) return;
    roles.push(roleId);
    h.prepare('UPDATE guilds SET override_role_ids = ? WHERE id = ?').run(JSON.stringify(roles), guildId);
}

function addGuildChannel(h, guildId, kind, key, discordId) {
    h.prepare('INSERT OR IGNORE INTO guild_channels (guild_id, kind, key, discord_id) VALUES (?, ?, ?, ?)')
        .run(guildId, kind, key, discordId);
}

function getGuildChannels(h, guildId) {
    return h.prepare('SELECT * FROM guild_channels WHERE guild_id = ? ORDER BY id').all(guildId);
}

function seedKnownGuilds(h) {
    for (const [name, ids] of Object.entries(KNOWN_GUILDS)) {
        const row = getGuildByName(h, name);
        if (!row) continue;
        for (const [col, value] of Object.entries(ids)) {
            if (row[col] == null) {
                h.prepare(`UPDATE guilds SET ${col} = ? WHERE id = ?`).run(value, row.id);
            }
        }
        if (ids.leader_role_id) addOverrideRole(h, row.id, ids.leader_role_id);
    }
}

const KNOWN_GUILD_NAMES = Object.keys(KNOWN_GUILDS);

module.exports = {
    KNOWN_GUILD_NAMES,
    ensureGuildSchema,
    createGuild,
    getGuildById,
    getGuildByName,
    setGuildDiscordIds,
    addOverrideRole,
    addGuildChannel,
    getGuildChannels,
    seedKnownGuilds,
};
