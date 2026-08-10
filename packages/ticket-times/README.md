# @dashboard/ticket-times

Dashboard page: pick a date, see every ticket with time logged against it that day across all clients, grouped by the technician who logged it. Same shape as Completed Tickets, but scoped by time entries rather than ticket completion -- a ticket doesn't need to be Complete (or even touched status-wise) to show up here, it just needs an hour logged on the chosen day.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`, picked up automatically by the shell.
- `server.js` - Express router mounted by the shell at `/api/ticket-times`.

## Date filtering

`TimeEntries.dateWorked` is a date-only field -- confirmed against real data that Autotask always stores it as midnight UTC of the calendar date the technician logged against, not a real instant with a time-of-day component. Unlike `completedDate`/`createDate` elsewhere on this dashboard, it needs no AEST offset conversion: an exact match (`eq`) against midnight UTC of the selected date IS the selected day, because that's the same calendar date the technician's own (AEST) clock showed when they entered it. Using the AEST day-bounds helper here would be solving a problem this field doesn't have.

Time can also be logged against Tasks (project work) with no `ticketID` at all -- excluded via an `exist` filter on `ticketID`, since this page is ticket time only.

## Time column

Shows only the hours logged **on the selected day**, not the ticket's all-time total (that's the Completed Tickets page's Time column, which is deliberately the opposite -- see its README). The same ticket can carry entries from more than one technician (or more than one entry from the same technician) on the same day; hours are summed per technician+ticket pair, so each technician's row shows only their own hours on that ticket for that day, never a colleague's hours or a combined total. If two technicians logged time against the same ticket on the same day, that ticket appears once in each of their groups, each showing only their own portion.

Displayed as `HH:MM` (`formatHours()` in `client.js`, same as Completed Tickets), not Autotask's raw decimal (e.g. `1.2667`) -- rounded to the nearest minute, rolling over into the next hour rather than ever showing `:60`.

Per-technician group headers and the page summary total just their own rows' hours the same way Completed Tickets does.

## Grouping

Grouped by `TimeEntries.resourceID` -- whoever logged the time -- not by the ticket's assigned or completed-by resource, since a ticket completed by one technician can easily have time logged against it by another. Entries with no `resourceID` land in "Unassigned" (same convention as Completed Tickets).

## No Review column

Completed Tickets has a Review? column (the "Ask For Review" UDF) since that page is specifically about completed work. This page is a time-tracking view independent of ticket status or completion, so that column doesn't apply here and was left out.

## Resource and company name resolution

Resolved via `@dashboard/autotask-client` (`resolveResourceName`, `resolveCompanyName`) and cached in memory for the life of the server process, same as every other page.
