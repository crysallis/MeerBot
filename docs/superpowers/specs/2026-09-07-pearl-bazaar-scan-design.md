# Pearl Bazaar scan — design

Date: 2026-09-07
Status: approved, ready for implementation planning

## Summary

A new, standalone scan mode that walks the Supreme Arena rankings list (ranks
1-100, unfiltered by guild) and, for every entry, drills into that player's
profile to check whether they participate in the Pearl Bazaar event. Where
they do, it captures that day's selling price and remaining daily selling
cap. Results are posted to Discord as a table, filtered to only players who
still have inventory left to sell at the moment of posting.

Run manually, a few times per quarter (Pearl Bazaar is an occasional
in-game event, unlike Supreme Arena's always-on weekly cycle) — deliberately
kept as its own mode rather than bolted onto the Supreme Arena scan, so the
common weekly SA scan stays fast and unaffected.

## Motivation

Pearl Bazaar gives each of the top 100 Supreme Arena players a randomized
per-person selling price and a capped daily quantity they can sell before
running out. There's no way to see this information in aggregate in-game —
it's one tap-through per player. The guild wants a single Discord post
showing, for every scanned player who still has stock left, their price and
remaining cap, so members can quickly see who's worth buying from right now.

Because "remaining cap" changes minute-to-minute as people buy and sell,
only the single most recent scan run has any value — there is no need to
retain history, and last run's data becomes actively misleading noise once
a new run exists.

## Non-goals

- No historical retention or trend tracking of Pearl Bazaar prices.
- No guild-filtering — all top-100 SA players are in scope, not just
  RiffRaff members.
- No retry-on-failure for an individual row's drill-in; a missed row is an
  acceptable, low-stakes loss (see "Per-row failure handling").
- Not wired into `/scan`'s mode-flag system — this is fully separate from
  that command and its `bot_config`-toggled `MODE_FLAGS`.

## Constraints inherited from Supreme Arena

Pearl Bazaar rides the exact same rankings screen Supreme Arena scans use.
That screen is only reachable / meaningful Monday and Tuesday UTC (see
`get_supreme_period()` in `db.py` — Supreme Arena is inactive outside that
window and `navigate_to_mode("supreme_arena")` will hit the inactive-screen
case the existing scan already handles). Pearl Bazaar does **not** need to
respect Supreme Arena's own once-per-day-per-period save guard (that guard
exists to stop the *ranking* scan from double-recording a settled period;
Pearl Bazaar isn't recording ranking data and can be run multiple times a
day if desired), but it does inherit the same Mon/Tue-only *reachability*
constraint, since there's no independent way to reach that list outside
Supreme Arena's own active window.

## Navigation & capture (miner side)

New file: `src/modes/pearl_bazaar.py`.

Reuses `navigate_to_mode("supreme_arena")` for nav, and `scroll_scan` +
`parse_rank_rows` for walking the list and reading rank numbers — identical
to `supreme_arena.py` — but does **not** call `apply_guild_filter()`, since
every row in the top 100 is in scope regardless of guild.

### New reusable drill-in hook

This is the third feature needing the same shape (guild scan's
`capture_ids.py`, ranking modes' `make_id_fallback_hook`, now this): tap a
row, read something from a screen reached by tapping into it, back out,
continue the scroll. Rather than a fourth bespoke implementation, add a
generalized version alongside `make_id_fallback_hook` in
`src/modes/common.py` that runs an arbitrary per-row callback (as an
`on_stop` hook passed to `scroll_scan`) for **every** row in the current
frame, not just unmatched ones. `make_id_fallback_hook` itself is left
alone; the new hook is a sibling entry point sharing the same tap/back
plumbing, not a rewrite.

### Per-row sequence

For each row visible at a scroll stop:

1. Read the rank number (already handled by `parse_rank_rows`, same as
   Supreme Arena).
2. Tap the row's banner at `RANK_CARD_AVATAR_X` / `RANK_CARD_AVATAR_Y_OFFSET`
   (existing measured constants from `common.py`) → opens that player's
   profile.
3. OCR "User ID: N" off the profile screen, reusing `USER_ID_RE` from
   `capture_ids.py`.
4. Look for the blue Pearl Bazaar icon on the profile. If it is not present
   (this player doesn't have this feature this cycle — expected and normal,
   not everyone participates), skip straight to step 7.
5. Tap the Pearl Bazaar icon → opens the pricing screen.
6. OCR two values off that screen:
   - **Today's Price** — the large 3-digit number.
   - **Total Daily Selling Cap** — read as-is; this field already reports
     the remaining sellable amount, no arithmetic needed.
7. Press Back **once**. Confirmed live behavior: from the Pearl Bazaar
   pricing screen, Back returns directly to the rank list (not to the
   intermediate profile screen) — only one Back is needed per row,
   regardless of whether steps 4-6 ran.
8. Continue the scroll to the next row.

### Per-row failure handling

If any step fails (profile popup doesn't load in time, OCR can't find a
value it expected), log it and move on to the next row with no retry. A
missed row is an acceptable loss — the goal of the feature is surfacing the
best available prices across the field, not completeness, and a skipped
player simply doesn't appear in this run's results.

## Storage

New bot-owned table (bot creates it in `utils/db.js`, matching the schema
ownership convention — this table has nothing to do with the miner's
shared identity/scan tables):

```sql
CREATE TABLE IF NOT EXISTS pearl_bazaar_prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rank INTEGER NOT NULL,
    ingame_id INTEGER NOT NULL,
    price INTEGER NOT NULL,
    selling_cap_remaining INTEGER NOT NULL,
    scanned_at TEXT NOT NULL
);
```

Only the latest run ever matters, so the table is wiped at the very start
of each run (`DELETE FROM pearl_bazaar_prices` before scanning begins),
then rows are inserted one at a time as each member is captured during the
scroll. This means a crash mid-run leaves whatever partial data the
*current* attempt managed to capture (still useful — real prices from
seconds ago, not stale data from last time), rather than either an empty
table or a half-overwritten mix of two runs.

The miner writes directly to this table from Python (same cross-repo
pattern already used for `scan_timings` — see `db.py`'s note on that table)
rather than round-tripping through the bot process's stdout.

### Scan timing log

Participates in the existing `scan_timings` table the same way every other
mode already does (`mode='pearl_bazaar'`) — no new plumbing needed, this is
free by following the established pattern in `db.py`.

## Discord command (bot side)

New standalone slash command, `/pearlbazaar` — not a `/scan` mode flag, not
part of `MODE_FLAGS`/`bot_config` toggling. Follows the same
`execFile(PYTHON, [SCRAPER, "--pearl-bazaar"], ...)` + stdout-marker
pattern `scan.js` already uses for its other mode results, but as its own
command file (e.g. `slash-commands/pearlbazaar.js`) rather than a branch
inside `scan.js`, since it has its own distinct reply/posting shape and
doesn't participate in the guild-scan flow (inactivity alerts, check-in
DMs, review-names handling, etc. are all irrelevant here).

On completion:

1. Read all rows from `pearl_bazaar_prices`.
2. Filter out any row where `selling_cap_remaining = 0` — sold out by the
   time of posting, per the requirement that this number is only
   meaningful as of right now.
3. For each remaining row, look up `ingame_id` against `members` to resolve
   an in-game name where we have one on file; fall back to the raw User ID
   for players not in our roster (expected for most of the top-100 field,
   since it isn't guild-filtered).
4. Post a table to the invoking channel:

   ```
   SA Position | ID/Name | Selling Price | Left to Sell
   20          | 132435334 | 965         | 160
   ```

## Testing

This feature is almost entirely live-ADB-dependent (nav, taps, OCR timing)
in the same way `capture_ids.py` and `make_id_fallback_hook` are — there's
no meaningful pure-logic surface on the miner side to unit test beyond
existing coverage of `parse_rank_rows`/`scroll_scan`, which this mode reuses
unchanged. Verification of the drill-in sequence itself will be a live test
run against the real game, matching how those prior features were
validated.

On the bot side, the cap-filter + name-resolution query in the
`/pearlbazaar` command is ordinary logic and will get a small `node --test`
covering: cap=0 rows excluded, cap>0 rows included, name resolved when
`ingame_id` matches a member, raw ID shown when it doesn't.
