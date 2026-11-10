const LABEL_IN_TEXT_RE = /\[\s*(PA|P|A)?\s*(\d{1,4})\s*\]/gi;
const LABEL_INPUT_RE = /^\[?\s*(PA|P|A)?\s*(\d{1,4})\s*\]?$/i;

function makeLabel(prefix, digits) {
    return `${(prefix || '').toUpperCase()}${parseInt(digits, 10)}`;
}

function extractLabels(text) {
    const labels = [];
    for (const m of String(text ?? '').matchAll(LABEL_IN_TEXT_RE)) {
        const label = makeLabel(m[1], m[2]);
        if (!labels.includes(label)) labels.push(label);
    }
    return labels;
}

function normalizeStageInput(input) {
    const m = LABEL_INPUT_RE.exec(String(input ?? '').trim());
    return m ? makeLabel(m[1], m[2]) : null;
}

function ensureAfkStageSchema(h) {
    h.exec(`
        CREATE TABLE IF NOT EXISTS afk_stage_posts (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            label       TEXT NOT NULL,
            message_id  TEXT NOT NULL,
            message_url TEXT NOT NULL,
            posted_by   TEXT,
            posted_at   TEXT NOT NULL,
            UNIQUE(message_id, label)
        );
        CREATE INDEX IF NOT EXISTS idx_afk_stage_posts_label ON afk_stage_posts(label);
    `);
}

function savePost(h, post, labels) {
    const remove = h.prepare('DELETE FROM afk_stage_posts WHERE message_id = ?');
    const insert = h.prepare(`
        INSERT INTO afk_stage_posts (label, message_id, message_url, posted_by, posted_at)
        VALUES (@label, @message_id, @message_url, @posted_by, @posted_at)
    `);
    h.transaction(() => {
        remove.run(post.message_id);
        for (const label of labels) insert.run({ ...post, label });
    })();
}

function removePost(h, messageId) {
    h.prepare('DELETE FROM afk_stage_posts WHERE message_id = ?').run(messageId);
}

function getStagePosts(h, label) {
    return h.prepare('SELECT * FROM afk_stage_posts WHERE label = ? ORDER BY posted_at ASC, id ASC').all(label);
}

function labelSortKey(label) {
    const m = /^(PA|P|A)?(\d+)$/.exec(label);
    return { number: parseInt(m[2], 10), prefix: m[1] || '' };
}

function getKnownLabels(h) {
    const rows = h.prepare('SELECT label, COUNT(*) AS posts FROM afk_stage_posts GROUP BY label').all();
    return rows.sort((a, b) => {
        const ka = labelSortKey(a.label);
        const kb = labelSortKey(b.label);
        return ka.number - kb.number || ka.prefix.localeCompare(kb.prefix);
    });
}

module.exports = {
    extractLabels,
    normalizeStageInput,
    ensureAfkStageSchema,
    savePost,
    removePost,
    getStagePosts,
    getKnownLabels,
};
