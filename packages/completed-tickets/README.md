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
- Excludes tickets with issue type 14 ("Monitoring Alert") -- client-side via `excludeMonitoringAlerts()` (`@dashboard/autotask-client`), NOT an Autotask query filter. A `noteq` query filter was confirmed (via a real user report on Tickets Created) to silently drop every not-yet-triaged ticket too, since Autotask's REST API treats `NULL != 14` as unknown rather than true -- see that function's own comment, and Tickets Created's README, for the full story (a real 6-of-7 undercount on one real day).
- Date filtering compares against **AEST** calendar-day boundaries for the selected date (`aestDayBoundsIso()`, `@dashboard/autotask-client`) -- not UTC, and not the server's own local clock.
- Resource and company names are resolved via `@dashboard/autotask-client` and cached in memory for the life of the server process.

## Time column

Each row shows the sum of `TimeEntries.hoursWorked` logged against that ticket -- **all** of its time entries, not just ones dated the same day as the ticket's completion. A ticket completed today can easily carry time logged on earlier days, and that work still counts toward "how many hours did this ticket take." Fetched via `fetchByFieldIn(client.timeEntries, 'ticketID', ticketIds)` (shared, `@dashboard/autotask-client`), one chunked query rather than a per-ticket lookup. Per-technician group headers and the page summary both total just their own tickets' hours.

Displayed as `HH:MM` (`formatHours()` in `client.js`), not Autotask's raw decimal (e.g. `1.2667`) -- rounded to the nearest minute, rolling over into the next hour rather than ever showing `:60`.

## Review? column

Reads the ticket's **"Ask For Review"** UDF (Autotask's own field label; the picklist values are `ASK` / `NO`) via `getTicketUdf()` (shared, `@dashboard/autotask-client` -- also used by the Asked for Review page) out of the `userDefinedFields` array the Tickets API includes on every ticket by default, no extra request needed. Blank when the UDF was never set on the ticket (its entry is present with a `null` value, or absent on older tickets).

## $ column -- scoped to the completing technician's own time, not the whole ticket

By request ("use these data sources and formulas for 'awaiting approve and post', posted and invoiced to show the dollar value of the times shown (only for the specific person, not the whole ticket)"). Deliberately a DIFFERENT scope from the Time column above: Time is the ticket's own all-time total across every technician who ever logged against it (see that section's own comment for why); $ is only the portion belonging to `completedByResourceID` -- the one resource each row/group is actually credited to -- via `resolveChargeableValue()` (`@dashboard/autotask-client`, shared with Ticket Times/Time Summaries; see its own comment for the real, 100%-verified rate formula) summed per `ticketID:resourceID` pair (`dollarsByTicketAndResource` in `server.js`). A ticket with real time from more than one technician never mixes their $ together under whichever one happened to complete it. Group headers and the page-level summary total the same way.

## Info line format

`{Date} - {Count} tickets - {total time summed} (h:mm) total - {$ total}`, by request ("change the info line ... to be like the one we just changed on Ticket Times") -- plain text throughout (no bold Count, no smaller/muted total), matching that page's own identically-worded change. Previously "**{Count}** ticket(s) completed on {Date} -- {total} (h:mm) logged against them".