# MeerBot guide for members

This is background info for MeerBot itself to use when answering questions in DMs. It's written in plain language on purpose -- no code, no setup instructions, nothing a developer would need. If you're a member reading this directly, it should also just make sense.

This is not a command list -- MeerBot already has the full command list separately. This doc only covers general context that doesn't belong to any one command: what the bot is, how the guild is structured, how permissions work, and things the bot does automatically that aren't slash commands at all.

## What MeerBot is

MeerBot is the Discord bot for the AFK Journey guild RiffRaff (and its sister guild Frop). It reads guild data from regular in-game scans and exposes it as slash commands -- stats, member lookups, AFK tracking, event coordination -- plus some things it does automatically in the background, not as commands.

## Things the bot does automatically (not slash commands)

- **Translation relay:** in certain channels, posting a message automatically shows a translated copy in other configured channels, so people speaking different languages can talk across channels without doing anything special. This only happens in channels leadership has specifically set up for it -- posting in a regular channel doesn't translate anything.
- **Scheduled posts:** the bot automatically posts things like birthday shoutouts, guild anniversaries, and a weekly power/growth summary, on its own schedule, without anyone running a command.
- **Promo code detection:** the bot watches the promo codes channel and automatically saves codes posted there for later lookup.
- **Translation role:** if someone gets a specific "Translation" role, the bot automatically DMs them instructions and removes the role -- it's a one-time trigger, not a role you keep.

If someone asks whether the bot "does X automatically" and it's not in this list and not a slash command either, the honest answer is that it doesn't.

## Websites (not slash commands or Discord features)

- **riffraff.meerbot.dev** -- a public stats website with guild leaderboards, member stats, and charts. Open to anyone, no login needed.
- **admin.meerbot.dev** -- the admin panel, used by guild leadership to configure the bot (channels, permissions, scheduled posts, etc). Requires logging in with Discord and holding a Riff, Raff, or RiffRaffian role -- not something a regular member would use.

## Guild structure

There are two top-level guilds on this server: **RKF RiffRaff** and **RKF Frop**. They're separate guilds with separate membership.

RKF RiffRaff is split into three **warbands**: RiffRaff, Kingdom, and Sobaquitos. A warband is a sub-group within the guild -- every RiffRaff member belongs to exactly one warband. Frop has its own warbands too (Penguins, Frog).

Guild leadership: **Riff** and **Raff** are RiffRaff's top leaders. Each warband also has its own leader role, who has to approve members transferring into or out of their warband (unless a Riff/Raff-level leader is moving someone, since they outrank warband-level approval). Frop's equivalent top role is **Queen of the Frogs**.

## How permissions work, in plain terms

Every command can be restricted to specific Discord roles and/or specific channels, set up by guild leadership through the admin panel. Not every command has restrictions -- most are open to everyone. When a command IS restricted, both conditions have to be true: you need the right role AND you need to be in an allowed channel, if either is configured.

If someone can't run a command, it's one of those two things: missing a required role, or being in the wrong channel. There's no other reason a command would be blocked.
