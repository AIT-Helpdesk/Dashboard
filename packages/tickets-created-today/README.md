# @dashboard/tickets-created-today

Dashboard page: pick a date, see every ticket created that day across all clients, grouped by company.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`, picked up automatically by the shell.
- `server.js` - Express router mounted by the shell at `/api/tickets-created-today`.

## Behavior notes

- Filters on the ticket's `createDate` field, compared against **AEST** calendar-day boundaries for the selected date (`aestDayBoundsIso()`, `@dashboard/autotask-client`) -- not UTC, and not the server's own local clock. Any status is included (this is about creation, not completion).
- Excludes tickets with issue type 14 ("Monitoring Alert"), same as the Completed Tickets page -- see the real bug this had below.
- Company names are resolved via `@dashboard/autotask-client` and cached in memory for the life of the server process.

## Real bug, found via a real user report: the Monitoring Alert exclusion was silently dropping most of today's tickets too

A user reported a specific real ticket (`T20260822.0004`) missing from this page despite being created today. Traced to `excludeMonitoringAlerts()` in `@dashboard/autotask-client` -- confirmed against real data: this page (and four others, see that function's own comment for the full list) used to send `{ op: 'noteq', field: 'issueType', value: 14 }` as an **Autotask query filter**. Autotask's REST API applies standard SQL three-valued-logic NULL semantics to `noteq`: `NULL != 14` evaluates to *unknown*, not *true*, so a ticket whose Issue Type has never been set (routine right after creation, before a technician triages it) was silently excluded by the query itself -- not just miscategorized, genuinely never returned.

Confirmed against the real account, one real day (2026-08-22): of 10 tickets actually created that day, 3 had `issueType: 14` (genuine Monitoring Alerts), 6 had `issueType: null` (not Monitoring Alerts at all, just not yet triaged), and 1 had a real other issue type. The old query-filter approach returned **1** ticket. The real correct count is **7**. That's a 6-of-7 undercount on a single ordinary day, not an edge case.

Fixed by moving the exclusion out of the Autotask query entirely -- `excludeMonitoringAlerts()` now fetches normally and filters `tickets.filter(t => t.issueType !== 14)` in plain JS, where `null !== 14` behaves the way anyone reading the code would actually expect. Confirmed fixed against the real account: this page's own `totalCount` for that same day went from 1 to 7, and `T20260822.0004` is now correctly included.