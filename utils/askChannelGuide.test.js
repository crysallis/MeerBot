require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildChannelGuideText, getChannelGuideText } = require('./askChannelGuide');

test('buildChannelGuideText includes a channel whose topic starts with the marker', () => {
    const text = buildChannelGuideText([
        { id: '111', topic: '[meerbot] Clash of Glory battle timing, crystal clash, hunting grounds' },
    ]);
    assert.equal(text, '<#111> — [meerbot] Clash of Glory battle timing, crystal clash, hunting grounds');
});

test('buildChannelGuideText includes a channel whose marker comes after a human description on its own line', () => {
    // Matches the real shape leadership naturally writes: a readable
    // description first, then a [meerbot] keyword line appended after.
    const topic = 'Compete in live, fair-play, 3v3 battles, watch live and bet on/guess the winners.\n[meerbot] 3v3, live battles, savannah cup, spectate, gamble, fortune,';
    const text = buildChannelGuideText([{ id: '111', topic }]);
    assert.equal(text, `<#111> — ${topic}`);
});

test('buildChannelGuideText excludes a channel with no topic', () => {
    const text = buildChannelGuideText([{ id: '111', topic: null }]);
    assert.equal(text, '');
});

test('buildChannelGuideText excludes a channel with an unmarked topic', () => {
    const text = buildChannelGuideText([{ id: '111', topic: 'just a normal description' }]);
    assert.equal(text, '');
});

test('buildChannelGuideText joins multiple marked channels on separate lines', () => {
    const text = buildChannelGuideText([
        { id: '111', topic: '[meerbot] Clash of Glory stuff' },
        { id: '222', topic: 'unrelated topic' },
        { id: '333', topic: '[meerbot] Recruitment chat' },
    ]);
    assert.equal(text, '<#111> — [meerbot] Clash of Glory stuff\n<#333> — [meerbot] Recruitment chat');
});

test('buildChannelGuideText matches the marker case-insensitively', () => {
    const text = buildChannelGuideText([{ id: '111', topic: '[MeerBot] Clash of Glory stuff' }]);
    assert.equal(text, '<#111> — [MeerBot] Clash of Glory stuff');
});

test('buildChannelGuideText tolerates leading/trailing whitespace around the topic', () => {
    const text = buildChannelGuideText([{ id: '111', topic: '  [meerbot] Clash of Glory stuff  ' }]);
    assert.equal(text, '<#111> — [meerbot] Clash of Glory stuff');
});

test('getChannelGuideText does not cache an empty result', () => {
    const emptyGuild = { channels: { cache: new Map([['1', { id: '1', topic: null }]]) } };
    const first = getChannelGuideText(emptyGuild);
    assert.equal(first, '');

    const markedGuild = { channels: { cache: new Map([['2', { id: '2', topic: '[meerbot] Recruitment chat' }]]) } };
    const second = getChannelGuideText(markedGuild);
    assert.equal(second, '<#2> — [meerbot] Recruitment chat');
});
