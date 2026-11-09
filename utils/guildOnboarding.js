const reg = require('./guildRegistry');
const model = require('./guildOnboardingModel');
const { findSharedTargets } = require('./guildOnboardingDiscovery');

const NON_MAIN_KEYS = model.CHANNEL_KEYS.filter(k => k !== 'main');
const GRANTS_DONE_KEY = 'grants_complete';

function isComplete(h, row) {
    if (!row.guild_role_id || !row.leader_role_id || !row.category_id || !row.main_channel_id) return false;
    const rows = reg.getGuildChannels(h, row.id);
    const keys = new Set(rows.filter(c => c.kind === 'channel').map(c => c.key));
    const grantsDone = rows.some(c => c.kind === 'shared_grant' && c.key === GRANTS_DONE_KEY);
    return grantsDone && NON_MAIN_KEYS.every(k => keys.has(k));
}

async function runOnboarding({ input, discord, h, apply, log = () => {} }) {
    const lines = [];
    const warnings = [];
    const created = { channels: {}, grants: [] };
    const say = line => { lines.push(line); log(line); };
    const result = ok => ({ ok, lines, created, warnings });
    const refuse = message => { say(message); return result(false); };

    let names;
    try {
        names = model.buildNames(input.name, input.emoji);
    } catch (err) {
        return refuse(err.message);
    }

    const guildName = `RKF ${String(input.name).trim()}`;
    const allGuilds = h.prepare('SELECT * FROM guilds').all();
    const existing = allGuilds.find(g => g.name.toLowerCase() === guildName.toLowerCase());
    if (existing && reg.KNOWN_GUILD_NAMES.includes(existing.name)) {
        return refuse(`${existing.name} already exists and was not created by onboarding, so it will not be touched.`);
    }
    if (existing && isComplete(h, existing)) return refuse(`${existing.name} is already onboarded.`);

    const others = allGuilds.filter(g => g.id !== existing?.id && g.guild_role_id);

    if (!(await discord.botCanManage())) {
        return refuse('The bot needs the Manage Roles and Manage Channels permissions to onboard a guild.');
    }
    for (const g of others) {
        if (!(await discord.roleExists(g.guild_role_id))) {
            return refuse(`${g.name}: the recorded guild role ${g.guild_role_id} no longer exists in the server.`);
        }
        if (g.category_id && !(await discord.categoryExists(g.category_id))) {
            return refuse(`${g.name}: the recorded category ${g.category_id} no longer exists in the server.`);
        }
    }

    const belowRoleId = await discord.lowestRoleAmong(others.map(g => g.guild_role_id));
    if (belowRoleId && !(await discord.botOutranks(belowRoleId))) {
        return refuse("The bot's role is not above the existing guild roles, so it cannot place the new roles. In Server Settings > Roles, drag the bot's role above them, then run this again.");
    }

    const recordedRoleIds = new Set(others.flatMap(g => [g.guild_role_id, g.leader_role_id].filter(Boolean)));
    const leaderMatch = await discord.findRoleByName(input.leaderRoleName);
    if (leaderMatch && recordedRoleIds.has(leaderMatch.id)) {
        return refuse(`"${input.leaderRoleName}" is already the guild or leader role of another guild.`);
    }

    try {
        const guild = apply ? (existing || reg.createGuild(h, guildName)) : existing;
        const ensureRole = async (recordedId, name, label) => {
            if (recordedId && await discord.roleExists(recordedId)) {
                say(`${label} "${name}" already recorded.`);
                return recordedId;
            }
            const found = await discord.findRoleByName(name);
            if (found) {
                say(`${label} "${name}" already exists in the server, reusing it.`);
                return found.id;
            }
            if (!apply) {
                say(`Would create ${label.toLowerCase()} "${name}".`);
                return null;
            }
            const made = await discord.createRole({ name, belowRoleId });
            say(`Created ${label.toLowerCase()} "${name}".`);
            return made.id;
        };

        const guildRoleId = await ensureRole(guild?.guild_role_id, names.guildRoleName, 'Guild role');
        if (apply) reg.setGuildDiscordIds(h, guild.id, { guildRoleId });

        const leaderRoleId = await ensureRole(guild?.leader_role_id, input.leaderRoleName, 'Leader role');
        if (apply) {
            reg.setGuildDiscordIds(h, guild.id, { leaderRoleId });
            reg.addOverrideRole(h, guild.id, leaderRoleId);
        }
        created.guildRoleId = guildRoleId;
        created.leaderRoleId = leaderRoleId;

        let categoryId = null;
        if (guild?.category_id && await discord.categoryExists(guild.category_id)) {
            categoryId = guild.category_id;
            say(`Category "${names.categoryName}" already recorded.`);
        } else {
            const found = await discord.findCategoryByName(names.categoryName);
            if (found) {
                categoryId = found.id;
                say(`Category "${names.categoryName}" already exists in the server, reusing it.`);
            } else if (!apply) {
                say(`Would create category "${names.categoryName}".`);
            } else {
                const overwrites = model.buildCategoryOverwrites({
                    everyoneId: discord.everyoneRoleId(), guildRoleId, leaderRoleId,
                });
                categoryId = (await discord.createCategory({ name: names.categoryName, overwrites })).id;
                say(`Created category "${names.categoryName}".`);
            }
        }
        if (apply) reg.setGuildDiscordIds(h, guild.id, { categoryId });
        created.categoryId = categoryId;

        for (const channel of names.channels) {
            let channelId = null;
            const found = categoryId ? await discord.findChannelInCategory(categoryId, channel.name) : null;
            if (found) {
                channelId = found.id;
                say(`Channel "${channel.name}" already exists, reusing it.`);
            } else if (!apply) {
                say(`Would create channel "${channel.name}".`);
            } else {
                channelId = (await discord.createChannel({ name: channel.name, categoryId })).id;
                say(`Created channel "${channel.name}".`);
            }
            if (apply) {
                if (channel.key === 'main') reg.setGuildDiscordIds(h, guild.id, { mainChannelId: channelId });
                else reg.addGuildChannel(h, guild.id, 'channel', channel.key, channelId);
            }
            created.channels[channel.key] = channelId;
        }

        const structure = await discord.snapshotStructure();
        const ownCategoryIds = [...others.map(g => g.category_id), categoryId].filter(Boolean);
        const targets = findSharedTargets(structure, others.map(g => g.guild_role_id), ownCategoryIds);
        for (const target of targets) {
            say(`${apply ? 'Granting' : 'Would grant'} "${names.guildRoleName}" access to ${target.kind} "${target.name}".`);
            if (target.kind === 'channel') {
                warnings.push(`Channel "${target.name}" is not synced to its category, so it was handled on its own.`);
            }
            if (apply) {
                await discord.grantAccess({ targetId: target.id, roleId: guildRoleId, perms: model.SHARED_PERMS });
                reg.addGuildChannel(h, guild.id, 'shared_grant', target.kind, target.id);
            }
            created.grants.push(target.id);
        }
        if (!targets.length) say('No shared categories found to grant access to.');
        if (apply) reg.addGuildChannel(h, guild.id, 'shared_grant', GRANTS_DONE_KEY, GRANTS_DONE_KEY);

        return result(true);
    } catch (err) {
        say(`Stopped: ${err.message}. Fix the cause and run the same command again to resume.`);
        return result(false);
    }
}

module.exports = { runOnboarding };
