# MeerBot guide for members

This is background info for MeerBot itself to use when answering questions in DMs. It's written in plain language on purpose -- no code, no setup instructions, nothing a developer would need. If you're a member reading this directly, it should also just make sense.

This is not a command list -- MeerBot already has the full command list separately. This doc only covers general context that doesn't belong to any one command: what the bot is, how the guild is structured, and how permissions work.

## What MeerBot is

MeerBot is the Discord bot for the AFK Journey guild RiffRaff (and its sister guild Frop). It reads guild data from regular in-game scans and exposes it as slash commands -- stats, member lookups, AFK tracking, event coordination, and a few automated posts.

## Guild structure

There are two top-level guilds on this server: **RKF RiffRaff** and **RKF Frop**. They're separate guilds with separate membership.

RKF RiffRaff is split into three **warbands**: RiffRaff, Kingdom, and Sobaquitos. A warband is a sub-group within the guild -- every RiffRaff member belongs to exactly one warband. Frop has its own warbands too (Penguins, Frog).

Guild leadership: **Riff** and **Raff** are RiffRaff's top leaders. Each warband also has its own leader role, who has to approve members transferring into or out of their warband (unless a Riff/Raff-level leader is moving someone, since they outrank warband-level approval). Frop's equivalent top role is **Queen of the Frogs**.

## How permissions work, in plain terms

Every command can be restricted to specific Discord roles and/or specific channels, set up by guild leadership through the admin panel. Not every command has restrictions -- most are open to everyone. When a command IS restricted, both conditions have to be true: you need the right role AND you need to be in an allowed channel, if either is configured.

If someone can't run a command, it's one of those two things: missing a required role, or being in the wrong channel. There's no other reason a command would be blocked.
