const stages = require('../afkStages');

const AFK_STAGES_CHANNEL_ID = '1569578942585774151';

const realDb = () => require('../db');

function postFrom(message) {
    return {
        message_id: message.id,
        message_url: message.url,
        posted_by: message.author?.id ?? null,
        posted_at: message.createdAt.toISOString(),
    };
}

function handleAfkStagePost(message, h = realDb()) {
    if (message.channelId !== AFK_STAGES_CHANNEL_ID) return;

    const labels = stages.extractLabels(message.content);
    if (!labels.length) return;

    stages.savePost(h, postFrom(message), labels);
    message.react('💾').catch(() => {});
}

function handleAfkStageEdit(message, h = realDb()) {
    if (message.channelId !== AFK_STAGES_CHANNEL_ID) return;
    stages.savePost(h, postFrom(message), stages.extractLabels(message.content));
}

function handleAfkStageDelete(message, h = realDb()) {
    stages.removePost(h, message.id);
}

module.exports = { AFK_STAGES_CHANNEL_ID, handleAfkStagePost, handleAfkStageEdit, handleAfkStageDelete };
