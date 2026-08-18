# @dashboard/unallocated-service-calls

Dashboard page: a month calendar showing every Autotask **Service Call** that has no resource (technician) assigned to any of its linked tickets -- the staffing gaps most worth catching before the scheduled time arrives. Auto-loads on the current month, no client/date input needed (unlike most pages on this dashboard) -- a calendar is meant to just be there when you open it.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`, picked up automatically by the shell.
- `server.js` - Express router mounted by the shell at `/api/unallocated-service-calls`.

## "To Do" items aren't included

The original ask was for both unallocated **Service Calls and To Dos** -- Autotask's ticket UI has a "Service Calls and To Dos" tab with separate "New Service Call" and "New To-Do" buttons, both apparently landing in the same list. Investigated exhaustively against the real API before building this page:

- `ToDos` isn't a valid entity at all (`GET /ToDos/entityInformation/fields` returns a genuine 404).
- `ServiceCallTasks` links a Service Call to a **Project Task** (`taskID`), not a ticket -- irrelevant here since these tickets have no `projectID`.
- `Tasks` (Project Tasks) requires a `projectID` -- there's no ticket-linked variant.
- `Appointments` has a `resourceID` but no company/ticket link at all -- a personal calendar entry, not what's on a ticket.
- `TicketSecondaryResources` has no date/time fields, so it isn't calendar-schedulable regardless of what it represents.
- `CompanyToDos` exists (confirmed in the Autotask SDK's full entity list, ~300 entities) but is a CRM/company-level activity, unrelated to tickets.
- Directly tested by creating a real To-Do on a real ticket (`T20260818.0022`) via the Autotask UI and re-querying `ServiceCalls`/`ServiceCallTickets` for that company/ticket before and after: **no new row appeared in either entity**.

Conclusion: Autotask's REST API v1.0 does not appear to expose ticket-level "To Do" items through any entity reachable from this dashboard's Autotask SDK/MCP tooling. If a route to that data is ever found, this page is the natural place to add it -- until then, it's Service Calls only, and the intro text says so.

## Data model

Confirmed against real data (`ServiceCalls` has 16 fields, none of them a resource):

- A resource is assigned per **ticket linked to the call**, not to the call itself -- `ServiceCallTickets` (join: `serviceCallID` + `ticketID`) links a call to however many tickets it covers, and `ServiceCallTicketResources` (keyed by `serviceCallTicketID`, that join row's own id -- **not** the call or ticket id directly) is where a technician actually gets assigned.
- **"Unallocated"** means none of a call's linked tickets have any resource assigned at all -- checked across every `ServiceCallTickets` row for that call, not just the first one, since a call can cover more than one ticket. A call with zero linked tickets at all is also unallocated by definition (there's no other path to assign a resource).
- Scoped to calls whose `isComplete` is `false` -- a completed call has nothing left to staff, so it's not a real gap regardless of history. Confirmed the API accepts a plain `false` against this field even though its declared type is `short` (0/1), not boolean.
- Scoped to calls **starting** within the selected month (`startDateTime`) -- a calendar's natural placement, the day a call begins, not every day it might span.

Verified end-to-end against real August 2026 data: of 6 non-complete calls that month, 5 had a resource on their one linked ticket and 1 didn't (a fresh call with no resource added yet) -- the report correctly surfaced exactly that 1.

## The calendar grid

`buildMonthGrid()` in `server.js` returns full Monday-start weeks covering the whole month -- e.g. August 2026 (starts Saturday, ends Monday) needs the preceding Monday through the following Sunday, so the grid is always complete weeks (42 or 35 days), never a ragged first/last row. Computed server-side (`gridDates`, an array of plain `"YYYY-MM-DD"` strings) using the same `mondayOf()`/`weekDatesFrom()` AEST-calendar-arithmetic helpers Security Alerts' chart uses, so `client.js` doesn't need to duplicate any calendar math -- it just chunks the array into rows of 7.

Each cell shows the day number and, for days with unallocated calls, one entry per call: start time + company name, red-tinted (same "needs attention" convention flagged rows use elsewhere), linking out to the first linked ticket if there is one. Today's cell is accent-highlighted using the server's own AEST `todayKey`, not the browser's local date.

## Navigation

Prev/Next month arrows plus a Today button -- no manual month/date entry, since jumping more than a month or two away isn't really this page's use case (it's about catching gaps in the near term). `lastMonth`/`lastData` (module-scope) restore the last-viewed month instantly on a same-session re-mount, same convention as every other page.

## Caching

10-minute TTL (shorter than most pages' 20) -- a staffing gap is exactly the kind of thing that gets fixed within the hour once noticed, so a stale "still unallocated" here is more actively misleading than it would be on a page that isn't meant to prompt immediate action. A **Refresh** button next to Today always bypasses the cache for whichever month is currently shown -- Prev/Next/Today are happy to serve a recent cached view (they're for browsing), Refresh is the explicit "check again right now" action.
