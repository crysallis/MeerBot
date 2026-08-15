# Ask MeerBot (DM Q&A) — Design

**Status:** Built and shipped. See amendment below — the knowledge-source
decision changed after real-world testing showed the original approach
producing developer-documentation-style answers to member questions.

**Amendment (2026-08-15, post-ship):** The original "Knowledge sources"
section below (README.md + ARCHITECTURE.md in full) was replaced with a
new purpose-written `docs/bot-guide.md`. In practice, feeding the model a
developer-facing README (setup instructions, .env variable tables, project
file structure) produced answers that read like documentation pages —
bold section banners, "Usage"/"How it works" headers — because the model
was pattern-matching the style of what it was given, and most of that
README content was never relevant to a member's question anyway. See
`gotcha-` and `project_ask-meerbot-dm-design` memory for the full
before/after. The rest of this document is left as originally approved
for historical accuracy; treat "Knowledge sources" and "Out of scope" as
superseded by this note.

## Problem

Members don't know what MeerBot can do or whether they're allowed to do it.
`/help` exists but requires knowing to look, and it doesn't answer "can I
run this in this channel" or "why didn't that work" — the exact confusion
that caused the command-wide permissions bug (`e4edaac`, see CLAUDE.md Key
Decisions and `gotcha-command-wide-permissions-silently-ignored.md`).

Daniel wants members to be able to just ask, in plain language: "how do I
vote on Clash of Glory times", "can I run /season", "why can't I do X here".

## Approach

A DM-only chat handler. A member DMs the bot; the bot answers using an LLM
call grounded in the bot's own documentation plus a personalized permission
check for that specific asker. No tool-use, no live DB mutation capability
— it only ever generates a text reply. It cannot let anyone do anything
they couldn't already do through the real slash commands, which continue
to enforce permissions independently via `enforcePermissions`.

This mirrors the existing pattern in `translationRelayHandler.js`: one
Anthropic API call per event, using the `@anthropic-ai/sdk` dependency and
`ANTHROPIC_API_KEY` already wired into the bot process.

### Trigger

DM only. No @mention trigger, no slash command. Chosen because DMs are
private (low stakes if the bot answers imperfectly — only the asker sees
it) and give the simplest permission story: check against the guild
member's real roles, no channel context to reconcile.

### Knowledge sources

Assembled into the system prompt on every call:

1. **`slash-commands/help.js`'s `COMMANDS` object** — already the
   structured source of truth: every command, subcommand, description,
   and permission requirement (`perm` field). This is the same data
   `/help` itself renders from, so answers stay in sync with `/help`
   automatically.
2. **`README.md`** (full text, ~280 lines) — user-facing by design
   already, small enough to include whole every call.
3. **`ARCHITECTURE.md`** (full text, ~730 lines) — includes implementation
   detail, but describes bot *behavior* extensively (timing, job types,
   permission model). The model is instructed via the system prompt to
   answer only what's relevant to the asker's question and to prefer
   `README.md`/`help.js` framing over internal implementation detail.

**`CLAUDE.md` is explicitly excluded.** It's Daniel's own working notes for
Claude Code sessions — mixed with unrelated project/ops content (PM2
commands, DB internals, admin auth mechanics) that has nothing to do with
"what can I ask MeerBot to do." It was never written as user-facing
documentation, unlike README/ARCHITECTURE.

### Permission-aware answers

For each question, the handler:

1. Fetches the asker's real Discord roles (guild member fetch by user ID
   — DMs have no `interaction.member`, so this requires an explicit guild
   fetch via `GUILD_ID`, same pattern already used by
   `transferButtonHandler.js` for DM-originated interactions).
2. Reads the same `command_permissions` rows `enforcePermissions` reads
   (role rows + channel rows, general vs. specific precedence per
   `utils/permissions.js`'s `pickRows` logic) — **read-only**, this
   handler never calls `enforcePermissions` itself, it inspects the same
   underlying data to build a description.
3. Builds a personalized capability summary — for each command: can this
   user run it (role check), and if it's channel-restricted, which
   channels. This gets added to the system prompt as ground truth about
   *this specific asker*, so the model can answer "yes", "no — that needs
   the Raff role, you don't have it", or "yes, but only in
   #leader-chat" instead of guessing or giving a generic answer.

This directly closes the confusion category behind the permissions bug:
a member asking "can I run /guild power in bot-chatter" gets a real
answer instead of finding out by trial and error.

### Answer generation

One Claude Haiku call per DM. System prompt = knowledge sources +
personalized capability summary + instruction to answer only from that
context, stay terse, and give the actual slash-command syntax (e.g.
`/glory cta time1: time2: duration:`) when relevant. User prompt = the
DM's raw text.

### Rate limiting

10 questions per hour, per user, tracked in-memory (a `Map<userId,
timestamp[]>` sliding window — same shape as the bot's existing global
slash-command rate limiter, just scoped per-user instead of global). Over
the limit: a plain reply telling them the limit and roughly when it
resets. No API call is made when over limit.

### Failure handling

If the Anthropic API call throws or times out, reply with a static
fallback pointing to `/help` — never leave the DM unanswered.

### Out of scope (this design)

- No conversation memory or threading — each DM is answered independently
  with no history of prior questions in the same DM.
- No tool-use or live DB queries beyond the one read-only permission
  lookup described above.
- No @mention or slash-command trigger — DM only.
- No game-knowledge content (heroes, skills, counters, synergies) — that
  is a separate, larger feature (a growing structured knowledge base,
  likely admin-panel-authored) to be designed and built independently.
  This design's system-prompt assembly is written as a single function
  specifically so that a future knowledge source can be appended there
  without reworking the DM handler itself.

## Files touched (expected, not yet planned in detail)

- New: `utils/handlers/askHandler.js` — DM handler, wired into
  `index.js`'s `messageCreate` dispatch alongside the existing handlers
  (`translationRelayHandler.js`, `promoCodeHandler.js`,
  `translationRoleHandler.js`).
- Read (not modified): `slash-commands/help.js` (`COMMANDS` export),
  `README.md`, `ARCHITECTURE.md`, `utils/permissions.js` (for the
  precedence logic pattern), `utils/db.js` (`command_permissions` reads).

## Open items for the implementation plan

- Exact system-prompt wording/instructions (tone, refusal behavior for
  off-topic questions, how strongly to discourage speculation beyond the
  provided docs).
- Whether `help.js`'s `COMMANDS` object needs to be exported separately
  for reuse here, or re-required as-is (it's already `module.exports`'d
  functions, not the raw object — needs checking at plan time).
- Where the in-memory rate-limit map lives (new module vs. colocated in
  the handler file).
