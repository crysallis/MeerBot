require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('every slash command file exports a valid {data, execute} shape', () => {
  const slashPath = path.join(__dirname, 'slash-commands');
  const files = fs.readdirSync(slashPath).filter(f => f.endsWith('.js'));
  assert.ok(files.length > 0, 'expected at least one slash command file');

  for (const file of files) {
    const cmd = require(path.join(slashPath, file));
    assert.ok(cmd?.data, `${file}: missing "data" export`);
    assert.equal(typeof cmd.data.name, 'string', `${file}: data.name must be a string`);
    assert.equal(typeof cmd.execute, 'function', `${file}: missing "execute" function export`);
  }
});

test('admin/server.js loads without throwing', () => {
  assert.doesNotThrow(() => require('./admin/server.js'));
});

test('stats/server.js loads without throwing', () => {
  assert.doesNotThrow(() => require('./stats/server.js'));
});

// Force process exit after brief delay to let test framework finish reporting.
// The servers' listen() calls are now guarded by require.main === module and won't
// execute when required from tests, so no ports are bound. However, other persistent
// resources (database connections, session stores, internal timers) may remain open.
// This ensures the process exits cleanly after all tests complete rather than hanging.
setTimeout(() => {
  process.exit(process.exitCode || 0);
}, 500);
