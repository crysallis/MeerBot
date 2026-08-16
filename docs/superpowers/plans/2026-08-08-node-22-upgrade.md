# Node 21 → 22 LTS Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the bot off Node 21.7.1 (EOL since June 2024, no security patches) onto Node 22 LTS, with a minimal automated safety net in place first so a broken import or native-module mismatch is caught before the bot is ever restarted for real.

**Architecture:** Two phases on one branch. Phase 1 adds two new `node --test` files — a command/entry-point load-smoke-test and a `jobScheduler.js` date-math test — alongside the existing `utils/jobTemplate.test.js` (18 tests, already passing). Phase 2 does the actual runtime swap: install Node 22 via nvm-windows, reinstall `node_modules` (recompiles/re-fetches the `better-sqlite3` native binary for the new Node ABI), run the full test suite, then a short manual smoke pass (bot + admin panel + stats site under PM2).

**Tech Stack:** Node.js (`node --test`, zero new test dependencies), nvm-windows, PM2, better-sqlite3 (native addon via `prebuild-install`).

## Global Constraints

- discord.js v15 is explicitly OUT OF SCOPE for this plan — it has no stable release yet (only unpublished dev/PR builds exist on npm as of 2026-08-08). Do not attempt any v15-related change here.
- Do a full dependency compatibility audit BEFORE writing tests (already done — see Evidence below); do not re-derive it.
- This repo's test convention is `node --test` (already wired as `npm test` in `package.json`), not a third-party framework. Follow the existing style in `utils/jobTemplate.test.js`: `require('node:test')`, `require('node:assert/strict')`, one `test()` block per case, plain `assert.equal`/`assert.deepEqual`.
- New test files sit next to the module they test (`utils/jobTemplate.test.js` next to `utils/jobTemplate.js`) — follow that placement convention, not a separate `tests/` directory.
- Work on a branch, not directly on `main` — this is explicitly requested by the user, unlike the smaller same-day fixes done earlier this session.
- The base branch is `main` (confirmed clean, no other in-progress work on it as of this plan).

**Dependency compatibility audit (completed 2026-08-08, before this plan was written):**
- Root project: 169 unique packages in the full tree. Zero declare an `engines.node` range that excludes Node 22. 112 explicitly declare Node 22 support (including `discord.js@14.26.4`/`14.27.0` and `@discordjs/rest@2.6.1`: both `>=18`; `@discordjs/ws`: `>=20`). 56 have no `engines.node` constraint at all (unconstrained, not a blocker).
- `admin/` subproject: 33 packages, same method — 0 flagged, 18 explicitly OK (including `vite@6.4.3`: `^18.0.0 || ^20.0.0 || >=22.0.0`), 15 unconstrained.
- `stats/` subproject: 35 packages, same method — 0 flagged, 18 explicitly OK, 17 unconstrained.
- `better-sqlite3@12.10.0` (the one native/compiled dependency in the whole tree): `engines.node` is `20.x || 22.x || 23.x || 24.x || 25.x || 26.x`. Directly confirmed its GitHub release (`v12.10.0`) ships a prebuilt Windows x64 binary for Node's ABI v127 (`better-sqlite3-v12.10.0-node-v127-win32-x64.tar.gz`) — ABI v127 is Node 22's ABI, so `npm install` on Node 22 will download a working prebuilt binary via `prebuild-install`, not fall back to a from-source `node-gyp` compile.
- PM2 (global, `pm2 --version` reports `7.0.1`): declares `engines.node: >=18.0.0`.
- Conclusion: no dependency in this stack is a blocker for Node 22. The upgrade risk is operational (native module re-link, PM2 daemon restart, `.env`/relative-path assumptions), not a compatibility gap.

---

### Task 1: Command + entry-point load smoke test

**Files:**
- Create: `index.smoke.test.js` (repo root, next to `index.js` — matches the "test file next to what it tests" convention)

**Interfaces:**
- Consumes: every file in `slash-commands/*.js` (each must export `{ data, execute }` per the existing loader contract in `index.js:44`), `admin/server.js`, `stats/server.js`
- Produces: nothing consumed by other tasks — this is a standalone verification file

- [ ] **Step 1: Write the smoke test**

This mirrors `index.js`'s existing loader loop (lines 40-51) but as an assertion instead of a `console.log`, and additionally requires the two other entry points. Requiring every command file (which transitively `require('../utils/db')`) opens a real connection to the shared `guild.db` at the default relative path — this is expected and matches how the bot itself behaves on every normal startup; it does not write anything, just opens the file and runs a schema-presence check.

```javascript
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
```

- [ ] **Step 2: Run it and confirm it passes on Node 21 first**

This establishes the pre-upgrade baseline — the whole point of this test is to catch a *regression* after the Node swap, so it must be green before that swap happens.

Run: `node --test index.smoke.test.js`
Expected: all 3 tests pass (one per slash-command file assertion loop, plus the two server.js loads), 0 failures.

If `admin/server.js` or `stats/server.js` throw on require because they call `app.listen()` at import time rather than behind a function/conditional, this step will reveal that immediately — check for a `require.main === module` guard or equivalent before treating it as this test's bug. If either file does start listening as a side effect of `require()`, stop and report back rather than working around it silently — that's a pre-existing structural fact about the file, not something to paper over in the test.

- [ ] **Step 3: Commit**

```bash
git add index.smoke.test.js
git commit -m "test: add command + entry-point load smoke test

Requires every slash-commands/*.js file and asserts the {data, execute}
shape the loader in index.js already expects, plus confirms admin/
server.js and stats/server.js load without throwing. Primary purpose:
catch an import-time break (native module mismatch, syntax error) from
the upcoming Node 22 upgrade immediately, via 'node --test', before
ever restarting the running bot process."
```

---

### Task 2: `jobScheduler.js` date-math tests

**Files:**
- Create: `utils/jobScheduler.test.js`
- Modify: `utils/jobScheduler.js` (export `nextFire`, `nextDailyAt`, `nextWeeklyAt` alongside the existing `computeMonthlyNext`/`initJobScheduler` exports — currently only those two are exported per `utils/jobScheduler.js:264`)

**Interfaces:**
- Consumes: `nextFire(job)`, `computeMonthlyNext(fireAtIso, count, dayOfMonth, nowMs)`, `nextDailyAt(hh, mm)`, `nextWeeklyAt(dayOfWeek, hh, mm)` — all pure functions already implemented in `utils/jobScheduler.js:17-77`, no signature changes
- Produces: nothing consumed by other tasks

- [ ] **Step 1: Export the three currently-unexported functions**

In `utils/jobScheduler.js`, modify the existing export line (currently line 264):

```javascript
module.exports = { initJobScheduler, computeMonthlyNext, nextFire, nextDailyAt, nextWeeklyAt };
```

- [ ] **Step 2: Write the failing tests**

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const { nextFire, computeMonthlyNext, nextDailyAt, nextWeeklyAt } = require('./jobScheduler');

test('nextFire: daily:1 advances by exactly one day', () => {
  const job = { fire_at: '2026-08-01T12:00:00.000Z', recurrence: 'daily:1' };
  const result = nextFire(job);
  assert.equal(result, '2026-08-02T12:00:00.000Z');
});

test('nextFire: weekly:2 advances by 14 days', () => {
  const job = { fire_at: '2026-08-01T09:00:00.000Z', recurrence: 'weekly:2' };
  const result = nextFire(job);
  assert.equal(result, '2026-08-15T09:00:00.000Z');
});

test('nextFire: fast-forwards past multiple missed intervals', () => {
  // fire_at is 10 days in the past relative to "now" at test-run time --
  // daily:1 must skip forward to the next occurrence strictly after now,
  // not just add one day to the stale fire_at.
  const staleFireAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const job = { fire_at: staleFireAt, recurrence: 'daily:1' };
  const result = new Date(nextFire(job));
  assert.ok(result.getTime() > Date.now(), 'next fire time must be in the future');
  assert.ok(result.getTime() - Date.now() < 24 * 60 * 60 * 1000, 'next fire time must be within one day from now');
});

test('nextFire: defaults to daily:1 when recurrence is missing', () => {
  const job = { fire_at: '2026-08-01T12:00:00.000Z' };
  const result = nextFire(job);
  assert.equal(result, '2026-08-02T12:00:00.000Z');
});

test('computeMonthlyNext: advances by one month, same day', () => {
  const result = computeMonthlyNext('2026-01-15T10:00:00.000Z', 1, 15, Date.parse('2026-01-16T00:00:00.000Z'));
  assert.equal(result, '2026-02-15T10:00:00.000Z');
});

test('computeMonthlyNext: clamps day 31 into a 28-day February without ratcheting down permanently', () => {
  // Jan 31 -> Feb (clamped to 28) -> Mar must return to day 31, not stay
  // clamped at 28 -- day_of_month (31) is always re-read as the source of
  // truth, never the previous fire_at's clamped day.
  const janToFeb = computeMonthlyNext('2026-01-31T10:00:00.000Z', 1, 31, Date.parse('2026-02-01T00:00:00.000Z'));
  assert.equal(janToFeb, '2026-02-28T10:00:00.000Z');

  const febToMar = computeMonthlyNext(janToFeb, 1, 31, Date.parse('2026-03-01T00:00:00.000Z'));
  assert.equal(febToMar, '2026-03-31T10:00:00.000Z');
});

test('computeMonthlyNext: MONTHLY_LAST_DAY (-1) always resolves to the actual last day of the target month', () => {
  const result = computeMonthlyNext('2026-01-31T10:00:00.000Z', 1, -1, Date.parse('2026-02-01T00:00:00.000Z'));
  assert.equal(result, '2026-02-28T10:00:00.000Z');
});

test('nextDailyAt: returns tomorrow if the target time today has already passed', () => {
  const now = new Date();
  const pastHour = (now.getUTCHours() - 1 + 24) % 24;
  const result = new Date(nextDailyAt(pastHour, 0));
  assert.ok(result.getTime() > now.getTime(), 'must be in the future');
});

test('nextWeeklyAt: returns a date on the requested day of week', () => {
  const result = new Date(nextWeeklyAt(3, 9, 0)); // Wednesday
  assert.equal(result.getUTCDay(), 3);
});
```

- [ ] **Step 3: Run and verify all tests pass**

Run: `node --test utils/jobScheduler.test.js`
Expected: 9 tests pass, 0 failures. If any date-math assertion fails, that's either a real pre-existing bug (report it, do not silently "fix" `jobScheduler.js`'s logic as a side effect of this task — that's out of scope for a safety-net task) or a mistake in the test's expected value — recheck the arithmetic by hand before assuming which.

- [ ] **Step 4: Run the full test suite to confirm nothing else broke from the new export line**

Run: `npm test`
Expected: all tests across `utils/jobTemplate.test.js`, `index.smoke.test.js` (Task 1), and this new file pass — total should be 18 (existing) + 3 (Task 1) + 9 (this task) = 30 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add utils/jobScheduler.js utils/jobScheduler.test.js
git commit -m "test: add jobScheduler date-math tests, export nextFire/nextDailyAt/nextWeeklyAt

Covers daily/weekly/monthly recurrence advancement, the missed-interval
fast-forward behavior, and the month-clamping edge case documented in
jobScheduler.js's own comments (Jan 31 -> Feb 28 -> Mar 31, not
permanently ratcheted down to 28). Exports the three previously-internal
functions so they're testable; no behavior change."
```

---

### Task 3: Node 22 LTS install + verification

**Files:**
- None modified in this repo — this task is an environment change (Node version) plus a `node_modules` reinstall. No source files change.

**Interfaces:**
- Consumes: Task 1 and Task 2's test files as the pass/fail gate
- Produces: nothing consumed by later tasks — this is the terminal task of the plan

- [ ] **Step 1: Confirm the pre-upgrade baseline is green on Node 21**

Run: `node --version` — expect `v21.7.1` (still on the old runtime at this point).
Run: `npm test` — expect all 30 tests passing (18 existing + 3 from Task 1 + 9 from Task 2). Do not proceed to Step 2 unless this is fully green — a failure here means Task 1 or 2 has a bug, not that Node 22 broke something, since Node hasn't been touched yet.

- [ ] **Step 2: Install Node 22 LTS via nvm-windows**

If nvm-windows isn't already installed, download and install it from the official releases (coreybutler/nvm-windows), then:

```
nvm install 22
nvm use 22
node --version
```

Expected: reports a `v22.x.x` version. Keep `v21.7.1` installed (nvm-windows keeps prior versions available) so `nvm use 21.7.1` is an instant rollback if anything in this task fails.

- [ ] **Step 3: Reinstall dependencies for the new Node ABI**

better-sqlite3 is a compiled native addon — its binary is tied to the specific Node ABI it was built/fetched against, so a straight `node_modules` carryover from Node 21 will not work under Node 22.

```
cd C:\vscode\DiscordBotAfkJ
rmdir /s /q node_modules
npm install
cd admin
rmdir /s /q node_modules
npm install
cd ..\stats
rmdir /s /q node_modules
npm install
cd ..
```

Expected: all three `npm install` runs complete without error. Watch the root install specifically for `better-sqlite3`'s install script output — it should report a successful prebuild download (not a `node-gyp rebuild` fallback compile, which would indicate no matching prebuilt binary was found for this Node/platform combo and something is off from what the audit predicted).

- [ ] **Step 4: Run the full test suite on Node 22**

Run: `node --test` (or `npm test`)
Expected: all 30 tests pass, identical to the Node 21 baseline in Step 1. This is the primary automated signal that the upgrade didn't silently break anything import-time or in the tested date-math/scheduling logic.

If any test fails here that passed on Node 21: stop, do not proceed to Step 5. Roll back with `nvm use 21.7.1`, reinstall `node_modules` on Node 21 (repeat Step 3's install commands), confirm the suite is green again, then investigate the specific failure before retrying the Node 22 install.

- [ ] **Step 5: Rebuild the admin and stats Vite bundles on Node 22**

```
npm run build --prefix admin
npm run build --prefix stats
```

Expected: both builds complete successfully with output sizes comparable to prior builds (no drastic size change, which would suggest something resolved differently under the new Node/npm).

- [ ] **Step 6: Manual smoke test — start everything under PM2 on Node 22**

PM2's own daemon process was running under Node 21; it needs to be killed and restarted so the new processes it spawns inherit Node 22.

```
pm2 kill
pm2 start ecosystem.config.js
pm2 save
pm2 logs --lines 30 --nostream
```

Expected: all three processes (`meerbot`, `meerbot-admin`, `meerbot-stats`) show as online in `pm2 status`, and the log tail shows clean startup (bot logs in as its Discord user, admin/stats servers report listening) with no uncaught exceptions.

Then, manually in Discord: run `/ping` and one read-only command that touches the DB (e.g. `/member` on yourself, or `/guild unlinked`), and open the admin panel in a browser to confirm it loads and the Server Structure tab (or any other tab) renders. This step is manual/observational — there is no scripted assertion for it, report back what you see rather than assuming success.

- [ ] **Step 7: Commit — nothing to commit for the version swap itself, but confirm working tree is clean**

There are no source file changes from this task (only `node_modules`, which is gitignored, and the environment's active Node version, which isn't tracked in the repo). Run `git status` and confirm no unexpected changes crept in (e.g. a lockfile shift from `npm install` resolving something slightly differently under Node 22's bundled npm — if that happens, review the lockfile diff before deciding whether to commit it, since a resolution difference here would be a legitimate finding worth capturing, not something to discard).

```bash
git status
git diff package-lock.json admin/package-lock.json stats/package-lock.json
```

If the lockfiles differ from what's already committed and the diff looks like a benign re-resolution (not a version regression), commit them:

```bash
git add package-lock.json admin/package-lock.json stats/package-lock.json
git commit -m "chore: regenerate lockfiles under Node 22's bundled npm

No dependency version changes intended -- npm re-resolved the tree
under a newer npm version as part of the Node 22 upgrade. Verified
full test suite (30 tests) and manual PM2 smoke test both pass."
```

If the lockfiles are unchanged, no commit is needed for this step.

---

## Explicitly Out of Scope

- **discord.js v14 → v15**: not released as a stable version as of this plan's writing (2026-08-08) — only unpublished dev/PR builds exist. No task in this plan touches it. When v15 does ship, it should get its own separate plan, informed by discord.js's official migration guide at that time — do not assume anything about its scope from this plan.
- **discord.js 14.26.4 → 14.27.0 patch bump**: this is a same-day, no-branch-needed `npm update discord.js` (confirmed in-range under the existing `^14.25.1` in `package.json`), unrelated to the Node runtime change. Do it separately if desired, not as part of this plan.
- **Full behavioral test coverage** (db.js helpers, permission checks, fake-Discord-interaction harness per command): explicitly deferred per the user's "minimal safety net" scope decision — this plan's tests exist only to catch a Node-upgrade regression, not to build out general test coverage. A fuller test suite remains a separate, later effort if wanted.
- **express 4 → 5** and any other major-version dependency bumps surfaced by `npm run check-updates`: unrelated to the Node runtime and out of scope here — those are independent, potentially-breaking decisions that deserve their own review, not bundled into a runtime upgrade.
