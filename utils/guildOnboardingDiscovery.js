function grantsView(overwrites, roleId) {
    return (overwrites || []).some(o => o.id === roleId && o.allow.includes('ViewChannel'));
}

function allGuildRolesCanView(overwrites, guildRoleIds) {
    return guildRoleIds.every(id => grantsView(overwrites, id));
}

function findSharedTargets(structure, guildRoleIds, ownCategoryIds) {
    if (!guildRoleIds.length) return [];

    const out = [];
    const channelTarget = c => ({ kind: 'channel', id: c.id, name: c.name });

    for (const category of structure.categories || []) {
        if (ownCategoryIds.includes(category.id)) continue;

        const shared = allGuildRolesCanView(category.overwrites, guildRoleIds);
        if (shared) out.push({ kind: 'category', id: category.id, name: category.name });

        for (const channel of category.channels || []) {
            if (shared && channel.synced) continue;
            if (allGuildRolesCanView(channel.overwrites, guildRoleIds)) out.push(channelTarget(channel));
        }
    }

    for (const channel of structure.uncategorised || []) {
        if (allGuildRolesCanView(channel.overwrites, guildRoleIds)) out.push(channelTarget(channel));
    }

    return out;
}

module.exports = { findSharedTargets };
