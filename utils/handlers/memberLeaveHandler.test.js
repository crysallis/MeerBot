require('dotenv').config();
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { handleMemberLeave, buildLeaveEmbed, findMemberByDiscordId } = require('./memberLeaveHandler');

let h;

beforeEach(() => {
    h = new Database(':memory:');
    h.exec(`
        CREATE TABLE warbands (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE members (
            id INTEGER PRIMARY KEY, ingame_name TEXT, discord_id TEXT, first_seen TEXT,
            warband_id INTEGER, ingame_id INTEGER
        );
        INSERT INTO warbands VALUES (1, 'Kingdom');
        INSERT INTO members VALUES (1, 'Caernafon', '111', '2026-01-05T10:00:00Z', 1, 424242);
        INSERT INTO members VALUES (2, 'NoDiscord', NULL, '2026-01-05T10:00:00Z', 1, NULL);
    `);
});

function fakeMember({ id = '111', partial = false, roles = [] } = {}) {
    return {
        id,
        partial,
        guild: { id: 'G' },
        joinedTimestamp: Date.UTC(2026, 0, 1),
        user: {
            id,
            username: 'caer',
            globalName: 'Caer',
            displayAvatarURL: () => 'https://example.com/a.png',
        },
        roles: {
            cache: new Map([
                ['G', { id: 'G', name: '@everyone', position: 0 }],
                ...roles.map(r => [r.id, r]),
            ]),
        },
    };
}

function fakeClient(sent) {
    const channel = { isTextBased: () => true, send: async p => { sent.push(p); } };
    return { channels: { cache: new Map([['C1', channel]]) } };
}

const embedFields = e => Object.fromEntries(e.toJSON().fields.map(f => [f.name, f.value]));

test('findMemberByDiscordId resolves a linked member with warband name', () => {
    const row = findMemberByDiscordId(h, '111');
    assert.equal(row.ingame_name, 'Caernafon');
    assert.equal(row.warband_name, 'Kingdom');
    assert.equal(findMemberByDiscordId(h, '999'), null);
});

test('embed carries discord name, in-game name, game id, warband and roles ordered by position', () => {
    const row = findMemberByDiscordId(h, '111');
    const member = fakeMember({
        roles: [
            { id: 'r1', name: 'Kingdom', position: 3 },
            { id: 'r2', name: 'Senior', position: 5 },
        ],
    });
    const f = embedFields(buildLeaveEmbed(row, member));
    assert.match(f['Discord'], /Caer \(caer\)/);
    assert.match(f['Discord'], /111/);
    assert.equal(f['In-game name'], 'Caernafon');
    assert.equal(f['Game ID'], '424242');
    assert.equal(f['Warband'], 'Kingdom');
    assert.equal(f['Roles when they left'], 'Senior, Kingdom');
});

test('partial member shows roles as unknown rather than None', () => {
    const row = findMemberByDiscordId(h, '111');
    const f = embedFields(buildLeaveEmbed(row, fakeMember({ partial: true })));
    assert.match(f['Roles when they left'], /^Unknown/);
});

test('missing game id renders a placeholder', () => {
    h.prepare('UPDATE members SET ingame_id = NULL WHERE id = 1').run();
    const f = embedFields(buildLeaveEmbed(findMemberByDiscordId(h, '111'), fakeMember()));
    assert.equal(f['Game ID'], '·');
});

test('linked member posts one embed to the configured channel', async () => {
    const sent = [];
    await handleMemberLeave(fakeMember(), fakeClient(sent), { h, channelId: 'C1' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].embeds.length, 1);
});

test('unknown member posts nothing', async () => {
    const sent = [];
    await handleMemberLeave(fakeMember({ id: '999' }), fakeClient(sent), { h, channelId: 'C1' });
    assert.equal(sent.length, 0);
});

test('no configured channel posts nothing and does not throw', async () => {
    const sent = [];
    await handleMemberLeave(fakeMember(), fakeClient(sent), { h, channelId: '' });
    assert.equal(sent.length, 0);
});

test('a send failure is swallowed', async () => {
    const client = { channels: { cache: new Map([['C1', { isTextBased: () => true, send: async () => { throw new Error('boom'); } }]]) } };
    await assert.doesNotReject(handleMemberLeave(fakeMember(), client, { h, channelId: 'C1' }));
});
