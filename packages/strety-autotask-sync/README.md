# @dashboard/strety-autotask-sync

An automated job (not a dashboard page -- no `dashboardPage` in `package.json`, so the shell never tries to mount it) that counts things in Autotask and writes them as Strety check-ins on a schedule, without a human in the loop. Built to replace the one-time manual write done earlier for "NOT READY: EOD - Tickets at Set Priority - Should be None" (see What's On's README) with something that keeps itself current.

**Status as of writing**: fully live on production -- connected, all four metrics in `metrics.js` verified against real data, running hourly and unattended via Windows Task Scheduler (see "Production setup" below), with its own health surfaced on What's On (see `status.js` below) if it ever stops working.

## A deliberately SEPARATE Strety connection, not the dashboard's own

This package has its own Strety OAuth app (its own client id/secret, in its own `.env` -- see below), its own token file, and its own limited-access Strety account -- entirely independent of the connection My Strety Tasks/What's On use. By request: an unattended automated write process should have its own narrowly-scoped credentials, not share the same access as everything else on this dashboard, so a bug or compromise here can't reach further than this one connection's own permissions.

This is what `@dashboard/strety-client`'s `createClient()` factory exists for (see that package's README) -- `client.js` here is the one place this package creates its own instance:

```js
createClient({
  clientId: process.env.STRETY_AUTOMATION_CLIENT_ID,
  clientSecret: process.env.STRETY_AUTOMATION_CLIENT_SECRET,
  tokenStorePath: path.join(__dirname, '.tokens.json'),
  connectPath: '/auth/strety-automation/connect',
})
```

## `.env` -- package-scoped, not the repo-root one

`packages/strety-autotask-sync/.env` (gitignored, like every other real credential in this repo), **not** the shared root `.env` every other package reads -- deliberately, so this connection's credentials live somewhere obviously separate rather than mixed in with everything else's. Contains:

```
STRETY_AUTOMATION_CLIENT_ID=...
STRETY_AUTOMATION_CLIENT_SECRET=...
```

Autotask access, by contrast, currently reuses the dashboard's existing root-`.env` credentials -- this side is read-only (counting tickets), a meaningfully lower risk than the Strety write access this package exists to isolate, so a second separate Autotask API user wasn't judged worth the extra administrative overhead. Revisit this if that judgment changes.

## Connecting it -- a real browser login, once, via the MAIN dashboard server

Strety's OAuth only supports `authorization_code` (confirmed against the real API -- see `@dashboard/strety-client`'s README), so there's no way around a real one-time browser round-trip to get the first token, same as the dashboard's own connection. But this package's own code is a periodic **standalone script with no server of its own** to catch that redirect -- so the one-time connect step happens on `packages/shell/server.js` instead (already a real, always-running, HTTPS-terminated server), via:

- `/auth/strety-automation/connect` -- redirects to Strety's real authorize screen, requesting `scope=read write` (this connection needs to write check-ins, same reasoning as the main connection's own scope -- see `@dashboard/strety-client`'s README).
- `/auth/strety-automation/callback` -- exchanges the resulting code, via `stretyAutomationClient.exchangeCodeForTokens()`.

Both gated behind the dashboard's own `requireAuth` (only an already-signed-in dashboard user gets this far), **and, as of 2026-08-28, further restricted to Amber only** (`STRETY_AUTOMATION_ADMIN_EMAIL` in `packages/shell/server.js`) -- confirmed root cause of a real incident where this connection ended up authorized as an employee's own Strety login instead of helpdesk@'s: the route was reachable by anyone, and a "Reconnect" link shown to every signed-in user on What's On (whenever the automation looked stale/broken) meant whoever clicked it got silently authorized instead, since Strety's login page reuses whatever Strety session is already active in that browser regardless of the `login_hint`. The matching visibility gate lives in `packages/whats-on/server.js` (`canSeeAutomationStatus`) -- everyone but Amber gets `automationStatus: null` for now, so the banner/link don't render for them at all. This is explicitly a temporary state while a permanent design gets decided, not the intended end state.

This connection's token file (`packages/strety-autotask-sync/.tokens.json`, via `stretyAutomationClient`) is required **only** by `packages/shell/server.js` (for this connect/callback pair) and by `sync.js` itself (for the actual scheduled writes) -- nothing dashboard-facing reads Strety data through it. Reconnecting it never changes what any signed-in user's own dashboard session sees; that always goes through each person's own `getPersonalClient(email)` connection instead (see `@dashboard/strety-client`'s README).

**Redirect URIs to register with the new Strety OAuth app**: `http://localhost:3000/auth/strety-automation/callback` (local) and `https://dashboard.ambientit.com.au/auth/strety-automation/callback` (production). **Confirmed required, not optional** -- Strety validates the exact redirect URI against a pre-registered list per OAuth app (the real error is `"The requested redirect uri is malformed or doesn't match client redirect URI"`); it has to be added (and saved) in the new app's own settings before `/auth/strety-automation/connect` will work, same as it presumably was for the main dashboard's own Strety app at some point in the past.

## `metrics.js` -- the list of what gets synced

Each entry: which real Strety metric (matched by **team + title**, with any `NOT READY:` prefix stripped before comparing -- not a hardcoded id, so it keeps working if that prefix is later removed once the automation is trusted) and a `countTickets()` function defining its Autotask query. `sync.js` treats finding zero or more than one matching Strety metric as a hard error for that one metric (not a guess) -- this is a write, and writing to the wrong record, or silently writing to nothing, is worse than a loud failure logged and moved past.

All four apply status not in `[Complete, Billing-Contract]` (this dashboard's standard "open" definition) -- the issueType/priority exclusions are applied in JS after fetching, **not** as Autotask API-level `notIn`/`noteq` filters, because Autotask's API-level `noteq`/`notIn` silently drops NULL values from matching (real tickets with no `issueType` set were wrongly excluded when this was tried at the API level first).

**Monitoring Alert (issueType 14) tickets are excluded on the first two, but deliberately INCLUDED on the last two, by request** -- these two care purely about priority (an automated alert escalated to a P1 priority is exactly as urgent as a human-raised one), unlike the dashboard-wide "exclude Monitoring Alerts" convention every other open-ticket count on this dashboard follows. This was a real correction, not a stylistic preference -- verified against real data the counts moved meaningfully once fixed (Urgent/Deadlines: `1` -> `11`; TODAY Jobs Missed: `5` -> `10`), confirming real Monitoring Alert tickets had actually been escalated to these priorities and were being missed.

- **"EOD - Tickets at Set Priority - Should be None"**: open tickets with priority `!! SET PRIORITY`, excluding Monitoring Alerts.
- **"EOD - Tickets Overdue - Should be None"**: open tickets, excluding priority `!! SET PRIORITY`/`!! TO BE SCHEDULED` and excluding Monitoring Alerts, whose `dueDateTime` is strictly in the past (a moment-in-time comparison, `lt now`).
- **"EOD - Urgent/Deadlines not actioned"**: open tickets (including Monitoring Alerts) with priority `P1 - CRITICAL` or `P1 - DEADLINE`, due today or earlier.
- **"EOD - TODAY Jobs Missed - Should be None"**: open tickets (including Monitoring Alerts) with priority `P1 - CANNOT BE MOVED`, due today or earlier.

The last two use "due today or earlier" -- a **calendar-date** comparison, deliberately different from Overdue's moment-in-time one (a ticket due later today already counts here, unlike Overdue which needs the actual deadline to have passed). `tomorrowAestMidnightUtcIso()` computes the real UTC instant of AEST midnight tomorrow and reuses the confirmed-working `lt` operator against it (`dueDateTime < tomorrow's AEST midnight` == "due today, AEST, or any earlier day") rather than risking an untested `lte` operator or an off-by-one at the day boundary.

Verified against real data: a real run wrote `3`, `188`, `11`, and `10` respectively (`sync.js` exit code `0`).

## `sync.js` -- create-or-update, not just create

**Strety enforces ONE check-in per metric per period** -- confirmed against the real API: a second `POST` for a period that already has a check-in (e.g. a second run the same day) gets a real `409 CONFLICT`. This isn't an edge case worth ignoring -- verified against real data it happens on literally the second-ever run, since the very first metric synced already had a manual one-time check-in from earlier the same day. `createOrUpdateCheckIn()` tries `POST` first; on a `409`, it reads the existing check-in's id straight out of the error body (`errors[0].meta.existing_check_in.id`, which Strety hands back for exactly this reason) and `PATCH`es that instead -- see `@dashboard/strety-client`'s README for the `patch()`/`If-Match` details this required adding to the shared client.

## `status.js` -- how What's On knows the automation is still working

After every run, `sync.js` writes its outcome to `last-run.json` (gitignored, like `.tokens.json` -- runtime state, not a credential, but still not checked in) via `writeLastRunStatus()` -- when it ran, whether it succeeded overall, and each metric's own individual result. What's On's `server.js` reads this back via `readLastRunStatus()` and surfaces a warning banner (with a `/auth/strety-automation/connect` button) if either:

- the last run **failed** (a real error, most likely this connection needing reconnecting -- same underlying cause as the main connection's own `reauth-required`, just a separate connection with its own separate failure), or
- the last run was **too long ago** (more than 3 hours, generous slack over the hourly schedule) -- catching a DIFFERENT failure mode a pure success/failure check can't see: the scheduled task itself has stopped firing entirely (disabled, box rebooted and it didn't come back, etc.), so there's no recent run to even check the success of.

Deliberately a plain file read, not a live API call from What's On -- checking this costs nothing extra against Strety's rate limit (see `@dashboard/strety-client`'s README, "Rate limiting"), unlike a proactive health-check request would. A healthy, current automation shows nothing at all -- same "silent when fine, loud when not" convention as the main connection's own `not-connected`/`reauth-required` messages.

## Production setup (Windows Task Scheduler)

Set up and verified working on the real production box -- see `DEPLOYMENT.md`'s own dedicated section for the full six-step walkthrough (`.env`, redirect URI, pull+restart, one-time connect, `Register-ScheduledTask`, verifying it actually ran). Two real gotchas hit and now documented there: `[TimeSpan]::MaxValue` is too large for Task Scheduler's own XML duration format (use a large-but-finite duration like 10 years instead), and `package-lock.json` can pick up local-only drift from running `npm install` on a different OS/npm version than wherever the lockfile was generated, which blocks `git pull` the same way `nav-layout.json` already could.

## Not yet built

Any more metrics beyond the four in `metrics.js` -- add an entry there, following the existing pattern, whenever one is specified.
