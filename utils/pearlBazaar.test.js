const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPearlBazaarRows } = require('./pearlBazaar');

test('excludes rows with zero selling cap remaining', () => {
    const rows = buildPearlBazaarRows(
        [{ rank: 1, ingame_id: 100, price: 900, selling_cap_remaining: 0 }],
        new Map(),
    );
    assert.deepEqual(rows, []);
});

test('includes rows with nonzero selling cap remaining', () => {
    const rows = buildPearlBazaarRows(
        [{ rank: 20, ingame_id: 132435334, price: 965, selling_cap_remaining: 160 }],
        new Map(),
    );
    assert.deepEqual(rows, [{ rank: 20, label: '132435334', price: 965, sellingCapRemaining: 160 }]);
});

test('resolves a known ingame_id to its member name', () => {
    const rows = buildPearlBazaarRows(
        [{ rank: 5, ingame_id: 42, price: 800, selling_cap_remaining: 10 }],
        new Map([[42, 'Crysallis']]),
    );
    assert.deepEqual(rows, [{ rank: 5, label: 'Crysallis', price: 800, sellingCapRemaining: 10 }]);
});

test('falls back to raw ingame_id when not in the name map', () => {
    const rows = buildPearlBazaarRows(
        [{ rank: 7, ingame_id: 999, price: 700, selling_cap_remaining: 5 }],
        new Map([[42, 'Crysallis']]),
    );
    assert.deepEqual(rows, [{ rank: 7, label: '999', price: 700, sellingCapRemaining: 5 }]);
});

test('sorts results by rank ascending', () => {
    const rows = buildPearlBazaarRows(
        [
            { rank: 50, ingame_id: 1, price: 500, selling_cap_remaining: 1 },
            { rank: 3, ingame_id: 2, price: 999, selling_cap_remaining: 1 },
        ],
        new Map(),
    );
    assert.deepEqual(rows.map(r => r.rank), [3, 50]);
});

test('no priceFloor argument includes rows of any price', () => {
    const rows = buildPearlBazaarRows(
        [{ rank: 1, ingame_id: 1, price: 100, selling_cap_remaining: 5 }],
        new Map(),
    );
    assert.equal(rows.length, 1);
});

test('priceFloor excludes rows below it', () => {
    const rows = buildPearlBazaarRows(
        [
            { rank: 1, ingame_id: 1, price: 799, selling_cap_remaining: 5 },
            { rank: 2, ingame_id: 2, price: 800, selling_cap_remaining: 5 },
            { rank: 3, ingame_id: 3, price: 801, selling_cap_remaining: 5 },
        ],
        new Map(),
        800,
    );
    assert.deepEqual(rows.map(r => r.rank), [2, 3]);
});
