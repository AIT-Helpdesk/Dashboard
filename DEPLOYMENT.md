# Deploying to the Windows Server cloud box

One-time move from local (`http://localhost:3000`) to `https://dashboard.ambientit.com.au` on the cloud server, reached via RDP. Do these roughly in order -- DNS needs a head start since it has to propagate before Caddy can issue a certificate.

## 0. DNS (do this first -- it needs time to propagate)

At whatever manages DNS for `ambientit.com.au`, add an **A record**: `dashboard` -> the cloud server's public IPv4 address. Give it a few minutes to propagate before step 6.

## 1. Get the code onto the server

From your local machine, `autotask-dashboard-deploy.zip` (in `C:\Users\AmberWorth\Claude\`) already has everything except `node_modules`, `.git`, and `.env` -- those get rebuilt/recreated fresh on the server. Copy it over:

- RDP in, then on your **local** machine right-click the zip -> Copy, switch to the RDP window, paste it onto the server's desktop (or wherever). RDP's clipboard carries files, not just text.
- Unzip it to e.g. `C:\apps\autotask-dashboard\` (Right-click -> Extract All).

## 2. Install prerequisites on the server

In an elevated PowerShell on the server:

```powershell
winget install OpenJS.NodeJS.LTS
```

If `winget` isn't available on this Windows Server edition, grab the LTS MSI directly from https://nodejs.org/en/download and run it. Confirm afterwards with a new PowerShell window:

```powershell
node -v   # should print v20.x or later
npm -v
```

## 3. Install dependencies

The `autotask-node` package lives on GitHub Packages, so `npm install` needs a GitHub personal access token (`read:packages` scope, `wyre-technology` org) in the environment -- same as the local Setup step in `README.md`:

```powershell
cd C:\apps\autotask-dashboard
$env:NPM_GITHUB_TOKEN = "ghp_your_token_here"
npm install
```

## 4. Create `.env` on the server

Create `C:\apps\autotask-dashboard\.env` (this file is never in the zip -- create it fresh here, don't copy your local one over RDP). Same Autotask credentials as local, but with production auth values:

```
AUTOTASK_USERNAME=...
AUTOTASK_SECRET='...'
AUTOTASK_INTEGRATION_CODE=...
PORT=3000

AUTH_CLIENT_ID=36cf5569-a3ba-44ff-b717-17c3ad5dbe48
AUTH_CLIENT_SECRET='...same secret value as local, or a fresh one from Entra...'
AUTH_TENANT_ID=98e99583-19c9-4ea4-887e-3e890be9bc70
APP_BASE_URL=https://dashboard.ambientit.com.au
SESSION_SECRET='generate a NEW random string here -- don't reuse the local one'
AUTH_ALLOWED_USERS=
```

Reusing the same Entra app registration (`36cf5569-...`) is simplest -- one place to manage, and you add a second redirect URI for it in the next step rather than creating a whole new app.

Generate a fresh `SESSION_SECRET` on the server itself:

```powershell
$bytes = New-Object byte[] 32
(New-Object System.Security.Cryptography.RNGCryptoServiceProvider).GetBytes($bytes)
($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
```

## 5. Add the production redirect URI in Entra

App registration `36cf5569-a3ba-44ff-b717-17c3ad5dbe48` -> **Authentication** -> Web platform -> **Add URI**:

```
https://dashboard.ambientit.com.au/auth/callback
```

Keep the `http://localhost:3000/auth/callback` one too if you still want to test locally sometimes -- an app registration can hold multiple redirect URIs. Save.

## 6. Install Caddy (reverse proxy + automatic HTTPS)

Caddy gets you a real Let's Encrypt certificate for the domain with almost no config, and proxies to the Node app running on `127.0.0.1:3000` (which, since the localhost-only binding change, is no longer reachable from outside at all except through Caddy).

```powershell
mkdir C:\caddy
# Download the Windows amd64 build from https://caddyserver.com/download and save as C:\caddy\caddy.exe
```

Create `C:\caddy\Caddyfile`:

```
dashboard.ambientit.com.au {
    reverse_proxy 127.0.0.1:3000
}
```

Test it manually first (leave this PowerShell window open):

```powershell
cd C:\caddy
.\caddy.exe run
```

Visit `https://dashboard.ambientit.com.au` from another machine -- Caddy should obtain the certificate automatically and you should see the Microsoft sign-in redirect. `Ctrl+C` to stop once confirmed; the next step makes it permanent.

## 7. Firewall

The cloud provider's network security group / firewall needs inbound **TCP 80 and 443** open (80 for the Let's Encrypt challenge and HTTP->HTTPS redirect, 443 for the app itself). Port 3000 should **not** be opened externally -- Node only listens on `127.0.0.1` now, so it's unreachable from outside even if 3000 were opened, but there's no reason to open it regardless.

## 8. Run both as Windows services (survive reboot and RDP logoff)

Without this, both processes die the moment you close the RDP session. [NSSM](https://nssm.cc/download) wraps any exe as a proper Windows service:

```powershell
# Extract nssm.exe somewhere, e.g. C:\nssm\nssm.exe, then:

C:\nssm\nssm.exe install AmbientDashboard "C:\Program Files\nodejs\node.exe" "server.js"
C:\nssm\nssm.exe set AmbientDashboard AppDirectory "C:\apps\autotask-dashboard\packages\shell"
C:\nssm\nssm.exe set AmbientDashboard Start SERVICE_AUTO_START

C:\nssm\nssm.exe install AmbientCaddy "C:\caddy\caddy.exe" "run --config C:\caddy\Caddyfile"
C:\nssm\nssm.exe set AmbientCaddy AppDirectory "C:\caddy"
C:\nssm\nssm.exe set AmbientCaddy Start SERVICE_AUTO_START

Start-Service AmbientDashboard
Start-Service AmbientCaddy
```

Check both came up:

```powershell
Get-Service AmbientDashboard, AmbientCaddy
```

## 9. Verify

Visit `https://dashboard.ambientit.com.au` from a machine that isn't the server itself. You should land on Microsoft sign-in, and land back on the dashboard signed in afterward -- same flow as the local `localhost:3000` test, just on the real domain.

## Updating later

There's no git remote configured for this project (checked: local repo, no `origin`), so future updates are the same manual copy: re-zip locally (same exclusions as `autotask-dashboard-deploy.zip`), copy over RDP, extract over the existing folder, `npm install` again if dependencies changed, then `Restart-Service AmbientDashboard`. Worth setting up a real git remote (a private GitHub repo) at some point so this is a `git pull` instead.
