const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const stages = require('../afkStages');
const {
    AFK_STAGES_CHANNEL_ID,
    handleAfkStagePost,
    handleAfkStageEdit,
    handleAfkStageDelete,
} = require('./afkStagePostHandler');

function makeDb() {
    const h = new Database(':memory:');
    stages.ensureAfkStageSchema(h);
    return h;
}

function makeMessage({ id = 'm1', content, channelId = AFK_STAGES_CHANNEL_ID, authorId = 'u1', reacts }) {
    return {
        id,
        content,
        channelId,
        author: { id: authorId },
        url: `https://discord.com/channels/g/${channelId}/${id}`,
        createdAt: new Date('2026-11-10T12:00:00.000Z'),
        react: async emoji => { if (reacts) reacts.push(emoji); },
    };
}

test('a post in the AFK stages channel is saved under each label it contains and reacted to', async () => {
    const h = makeDb();
    const reacts = [];
    handleAfkStagePost(makeMessage({ content: 'Guide for [P127] and [127]', reacts }), h);
    await new Promise(r => setTimeout(r, 0));

    const rows = stages.getStagePosts(h, 'P127');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].posted_by, 'u1');
    assert.strictEqual(rows[0].message_url, 'https://discord.com/channels/g/' + AFK_STAGES_CHANNEL_ID + '/m1');
    assert.strictEqual(stages.getStagePosts(h, '127').length, 1);
    assert.deepStrictEqual(reacts, ['💾']);
});

test('a post in any other channel is ignored', () => {
    const h = makeDb();
    handleAfkStagePost(makeMessage({ content: '[127]', channelId: '999' }), h);
    assert.strictEqual(stages.getStagePosts(h, '127').length, 0);
});

test('chatter with no label is ignored and not reacted to', async () => {
    const h = makeDb();
    const reacts = [];
    handleAfkStagePost(makeMessage({ content: 'thanks, that helped!', reacts }), h);
    await new Promise(r => setTimeout(r, 0));
    assert.strictEqual(stages.getKnownLabels(h).length, 0);
    assert.deepStrictEqual(reacts, []);
});

test('editing a post re-reads its labels', () => {
    const h = makeDb();
    handleAfkStagePost(makeMessage({ content: '[P12]' }), h);
    handleAfkStageEdit(makeMessage({ content: '[PA12]' }), h);
    assert.strictEqual(stages.getStagePosts(h, 'P12').length, 0);
    assert.strictEqual(stages.getStagePosts(h, 'PA12').length, 1);
});

test('editing the label away removes the post', () => {
    const h = makeDb();
    handleAfkStagePost(makeMessage({ content: '[12]' }), h);
    handleAfkStageEdit(makeMessage({ content: 'oops, wrong channel' }), h);
    assert.strictEqual(stages.getStagePosts(h, '12').length, 0);
});

test('an edit in another channel does not touch stored posts', () => {
    const h = makeDb();
    handleAfkStagePost(makeMessage({ content: '[12]' }), h);
    handleAfkStageEdit(makeMessage({ content: 'nothing', channelId: '999' }), h);
    assert.strictEqual(stages.getStagePosts(h, '12').length, 1);
});

test('deleting a post removes it, even when the deleted message is only a partial', () => {
    const h = makeDb();
    handleAfkStagePost(makeMessage({ content: '[12] [P12]' }), h);
    handleAfkStageDelete({ id: 'm1', partial: true }, h);
    assert.strictEqual(stages.getKnownLabels(h).length, 0);
});
