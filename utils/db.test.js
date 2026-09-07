require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('./db');

test('auto_delete_rules table exists with expected columns', () => {
    const cols = db.prepare("PRAGMA table_info(auto_delete_rules)").all().map(c => c.name);
    assert.deepEqual(cols.sort(), ['command', 'created_at', 'enabled', 'id', 'reaction_rule_id', 'scope', 'subcommand'].sort());
});

test('AUTO_DELETE_SECONDS config default is 30', () => {
    const botConfig = require('./botConfig');
    assert.equal(botConfig.get('AUTO_DELETE_SECONDS'), '30');
});

test('pearl_bazaar_prices table exists with expected columns', () => {
    const cols = db.prepare("PRAGMA table_info(pearl_bazaar_prices)").all().map(c => c.name);
    assert.deepEqual(cols.sort(), ['id', 'rank', 'ingame_id', 'price', 'selling_cap_remaining', 'scanned_at'].sort());
});
