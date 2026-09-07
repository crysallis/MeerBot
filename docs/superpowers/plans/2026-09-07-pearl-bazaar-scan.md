# Pearl Bazaar Scan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a standalone, manually-triggered Pearl Bazaar scan that drills into each of the top 100 Supreme Arena-ranked players' profiles to capture that day's selling price and remaining daily cap, and posts the results (filtered to players who still have stock) to Discord via a new `/pearlbazaar` command.

**Architecture:** A new miner-side mode module (`src/modes/pearl_bazaar.py`) reuses Supreme Arena's navigation and rank-scrolling but adds a new generalized drill-in `on_stop` hook (in `src/modes/common.py`, alongside the existing `make_id_fallback_hook`) that fires for every row: tap banner → read User ID → look for the Pearl Bazaar icon → if present, tap it, OCR price + remaining cap, back once. Results land in a new bot-owned table that's wiped at the start of each run. A new bot-side slash command (`slash-commands/pearlbazaar.js`) triggers the scraper the same way `/scan` does, then reads that table, filters and resolves names via a small pure helper module (`utils/pearlBazaar.js`), and posts a table embed.

**Tech Stack:** Python (miner: OpenCV/ADB nav, OCR via existing `ocr.py`), Node.js + discord.js v14 + better-sqlite3 (bot), shared SQLite `guild.db`.

**Spec:** `docs/superpowers/specs/2026-09-07-pearl-bazaar-scan-design.md`

## Global Constraints

- Pearl Bazaar is only reachable Monday/Tuesday UTC — it rides Supreme Arena's own rankings screen, which is inactive outside that window (per `get_supreme_period()` in `src/db.py`). No new gate needed; `navigate_to_mode("supreme_arena")` already surfaces the inactive-screen case.
- No guild filtering — every row up to rank 100 is in scope (`apply_guild_filter()` is NOT called).
- No retry on a failed row (banner tap, Pearl icon tap, or OCR miss) — log and move to the next row.
- The `pearl_bazaar_prices` table is wiped (`DELETE`) at the **start** of each run, before any row is scanned — not at the end.
- Exactly one `back()` per row after the Pearl Bazaar screen (or after the profile screen, if no Pearl icon was found) — confirmed live behavior, Back returns straight to the rank list.
- "Total Daily Selling Cap" is read and stored as-is — it already means "remaining," no arithmetic.
- `/pearlbazaar` is a fully separate command from `/scan` — not a `MODE_FLAGS` entry, not `bot_config`-toggled.

---

### Task 1: Add `pearl_bazaar_prices` table (bot-owned schema)

**Files:**
- Modify: `utils/db.js` (add a new `CREATE TABLE IF NOT EXISTS` block near `scan_timings`, e.g. after line 210)
- Test: `utils/db.test.js` (append)

**Interfaces:**
- Produces: table `pearl_bazaar_prices(id, rank, ingame_id, price, selling_cap_remaining, scanned_at)` that later tasks read/write directly via `better-sqlite3` (miner writes via Python's own sqlite3 connection to the same file; bot reads via `db.prepare(...)`).

- [ ] **Step 1: Write the failing test**

Append to `utils/db.test.js`:

```javascript
test('pearl_bazaar_prices table exists with expected columns', () => {
    const cols = db.prepare("PRAGMA table_info(pearl_bazaar_prices)").all().map(c => c.name);
    assert.deepEqual(cols.sort(), ['id', 'rank', 'ingame_id', 'price', 'selling_cap_remaining', 'scanned_at'].sort());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="pearl_bazaar_prices table exists"`
Expected: FAIL (table does not exist, `table_info` returns empty array, columns `[]` doesn't match expected)

- [ ] **Step 3: Add the table**

In `utils/db.js`, add immediately after the `scan_timings` CREATE TABLE block (around line 201, right before the `bot_config` table):

```sql
  CREATE TABLE IF NOT EXISTS pearl_bazaar_prices (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    rank                   INTEGER NOT NULL,
    ingame_id              INTEGER NOT NULL,
    price                  INTEGER NOT NULL,
    selling_cap_remaining  INTEGER NOT NULL,
    scanned_at             TEXT NOT NULL
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern="pearl_bazaar_prices table exists"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add utils/db.js utils/db.test.js
git commit -m "feat: add pearl_bazaar_prices table"
```

---

### Task 2: Generalized drill-in hook in the miner (`common.py`)

**Files:**
- Modify: `C:\vscode\AFKDataMining\src\modes\common.py` (add new function after `make_id_fallback_hook`, which ends around line 651)
- Test: none (this function is ADB/OCR-dependent, no pure-logic unit test surface — matches existing convention, `make_id_fallback_hook` itself has no unit test either)

**Interfaces:**
- Consumes: `scroll_scan`'s `on_stop(stop_img, stop_frame_entries)` calling convention (from `common.py`, already defined); `device.tap(x, y)`, `device.back()`, `device.screenshot()`, `device.mark_progress()`; `ocr.ocr_image(img)`; `modes.common.read_user_id(img)`; `modes.common.block_center(box)`; `modes.common.RANK_CARD_AVATAR_X`, `modes.common.RANK_CARD_AVATAR_Y_OFFSET`.
- Produces: `make_drill_in_hook(row_callback, avatar_x=RANK_CARD_AVATAR_X, avatar_y_offset=RANK_CARD_AVATAR_Y_OFFSET) -> on_stop_fn`, where `row_callback(rank: int, user_id: int | None) -> None` is called once per row after the tap/OCR/back sequence completes for that row (whether or not a User ID was read — `row_callback` itself decides what to do, e.g. skip if `user_id is None`). This is what `pearl_bazaar.py` (Task 3) passes into `scroll_scan(..., on_stop=...)`.

This differs from `make_id_fallback_hook` in three ways: it fires for **every** row (no "already resolved, skip" short-circuit), it keys off `rank` instead of resolved member name (Pearl Bazaar has no guild filter, so there's no roster name to resolve against), and it delegates all per-row business logic (the Pearl-icon-then-price drill-down) to a caller-supplied `row_callback` instead of hardcoding the User-ID-specific save logic inline — `make_id_fallback_hook` stays untouched as its own thing.

- [ ] **Step 1: Add the new function**

Add to `C:\vscode\AFKDataMining\src\modes\common.py`, immediately after `make_id_fallback_hook`'s closing `return on_stop` (end of that function, before end of file):

```python
def make_drill_in_hook(row_callback, avatar_x: int = RANK_CARD_AVATAR_X,
                       avatar_y_offset: int = RANK_CARD_AVATAR_Y_OFFSET):
    """Builds an on_stop hook (pass to scroll_scan) that taps EVERY row's
    banner while it's still on screen, reads that row's permanent in-game
    User ID from the profile popup, then hands off to row_callback(rank,
    user_id) for any further mode-specific drill-in (e.g. Pearl Bazaar
    tapping a second icon) before backing out.

    Unlike make_id_fallback_hook, this fires unconditionally for every row
    (no roster-match short-circuit) since it's meant for unfiltered,
    unguilded lists where there's no resolved member name to check against.
    row_callback owns everything past reading the User ID -- this hook only
    guarantees the tap/OCR/back sequence for the profile step and that
    row_callback runs exactly once per row while it's on screen, honoring
    the same reuse-the-scroll-in-progress approach that avoided Arcane
    Lab's over-scroll bug (see make_id_fallback_hook's docstring / project
    memory) -- no second pass, no re-navigation.

    row_callback is responsible for its own further taps/backs (e.g. Pearl
    icon -> price screen -> back) and must leave the screen back at the
    rank list before returning, matching this hook's own contract to
    scroll_scan."""
    tapped_ranks: set[int] = set()

    def on_stop(stop_img, stop_frame_entries: list[dict]) -> None:
        for entry in stop_frame_entries:
            rank = entry.get('rank')
            if rank is None or rank in tapped_ranks:
                continue
            tapped_ranks.add(rank)

            row_y = None
            for box, text, _conf in ocr_image(stop_img):
                cx, cy = block_center(box)
                if SequenceMatcher(None, text.strip().lower(), entry.get('name', '').lower()).ratio() >= 0.88:
                    row_y = cy
                    break
            if row_y is None:
                continue

            tap(avatar_x, row_y + avatar_y_offset)
            time.sleep(1.5)
            user_id = read_user_id(screenshot())
            mark_progress()  # real device work happened regardless of outcome

            row_callback(rank, user_id)

    return on_stop
```

- [ ] **Step 2: Manual sanity check (no automated test — matches existing convention for ADB-dependent hooks)**

Run: `python -c "from modes.common import make_drill_in_hook; print(make_drill_in_hook(lambda r, u: None))"`
Expected: prints a function object with no import errors — confirms the new function is syntactically valid and its imports (all already used elsewhere in the file: `time`, `SequenceMatcher`, `ocr_image`, `block_center`, `tap`, `screenshot`, `read_user_id`, `mark_progress`) resolve correctly.

- [ ] **Step 3: Commit**

```bash
cd C:\vscode\AFKDataMining
git add src/modes/common.py
git commit -m "feat: add generalized per-row drill-in hook for unfiltered ranking lists"
```

---

### Task 3: Pearl Bazaar DB save function (miner side)

**Files:**
- Modify: `C:\vscode\AFKDataMining\src\db.py` (add new function near `save_supreme_arena`, around line 1020)

**Interfaces:**
- Consumes: existing `_connect()` context manager (from `db.py`, used by every other `save_*` function).
- Produces: `wipe_pearl_bazaar_prices() -> None` and `save_pearl_bazaar_row(rank: int, ingame_id: int, price: int, selling_cap_remaining: int) -> None`, called by `pearl_bazaar.py` (Task 4) — `wipe_pearl_bazaar_prices()` once at the start of the scan, `save_pearl_bazaar_row(...)` once per successfully-captured row (immediate per-row write, matching every other `save_*` function's "write as you go" convention so a crash never loses already-captured rows).

- [ ] **Step 1: Add the functions**

Add to `C:\vscode\AFKDataMining\src\db.py`, immediately after `save_supreme_arena` (which ends around line 1020, right before `save_guild_duel`):

```python
def wipe_pearl_bazaar_prices() -> None:
    """Clears the previous run's rows at the START of a new run (not the end)
    -- only the latest run ever matters (remaining cap changes minute to
    minute), and a crash mid-run should leave this run's partial-but-fresh
    data rather than stale data from last time."""
    with _connect() as conn:
        conn.execute("DELETE FROM pearl_bazaar_prices")


def save_pearl_bazaar_row(rank: int, ingame_id: int, price: int, selling_cap_remaining: int) -> None:
    """Writes one row immediately as it's captured -- same immediate-write
    pattern as every other save_*() here, so a crash partway through the
    100-row drill-in never loses rows already captured this run."""
    scanned_at = _utcnow().isoformat()
    with _connect() as conn:
        conn.execute(
            """INSERT INTO pearl_bazaar_prices
               (rank, ingame_id, price, selling_cap_remaining, scanned_at)
               VALUES (?, ?, ?, ?, ?)""",
            (rank, ingame_id, price, selling_cap_remaining, scanned_at))
```

- [ ] **Step 2: Manual sanity check**

Run: `python -c "from db import wipe_pearl_bazaar_prices, save_pearl_bazaar_row; wipe_pearl_bazaar_prices(); save_pearl_bazaar_row(20, 132435334, 965, 160); import sqlite3; conn = sqlite3.connect('guild.db'); print(conn.execute('SELECT * FROM pearl_bazaar_prices').fetchall())"` (run from `C:\vscode\AFKDataMining\src`, against the real dev `guild.db` — Task 1 must be done first so the table exists)
Expected: prints one row `(1, 20, 132435334, 965, 160, '<iso timestamp>')`

- [ ] **Step 3: Commit**

```bash
cd C:\vscode\AFKDataMining
git add src/db.py
git commit -m "feat: add pearl_bazaar_prices save/wipe functions"
```

---

### Task 4: Pearl Bazaar scan mode (miner side)

**Files:**
- Create: `C:\vscode\AFKDataMining\src\modes\pearl_bazaar.py`
- Modify: `C:\vscode\AFKDataMining\src\scraper.py:186` (add `"pearl_bazaar"` to the `MODES` tuple)

**Interfaces:**
- Consumes: `nav.navigate_to_mode`, `nav.find_template`, `nav._t`, `device.screenshot`, `device.tap`, `device.back`, `ocr.ocr_image`, `modes.common.parse_rank_rows`, `modes.common.scroll_scan`, `modes.common.make_drill_in_hook` (Task 2), `db.wipe_pearl_bazaar_prices`, `db.save_pearl_bazaar_row` (Task 3).
- Produces: `scan() -> str` (module-level, matches the exact contract `scraper.py`'s `run_modes()` calls via `importlib.import_module(f"modes.{mode}").scan()` — no arguments, returns one of `"success"`/`"skipped"`/`"failed"`).

This task needs two new template images (the Pearl Bazaar icon on the profile screen, and a marker for the pricing screen so OCR knows where to read price/cap) — these must be captured live via `capture_template.py` against the real game before this task's live verification step, same as every other template-matched icon in this codebase (see the Dream Realm Hell-tier template gotcha in project memory: templates MUST come from an ADB screencap, never external art, or `cv2` matching silently fails).

- [ ] **Step 1: Capture required templates (live, on-device)**

Run `capture_template.py` (from `C:\vscode\AFKDataMining\src`) against a live BlueStacks session with a Supreme Arena profile open that has the Pearl Bazaar icon visible, saving:
- `src/templates/pearl_bazaar_icon.png` — the blue Pearl icon on the profile screen
- `src/templates/pearl_bazaar_price_label.png` — a stable text/icon marker on the pricing screen, used only to confirm the tap landed on the right screen before OCR (not for the numbers themselves, which come from `ocr_image`)

Expected: two PNG files exist under `src/templates/`, captured at BlueStacks' native 1080x1920 resolution.

- [ ] **Step 2: Write `pearl_bazaar.py`**

```python
"""Pearl Bazaar drill-in scan. Walks the (unfiltered) Supreme Arena rankings
list, ranks 1-100, and for every row taps into that player's profile to
check for the Pearl Bazaar icon. Where present, captures today's selling
price and remaining daily selling cap. No guild filter -- most of the top
100 are other guilds' members. Only the latest run's data has any value
(remaining cap changes minute to minute), so the table is wiped at the
START of this scan, not the end."""
import re

from db import wipe_pearl_bazaar_prices, save_pearl_bazaar_row
from device import screenshot, tap, back
from nav import navigate_to_mode, find_template, _t
from ocr import ocr_image
from modes.common import parse_rank_rows, scroll_scan, make_drill_in_hook

PRICE_RE = re.compile(r"\b(\d{3})\b")
CAP_RE = re.compile(r"Total\s*Daily\s*Selling\s*Cap\D*(\d+)", re.IGNORECASE)


def _parse(img, ocr_results) -> list[dict]:
    return [{"name": row.name, "rank": row.rank} for row in parse_rank_rows(img, ocr_results)]


def _capture_pearl_bazaar_row(rank: int, user_id: int | None) -> None:
    if user_id is None:
        print(f"PEARL_BAZAAR: rank {rank} User ID not read, skipping.")
        back()
        return

    icon_pos = find_template(screenshot(), _t("pearl_bazaar_icon"), threshold=0.80)
    if not icon_pos:
        # Expected and normal -- not everyone participates in this event.
        back()
        return

    tap(*icon_pos)
    import time
    time.sleep(1.2)

    price_screen = screenshot()
    if not find_template(price_screen, _t("pearl_bazaar_price_label"), threshold=0.80):
        print(f"PEARL_BAZAAR: rank {rank} (ID {user_id}) Pearl screen didn't load, skipping.")
        back()
        return

    price = None
    cap_remaining = None
    for _box, text, _conf in ocr_image(price_screen):
        if price is None:
            m = PRICE_RE.search(text)
            if m:
                price = int(m.group(1))
        m = CAP_RE.search(text)
        if m:
            cap_remaining = int(m.group(1))

    # Exactly one Back from the pricing screen returns straight to the rank
    # list -- confirmed live, the game skips the intermediate profile screen.
    back()

    if price is None or cap_remaining is None:
        print(f"PEARL_BAZAAR: rank {rank} (ID {user_id}) price/cap not read, skipping.")
        return

    save_pearl_bazaar_row(rank, user_id, price, cap_remaining)
    print(f"PEARL_BAZAAR: rank {rank} (ID {user_id}) price {price}, {cap_remaining} left to sell.")


def scan() -> str:
    try:
        navigate_to_mode("supreme_arena")
    except RuntimeError:
        if find_template(screenshot(), _t("supreme_arena_inactive"), threshold=0.80):
            print("PEARL_BAZAAR: Supreme Arena inactive, skipping.")
            return "skipped"
        raise

    from device import tap as _tap
    daily_calc = find_template(screenshot(), _t("supreme_arena_daily_calc"), threshold=0.80)
    if daily_calc:
        _tap(*daily_calc)

    wipe_pearl_bazaar_prices()

    scroll_scan(_parse, "Pearl Bazaar",
                on_stop=make_drill_in_hook(_capture_pearl_bazaar_row))

    print("PEARL_BAZAAR: scan complete.")
    return "success"
```

- [ ] **Step 3: Add to `MODES` in `scraper.py`**

In `C:\vscode\AFKDataMining\src\scraper.py:186`, change:

```python
MODES = ("dream_realm", "afk_stages", "arena", "supreme_arena", "honor_duel", "arcane_lab", "clashfronts", "guild_duel")
```

to:

```python
MODES = ("dream_realm", "afk_stages", "arena", "supreme_arena", "honor_duel", "arcane_lab", "clashfronts", "guild_duel", "pearl_bazaar")
```

This alone gives `pearl_bazaar.py` a `--pearl-bazaar` CLI flag and dispatch through `run_modes()` for free — no other changes to `scraper.py` needed.

- [ ] **Step 4: Live verification**

Run (from `C:\vscode\AFKDataMining\src`, with BlueStacks running and the game open, on a Monday or Tuesday UTC so Supreme Arena is active): `python scraper.py --pearl-bazaar`
Expected: navigates to Supreme Arena rankings, scrolls through the list tapping each row's banner, checking for the Pearl icon, capturing price/cap where present, and printing `PEARL_BAZAAR: rank N (ID ...) price ..., ... left to sell.` lines. Verify against `sqlite3 guild.db "SELECT * FROM pearl_bazaar_prices"` that rows landed with plausible 3-digit prices and cap values.

- [ ] **Step 5: Commit**

```bash
cd C:\vscode\AFKDataMining
git add src/modes/pearl_bazaar.py src/scraper.py src/templates/pearl_bazaar_icon.png src/templates/pearl_bazaar_price_label.png
git commit -m "feat: add Pearl Bazaar drill-in scan mode"
```

---

### Task 5: Pure filter/name-resolution helper (bot side)

**Files:**
- Create: `utils/pearlBazaar.js`
- Test: `utils/pearlBazaar.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure function, plain JS objects in/out — does not touch the DB itself, so it's fast and independent of live roster data).
- Produces: `buildPearlBazaarRows(dbRows, nameByIngameId)` used by Task 6's slash command. `dbRows` is an array of `{rank, ingame_id, price, selling_cap_remaining}` (shape of a row from `pearl_bazaar_prices`). `nameByIngameId` is a `Map<number, string>` (ingame_id -> resolved in-game name) built by the caller from a `members` lookup. Returns an array of `{rank, label, price, sellingCapRemaining}` sorted by `rank` ascending, with `selling_cap_remaining === 0` rows excluded and `label` set to the resolved name if present in the map, else `String(ingame_id)`.

- [ ] **Step 1: Write the failing tests**

Create `utils/pearlBazaar.test.js`:

```javascript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="selling cap|ingame_id|rank ascending"`
Expected: FAIL with "Cannot find module './pearlBazaar'"

- [ ] **Step 3: Write the implementation**

Create `utils/pearlBazaar.js`:

```javascript
function buildPearlBazaarRows(dbRows, nameByIngameId) {
    return dbRows
        .filter(row => row.selling_cap_remaining !== 0)
        .map(row => ({
            rank: row.rank,
            label: nameByIngameId.get(row.ingame_id) || String(row.ingame_id),
            price: row.price,
            sellingCapRemaining: row.selling_cap_remaining,
        }))
        .sort((a, b) => a.rank - b.rank);
}

module.exports = { buildPearlBazaarRows };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="selling cap|ingame_id|rank ascending"`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add utils/pearlBazaar.js utils/pearlBazaar.test.js
git commit -m "feat: add Pearl Bazaar row filter/resolve helper"
```

---

### Task 6: `/pearlbazaar` slash command

**Files:**
- Create: `slash-commands/pearlbazaar.js`

**Interfaces:**
- Consumes: `utils/pearlBazaar.js`'s `buildPearlBazaarRows` (Task 5), `utils/db.js`'s default export (`db.prepare(...)`, already how every command queries `pearl_bazaar_prices` and `members`), `utils/permissions.js`'s `enforcePermissions` (same permission-gate pattern every other command uses), `utils/colors.js`'s `pickColor`. Reuses `scan.js`'s `PYTHON`/`SCRAPER` env-var convention and `execFile` invocation shape (not imported — this is its own file, so these are redeclared locally, matching how `scan.js` itself declares them rather than sharing a module).
- Produces: registered slash command `pearlbazaar`, no subcommands, discoverable by `index.js`'s existing command loader (no changes needed there — it loads every file in `slash-commands/` automatically, same as every other command file).

- [ ] **Step 1: Write the command**

Create `slash-commands/pearlbazaar.js`:

```javascript
const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require("discord.js");
const { execFile, exec } = require("child_process");
const path = require("path");
const db = require("../utils/db");
const { pickColor } = require("../utils/colors");
const { enforcePermissions } = require("../utils/permissions");
const { buildPearlBazaarRows } = require("../utils/pearlBazaar");

const PYTHON = process.env.SCRAPER_PYTHON || "python";
const SCRAPER = process.env.SCRAPER_SCRIPT;

function nameLookupMap() {
	const rows = db.prepare("SELECT ingame_id, ingame_name FROM members WHERE ingame_id IS NOT NULL").all();
	return new Map(rows.map(r => [r.ingame_id, r.ingame_name]));
}

function buildResultsEmbed(rows) {
	if (rows.length === 0) {
		return new EmbedBuilder()
			.setTitle("🦪 Today's Pearl Bazaar Prices")
			.setDescription("No sellers with stock remaining were found this run.")
			.setColor(pickColor());
	}

	const lines = rows.map(r => `\`#${r.rank}\` **${r.label}** · ${r.price} · ${r.sellingCapRemaining} left`);
	return new EmbedBuilder()
		.setTitle("🦪 Today's Pearl Bazaar Prices")
		.setDescription(`SA Position | Name/ID | Price | Left to Sell\n${lines.join("\n")}`)
		.setColor(pickColor())
		.setFooter({ text: "Sold-out sellers are excluded · left-to-sell changes minute to minute" });
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName("pearlbazaar")
		.setDescription("Scan today's Pearl Bazaar prices across the top 100 Supreme Arena players"),

	async execute(interaction) {
		if (!(await enforcePermissions(interaction, "pearlbazaar", null))) return;
		if (!SCRAPER) {
			return interaction.reply({
				content: "❌ `SCRAPER_SCRIPT` not set in `.env`.",
				flags: MessageFlags.Ephemeral,
			});
		}

		await new Promise((resolve) => {
			exec("adb devices", (_err, stdout) => {
				if (stdout && stdout.includes("127.0.0.1:5555\tdevice")) return resolve();
				exec("adb connect 127.0.0.1:5555", resolve);
			});
		});

		await interaction.reply("⏳ Pearl Bazaar scan started · this walks all 100 ranks and takes a while · results will post here when done.");

		execFile(PYTHON, [SCRAPER, "--pearl-bazaar"], { cwd: path.dirname(SCRAPER) }, async (error, stdout) => {
			if (error) {
				console.error("Pearl Bazaar scan error:", error);
				const lines = stdout ? stdout.split("\n").filter(Boolean) : [];
				const tail = lines.slice(-15).join("\n");
				const tailBlock = tail ? `\n\nLast output before failure:\n\`\`\`${tail.slice(-1500)}\`\`\`` : "";
				return interaction.channel.send(`❌ Pearl Bazaar scan failed:\n\`\`\`${error.message.slice(0, 500)}\`\`\`${tailBlock}`);
			}

			const dbRows = db.prepare(
				"SELECT rank, ingame_id, price, selling_cap_remaining FROM pearl_bazaar_prices"
			).all();
			const rows = buildPearlBazaarRows(dbRows, nameLookupMap());

			await interaction.channel.send({ embeds: [buildResultsEmbed(rows)] });
		});
	},
};
```

- [ ] **Step 2: Manual smoke test (no automated test — this file is a thin Discord/execFile wrapper, matching `scan.js`'s own untested-directly convention; its only real logic is delegated to the already-tested `pearlBazaar.js`)**

Run: `node -e "require('./slash-commands/pearlbazaar.js'); console.log('loaded ok')"`
Expected: prints `loaded ok` with no throw — confirms requires resolve and the module exports the expected `data`/`execute` shape.

- [ ] **Step 3: Commit**

```bash
git add slash-commands/pearlbazaar.js
git commit -m "feat: add /pearlbazaar slash command"
```

---

### Task 7: Docs sync

**Files:**
- Modify: `CLAUDE.md` (Slash Commands table)
- Modify: `slash-commands/help.js` (if it maintains its own static command list separate from auto-discovery — check first)

**Interfaces:** none (documentation only).

- [ ] **Step 1: Check whether `help.js` needs a manual entry**

Run: `grep -n "COMMANDS\s*=" slash-commands/help.js`
If `help.js` builds its list dynamically from loaded commands, no change needed there. If it maintains a static array/object (matching the `askHandler.js` reference to `help.js`'s `COMMANDS` described in `CLAUDE.md`), add a `pearlbazaar` entry following that file's existing format for a single-subcommand-less entry like `/ping`.

- [ ] **Step 2: Add to `CLAUDE.md`'s Slash Commands table**

In `CLAUDE.md`, add a row to the Slash Commands table (alphabetically near `/note` or wherever fits the existing ordering):

```markdown
| `/pearlbazaar` | Drill-in scan of Pearl Bazaar prices across SA ranks 1-100 · posts today's price + remaining cap for sellers who still have stock · no guild filter, run manually a few times a quarter |
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md slash-commands/help.js
git commit -m "docs: document /pearlbazaar command"
```

---

## Post-plan note

Task 4's live verification (Step 4) can only run Monday/Tuesday UTC, with BlueStacks up and the game open, and ideally during an active Pearl Bazaar event window so at least one profile actually has the icon to drill into. If no event is currently live, that step still validates the tap/OCR/back mechanics against profiles with no icon (the "skip, expected and normal" path) — full end-to-end validation with real price/cap data will need to wait for the next live Pearl Bazaar window, matching how AFK Stages Phase 3 was left pending until the content actually existed (see project memory).
