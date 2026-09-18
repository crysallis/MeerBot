const db = require('../db');

const EASTER_EGGS_FORUM_ID = '1376292444211118111';

// Title marker must lead the message, e.g. "[Exemplar]\nAfter finding 3 pigeons..."
const TITLE_RE = /^\[([^\]]{2,40})\]/;

function extractTitle(text) {
    const m = TITLE_RE.exec((text || '').trim());
    return m ? m[1].trim() : null;
}

function isEasterEggsThreadMessage(message) {
    return message.channel?.isThread?.() && message.channel.parentId === EASTER_EGGS_FORUM_ID;
}

const upsertTitlePost = db.prepare(`
    INSERT INTO title_posts (title, message_id, thread_id, message_url, posted_by, posted_at)
    VALUES (@title, @message_id, @thread_id, @message_url, @posted_by, @posted_at)
    ON CONFLICT(message_id) DO UPDATE SET
        title = excluded.title,
        message_url = excluded.message_url
`);

const deleteTitlePost = db.prepare(`DELETE FROM title_posts WHERE message_id = ?`);

function handleTitlePost(message) {
    if (!isEasterEggsThreadMessage(message)) return;

    const title = extractTitle(message.content);
    if (!title) return;

    upsertTitlePost.run({
        title,
        message_id: message.id,
        thread_id: message.channel.id,
        message_url: message.url,
        posted_by: message.author?.id ?? null,
        posted_at: message.createdAt.toISOString(),
    });
    message.react('💾').catch(() => {});
}

function handleTitlePostEdit(message) {
    if (!isEasterEggsThreadMessage(message)) return;

    const title = extractTitle(message.content);
    if (!title) {
        deleteTitlePost.run(message.id);
        return;
    }

    upsertTitlePost.run({
        title,
        message_id: message.id,
        thread_id: message.channel.id,
        message_url: message.url,
        posted_by: message.author?.id ?? null,
        posted_at: message.createdAt.toISOString(),
    });
}

function getTitlePosts(title) {
    return db.prepare(
        `SELECT * FROM title_posts WHERE title = ? COLLATE NOCASE ORDER BY posted_at ASC`
    ).all(title);
}

function getKnownTitles() {
    return db.prepare(`SELECT DISTINCT title FROM title_posts ORDER BY title ASC`).all().map(r => r.title);
}

module.exports = { handleTitlePost, handleTitlePostEdit, getTitlePosts, getKnownTitles, extractTitle };
