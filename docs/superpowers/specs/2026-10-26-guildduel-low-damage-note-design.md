# `/guildduel low`: a damage note and a red-flag section

## Why

`/guildduel low` flags members on crests and activeness only. Since the weekend damage scan began (week
of 2026-10-19) we can also see who earned crests and never spent them. The first by-hand analysis found
five members with crests and no damage and ten who used under half their crests' worth of hits. Leaders
want the zero-attack case called out directly as a red flag, and a small damage note on the people the
command already flags.

## Behavior

- A new section at the top, `🚩 Earned crests but never attacked (N)`, lists active, non-AFK members who
  earned at least one hit's worth of crests (200) in a week that has damage data (10 or more members with
  damage) and have no damage recorded that week. Each line: name, crests earned, "no damage recorded", and
  "X of Y weeks" when more than one week has data. This section does not depend on the other flags.
- Each member already flagged by the existing crest and activeness rules gets one extra line:
  `↳ damage: ≈N% of crests spent (K wks) · at or above / below F% of the guild mean hit`.
  N = their damage per crest earned against that week's guild mean damage per hit (total damage / total
  hits over non-AFK dealers), averaged over the lookback weeks that have damage data; shown as `100%+`
  from 100. F = the new setting. `no damage data in this period` when none of their weeks has data.
- Damage never flags anyone by itself and never changes who is on the list.
- Footer adds the formula, the mean hit, the floor, the weeks of damage data, and a warning that a missed
  scan read can show a false zero, so check in-game before acting.
- New admin setting `GUILDDUEL_HIT_FLOOR` (label Damage Floor, percent of the guild mean hit, default 50),
  in the Guild Duel box on the Config tab, read on every run (no restart). `/guildduel recap` uses the same
  setting for its "used only a small part of their crests" group, and now estimates unspent damage at the
  guild mean hit (it used the median before).

## Honest limit

Total damage and crests earned are all we have, not the number of hits made. A low value means unspent
crests, weak hits, or both. The wording says "of crests spent" with an approximation sign and the footer
gives the formula for that reason.

## Out of scope

Flagging on damage alone; a multi-week damage rule (only one week of data exists as of 2026-10-26); showing
names outside `/guildduel low`'s existing ephemeral reply.
