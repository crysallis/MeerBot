// Load environment variables first, before any modules are imported. The first test below
// requires slash-commands/*.js, which transitively requires utils/db.js · that module
// reads process.env.GUILD_DB_PATH at module-load time (not inside a function), so dotenv
// must run before that require chain fires or the DB connection fails.
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Intercept setInterval to unref its timers. The session store (better-sqlite3-session-store)
// sets up an interval for clearing expired sessions that never gets unref'd, keeping the
// process alive indefinitely. We unref all intervals globally to allow process exit after
// tests complete. This is safe because the test runs synchronously and completes before
// any intervals need to fire.
const origSetInterval = global.setInterval;
global.setInterval = function(...args) {
  const timer = origSetInterval.apply(this, args);
  if (timer.unref) timer.unref();
  return timer;
};

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

// Exit cleanly after tests complete. The beforeExit hook allows beforeExit to fire
// now that intervals have been unref'd (won't block process exit).
process.on('beforeExit', () => {
  process.exit(process.exitCode || 0);
});
