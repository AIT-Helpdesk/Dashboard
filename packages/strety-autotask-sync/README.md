# @dashboard/strety-autotask-sync

An automated job (not a dashboard page -- no `dashboardPage` in `package.json`, so the shell never tries to mount it) that counts things in Autotask and writes them as Strety check-ins on a schedule, without a human in the loop. Built to replace the one-time manual write done earlier for "NOT READY: EOD - Tickets at Set Priority - Should be None" (see What's On's README) with something that keeps itself current.

**Status as of writing**: connection plumbing and all four current metrics built and verified working end-to-end against real data (`sync.js` run for real, all four written successfully -- see `metrics.js` below). The actual periodic trigger (Windows Task Scheduler) is not yet set up on production -- every run so far has been manual.

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

Both gated behind the dashboard's own `requireAuth`, same as the main `/auth/strety/*` routes -- only an already-signed-in dashboard user can (re)connect this. Once connected, the token file this writes (`packages/strety-autotask-sync/.tokens.json`) is what the actual scheduled script (once built) reads directly -- it never needs the dashboard server running to do its own work, only for this one-time (or occasional re-auth) setup step.

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

## Not yet built

- The scheduling mechanism -- planned as Windows Task Scheduler running `node packages/strety-autotask-sync/sync.js` periodically on the production box, not an in-process timer inside the dashboard's own server (so a hung or crashing sync run can't take the dashboard down, and vice versa -- genuinely separate failure domains).
- Any status/health surfacing for THIS connection specifically on the dashboard (What's On's `reauth-required` handling, see its own README, currently only covers the dashboard's own default connection -- this one needs its own equivalent).
- Any more metrics beyond the four in `metrics.js` -- add an entry there, following the existing pattern, whenever one is specified.
