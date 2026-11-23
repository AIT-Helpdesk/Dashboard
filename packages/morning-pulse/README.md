# @dashboard/morning-pulse

A scheduled, Datto-RMM-only overnight briefing -- "what should the team spend
their first hours on today", ranked by customer impact, not alert count.
Modelled directly on a real manual run done in chat on 2026-11-23 against
the real account (403 sites, 1577 devices) -- see `job.js`'s own header
comment for what that run found and what this package deliberately didn't
try to replicate (Datto's activity log; the MCP-connector-specific
page-budget caution, which doesn't apply to a plain `axios` call).

Separate from `@dashboard/whats-on`'s own "Today's Brief (Kaseya-MCP
Morning Pulse)" box, by request -- that box stays as-is; this is a fuller,
differently-ranked report with its own page, not a replacement.

## How it runs

Same `run.js`/`job.js`/`status.js` split as `@dashboard/strety-autotask-sync`
and `@dashboard/domain-itglue-gap`: `run.js` is the Windows Task Scheduler
entrypoint (loads the repo-root `.env`, calls `job.js`'s `runFullPull()`,
exits), `job.js` does the real work and writes the result to `last-run.json`
(gitignored, like every other package's own) via `status.js`. **The
dashboard page never calls Datto RMM live** -- `server.js`'s `GET /` just
reads `last-run.json` back. The page is always fast; the data is only ever
as fresh as the last scheduled run (see "Production setup" below for the
schedule itself).

A real run against the live account takes well under 10 seconds (confirmed
twice this session, 7-9s) -- far faster than an equivalent manual pull
through Datto's MCP connector, which is metered per tool call; this goes
straight through `@dashboard/datto-rmm`'s own `axios`-based REST client.

## What it checks, and what it deliberately doesn't

- **Site down** -- every device at a site offline, at least one of them
  infrastructure, most recently seen within 7 days (`DORMANT_AFTER_MS`).
- **Site outage / isolated drop** -- 2+ (or exactly 1) infrastructure
  devices newly offline since the overnight window started (previous
  working day 18:00 AEST; a Monday run covers the weekend -- see
  `computeOvernightWindowStartMs()`).
- **Monitoring gaps** -- an offline infrastructure device with no
  `online_offline_status_ctx` alert on file at all, open or resolved.
- **Disk / backup / file-system / AD-replication risk** on an ONLINE
  infrastructure device, from its own open alerts (`perf_disk_usage_ctx`,
  `backup_management_ctx`, an `eventlog_ctx` naming `Ntfs` + event `55`, a
  `comp_script_ctx` mentioning replication). Disk is additionally confirmed
  against the real free-space number (`getDeviceAudit()`), fetched only for
  devices that already have an open disk alert.
- **Flapping vs. scheduled shutdown** -- `classifyRecurrence()` groups a
  device's resolved `online_offline_status_ctx` alerts and checks whether
  the drop times (and resolve times) cluster within 20 minutes of each
  other across 2+ different days. Confirmed live against three real
  Azure-hosted client VMs (`RSC-TS01`, `GWP-AZ-TS1`, `MO-AZ-TS01`) that drop
  and auto-resolve at the same time most nights -- almost certainly a
  scheduled Azure shutdown firing a Critical "offline" alert every night,
  not a fault. A device recognized as "scheduled" is excluded from the
  isolated-drop/site-outage checks entirely -- **confirmed necessary**: the
  first real run landed mid-drop on `MO-AZ-TS01`'s own nightly window and
  reported it as both a new isolated outage AND a recognized schedule for
  the same event, before this exclusion was added.
- **Cross-site correlation** -- two or more DIFFERENT sites' devices
  recovering within 5 minutes of each other, more than once, flagged as a
  likely shared dependency (same Azure region/host) rather than separate
  faults.
- **Open Critical security-threat alerts** -- outside this skill's own
  scope (servers/infrastructure), but too sharp a signal to bury. Bounded
  to the last 21 days and a 15-row display cap -- confirmed live the first
  real run turned up open Critical alerts almost a year old (Datto doesn't
  auto-expire these), which is a stale-alert-hygiene problem, not "what
  happened last night".
- **Not built**: Datto's activity log (no wrapper exists in
  `@dashboard/datto-rmm`, and it added nothing on the night this was
  modelled against); a live "refresh now" button (the page only ever reads
  the last scheduled run -- see "How it runs" above); ESXi as its own
  infrastructure category (this account's real `deviceType.category`
  values, confirmed live, have no separate ESXi entry -- infra here is
  `Server` + any `Network Device (...)` variant).

## Capacity-based plan

Default `HOURS=3`, `TECHNICIANS=1` -> 180 minutes. Candidates are ranked
(site-down first, then disk/backup/AD risk, then everything else) and
packed greedily into that budget; anything that doesn't fit is listed under
`skippedForCapacity` rather than silently dropped.

## Extended in `@dashboard/datto-rmm`

Two additions to `packages/datto-rmm/lib.js` for this package, both
confirmed live against the real account before use:

- `fetchRawResolvedAlerts(maxPages)` -- `/v2/account/alerts/resolved` is a
  real, genuinely account-wide endpoint (confirmed; same shape/pagination
  as the existing `fetchRawOpenAlerts()`).
- `mapAlert()` now also carries `muted`, `ticketNumber`, `resolvedBy`,
  `resolvedOn`, `siteUid` -- purely additive, every existing caller is
  unaffected.

## Production setup (Windows Task Scheduler)

Not yet registered on production -- see `DEPLOYMENT.md`'s own section for
the walkthrough, same pattern as every other scheduled job in this repo.
Suggested schedule: once daily, early morning AEST (e.g. 6:00am) before the
team starts, well after the overnight window this report covers has closed.

```powershell
$action = New-ScheduledTaskAction -Execute 'cmd.exe' `
  -Argument '/c node packages\morning-pulse\run.js > logs\morning-pulse.log 2>&1' `
  -WorkingDirectory "C:\apps\autotask-dashboard-git"
$trigger = New-ScheduledTaskTrigger -Daily -At 6am
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Register-ScheduledTask -TaskName "AmbientMorningPulse" -Action $action -Trigger $trigger -Settings $settings `
  -Description "Daily 6am: Datto RMM overnight briefing for the Morning Pulse dashboard page"
```

## Not yet built

- A "run now" trigger for someone who wants a fresher-than-last-night view
  without waiting for 6am -- deliberately left out of this first version
  (see "How it runs" above); would need its own route and a spinner, same
  shape as `@dashboard/domain-itglue-gap`'s own `?force=true`.
- Surfacing this report's staleness on What's On (a "Morning Pulse hasn't
  run since X" banner), the same way `@dashboard/strety-autotask-sync`'s
  automation health already is -- not asked for yet.
