require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const {
    extractTitle,
    handleTitlePost,
    handleTitlePostEdit,
    getTitlePosts,
    getKnownTitles,
} = require('./titlePostHandler');

const FORUM_ID = '1376292444211118111';
const OTHER_FORUM_ID = '9999999999999999999';
const TEST_THREAD_ID = 'test-thread-titlePostHandler';

// Titles are prefixed so a test assertion can never accidentally match real
// backfilled data sharing the same title_posts table (bit us once: a real
// "Stuck" title from the live easter-eggs forum collided with a test fixture
// also named "Stuck", inflating an expected-1-row assertion to 2).
const T = name => `TEST_${name}`;

function makeStubMessage({ id, content, threadId = TEST_THREAD_ID, parentId = FORUM_ID, authorId = 'user1', reactCalls }) {
    return {
        id,
        content,
        channel: { id: threadId, parentId, isThread: () => true },
        author: { id: authorId },
        url: `https://discord.com/channels/g/${threadId}/${id}`,
        createdAt: new Date('2026-09-17T12:00:00.000Z'),
        react: async (emoji) => { if (reactCalls) reactCalls.push(emoji); },
    };
}

function clearTestRows() {
    db.prepare('DELETE FROM title_posts WHERE thread_id = ?').run(TEST_THREAD_ID);
}

test.beforeEach(clearTestRows);
test.afterEach(clearTestRows);

test('extractTitle pulls the bracket at the start of a message', () => {
    assert.strictEqual(
        extractTitle('[Exemplar]\nAfter finding 3 pigeons, switch to night and go to the location on the map'),
        'Exemplar'
    );
});

test('extractTitle returns null for chatter with no leading bracket', () => {
    assert.strictEqual(extractTitle('the last pigeon'), null);
    assert.strictEqual(extractTitle('I really love discovering these and posting them.'), null);
    assert.strictEqual(extractTitle(''), null);
});

test('extractTitle ignores a bracket that is not at the start of the message', () => {
    assert.strictEqual(extractTitle('go talk to Marshell to get the [Stuck] title'), null);
});

test('handleTitlePost saves a new title post and reacts', async () => {
    const reactCalls = [];
    const msg = makeStubMessage({ id: 'm1', content: `[${T('Stuck')}]\nFind Marshell, talk to him, and get the title`, reactCalls });
    handleTitlePost(msg);
    await new Promise(r => setTimeout(r, 0));

    const rows = getTitlePosts(T('Stuck'));
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].message_id, 'm1');
    assert.strictEqual(rows[0].posted_by, 'user1');
    assert.deepStrictEqual(reactCalls, ['💾']);
});

test('handleTitlePost ignores messages outside the easter-eggs forum', () => {
    const msg = makeStubMessage({ id: 'm2', content: `[${T('Stuck')}]\nsome text`, parentId: OTHER_FORUM_ID });
    handleTitlePost(msg);
    assert.strictEqual(getTitlePosts(T('Stuck')).length, 0);
});

test('handleTitlePost ignores messages with no bracket (plain chatter)', () => {
    const msg = makeStubMessage({ id: 'm3', content: 'the last pigeon' });
    handleTitlePost(msg);
    assert.strictEqual(getTitlePosts(T('Stuck')).length, 0);
});

test('two different messages referencing the same title both get stored', () => {
    handleTitlePost(makeStubMessage({ id: 'm4', content: `[${T('Fledgling')}]\nGo talk to Aurora`, authorId: 'a' }));
    handleTitlePost(makeStubMessage({ id: 'm5', content: `[${T('Fledgling')}]\nBetter writeup with screenshots`, authorId: 'b' }));

    const rows = getTitlePosts(T('Fledgling'));
    assert.strictEqual(rows.length, 2);
    assert.deepStrictEqual(rows.map(r => r.message_id).sort(), ['m4', 'm5']);
});

test('getTitlePosts is case-insensitive', () => {
    handleTitlePost(makeStubMessage({ id: 'm6', content: `[${T('Exemplar')}]\ntext` }));
    assert.strictEqual(getTitlePosts(T('Exemplar').toLowerCase()).length, 1);
    assert.strictEqual(getTitlePosts(T('Exemplar').toUpperCase()).length, 1);
});

test('handleTitlePostEdit updates the title in place for the same message_id', () => {
    handleTitlePost(makeStubMessage({ id: 'm7', content: `[${T('Sutck')}]\ntypo'd title` }));
    assert.strictEqual(getTitlePosts(T('Sutck')).length, 1);

    handleTitlePostEdit(makeStubMessage({ id: 'm7', content: `[${T('Stuck')}]\nfixed the typo` }));
    assert.strictEqual(getTitlePosts(T('Sutck')).length, 0);
    assert.strictEqual(getTitlePosts(T('Stuck')).length, 1);
});

test('handleTitlePostEdit removes the row if the bracket is edited away', () => {
    handleTitlePost(makeStubMessage({ id: 'm8', content: `[${T('Stuck')}]\noriginal` }));
    assert.strictEqual(getTitlePosts(T('Stuck')).length, 1);

    handleTitlePostEdit(makeStubMessage({ id: 'm8', content: 'never mind, deleting the bracket' }));
    assert.strictEqual(getTitlePosts(T('Stuck')).length, 0);
});

test('getKnownTitles returns distinct titles for autocomplete', () => {
    handleTitlePost(makeStubMessage({ id: 'm9', content: `[${T('Alpha')}]\ntext`, authorId: 'a' }));
    handleTitlePost(makeStubMessage({ id: 'm10', content: `[${T('Alpha')}]\ntext2`, authorId: 'b' }));
    handleTitlePost(makeStubMessage({ id: 'm11', content: `[${T('Beta')}]\ntext`, authorId: 'c' }));

    const known = getKnownTitles().filter(t => t.startsWith('TEST_'));
    assert.deepStrictEqual(known.sort(), [T('Alpha'), T('Beta')]);
});
