const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findSharedTargets } = require('./guildOnboardingDiscovery');

const view = id => ({ id, allow: ['ViewChannel'], deny: [] });
const hidden = id => ({ id, allow: [], deny: ['ViewChannel'] });
const ch = (id, name, synced, overwrites = []) => ({ id, name, synced, overwrites });
const cat = (id, name, overwrites, channels = []) => ({ id, name, overwrites, channels });

const ROLES = ['rA', 'rB'];

test('finds a category every guild role can view', () => {
    const structure = {
        categories: [
            cat('c1', 'Battle', [view('rA'), view('rB')], [ch('x1', 'one', true)]),
            cat('c2', 'OnlyA', [view('rA'), hidden('rB')]),
            cat('c3', 'OwnA', [view('rA'), view('rB')]),
        ],
        uncategorised: [],
    };
    const out = findSharedTargets(structure, ROLES, ['c3']);
    assert.deepEqual(out, [{ kind: 'category', id: 'c1', name: 'Battle' }]);
});

test('does not return synced channels of a shared category', () => {
    const structure = {
        categories: [cat('c1', 'Battle', [view('rA'), view('rB')], [ch('x1', 'one', true), ch('x2', 'two', true)])],
        uncategorised: [],
    };
    const out = findSharedTargets(structure, ROLES, []);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'category');
});

test('returns an unsynced channel that grants every guild role under a non-shared category', () => {
    const structure = {
        categories: [
            cat('c1', 'Mixed', [hidden('rA')], [
                ch('x1', 'open', false, [view('rA'), view('rB')]),
                ch('x2', 'onlyA', false, [view('rA')]),
            ]),
        ],
        uncategorised: [],
    };
    const out = findSharedTargets(structure, ROLES, []);
    assert.deepEqual(out, [{ kind: 'channel', id: 'x1', name: 'open' }]);
});

test('returns an unsynced channel inside a shared category when it grants every guild role itself', () => {
    const structure = {
        categories: [
            cat('c1', 'Battle', [view('rA'), view('rB')], [
                ch('x1', 'synced', true),
                ch('x2', 'custom', false, [view('rA'), view('rB')]),
            ]),
        ],
        uncategorised: [],
    };
    const out = findSharedTargets(structure, ROLES, []);
    assert.deepEqual(out.map(t => t.id), ['c1', 'x2']);
});

test('ignores channels in an own category', () => {
    const structure = {
        categories: [cat('c3', 'OwnA', [], [ch('x1', 'chat', false, [view('rA'), view('rB')])])],
        uncategorised: [],
    };
    assert.deepEqual(findSharedTargets(structure, ROLES, ['c3']), []);
});

test('checks uncategorised channels too', () => {
    const structure = { categories: [], uncategorised: [ch('u1', 'lobby', false, [view('rA'), view('rB')])] };
    assert.deepEqual(findSharedTargets(structure, ROLES, []), [{ kind: 'channel', id: 'u1', name: 'lobby' }]);
});

test('returns nothing when guildRoleIds is empty', () => {
    const structure = {
        categories: [cat('c1', 'Anything', [], [ch('x1', 'one', false)])],
        uncategorised: [ch('u1', 'lobby', false)],
    };
    assert.deepEqual(findSharedTargets(structure, [], []), []);
});

test('a deny-only overwrite is not access', () => {
    const structure = { categories: [cat('c1', 'Locked', [hidden('rA'), hidden('rB')])], uncategorised: [] };
    assert.deepEqual(findSharedTargets(structure, ROLES, []), []);
});
