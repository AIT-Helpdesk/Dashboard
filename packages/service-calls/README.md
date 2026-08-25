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

Three lines per entry, by request: the first is the start time and company name; the second is specifically the allocation state -- the resource name(s) in **green** (`.text-highlight-green`, same colour What's On's own Service Calls section uses for the same thing) if allocated, or the word "Unallocated" (default muted colour) if not; the third is the first line of the call's own description (an em dash when there's none), so all three are visible directly on the calendar without needing to hover. A description's first LINE specifically -- split on any real newline in the text and the first non-blank one used -- not just however much of the full (often multi-paragraph) description happens to fit before the cell's own width cuts it off. Each line truncates independently with an ellipsis if it's too long for the cell, rather than the whole entry wrapping unpredictably. Line 3 always renders, even with nothing to show, so every entry keeps the same three-line shape rather than descriptionless calls looking shorter than ones with one. Cells are sized (`.calendar-cell`, 50% taller than the page's original single-line design) to comfortably fit several entries before the per-cell scroll kicks in.

Color-coded the same way flagged cells are elsewhere on this dashboard, three states in priority order: **green** for a completed call (regardless of allocation -- nothing left to staff or review once it's done), **blue** for allocated-but-not-yet-complete (staffed, still upcoming/in progress), **red** for unallocated (the staffing gap this page originally existed to surface). Completed always wins over allocation state, since a finished call isn't a meaningful "gap" anymore even if it happened to go out unstaffed.

A separate, independent left-border accent layers on top of that fill for two specific `ServiceCalls.status` values, by request: a **gold** bar for **Onsite Arranged**, a **red** bar for **Onsite TBA**. These are recent additions to Autotask's own ServiceCalls status picklist (`103`/`104`) -- confirmed against the LIVE picklist via `ServiceCalls/entityInformation/fields` directly, after an external tool used during investigation turned out to be serving a stale, cached 4-value copy of the same picklist (`New`/`Complete`/`Canceled`/`Canceled by Client` only). `getPicklistLabels(client.serviceCalls, 'status')` in `server.js` resolves the label the same way every other picklist on this dashboard does, so it stays correct if Autotask adds further statuses later -- only the two "Onsite" labels specifically get the border accent, everything else gets none.

Hovering an entry shows its linked ticket(s) (number + title, with the ticket's own status on the line beneath it) AND the call's own description, if it has one -- both together, not one-or-the-other, since a call can have both a real linked ticket and a description explaining the work -- plus the allocation state, completion state, and the service call's own status, as a tooltip. Clicking an entry with a linked ticket opens that ticket in Autotask as a real popup window (not just a new tab -- same pattern as Client Financials'/Client Details' invoice links); one with no ticket link isn't clickable.

## Day detail popup

The day number in each cell is a button -- clicking it opens a real popup window (same "not just a new tab" convention as ticket links, via explicit `window.open` features) listing every entry **currently visible** in that cell (respects whichever of Show Unallocated Only / Show Completed are active, so it's the same set already on screen, not the unfiltered full day). Disabled (not clickable) on a day with zero visible entries.

Shows every detail otherwise only available by hovering an entry -- ticket number/title/status for EVERY linked ticket (the calendar entry itself only shows/links the first one, see the multi-ticket note above), the call's own description, full allocation state (who, or "Unallocated"), completion state, and service call status -- since there's no hover interaction available in a list this detailed. Built and written entirely client-side (`document.write` into the new window) from the already-loaded `lastData`, not a server round trip. The popup is a standalone document (not part of the shell page), so it can't inherit the dashboard's CSS custom properties -- `openDayPopup()` reads the current light/dark mode the same way `app.js`'s theme toggle does and inlines the matching literal color values, so it looks consistent with whichever mode the dashboard is actually in rather than defaulting to one fixed look.

## "Mine" outline

A full green outline (`outline`, not `border` -- avoids fighting the left-border accent's own color, and doesn't shift layout since an outline draws outside the box) on any entry where the signed-in user is one of the call's allocated resources. Resolved server-side from the dashboard's own auth session (`req.session.user.email` -> `resolveResourceIdByEmail()`, same pattern Ticket Times uses to pin the signed-in user's own group), never a query param, so there's no way to spoof "mine" via the URL. Independent of every other accent on the entry (fill color, Onsite left-border) -- combines with whatever else is already showing rather than replacing it. Verified against real data: two real August calls allocated to the signed-in user both correctly outlined, every other real call (allocated to other technicians, or unallocated) correctly not outlined.

Because `isMine` depends on who's asking, the report cache key (`getReport()`) includes the signed-in user's email alongside the month -- otherwise one user's cached response (with their own "mine" flags baked in) could leak into another user's view of the same month.

## The calendar grid

`buildMonthGrid()` in `server.js` returns full Monday-start weeks covering the whole month -- e.g. August 2026 (starts Saturday, ends Monday) needs the preceding Monday through the following Sunday, so the grid is always complete weeks (42 or 35 days), never a ragged first/last row. Computed server-side (`gridDates`, an array of plain `"YYYY-MM-DD"` strings) using the same `mondayOf()`/`weekDatesFrom()` AEST-calendar-arithmetic helpers Security Alerts' chart uses, so `client.js` doesn't need to duplicate any calendar math -- it just chunks the array into rows of 7.

Today's cell is accent-highlighted using the server's own AEST `todayKey`, not the browser's local date.

## Navigation

Prev/Next month arrows plus a Today button -- no manual month/date entry, since jumping more than a month or two away isn't really this page's use case. `lastMonth`/`lastData` (module-scope) restore the last-viewed month instantly on a same-session re-mount, same convention as every other page.

## Caching

10-minute TTL (shorter than most pages' 20) -- a staffing gap is exactly the kind of thing that gets fixed within the hour once noticed, so a stale "still unallocated" here is more actively misleading than it would be on a page that isn't meant to prompt immediate action. A **Refresh** button next to Today always bypasses the cache for whichever month is currently shown -- Prev/Next/Today are happy to serve a recent cached view (they're for browsing), Refresh is the explicit "check again right now" action.
