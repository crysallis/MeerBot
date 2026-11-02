const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReport, reportLines, historyLines, chunkLines } = require('./warningReport');

const NOW = new Date('2026-11-02T12:00:00.000Z');

function row(over) {
    return {
        id: 1, member_id: 1, name: 'Alpha', reason: 'Reason', created_by: '111',
        created_at: '2026-10-20T00:00:00.000Z', expires_at: '2027-01-20T00:00:00.000Z', ended_at: null, ended_by: null,
        ...over,
    };
}

test('buildReport ranks by active count, then most recent warning, then name', () => {
    const rows = [
        row({ id: 1, member_id: 1, name: 'Alpha' }),
        row({ id: 2, member_id: 2, name: 'Beta', created_at: '2026-10-25T00:00:00.000Z' }),
        row({ id: 3, member_id: 2, name: 'Beta', created_at: '2026-10-26T00:00:00.000Z' }),
        row({ id: 4, member_id: 3, name: 'Carol', created_at: '2026-10-28T00:00:00.000Z' }),
    ];
    const out = buildReport(rows, { includeExpired: false }, NOW);
    assert.deepEqual(out.map(e => [e.name, e.active, e.total]), [['Beta', 2, 2], ['Carol', 1, 1], ['Alpha', 1, 1]]);
    assert.deepEqual(out[0].latest, { createdAt: '2026-10-26T00:00:00.000Z', reason: 'Reason', status: 'active' });
});

test('buildReport drops members with only lapsed warnings, and keeps them with includeExpired', () => {
    const rows = [
        row({ id: 1, member_id: 1, name: 'Alpha' }),
        row({ id: 2, member_id: 2, name: 'Beta', expires_at: '2026-09-01T00:00:00.000Z' }),
        row({ id: 3, member_id: 3, name: 'Carol', ended_at: '2026-10-21T00:00:00.000Z', ended_by: '222' }),
    ];
    assert.deepEqual(buildReport(rows, { includeExpired: false }, NOW).map(e => e.name), ['Alpha']);
    const all = buildReport(rows, { includeExpired: true }, NOW);
    assert.deepEqual(all.map(e => [e.name, e.active, e.total]), [['Alpha', 1, 1], ['Beta', 0, 1], ['Carol', 0, 1]]);
});

test('buildReport on no rows gives no entries', () => {
    assert.deepEqual(buildReport([], { includeExpired: true }, NOW), []);
});

test('reportLines truncates a long reason and shows the latest date', () => {
    const entries = buildReport([row({ reason: 'x'.repeat(200) })], { includeExpired: false }, NOW);
    const [line] = reportLines(entries, { includeExpired: false });
    assert.ok(line.startsWith('**Alpha** · 1 active · latest 2026-10-20 · '));
    assert.ok(line.endsWith('...'));
    assert.ok(line.length < 140);
});

test('reportLines shows totals when expired warnings are included', () => {
    const entries = buildReport([row({ expires_at: '2026-09-01T00:00:00.000Z' })], { includeExpired: true }, NOW);
    const [line] = reportLines(entries, { includeExpired: true });
    assert.ok(line.includes('0 active (1 total)'), line);
});

test('historyLines marks expired and ended early distinctly and shows edit lines', () => {
    const warnings = [
        { ...row({ id: 5, reason: 'Live' }), status: 'active', edits: [{ at: '2026-10-22T00:00:00.000Z', actor: '333', detail: JSON.stringify({ reason: { from: 'Old', to: 'Live' } }) }] },
        { ...row({ id: 4, reason: 'Lapsed', expires_at: '2026-09-01T00:00:00.000Z' }), status: 'expired', edits: [] },
        { ...row({ id: 3, reason: 'Stopped', ended_at: '2026-10-21T00:00:00.000Z', ended_by: '222' }), status: 'ended', edits: [] },
    ];
    const [live, lapsed, stopped] = historyLines(warnings);
    assert.ok(live.includes('#5') && live.includes('active') && live.includes('Live'));
    assert.ok(live.includes('<@333>') && live.includes('Old'));
    assert.ok(lapsed.includes('expired'));
    assert.ok(stopped.includes('ended early') && stopped.includes('<@222>') && stopped.includes('2026-10-21'));
});

test('historyLines reads bot-created warnings as MeerBot', () => {
    const [block] = historyLines([{ ...row({ created_by: 'bot' }), status: 'active', edits: [] }]);
    assert.ok(block.includes('MeerBot'));
    assert.ok(!block.includes('<@bot>'));
});

test('chunkLines keeps every chunk under max and never splits a line', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i} ${'y'.repeat(100)}`);
    const chunks = chunkLines(lines, 1000);
    assert.ok(chunks.length > 1);
    for (const c of chunks) assert.ok(c.length <= 1000);
    assert.equal(chunks.join('\n').split('\n').length, 50);
});

test('chunkLines hard-cuts one oversize line', () => {
    const [chunk] = chunkLines(['z'.repeat(5000)], 1000);
    assert.equal(chunk.length, 1000);
    assert.ok(chunk.endsWith('...'));
});

test('chunkLines on nothing gives no chunks, and honors a custom separator', () => {
    assert.deepEqual(chunkLines([]), []);
    assert.deepEqual(chunkLines(['a', 'b'], 3800, '\n\n'), ['a\n\nb']);
});
