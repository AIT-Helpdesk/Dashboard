# @dashboard/saas-protection

Dashboard page: Microsoft 365 backup health for every client, via Datto SaaS Protection -- a client list sorted worst-backup-% first, plus five whole-account widgets (All Backups, All Backups Failed, Some Backups Failed, Clients Succeeded, Accepted Failures) that classify every client by whether its application-type backups (Exchange/SharePoint/OneDrive/Teams) are actually succeeding. Reads exclusively from Datto SaaS Protection's own REST API (`api.datto.com` -- a wholly separate Datto product/API from Datto RMM, with its own Partner-Portal-issued key pair) plus a small local SQLite database for "accepted failure" records; no Autotask or other vendor involvement beyond that.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`.
- `server.js` - Express router mounted by the shell at `/api/saas-protection`.
- `db.js` - the "accepted failures" SQLite table (`node:sqlite`'s `DatabaseSync`, same zero-new-dependency convention Contract Checks/TC Elite Rollout use), stored at `data.db` in this package's own directory.

## Two tiers of backup data, and why both exist

- `GET /domains` returns one row per M365 tenant, unpaginated, each already carrying a ready-made `backupStats.backupPercentage` -- the cheap, bulk-fetchable source behind the main client table (cached 30 minutes).
- The real per-application-type status (what's actually failing, and why) is **not** in that aggregate at all -- it needs a separate `/​{customerId}/applications` call **per client**. `activeServicesCount`/`activeServicesWithRecentBackupCount` on the `/domains` row turned out to be a seat-equivalent count, not a services breakdown, confirmed against real data -- so every widget beyond the main table's own Backup % column is built from this heavier per-client pass instead (`computeServiceAggregate()`), bounded-concurrency fetched across the whole account (~230+ real clients) and cached as one aggregate for 30 minutes.

A handful of customer IDs (confirmed ~14 of 234) consistently return a Datto-side 500 on their own `/applications` endpoint -- those clients are excluded from classification entirely (not guessed at) rather than failing the whole aggregate.

## Deriving one application type's real status

`lastFullyProtectedTime` is **not always a timestamp** -- confirmed against real data: a healthy app type carries an epoch-ms string, but one that isn't protected carries an enum string instead (e.g. `OVER_10_DAYS_AGO`, `INGESTING_SERVICES`). The real "what's wrong" signal is `backupHistory`'s own most recent rolling-window bucket (`Between0dAnd1d`)'s human-readable `status` ("Perfect", "Backup With Issues", "Backup With Lots Of Issues", "Insufficient History") -- falling back to the humanized enum only when there's no history bucket at all yet (a freshly-added app type).

## Accepted Failures ("I know, don't keep counting it")

Any (client, application type) pair with a real failure can be marked an Allowed-style exception with an end date ("Accept Until") -- stored in `db.js`'s `accepted_failures` table, keyed `UNIQUE(customer_id, app_type)`. An **active** acceptance (end date not yet reached) excludes that pair from every classifying widget entirely -- counted as neither success nor failure, as if it hadn't happened. One that has since **lapsed** still counts as a real failure, but carries its lapsed record along so the UI can show "Failure accepted for X to Y." Re-accepting an already-accepted pair only ever moves its end date (and who/when) forward -- the original `start_date` set on first acceptance is preserved by the `ON CONFLICT` upsert, by request ("leave the commencement date of the failures as is"). Accepting is a pure DB write with no live Datto call, so it's instant; the already-warm in-memory aggregate cache is patched in place (`patchServiceAggregateCache()`) rather than waiting for the next 30-minute recompute.

## The five widgets, and the "Load from Cache" vs. "Get Full Refresh" split

All four classifying widgets (All Backups' two-color ring, All Failed, Some Failed, Succeeded) come from the **same** per-application aggregate pass, so a client can never appear in a bucket the ring itself disagrees with. The fifth (Accepted Failures) is a cheap DB-only count of currently-active acceptances.

Two distinct refresh tiers on screen, by request:
- **Load from Cache** (and typing a client-name filter) -- reuses whatever's already cached, both client-side and server-side; cheap, no live Datto pull unless a cache has genuinely gone stale.
- **Get Full Refresh** -- `force=true` on every request, bypassing *every* cache including the ~230+-call aggregate, and clears every client-side cache too so nothing silently masks what was just forced fresh. Can take up to 2 minutes; a warning banner appears if the widgets are still loading past a 3-second grace period.

## Scheduled background refresh

A fixed, predictable schedule (AEST-anchored) re-warms the aggregate once an hour at :02 past the hour, 7am-5pm AEST only -- replacing an earlier always-on 15-minute `setInterval` warmer that kept re-hitting the handful of permanently-500ing customers around the clock regardless of whether anyone was using the page. A manual Get Full Refresh from a user still always wins (its own `force=true` bypasses this schedule entirely).

## Per-client detail popup

Clicking a client name fetches that one client's own `/applications` (30-day history variant, matching Datto's own Partner Portal "Backup Status" chart window) and `/seats`. The per-seat table shows a "Last Successful Backup" column even though Datto's `/seats` endpoint carries no per-seat backup date at all (confirmed -- checked that endpoint, its own `detailedBackupStats` endpoint, and the activity log; none expose one) -- each seat's `seatType` is mapped to the application type that actually backs it up (e.g. `User`/`SharedMailbox` → Exchange) and that application's own last-successful-backup time is shown instead, labeled honestly via a tooltip rather than presented as seat-specific.

## Caching

- `/domains` (main table): 30 minutes.
- Per-client applications/seats detail: 30 minutes each, cached independently so a widget bucket that only needs applications doesn't also pay for seats.
- The whole-account service aggregate (all four classifying widgets): 30 minutes, with in-flight de-duplication, plus the hourly scheduled warm described above.
- Accepted Failures count: no cache -- always a fresh, cheap local DB read.
