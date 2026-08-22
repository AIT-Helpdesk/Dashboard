# @dashboard/asked-for-review

Dashboard page: pick any date, see every ticket that was asked for a Google review that week -- Monday through Sunday, broken out into a section per day.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`, picked up automatically by the shell.
- `server.js` - Express router mounted by the shell at `/api/asked-for-review`.

## Behavior notes

- "Asked for review" means the ticket's **"Ask For Review"** UDF (Autotask's own field label; picklist values `ASK` / `NO`) is `ASK` -- read via `getTicketUdf()` (shared, `@dashboard/autotask-client`, also used by Completed Tickets' "Review?" column). Tickets where the UDF is `NO`, blank, or never set are excluded entirely -- this page is a filtered subset, not every completed ticket with its review status shown.
- "Completed" uses the same definition as Completed Tickets: status ID 5 (Complete) matched on `completedDate`, plus status ID 20 (Billing - Contract) matched on `resolvedDateTime` since that status never gets a `completedDate` set. Excludes issue type 14 ("Monitoring Alert") -- client-side via `excludeMonitoringAlerts()` (`@dashboard/autotask-client`), not an Autotask query filter (a `noteq` filter was confirmed to silently drop every not-yet-triaged ticket too -- see Tickets Created's README for the real-data story).
- The selected date is only used to find its week -- the picked date itself doesn't have to be a Monday or Sunday. The week is Monday through Sunday (**AEST** calendar days, not UTC), computed from the selected date and always shown in full regardless of where in the week the picked date falls. A ticket's own completed/resolved timestamp is likewise bucketed into whichever day it falls on in AEST (`isoDateAest()`), not UTC. `mondayOf()`, `weekDatesFrom()`, and `isoDateAest()` are shared (`@dashboard/autotask-client`) -- Security Alerts' weekly chart uses the same Monday-Sunday week logic.
- Each of the 7 days is its own section (technician-group-styled heading, reused from Completed Tickets), in Monday->Sunday order, showing "None." when nothing in that day's results was asked for review.
- Within a day, tickets are sorted alphabetically by company.
- Resource and company names are resolved via `@dashboard/autotask-client` and cached in memory for the life of the server process.
