const CHANNEL_KEYS = ['main', 'battledrills', 'guildduel', 'clashofglory', 'clashfronts'];

const MEMBER_PERMS = {
    allow: [
        'AddReactions', 'Stream', 'ViewChannel', 'SendMessages', 'SendTTSMessages', 'EmbedLinks',
        'AttachFiles', 'ReadMessageHistory', 'UseExternalEmojis', 'Connect', 'Speak', 'UseVAD',
        'UseApplicationCommands', 'RequestToSpeak', 'CreatePublicThreads', 'UseExternalStickers',
        'SendMessagesInThreads', 'UseEmbeddedActivities', 'UseSoundboard', 'UseExternalSounds',
        'SendVoiceMessages',
    ],
    deny: [
        'CreateInstantInvite', 'ManageChannels', 'PrioritySpeaker', 'ManageMessages', 'MentionEveryone',
        'MuteMembers', 'DeafenMembers', 'MoveMembers', 'ManageRoles', 'ManageWebhooks', 'ManageEvents',
        'ManageThreads', 'CreatePrivateThreads', 'CreateEvents', 'SendPolls', 'UseExternalApps',
        'PinMessages', 'BypassSlowmode',
    ],
};

const LEADER_PERMS = {
    allow: [
        'CreateInstantInvite', 'AddReactions', 'PrioritySpeaker', 'Stream', 'ViewChannel', 'SendMessages',
        'SendTTSMessages', 'ManageMessages', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory',
        'MentionEveryone', 'UseExternalEmojis', 'Connect', 'Speak', 'MuteMembers', 'DeafenMembers',
        'MoveMembers', 'UseVAD', 'UseApplicationCommands', 'RequestToSpeak', 'ManageEvents',
        'ManageThreads', 'CreatePublicThreads', 'CreatePrivateThreads', 'UseExternalStickers',
        'SendMessagesInThreads', 'UseEmbeddedActivities', 'UseSoundboard', 'CreateEvents',
        'UseExternalSounds', 'SendVoiceMessages', 'SendPolls', 'PinMessages', 'BypassSlowmode',
    ],
    deny: ['ManageChannels', 'ManageRoles', 'ManageWebhooks', 'UseExternalApps'],
};

const SHARED_PERMS = {
    allow: [
        'AddReactions', 'Stream', 'ViewChannel', 'SendMessages', 'SendTTSMessages', 'EmbedLinks',
        'AttachFiles', 'ReadMessageHistory', 'UseExternalEmojis', 'Connect', 'Speak', 'UseVAD',
        'UseApplicationCommands', 'CreatePublicThreads', 'CreatePrivateThreads', 'UseExternalStickers',
        'SendMessagesInThreads', 'UseEmbeddedActivities', 'UseSoundboard', 'UseExternalSounds',
        'SendVoiceMessages', 'SendPolls', 'PinMessages',
    ],
    deny: [
        'CreateInstantInvite', 'ManageChannels', 'PrioritySpeaker', 'ManageMessages', 'MentionEveryone',
        'MuteMembers', 'DeafenMembers', 'MoveMembers', 'ManageRoles', 'ManageWebhooks', 'RequestToSpeak',
        'ManageEvents', 'ManageThreads', 'CreateEvents', 'UseExternalApps', 'BypassSlowmode',
    ],
};

const MAX_NAME_LENGTH = 100;

function slugify(name) {
    return String(name).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function buildNames(name, emoji) {
    const slug = slugify(name);
    if (!slug) throw new Error('Invalid guild name: it has no letters or digits');

    const channels = [
        { key: 'main', name: `╠⋮ㆍ${slug}ㆍ${emoji}` },
        { key: 'battledrills', name: `╠⋮🏰battleㆍdrillsㆍ${slug}` },
        { key: 'guildduel', name: `╠⋮🐦‍🔥guildㆍduelㆍ${slug}` },
        { key: 'clashofglory', name: '╠⋮🗺️clashㆍofㆍglory' },
        { key: 'clashfronts', name: `﴾ㆍclashfrontsㆍ${slug}` },
    ];
    const trimmed = String(name).trim();
    const guildRoleName = `RKF ${trimmed} (Guild)`;
    const categoryName = `⚔️🏰⋮RKF ${trimmed}⋮🏰⚔️`;

    for (const n of [guildRoleName, categoryName, ...channels.map(c => c.name)]) {
        if ([...n].length > MAX_NAME_LENGTH) {
            throw new Error(`Invalid guild name: "${n}" would be over ${MAX_NAME_LENGTH} characters`);
        }
    }

    return { slug, guildRoleName, categoryName, channels };
}

function buildCategoryOverwrites({ everyoneId, guildRoleId, leaderRoleId }) {
    return [
        { id: everyoneId, allow: [], deny: ['ViewChannel', 'Connect'] },
        { id: guildRoleId, allow: [...MEMBER_PERMS.allow], deny: [...MEMBER_PERMS.deny] },
        { id: leaderRoleId, allow: [...LEADER_PERMS.allow], deny: [...LEADER_PERMS.deny] },
    ];
}

module.exports = {
    CHANNEL_KEYS,
    MEMBER_PERMS,
    LEADER_PERMS,
    SHARED_PERMS,
    slugify,
    buildNames,
    buildCategoryOverwrites,
};
