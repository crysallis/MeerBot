const { ChannelType, OverwriteType, PermissionFlagsBits } = require('discord.js');

function describeOverwrites(channel) {
    return [...channel.permissionOverwrites.cache.values()]
        .filter(o => o.type === OverwriteType.Role)
        .map(o => ({ id: o.id, allow: o.allow.toArray(), deny: o.deny.toArray() }));
}

function describeChannel(channel) {
    return {
        id: channel.id,
        name: channel.name,
        synced: Boolean(channel.permissionsLocked),
        overwrites: describeOverwrites(channel),
    };
}

function toStructure(channels) {
    const categories = new Map();
    const uncategorised = [];

    for (const channel of channels.values()) {
        if (!channel) continue;
        if (channel.type === ChannelType.GuildCategory) {
            const entry = { id: channel.id, name: channel.name, overwrites: describeOverwrites(channel) };
            entry.channels = categories.get(channel.id)?.channels ?? [];
            categories.set(channel.id, entry);
            continue;
        }
        if (channel.parentId) {
            if (!categories.has(channel.parentId)) categories.set(channel.parentId, { channels: [] });
            categories.get(channel.parentId).channels.push(describeChannel(channel));
        } else {
            uncategorised.push(describeChannel(channel));
        }
    }

    return { categories: [...categories.values()], uncategorised };
}

function permsToEditObject(perms) {
    const out = {};
    for (const name of perms.allow) out[name] = true;
    for (const name of perms.deny) out[name] = false;
    return out;
}

function makeDiscordAdapter(guild) {
    const fetchChannel = id => guild.channels.fetch(id).catch(() => null);

    return {
        async botCanManage() {
            const me = guild.members.me ?? await guild.members.fetchMe();
            return me.permissions.has([PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels]);
        },

        everyoneRoleId() {
            return guild.roles.everyone.id;
        },

        async roleExists(id) {
            return Boolean(await guild.roles.fetch(id).catch(() => null));
        },

        async categoryExists(id) {
            const channel = await fetchChannel(id);
            return Boolean(channel) && channel.type === ChannelType.GuildCategory;
        },

        async lowestRoleAmong(ids) {
            const roles = await guild.roles.fetch();
            const picked = ids.map(id => roles.get(id)).filter(Boolean).sort((a, b) => a.position - b.position);
            return picked.length ? picked[0].id : null;
        },

        async botOutranks(roleId) {
            const me = guild.members.me ?? await guild.members.fetchMe();
            const role = await guild.roles.fetch(roleId);
            return me.roles.highest.position > role.position;
        },

        async findRoleByName(name) {
            const roles = await guild.roles.fetch();
            const role = roles.find(r => r.name === name);
            return role ? { id: role.id } : null;
        },

        async findCategoryByName(name) {
            const channels = await guild.channels.fetch();
            const found = channels.find(c => c && c.type === ChannelType.GuildCategory && c.name === name);
            return found ? { id: found.id } : null;
        },

        async findChannelInCategory(categoryId, name) {
            const channels = await guild.channels.fetch();
            const found = channels.find(c => c && c.parentId === categoryId && c.name === name);
            return found ? { id: found.id } : null;
        },

        async createRole({ name, belowRoleId }) {
            const below = belowRoleId ? await guild.roles.fetch(belowRoleId) : null;
            const role = await guild.roles.create({
                name,
                permissions: [],
                ...(below ? { position: below.position } : {}),
                reason: 'Guild onboarding',
            });
            return { id: role.id };
        },

        async createCategory({ name, overwrites }) {
            const category = await guild.channels.create({
                name,
                type: ChannelType.GuildCategory,
                permissionOverwrites: overwrites.map(o => ({
                    id: o.id, type: OverwriteType.Role, allow: o.allow, deny: o.deny,
                })),
                reason: 'Guild onboarding',
            });
            return { id: category.id };
        },

        async createChannel({ name, categoryId }) {
            const channel = await guild.channels.create({
                name,
                type: ChannelType.GuildText,
                parent: categoryId,
                reason: 'Guild onboarding',
            });
            return { id: channel.id };
        },

        async grantAccess({ targetId, roleId, perms }) {
            const target = await fetchChannel(targetId);
            if (!target) throw new Error(`Channel or category ${targetId} not found`);

            const syncedChildren = target.type === ChannelType.GuildCategory
                ? [...(await guild.channels.fetch()).values()].filter(c => c && c.parentId === targetId && c.permissionsLocked)
                : [];

            await target.permissionOverwrites.edit(roleId, permsToEditObject(perms), { reason: 'Guild onboarding' });

            for (const child of syncedChildren) await child.lockPermissions();
        },

        async snapshotStructure() {
            return toStructure(await guild.channels.fetch());
        },
    };
}

module.exports = { makeDiscordAdapter, toStructure, permsToEditObject };
