# @dashboard/service-calls

Dashboard page: a month calendar of every Autotask **Service Call**, showing the resource(s) (technicians) assigned to each -- or flagging it as unallocated if none are. Auto-loads on the current month, no client/date input needed (unlike most pages on this dashboard) -- a calendar is meant to just be there when you open it.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`, picked up automatically by the shell.
- `server.js` - Express router mounted by the shell at `/api/service-calls`.

Originally built as "Unallocated Service Calls" (staffing gaps only); broadened by request to show every call with its resource(s), plus a toggle to narrow back down to just the unallocated ones.

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
- **"Allocated"** means at least one resource is assigned across ANY of a call's linked tickets. Every distinct resource found across all of them is shown (a call covering more than one ticket could in principle have different technicians on different tickets) -- `resourceNames` is the de-duplicated, alphabetically sorted list. **"Unallocated"** (`allocated: false`) means none of a call's linked tickets have any resource at all, including a call with zero linked tickets (there's no other path to assign a resource).
- Scoped to calls **starting** within the selected month (`startDateTime`) -- a calendar's natural placement, the day a call begins, not every day it might span.
- **Every** service call in the month is included regardless of completion status, by request -- this is a full "what's scheduled" calendar, not just a staffing-gap finder. (The page started life scoped to `isComplete = false` only, when it only showed unallocated gaps; that filter was dropped once the scope broadened to all calls.)

Verified end-to-end against real August 2026 data: of 6 non-complete calls that month, 5 had a resource on their one linked ticket and 1 didn't (a fresh call with no resource added yet) -- the report correctly showed all 6, with the 5 resourced ones correctly named and the 1 correctly flagged unallocated.

## Show Unallocated Only / Show All (toggle)

A link-styled button next to Refresh. Defaults to showing **all** calls; the button itself is labeled **"Show Unallocated Only"** (it names the action a click performs, not the current state), and clicking it filters the calendar down to unallocated calls only and relabels itself **"Show All"** for the click back. Purely a client-side filter over the already-loaded month's data (`showUnallocatedOnly`, module-scope, survives a same-session re-mount same as `lastMonth`/`lastData`) -- toggling it never re-fetches, since the server always returns the full month regardless of this setting.

## Show Completed (checkbox, off by default)

Same client-side-only pattern as the toggle above -- server always returns every call including completed ones (`isComplete` on each row), and this just filters the display. Off by default so a completed call (nothing left to staff or review) doesn't clutter the calendar; ticking it shows them too. Combines with "Show Unallocated Only" by AND (e.g. both active shows only calls that are BOTH still unallocated AND not complete -- a genuinely-completed call is never "unallocated" in the actionable sense once work is done, but the filter is literal about the `isComplete` flag either way).

The summary line always reflects what's actually filtered into view, not the server's raw month totals -- when completed calls are hidden, it says so explicitly (e.g. "7 service calls in August 2026 (1 unallocated, 8 total -- completed hidden)") rather than silently showing a total that doesn't match what's on the calendar.

## Calendar entries

Two lines per entry, by request: the first is the start time and company name, the second is specifically the allocation state -- the resource name(s) if allocated, or the word "Unallocated" -- so it's visible directly on the calendar without needing to hover. Each line truncates independently with an ellipsis if it's too long for the cell, rather than the whole entry wrapping unpredictably. Cells are sized (`.calendar-cell`, 50% taller than the page's original single-line design) to comfortably fit several two-line entries before the per-cell scroll kicks in.

Color-coded the same way flagged cells are elsewhere on this dashboard, three states in priority order: **green** for a completed call (regardless of allocation -- nothing left to staff or review once it's done), **blue** for allocated-but-not-yet-complete (staffed, still upcoming/in progress), **red** for unallocated (the staffing gap this page originally existed to surface). Completed always wins over allocation state, since a finished call isn't a meaningful "gap" anymore even if it happened to go out unstaffed. Hovering an entry shows its linked ticket(s) (number + title) AND the call's own description, if it has one -- both together, not one-or-the-other, since a call can have both a real linked ticket and a description explaining the work -- plus the allocation state and completion state, as a tooltip. Clicking an entry with a linked ticket opens that ticket in Autotask; one with no ticket link isn't clickable.

## The calendar grid

`buildMonthGrid()` in `server.js` returns full Monday-start weeks covering the whole month -- e.g. August 2026 (starts Saturday, ends Monday) needs the preceding Monday through the following Sunday, so the grid is always complete weeks (42 or 35 days), never a ragged first/last row. Computed server-side (`gridDates`, an array of plain `"YYYY-MM-DD"` strings) using the same `mondayOf()`/`weekDatesFrom()` AEST-calendar-arithmetic helpers Security Alerts' chart uses, so `client.js` doesn't need to duplicate any calendar math -- it just chunks the array into rows of 7.

Today's cell is accent-highlighted using the server's own AEST `todayKey`, not the browser's local date.

## Navigation

Prev/Next month arrows plus a Today button -- no manual month/date entry, since jumping more than a month or two away isn't really this page's use case. `lastMonth`/`lastData` (module-scope) restore the last-viewed month instantly on a same-session re-mount, same convention as every other page.

## Caching

10-minute TTL (shorter than most pages' 20) -- a staffing gap is exactly the kind of thing that gets fixed within the hour once noticed, so a stale "still unallocated" here is more actively misleading than it would be on a page that isn't meant to prompt immediate action. A **Refresh** button next to Today always bypasses the cache for whichever month is currently shown -- Prev/Next/Today are happy to serve a recent cached view (they're for browsing), Refresh is the explicit "check again right now" action.
