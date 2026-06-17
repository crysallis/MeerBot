# Exposing the admin panel to RiffRaff leadership

The panel runs on the bot PC and binds to `127.0.0.1:3001`. To let Riff/Raff reach
it from their own machines we put a Cloudflare Tunnel in front of that local port
and gate it with Discord login. The panel never gets a public port; `cloudflared`
makes an outbound connection to Cloudflare and proxies traffic back to loopback.

## Access tiers (recap)

| Tier | Who | What they can do |
|---|---|---|
| **local** | A browser open directly on the bot PC (`http://127.0.0.1:3001`) | Everything, including reserved ops: bot restart, config edits, scheduled-job edits, scan-mode toggles, refresh-discord-data, command-permission edits |
| **manage** | Riff + Raff (remote, Discord login) | All day-to-day edits; the reserved ops above are blocked |
| **read** | RiffRaffian role (remote) | View only |
| (rejected) | Anyone else | Bounced at login |

## Configuring who can do what

Use the **Access tab** (visible only on the local PC). It has three sections:
- **Operations by tab** — set each action's required tier (read/manage/local).
  Defaults: restart / refresh / scan-modes / scan-authorized-user = `local`,
  every other edit = `manage`, all viewing = `read`.
- **Roles** — set each Discord role to none / read / manage (a role can never be
  `local` — that tier is the physical PC only).
- **Audit log** — recent changes, who made them.

Code defaults live in the `OPERATIONS` registry in `admin/auth.js`; the Access tab
writes overrides to `panel_op_access`, and role grants to `panel_roles`. Role-tier
changes apply at the user's next login.

## One-time setup

### 1. Discord OAuth2
Discord Developer Portal -> MeerBot app -> OAuth2:
- Add redirect: `https://admin.meerbot.dev/auth/callback`
- **Client ID** is the same number as your Application ID — the code reuses
  `APPLICATION_ID`, so you do not need to copy it.
- **Client Secret** is a separate credential (not the bot token). Click
  **Reset Secret** and copy it. This is safe: it does NOT invalidate the bot token,
  so the bot keeps running. (Never reset the *bot token* — that would break the bot.)

### 2. .env (on the bot PC)
Fill in the admin block (see `.env.example`):
```
ADMIN_PUBLIC_HOST=admin.meerbot.dev
ADMIN_OAUTH_REDIRECT=https://admin.meerbot.dev/auth/callback
DISCORD_CLIENT_SECRET=...   # from OAuth2 -> Reset Secret
SESSION_SECRET=<long random string>
# DISCORD_CLIENT_ID is optional · defaults to APPLICATION_ID
```
Generate a secret: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`

Then restart the admin process from an elevated terminal:
`pm2 restart meerbot-admin --update-env`

### 3. Cloudflare Tunnel
```
winget install --id Cloudflare.cloudflared
cloudflared tunnel login
cloudflared tunnel create meerbot-admin
cloudflared tunnel route dns meerbot-admin admin.meerbot.dev
```
Create `%USERPROFILE%\.cloudflared\config.yml`:
```yaml
tunnel: meerbot-admin
credentials-file: C:\Users\crysa\.cloudflared\<tunnel-id>.json
ingress:
  - hostname: admin.meerbot.dev
    service: http://127.0.0.1:3001
  - service: http_status:404
```
Install it as an always-on Windows service (so it survives reboots):
```
cloudflared service install
```

### 4. Keep the PC awake
The panel is down for everyone whenever this PC sleeps. Set Power & sleep ->
Sleep -> Never (at least while plugged in).

## Verify
1. Local browser to `http://127.0.0.1:3001` -> top-right shows "Local (this PC) ·
   local"; Restart Bot button visible and works.
2. `https://admin.meerbot.dev` from a phone on cellular -> Discord login. Riff/Raff
   account lands on the panel as `manage` (no Restart button); RiffRaffian as
   `read` (no edit controls); anyone else is rejected.
3. A remote manage user hitting a reserved endpoint gets 403 (server-enforced, not
   just a hidden button).
4. `panel_audit` table gains a row per change with the actor's Discord ID.

## Optional second factor
Layer Cloudflare Access (Zero Trust -> Access -> Applications) in front of
`admin.meerbot.dev` for an email/Google gate before traffic even reaches the app.
