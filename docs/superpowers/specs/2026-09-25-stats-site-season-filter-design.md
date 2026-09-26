# Stats site season filter

## Why

`member_snapshots.season_id` and `dream_realm_bosses.season` already exist as real FKs into
`ally_seasons.id` (shipped in the `/guild seasongrowth` feature and the original Dream Realm
schema respectively). The public stats site (`stats/`) never surfaced either -- Power Growth
and Activeness charts show one flat all-time history, and the Dream Realm tab's boss dropdown
lists every boss from every season in one list, with same-named bosses across seasons showing
as separate entries with no indication which season they belong to.

Verified against live data before designing (2026-09-25):
- `dream_realm_bosses`: two seasons present, 1 and 8 (season numbering isn't sequential -- id 8
  is "Veil of Memories", the currently active row in `ally_seasons`). No NULL seasons, no
  orphaned `dream_realm_scores` rows.
- `member_snapshots`: confirmed no single `snapshot_id` spans two different `season_id` values --
  every snapshot is cleanly one season. Filtering rows by `season_id` and deriving the visible
  snapshot list from surviving rows is safe today and stays correct if that ever changes.

## Decisions (confirmed with Daniel 2026-09-25)

- **Power Growth chart**: add a season selector, but keep an "All" option alongside it --
  default view stays full history, no regression to current behavior.
- **Activeness chart**: same treatment as Power, done in this same pass (not deferred).
- **Dream Realm tab**: season selector required, no "All" option -- same rule already approved
  for the admin panel's Dream Realm Bosses tab. Defaults to whichever season is
  `ally_seasons.active = 1`.

## API changes (`stats/server.js`)

- New `/api/seasons` endpoint: `SELECT id, name, active FROM ally_seasons ORDER BY id`. Shared
  by all three tabs' season dropdowns.
- `/api/power-history`: add `ms.season_id` to the row SELECT. No filtering server-side --
  client filters, same pattern as the existing warband/member filters.
- `/api/activeness-history`: same -- add `ms.season_id` to the row SELECT.
- `/api/dream-realm`: already returns `season` per boss (`dream_realm_bosses.season`). No
  endpoint change needed, just client-side filtering on data already returned.

## Client changes

**`power.js` / new `activeness.js` season filter** (mirror each other):
- Season `<select>` populated from `/api/seasons`, "All" as the first option, selected by
  default (per Daniel's decision).
- When a specific season is selected: filter `rows`/snapshots by `season_id` before building
  the member snapshot maps, so the x-axis only shows that season's snapshots.
- The "sort by last snapshot" step in `render()` must use the season-filtered snapshot list,
  not the global last snapshot -- otherwise sorting silently references a snapshot outside the
  filtered range.

**`dreamrealm.js`**:
- Season `<select>` populated from `/api/seasons`, no "All" entry. Default to the row where
  `active = 1`.
- Changing season must rebuild the `dr-boss` dropdown (filtered to that season's bosses) before
  calling `updateDates()` -- today `bossEl` is populated once at init from the full unfiltered
  list.
- Handle the case where a selected season has zero bosses (shouldn't happen given current data,
  but a prepped-not-yet-populated season is possible) with an empty state rather than
  `parseInt('')` silently rendering nothing.

## Out of scope

- No schema changes -- both season columns already exist and are populated correctly.
- No changes to the admin panel's own pinned Dream Realm Bosses tab filter (separate, already
  designed, still gated on Daniel's go-ahead).
- No fix to `get_boss_for_date`'s season-boundary gap (tracked separately, not urgent).
