<!-- Copilot / AI Agent instructions for the repository root `DiscordBotAfkJ` -->
# Agent Instructions — DiscordBotAfkJ

Purpose: help AI agents become productive quickly by describing where to look, common patterns, and safe workflows for this repository.

- **Project root**: `DiscordBotAfkJ/` — start here for any searches.
- **First-step checklist (automated discovery)**
  1. Open `package.json` (if present) and list `scripts`, `dependencies`, and `devDependencies`.
  2. Look for `src/`, `bot/`, `commands/`, `events/`, or `index.js` / `index.ts` to identify the entry point.
  3. Check for `.env` or `.env.example` for runtime configuration keys (DO NOT output secrets).
  4. Check `.github/workflows/` for CI build / test commands.

- **Big-picture architecture (how to infer it)**
  - If a `commands/` directory exists: the bot follows a command-handler pattern — each file exports a command object/function.
  - If an `events/` directory exists: event handlers are separated by Discord events (e.g., `messageCreate`, `ready`).
  - Look for a central `client` or `bot` init (e.g., `new Client(...)` in `index.js`) — that file wires commands, events, and login.

- **Project-specific conventions to look for**
  - Command files: usually export `{ name, description, execute(interaction|message, args) }` or `module.exports = { ... }`.
  - Config: environment-driven via `.env` and accessed with `process.env.*` or a small `config.js` wrapper.
  - Commands loaded dynamically: search for `fs.readdirSync` combined with `require`/`import` — modify loader only if adding many commands.

- **Developer workflows (commands to run / inspect)**
  - Install: `npm install` or `yarn` — inspect `package.json` to confirm package manager and scripts.
  - Run locally: look for `npm run start` / `npm run dev`; otherwise `node index.js` or `node ./src/index.js`.
  - Tests: run `npm test` if present; otherwise check for `tests/` or `__tests__/` folders.

- **Integration points & external dependencies**
  - Look for `discord.js`, `@discordjs/builders`, `typeorm` / `mongoose` / `pg`, or `redis` in dependencies to detect DB / cache / Discord libs.
  - If a `Dockerfile` or `Procfile` exists, prefer reproducing its steps to run the app in similar env.

- **Safe edit guidelines for AI agents**
  - Never commit secrets or values from local `.env` files. If a required key is missing, add an entry to `.env.example` instead.
  - When adding a command: follow existing file/export style and update the command loader (if one exists) rather than changing the loader pattern.
  - For formatting: honor existing code style; run `npm run format` if `prettier` or `eslint --fix` scripts exist.

- **Examples to check/modify (search for these filenames/strings)**
  - `package.json` — get scripts and start command
  - `index.js`, `index.ts`, `bot.js`, `src/index.js` — entry point
  - `commands/` and `events/` — add new features here
  - `.env.example` — add required env keys here
  - `.github/workflows/*` — mirror CI steps when running tests locally

- **When you don't know — ask these quick questions**
  1. Where is the canonical entrypoint (which file calls `client.login`)?
  2. Is there a preferred node/npm version (check `engines` in `package.json`)?
  3. Are there deployment steps (Docker, hosting provider) recorded elsewhere?

If this file is missing repository-specific details, update it after a quick scan of `package.json`, `index.*`, and any `commands/` or `events/` folders. Ask the repo owner for missing CI or run/launch details.

---
_Generated automatically. Please tell me any unclear areas to refine this to the project's specifics._
