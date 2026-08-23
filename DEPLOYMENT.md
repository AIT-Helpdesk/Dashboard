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

## Setting up the Autotask -> Strety automation (Windows Task Scheduler)

A separate one-time setup, additional to steps 0-9 above -- automatically syncs Autotask ticket counts into Strety Helpdesk Task Tracker scorecards on a schedule, using its own limited-access Strety connection (see `packages/strety-autotask-sync`'s own README for the full story: why it's a separate connection, what each metric's criteria is, the `409`/`PATCH` upsert behavior, etc.). Do this once the main dashboard is already deployed and running.

### 1. Create the automation's own `.env`

`packages/strety-autotask-sync/.env` is never in a `git pull` (gitignored, like the main `.env`) -- create it fresh on the server:

```
STRETY_AUTOMATION_CLIENT_ID=...
STRETY_AUTOMATION_CLIENT_SECRET=...
```

### 2. Add the production redirect URI in Strety

The automation's Strety OAuth app needs `https://dashboard.ambientit.com.au/auth/strety-automation/callback` added to its allowed redirect URIs -- confirmed Strety validates this exactly, not loosely (a mismatch fails with "The requested redirect uri is malformed or doesn't match client redirect URI"). Already done if this was added when the app was first created (see the package's own README).

### 3. Pull and restart

The new automation routes and the `@dashboard/strety-autotask-sync` package only take effect after a restart, same as any other code change -- but this particular update DOES need `npm install` (unlike most), since it's a brand-new workspace package that has to be linked:

```powershell
cd C:\apps\autotask-dashboard-git
git checkout -- packages/shell/nav-layout.json
git pull
npm install
Restart-Service AmbientDashboard
```

### 4. Connect the automation, once, via a real browser

Visit `https://dashboard.ambientit.com.au/auth/strety-automation/connect`, signed into the dashboard, and log in as the limited-access Strety account (not your own) to approve it. This writes `packages/strety-autotask-sync/.tokens.json` on the server -- separate from local's own copy of that file, and separate from the main dashboard connection's own token file.

### 5. Create the scheduled task

Runs `sync.js` hourly, **8am-6pm only** (by request -- Autotask ticket counts don't need syncing overnight when nobody's working), logging its output (`sync.js`'s own `[OK]`/`[FAILED]` detail per metric -- Task Scheduler's own history only shows a numeric exit code, not that detail, so redirecting to a real log file is the only way to actually diagnose a failed run later):

```powershell
New-Item -ItemType Directory -Force -Path C:\apps\autotask-dashboard-git\logs | Out-Null

$action = New-ScheduledTaskAction -Execute "cmd.exe" `
  -Argument '/c node packages\strety-autotask-sync\sync.js > logs\strety-autotask-sync.log 2>&1' `
  -WorkingDirectory "C:\apps\autotask-dashboard-git"

# Daily trigger starting 8am, repeating hourly for a 10-hour window -- fires
# at 8,9,10,11,12,13,14,15,16,17,18 (11 runs/day, last one exactly at 6pm;
# RepetitionDuration is inclusive of the occurrence that lands exactly on
# its own boundary). Native Task Scheduler support for "hourly, but only
# within a daily clock-time window" -- no separate script-side time check
# needed in sync.js itself.
#
# CONFIRMED (the hard way, against a real production task) that
# New-ScheduledTaskTrigger -Daily does NOT accept -RepetitionInterval/
# -RepetitionDuration as direct parameters -- combining them throws
# "New-ScheduledTaskTrigger : Parameter set cannot be resolved using the
# specified named parameters" (those two only belong to the -Once
# parameter set). The trigger object DOES still support a Repetition
# pattern regardless of type (it's a real Task Scheduler feature, visible
# in the GUI too) -- just not settable via this cmdlet's -Daily branch.
# Setting $trigger.Repetition.Interval/.Duration directly afterward looked
# like it worked (no error) but silently did NOT persist -- re-reading the
# registered task back showed blank Interval/Duration. What DOES work:
# build a real repetition pattern the ONE way the cmdlet actually supports
# (a -Once trigger, which is only used to harvest its .Repetition object,
# thrown away otherwise) and assign that WHOLE object onto the real Daily
# trigger, rather than mutating individual leaf properties on it.
$trigger = New-ScheduledTaskTrigger -Daily -At 8am
$repeatSource = New-ScheduledTaskTrigger -Once -At 8am -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Hours 10)
$trigger.Repetition = $repeatSource.Repetition

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable
Register-ScheduledTask -TaskName "AmbientStretyAutotaskSync" -Action $action -Trigger $trigger -Settings $settings `
  -Description "Hourly, 8am-6pm: sync Autotask ticket counts into Strety Helpdesk Task Tracker scorecards"
```

Runs as SYSTEM by default (no `-User` specified) -- fine here, since it only needs filesystem access to its own package folder and outbound HTTPS, nothing more privileged. The log is overwritten each run, not appended (`>` not `>>`) -- Strety's own check-in `context` notes are already the real audit trail of every value actually written, so this log is only for diagnosing a failed run, not a permanent record; unbounded growth wasn't worth it. Switch to `>>` if you want history instead.

**Changing an already-registered task's schedule later** (rather than a fresh setup): confirmed `Set-ScheduledTask -Trigger` does NOT reliably swap a trigger's TYPE in place (tried it against the real task -- the old `-Once`-with-repetition trigger stayed exactly as it was, no error, just silently unchanged). Unregister and re-register instead:

```powershell
Unregister-ScheduledTask -TaskName "AmbientStretyAutotaskSync" -Confirm:$false

$action = New-ScheduledTaskAction -Execute "cmd.exe" `
  -Argument '/c node packages\strety-autotask-sync\sync.js > logs\strety-autotask-sync.log 2>&1' `
  -WorkingDirectory "C:\apps\autotask-dashboard-git"
$trigger = New-ScheduledTaskTrigger -Daily -At 8am
$repeatSource = New-ScheduledTaskTrigger -Once -At 8am -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Hours 10)
$trigger.Repetition = $repeatSource.Repetition
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable
Register-ScheduledTask -TaskName "AmbientStretyAutotaskSync" -Action $action -Trigger $trigger -Settings $settings `
  -Description "Hourly, 8am-6pm: sync Autotask ticket counts into Strety Helpdesk Task Tracker scorecards"

# Verify: TriggerType MSFT_TaskDailyTrigger, StartBoundary ...T08:00:00,
# Repetition Interval PT1H / Duration PT10H / StopAtDurationEnd True.
$t = (Get-ScheduledTask -TaskName "AmbientStretyAutotaskSync").Triggers
$t.CimClass.CimClassName
$t.StartBoundary
$t.Repetition | Format-List *
```

This dashboard previously ran the sync **24/7** (`-RepetitionDuration (New-TimeSpan -Days 3650)`, ~10 years, off a `-Once -At (Get-Date)` trigger rather than a daily one) -- `-RepetitionDuration (New-TimeSpan -Days 3650)`, not `[TimeSpan]::MaxValue`, is still the right move if you ever DO want round-the-clock repetition again: confirmed against a real run `MaxValue` is too large to serialize into Task Scheduler's own XML duration format and gets rejected outright (`Register-ScheduledTask : The task XML contains a value which is incorrectly formatted or out of range`). A large-but-finite duration is the standard workaround for "repeat indefinitely" -- 10 years is far longer than this box will run unattended before someone touches it again anyway.

### 6. Verify it actually works before waiting for the first real hourly run

```powershell
Start-ScheduledTask -TaskName "AmbientStretyAutotaskSync"
Start-Sleep -Seconds 15
Get-ScheduledTaskInfo -TaskName "AmbientStretyAutotaskSync"   # LastTaskResult: 0 means success
Get-Content C:\apps\autotask-dashboard-git\logs\strety-autotask-sync.log
```

## Updating later

The project now has a real git remote (`AIT-Helpdesk/Dashboard` on GitHub, cloned at `C:\apps\autotask-dashboard-git` on the server), so updates are just:

```powershell
cd C:\apps\autotask-dashboard-git
git checkout -- packages/shell/nav-layout.json package-lock.json   # discard local-only changes to these two -- see below
git pull
npm install          # only if dependencies changed
Restart-Service AmbientDashboard
```

**Why the `git checkout` line, every time**: two files reliably drift out of sync with git on their own, for two different reasons, and either one blocks `git pull` outright ("Your local changes to the following files would be overwritten by merge... Aborting") if left uncommitted:

- `packages/shell/nav-layout.json` (the sidebar layout) can be edited directly on the server via its own `localhost:3000` (see README.md "Deploying the sidebar layout"). If that's happened since the last deploy, the file has local changes uncommitted.
- `package-lock.json` can end up with a local diff purely from running `npm install` on the server -- a different OS/npm version than wherever the committed lockfile was last generated can normalize/reorder it slightly, with no real dependency change involved. Confirmed against a real deploy: this alone was enough to abort a `git pull`.

Running `git checkout -- <path>` on both first always resolves this ahead of time (a no-op if there are no local changes, a clean discard if there are), so `git pull` never has anything to fail on. Deliberate for `nav-layout.json`, by request -- git is the source of truth for that file, any layout change made only on the server and never committed is expected to be lost on the next deploy. Just a practical necessity for `package-lock.json` -- its local drift is never a real deliberate edit worth keeping.

## Deploying TC Elite Rollout (first-time)

A separate one-time step, additional to the "Updating later" routine above, needed the first time `packages/tc-elite-rollout` lands on production. Two things about this page don't fall out of the ordinary update flow:

### 1. Confirm production's Node version first -- a hard blocker if it fails

This page's datastore is node's own built-in **`node:sqlite`** (`DatabaseSync`), which needs **Node >=22.5**. The original install step earlier in this doc only asked for "v20.x or later" -- if the server is still on an older Node 20 LTS install, the dashboard will throw the moment this code loads, not just this one page.

```powershell
node -v   # must be >= 22.5
```

If it's older, upgrade the same way as the original install (`winget install OpenJS.NodeJS.LTS`, or the MSI from https://nodejs.org/en/download), then confirm again with a fresh PowerShell window.

### 2. `npm install` is required this time, not optional

`@dashboard/tc-elite-rollout` is a brand-new workspace package (same situation as `strety-autotask-sync` when that was first added) -- it has to be linked in, so don't skip `npm install` even if you'd normally judge it unnecessary for a given update.

### 3. The real imported data has to be copied over as a file -- git pull alone won't bring it

`packages/tc-elite-rollout/data.db` is deliberately gitignored (runtime data, not source). After `git pull` + restart, the page will appear, but `db.js` just creates a fresh, **empty** SQLite database on the server -- none of the real client rollout data imported from the original spreadsheet. That data only exists as a file on whichever machine ran the import, and has to be copied over separately from git, the same RDP-clipboard-carries-files way the original deploy zip was copied in step 1.

**On the source machine, before copying**, stop that machine's own dashboard server first and checkpoint the WAL, so the single `data.db` file is complete and self-contained (WAL mode means the file alone can be missing recently-committed data until checkpointed/closed -- confirmed the hard way earlier in this page's own build, see its README):

```powershell
cd C:\apps\autotask-dashboard-git\packages\tc-elite-rollout   # or wherever the source copy lives
node -e "const {db}=require('./db.js'); db.exec('PRAGMA wal_checkpoint(TRUNCATE)');"
```

**Then copy just that one file** -- `data.db` (not any `-shm`/`-wal` sidecars; they should be gone/empty after the checkpoint above and aren't needed) -- to `C:\apps\autotask-dashboard-git\packages\tc-elite-rollout\data.db` on the production server. Do this **before** `Restart-Service AmbientDashboard` where possible -- if the service already started against an empty `data.db`, dropping a new file into place won't be picked up until it's restarted again anyway.

### 4. Verify

Visit the TC Elite Rollout page on the real domain and confirm the real client list shows up (not an empty grid) -- spot-check a client you recognize against what you know is actually true for them.

The sidebar's new "Process & Progress" category needs no separate step -- `nav-layout.json` is part of the normal git-tracked deploy, so it arrives with the regular `git pull`.
