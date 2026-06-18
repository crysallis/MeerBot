# Security Policy

## Scope

This repo covers two components:

- **MeerBot** -- a Discord bot for guild management
- **Admin panel** -- a self-hosted Express web app accessible only to guild leadership

Both are self-hosted. There is no public-facing service and no user data beyond guild membership and in-game stats.

## Reporting a Vulnerability

If you find a security issue, please don't open a public issue. Instead:

- **GitHub private advisory**: [Report a vulnerability](https://github.com/crysallis/MeerBot/security/advisories/new)

Include a description of the issue, the affected component, and steps to reproduce if possible. I'll respond as quickly as I can -- this is a personal project so no SLA, but I take security seriously and will act on real findings promptly.

## What to Expect

- Acknowledgement within a few days
- A fix or documented decision (won't fix + reasoning) once reviewed
- Credit in the commit/release notes if you'd like it

## Out of Scope

- Denial of service / resource exhaustion
- Issues requiring physical access to the host machine
- Vulnerabilities in third-party dependencies (report those upstream)
- The admin panel's local-only operations -- these are intentionally restricted to loopback origin and are not reachable remotely
