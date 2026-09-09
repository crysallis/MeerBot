require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildChannelGuideText, getChannelGuideText } = require('./askChannelGuide');

test('buildChannelGuideText includes a channel whose topic starts with the marker', () => {
    const text = buildChannelGuideText([
        { id: '111', topic: '[meerbot] Clash of Glory battle timing, crystal clash, hunting grounds' },
    ]);
    assert.equal(text, '<#111> — Clash of Glory battle timing, crystal clash, hunting grounds');
});

test('buildChannelGuideText excludes a channel with no topic', () => {
    const text = buildChannelGuideText([{ id: '111', topic: null }]);
    assert.equal(text, '');
});

test('buildChannelGuideText excludes a channel with an unmarked topic', () => {
    const text = buildChannelGuideText([{ id: '111', topic: 'just a normal description' }]);
    assert.equal(text, '');
});

test('buildChannelGuideText excludes a channel with only the marker and no description', () => {
    const text = buildChannelGuideText([{ id: '111', topic: '[meerbot]' }, { id: '222', topic: '[meerbot]   ' }]);
    assert.equal(text, '');
});

test('buildChannelGuideText joins multiple marked channels on separate lines', () => {
    const text = buildChannelGuideText([
        { id: '111', topic: '[meerbot] Clash of Glory stuff' },
        { id: '222', topic: 'unrelated topic' },
        { id: '333', topic: '[meerbot] Recruitment chat' },
    ]);
    assert.equal(text, '<#111> — Clash of Glory stuff\n<#333> — Recruitment chat');
});

test('buildChannelGuideText matches the marker case-insensitively', () => {
    const text = buildChannelGuideText([{ id: '111', topic: '[MeerBot] Clash of Glory stuff' }]);
    assert.equal(text, '<#111> — Clash of Glory stuff');
});

test('buildChannelGuideText tolerates leading/trailing whitespace around the topic', () => {
    const text = buildChannelGuideText([{ id: '111', topic: '  [meerbot] Clash of Glory stuff  ' }]);
    assert.equal(text, '<#111> — Clash of Glory stuff');
});

test('getChannelGuideText does not cache an empty result', () => {
    const emptyGuild = { channels: { cache: new Map([['1', { id: '1', topic: null }]]) } };
    const first = getChannelGuideText(emptyGuild);
    assert.equal(first, '');

    const markedGuild = { channels: { cache: new Map([['2', { id: '2', topic: '[meerbot] Recruitment chat' }]]) } };
    const second = getChannelGuideText(markedGuild);
    assert.equal(second, '<#2> — Recruitment chat');
});
