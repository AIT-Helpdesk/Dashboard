# @dashboard/completed-tickets

Dashboard page: pick a date, see every ticket completed that day across all clients, grouped by the technician who closed it.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`, picked up automatically by the shell.
- `server.js` - Express router mounted by the shell at `/api/completed-tickets`.

## Behavior notes

- "Completed" means Autotask ticket status ID 5 (Complete) or status ID 20
  (Billing - Contract). Both count by request.
- Status 5 tickets are matched on `completedDate`. Status 20 tickets never get a
  `completedDate` set (Autotask only populates it on the transition to status 5), so
  they're matched on `resolvedDateTime` instead - the closest equivalent to "when the
  work was actually finished," before the ticket got routed to billing. This means
  the two statuses need two separate API queries, merged in `server.js`.
- Status 20 tickets typically have no `completedByResourceID` (or `assignedResourceID`)
  in Autotask's data, so they land in the "Unassigned" group.
- Excludes tickets with issue type 14 ("Monitoring Alert").
- Date filtering compares against UTC calendar-day boundaries for the selected date.
- Resource and company names are resolved via `@dashboard/autotask-client` and cached in memory for the life of the server process.