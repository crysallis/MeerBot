# `/glorycta` — Clash of Glory Battle-Time Vote — Design

## Problem

Clash of Glory is a new AFK Journey guild mode requiring the guild to agree on a battle
time. RiffRaff needs a way to propose two candidate UTC times and let members vote via
reaction, with a tally that resolves each voter to their linked in-game name, not just
their raw Discord handle.

## Scope

- New slash command `/glorycta` — posts a pinned poll with two time options, each
  represented by a randomly-chosen emoji (not admin-picked, not fixed) so voters must
  read the times rather than pattern-match a familiar emoji.
- Members vote by reacting with one or both of the two poll emoji. Any other emoji
  reacted onto the poll message is silently removed — no DM, no follow-up message.
- After a configurable duration, the vote closes automatically: the bot tallies both
  reaction lists (resolving Discord ID → in-game name via `members.discord_id`, same
  join used elsewhere), posts the tally as a new message in the same channel, and
  unpins the original poll.
- Out of scope: admin-specified emoji, a general-purpose timezone-conversion command,
  live-updating vote counts in the embed (Discord's native reaction counter already
  shows a live count next to each emoji — no bot-side duplication needed), any
  mechanism for a user to save a personal timezone preference.

## Command Shape

```
/glorycta time1:<HH:MM> time2:<HH:MM> duration:<integer hours>
```

- `time1` / `time2`: strict `HH:MM` 24-hour UTC clock times (e.g. `06:00`, `20:00`).
  Validated with a simple regex (`^([01]\d|2[0-3]):[0-5]\d$`) at the command level;
  reject with an ephemeral error on malformed input, same pattern as other commands'
  input validation.
- `duration`: whole hours the vote stays open (positive integer).
- Gated via `enforcePermissions(interaction, "glorycta")` — no code-hardcoded role
  check, follows the existing convention (e.g. `clashfronts.js`) of deferring to the
  admin panel's Permissions tab. New `OPERATIONS` entry so it's visible/configurable
  there.

## Emoji Selection

New static pool in a small helper module (e.g. `utils/glorycta.js`), built from
Discord's standard emoji set **excluding** flag emoji and skin-tone modifier variants
(both explicitly ruled out during brainstorming — flags would dominate the randomness
and carry no meaning here, skin-tone variants are redundant repeats of the same base
emoji). On each `/glorycta` invocation, pick 2 distinct emoji at random from this pool,
one per time option — never admin-specified, never fixed, so voters can't develop a
positional habit ("the left one is always the early time") and must read the labels.

## Poll Message

Embed fields, one per time option, inline side-by-side (mirrors the in-game card's
Local-time-first / UTC-second information hierarchy — see reference screenshot from
brainstorming — without attempting to replicate borders/checkmarks, which are the
in-game client's post-selection state, not something Discord embeds can produce):

```
🐢 Option A                          🦋 Option B
Local: <t:1755000000:t>              Local: <t:1755021600:t>
UTC: 06:00                           UTC: 20:00
```

`<t:UNIX:t>` is Discord's native dynamic timestamp tag — the Discord client (not the
bot) renders it in each viewer's own local device timezone automatically. The UNIX
timestamp is computed from `time1`/`time2` interpreted as UTC on the **next occurrence**
of that clock time from now, evaluated independently per option (if `time1` has already
passed today in UTC but `time2` hasn't, `time1` rolls to tomorrow while `time2` stays
today — the two options are never assumed to land on the same calendar date) — Clash of
Glory times are same-day-recurring slots, not far-future dates.

Embed description carries the call-to-arms copy (epic/dramatic tone, per brainstorming):

> ⚔️ **The horns sound, RiffRaff!** Clash of Glory draws near, and the guild must
> stand united at a single hour. Two banners are raised below — react with the matching
> emoji to pledge your hour of battle. Vote for one, or both if either hour serves you.
> The call closes in **{duration}** — choose your glory.

Bot posts the embed, adds both emoji as its own reactions (so voters can tap rather
than needing to type/find the emoji), and pins the message.

## Enforcement While Open

New `messageReactionAdd` handler (e.g. `utils/handlers/gloryctaReactionGuard.js` —
actual filename TBD at implementation, following the existing `utils/handlers/`
convention):

- Ignore if `user.bot` (standard loop-guard, matches every other reaction/message
  handler in the codebase).
- Ignore if the message isn't a tracked open `/glorycta` poll (look up by message ID
  against the active `glorycta_polls` table — see Data Model).
- If the reacted emoji is not one of the poll's two valid emoji: remove that specific
  user's reaction (`reaction.users.remove(user.id)`) immediately. No DM, no channel
  message — silent removal only, per explicit brainstorming answer.

## Data Model

New table, bot-owned (follows `utils/db.js` CREATE-statement convention, no migration
trail):

```sql
CREATE TABLE IF NOT EXISTS glorycta_polls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,           -- FK to scheduled_jobs, the tally job
    message_id TEXT NOT NULL UNIQUE,
    channel_id TEXT NOT NULL,
    emoji_a TEXT NOT NULL,
    emoji_b TEXT NOT NULL,
    label_a TEXT NOT NULL,             -- "06:00"
    label_b TEXT NOT NULL,             -- "20:00"
    fire_at_a TEXT NOT NULL,           -- ISO timestamp used for <t:...> tag A
    fire_at_b TEXT NOT NULL,
    created_at TEXT NOT NULL
);
```

`message_id` is the lookup key for the reaction guard (checked on every
`messageReactionAdd`, so it needs to be a fast/indexed lookup — `UNIQUE` gives that for
free). Row is deleted when the tally job fires and completes, mirroring how
`remindme`/`recruitment_followup` jobs delete their own `scheduled_jobs` row after
running — no historical poll archive, matching this feature's disposable/one-shot
nature (unlike, say, `recruitment`, nothing downstream needs to query past polls).

## Tally Job

New `scheduled_jobs.type = 'glorycta_tally'`, added to `jobScheduler.js`'s `tick()`
dispatch alongside `remindme`/`recruitment_followup` — same one-shot pattern (fires
once, row deleted after, no recurrence).

On fire:
1. Fetch the poll message via `channel.messages.fetch(message_id)`.
2. For each of the two emoji, fetch the reaction's user list
   (`reaction.users.fetch()`), excluding the bot's own reaction entry.
3. Resolve each Discord user ID against `members.discord_id` → `ingame_name`. Unlinked
   voters display as their raw Discord display name only — same convention already
   used by `clashfronts.js` and `/guild unlinked` for unlinked members.
4. A user appearing under both emoji is listed under both columns (counts as "either
   works" — explicit brainstorming answer, no separate "both" bucket).
5. Post a new embed message in the same channel (not a reply/thread, not a DM) listing
   both time options with their resolved voter lists and counts.
6. Unpin the original poll message (`message.unpin()`).
7. Delete the `glorycta_polls` row for this poll.

## Error Handling

- Malformed `HH:MM` input → ephemeral validation error, no poll created.
- Permission-check failure → handled entirely by `enforcePermissions` (existing
  shared behavior, no new logic needed).
- Tally job fires but the poll message was deleted out-of-band (e.g. manually removed
  from Discord) → `messages.fetch` rejects; catch and log via
  `console.error('[Glorycta] ...')`, delete the `glorycta_polls` row and the job so it
  doesn't retry forever, matching the existing pattern in `jobScheduler.js`'s `tick()`
  try/catch per job.
- Reaction guard fires on a message that turns out not to be trackable (bot restarted
  mid-vote, `glorycta_polls` row somehow missing) → no-op, do nothing (fail safe, not
  fail loud — an untracked message should never trigger removal).

## Testing

- Unit-test the `HH:MM` → next-occurrence-UTC-timestamp helper (today vs. rolled to
  tomorrow cases), following existing test conventions
  ([[project_node-upgrade-and-tests]] notes headless tests are the planned direction;
  until that lands, a one-off manual test script under the project's existing ad-hoc
  test pattern is acceptable, consistent with how other utils are currently tested).
- Manual live test on `meerbot-test` (per [[project_test-bot-worktree]]): create a
  short-duration (e.g. 2-minute) poll, react with a third emoji to confirm silent
  removal, react with both valid emoji from one account to confirm dual-column tally,
  let it expire and confirm auto-unpin + tally post.
