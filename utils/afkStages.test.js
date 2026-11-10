const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const stages = require('./afkStages');

function makeDb() {
    const h = new Database(':memory:');
    stages.ensureAfkStageSchema(h);
    return h;
}

function post(overrides = {}) {
    return {
        message_id: 'm1',
        message_url: 'https://discord.com/channels/g/c/m1',
        posted_by: 'u1',
        posted_at: '2026-11-10T12:00:00.000Z',
        ...overrides,
    };
}

test('extractLabels finds a bracketed label at the start of a post', () => {
    assert.deepStrictEqual(stages.extractLabels('[127]\nUse the green team'), ['127']);
});

test('extractLabels finds a label anywhere in the post', () => {
    assert.deepStrictEqual(stages.extractLabels('Clear guide for [P127] with screenshots'), ['P127']);
});

test('extractLabels reads all four label shapes, case-insensitively', () => {
    assert.deepStrictEqual(
        stages.extractLabels('[127] [p127] [Pa127] [a127]'),
        ['127', 'P127', 'PA127', 'A127']
    );
});

test('extractLabels returns each label once, in order of first appearance', () => {
    assert.deepStrictEqual(stages.extractLabels('[P12] then [12] then [p12]'), ['P12', '12']);
});

test('extractLabels strips leading zeros so [007] and [7] are the same stage', () => {
    assert.deepStrictEqual(stages.extractLabels('[007] [P007]'), ['7', 'P7']);
});

test('extractLabels ignores brackets that are not stage labels', () => {
    assert.deepStrictEqual(stages.extractLabels('[Title] [note] [X12] [12a] [] [PAA12] [P]'), []);
    assert.deepStrictEqual(stages.extractLabels('stage 127 without brackets'), []);
    assert.deepStrictEqual(stages.extractLabels(''), []);
    assert.deepStrictEqual(stages.extractLabels(null), []);
});

test('normalizeStageInput accepts bare, bracketed, spaced and lowercase input', () => {
    assert.strictEqual(stages.normalizeStageInput('127'), '127');
    assert.strictEqual(stages.normalizeStageInput('p127'), 'P127');
    assert.strictEqual(stages.normalizeStageInput('[PA127]'), 'PA127');
    assert.strictEqual(stages.normalizeStageInput('  a 127 '), 'A127');
    assert.strictEqual(stages.normalizeStageInput('0127'), '127');
});

test('normalizeStageInput rejects anything that is not a stage label', () => {
    assert.strictEqual(stages.normalizeStageInput(''), null);
    assert.strictEqual(stages.normalizeStageInput('abc'), null);
    assert.strictEqual(stages.normalizeStageInput('12x'), null);
    assert.strictEqual(stages.normalizeStageInput('P'), null);
    assert.strictEqual(stages.normalizeStageInput(null), null);
});

test('savePost stores one row per label and getStagePosts finds it', () => {
    const h = makeDb();
    stages.savePost(h, post(), ['127', 'P127']);
    assert.strictEqual(stages.getStagePosts(h, '127').length, 1);
    assert.strictEqual(stages.getStagePosts(h, 'P127').length, 1);
    assert.strictEqual(stages.getStagePosts(h, 'A127').length, 0);
});

test('127 and P127 are different stages and do not match each other', () => {
    const h = makeDb();
    stages.savePost(h, post({ message_id: 'm1' }), ['127']);
    stages.savePost(h, post({ message_id: 'm2' }), ['P127']);
    assert.deepStrictEqual(stages.getStagePosts(h, '127').map(r => r.message_id), ['m1']);
    assert.deepStrictEqual(stages.getStagePosts(h, 'P127').map(r => r.message_id), ['m2']);
});

test('several posts can share a label and come back oldest first', () => {
    const h = makeDb();
    stages.savePost(h, post({ message_id: 'm2', posted_at: '2026-11-10T13:00:00.000Z' }), ['50']);
    stages.savePost(h, post({ message_id: 'm1', posted_at: '2026-11-10T12:00:00.000Z' }), ['50']);
    assert.deepStrictEqual(stages.getStagePosts(h, '50').map(r => r.message_id), ['m1', 'm2']);
});

test('savePost on an edited message replaces its labels', () => {
    const h = makeDb();
    stages.savePost(h, post(), ['127', 'P127']);
    stages.savePost(h, post(), ['127', 'A127']);
    assert.strictEqual(stages.getStagePosts(h, 'P127').length, 0);
    assert.strictEqual(stages.getStagePosts(h, '127').length, 1);
    assert.strictEqual(stages.getStagePosts(h, 'A127').length, 1);
});

test('savePost with no labels removes the message entirely', () => {
    const h = makeDb();
    stages.savePost(h, post(), ['127']);
    stages.savePost(h, post(), []);
    assert.strictEqual(stages.getStagePosts(h, '127').length, 0);
});

test('removePost deletes every row for that message and leaves others alone', () => {
    const h = makeDb();
    stages.savePost(h, post({ message_id: 'm1' }), ['127', 'P127']);
    stages.savePost(h, post({ message_id: 'm2' }), ['127']);
    stages.removePost(h, 'm1');
    assert.deepStrictEqual(stages.getStagePosts(h, '127').map(r => r.message_id), ['m2']);
    assert.strictEqual(stages.getStagePosts(h, 'P127').length, 0);
});

test('getKnownLabels lists each label once with its post count, numbers first then by prefix', () => {
    const h = makeDb();
    stages.savePost(h, post({ message_id: 'm1' }), ['127', 'P127']);
    stages.savePost(h, post({ message_id: 'm2' }), ['127', 'A9']);
    stages.savePost(h, post({ message_id: 'm3' }), ['PA127', '9']);
    assert.deepStrictEqual(stages.getKnownLabels(h), [
        { label: '9', posts: 1 },
        { label: 'A9', posts: 1 },
        { label: '127', posts: 2 },
        { label: 'P127', posts: 1 },
        { label: 'PA127', posts: 1 },
    ]);
});
