# Database backups

`backup-databases.js` -- nightly backup for this dashboard's own SQLite
databases (currently TC Elite Rollout and Workshop Board; add a new entry
to the `DATABASES` array at the top of the script if a future page gets
its own writable database).

## Why not just copy the `.db` file?

Both databases run in WAL mode (multiple staff editing concurrently is
the whole point of both pages). A plain file copy of `data.db` alone can
miss recent writes that are still sitting, uncheckpointed, in
`data.db-wal` -- this genuinely happened once during this project's
development, and is exactly the failure mode this script avoids.

Instead, this script uses `node:sqlite`'s own `backup()` function -- a
real wrapper around SQLite's official Online Backup API, not a file
copy. It is **safe to run while the app keeps running**: if
AmbientDashboard writes to a database mid-backup, the backup silently
restarts until it captures a fully consistent snapshot, rather than
producing a torn one. No need to stop the service for a routine backup.
Every completed backup is also verified afterward (`PRAGMA
integrity_check` + confirming it has real tables) before being counted
as successful -- a backup that silently didn't work is worse than no
backup, so a failed verification counts as a failed backup.

Zero new dependencies -- `node:sqlite` is a Node built-in, same one every
page's own `db.js` already uses. Requires Node >=23.8.0 (both dev and
production are on Node 24.x already).

## Where backups go

`../autotask-dashboard-backups/<db-name>/<db-name>-<timestamp>.db` --
deliberately a **sibling folder outside the git checkout**, not inside
`packages/*`, so a `git clean`/`git reset --hard` run against the repo
can never touch them. Override the location by setting the
`WORKSHOP_DASHBOARD_BACKUP_DIR` environment variable before running the
script (e.g. set it in the scheduled task itself, see below).

A `backup.log` file in that same root directory accumulates one line per
backup attempt (success, failure, or pruned-old-file), on top of the
same lines being printed to the console -- useful for checking what
happened without digging through Task Scheduler's own history.

Backups older than 30 days are deleted automatically on each run (only
files this script itself created, matched by the `.db` extension inside
its own per-database subfolder -- nothing else in that directory is ever
touched). Change `KEEP_DAYS` at the top of the script to adjust.

## Running it manually

```powershell
cd C:\Apps\autotask-dashboard-git
node scripts\backup-databases.js
```

## Scheduling it on production (Windows Task Scheduler)

Run once, from an elevated PowerShell prompt, to register a daily
2am task (adjust `-At` to taste). Uses `node.exe`'s **full path**
deliberately -- Task Scheduler runs under a different account/PATH
than your own interactive session, so relying on plain `node.exe`
being found on PATH is a common way this kind of task silently fails.
Confirm the path below actually matches this machine first:

```powershell
(Get-Command node).Source
# e.g. C:\Program Files\nodejs\node.exe -- use whatever that prints below

$action = New-ScheduledTaskAction -Execute "C:\Program Files\nodejs\node.exe" -Argument "scripts\backup-databases.js" -WorkingDirectory "C:\Apps\autotask-dashboard-git"
$trigger = New-ScheduledTaskTrigger -Daily -At 2am
Register-ScheduledTask -TaskName "AmbientDashboard Database Backup" -Action $action -Trigger $trigger -Description "Nightly SQLite backup for TC Elite Rollout and Workshop Board" -RunLevel Highest
```

To test it fires correctly without waiting for 2am:

```powershell
Start-ScheduledTask -TaskName "AmbientDashboard Database Backup"
# then check:
Get-ScheduledTaskInfo -TaskName "AmbientDashboard Database Backup"
Get-Content "C:\Apps\autotask-dashboard-backups\backup.log" -Tail 10
```

## Restoring from a backup

Stop `AmbientDashboard`, copy the chosen backup file over the live
`data.db` (**also delete any `data.db-shm`/`data.db-wal` sitting
alongside it first** -- a stale WAL/shm pair from a different database
"generation" can mask what's actually in the restored file, the same
issue documented in each page's own `db.js`), then restart the service.
