const LEGACY_WELCOME_KEYS = {
    'RKF RiffRaff': 'ROSTER_WELCOME_RIFFRAFF_CHANNEL_ID',
    'RKF Frop': 'ROSTER_WELCOME_FROP_CHANNEL_ID',
};

function entryFromRow(row, getConfig) {
    if (!row || !row.guild_role_id) return null;

    let welcomeChannelId = row.main_channel_id || null;
    if (!welcomeChannelId && LEGACY_WELCOME_KEYS[row.name]) {
        welcomeChannelId = getConfig(LEGACY_WELCOME_KEYS[row.name]) || null;
    }

    return { id: row.guild_role_id, label: row.name, welcomeChannelId };
}

function formatGuildNames(rows) {
    const names = rows.map(r => r.name.replace(/^RKF\s+/, ''));
    if (names.length <= 1) return names.join('');
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

module.exports = { entryFromRow, formatGuildNames, LEGACY_WELCOME_KEYS };
