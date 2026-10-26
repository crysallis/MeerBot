# `/guildduel recap` · a numbers-only recap of one Guild Duel week

## Why

After the weekend boss, leadership wants one public post that shows how much damage the guild left
unspent, without naming anyone. A manual version (2026-10-25, week of Oct 19) found 17,368B dealt at
13.7B per hit and about 156 unspent hits (about 2,150B, 12 percent). This makes that repeatable.

## Behavior

- New subcommand `/guildduel recap [date]` under the existing `/guildduel` command, so it follows
  that command's permission rules (`enforcePermissions('guildduel', 'recap')`, default Manage Server,
  adjusted on the admin Permissions tab). The reply is a PUBLIC embed, never ephemeral on success.
- `date` is optional, `YYYY-MM-DD`, any day inside the duel week (Monday 00:00 to Sunday 23:59:59 UTC).
  Autocomplete offers the weeks that have data, labelled `Oct 19 to Oct 25, 2026`. Empty = the latest
  finished week that has data.
- Replies (all ephemeral, one sentence): invalid date; a week before our first damage data ("we can't
  do a recap for that week, we weren't capturing damage data then"); the in-progress week ("that duel is
  still in progress, check again next week after it's over"); a future week; a finished week with no
  usable data; a finished week whose crests are not scanned yet ("check again after Monday's scan").
- Embed, no member names anywhere: date range (and the Sat/Sun boss window), guild total damage, hits
  and average damage per hit, then two groups (earned crests but never attacked; attacked but far below
  their crests) with member count, unspent hits and estimated damage, then the combined unspent hits,
  damage and percent of what the guild dealt. Footer: AFK excluded, estimates use the guild mean hit, one
  hit = 200 crests.

## Numbers (same as the manual run)

Hits = crests / 200. Dealers = non-AFK members with crests > 0 and damage > 0. Average damage per hit =
total damage / total hits over dealers, and that mean is the yardstick (changed from the median on
2026-10-26 so the recap and `/guildduel low` agree). Group 1 = non-AFK members with crests >= 200 and no
damage: unspent hits = crests / 200. Group 2 = dealers whose damage per hit is under the shared
`GUILDDUEL_HIT_FLOOR` share of the mean hit (default 50 percent, adjustable on the admin Config tab):
unspent hits = hits - damage / mean. Estimated damage = unspent hits x mean.

## AFK rule (user's decision)

A member is excluded if they have a CURRENT `member_afk` record that started before the end of that
week (and whose `return_date`, if any, is not before the week started), or an AFK HISTORY row that
overlaps the week (`started_at` before the week end and `ended_at` null or on/after the week start).
Someone who went AFK after the week is NOT excluded.

## Data availability

A week "has data" when at least 10 members have a damage value. First data week today is 2026-10-19.
Weeks are Monday-based UTC, matching `guild_duel_rankings.period_start`.

## Not in scope

Admin-configurable thresholds; names or per-member output; posting on a schedule; weeks before
2026-10-19 (damage was not captured).
