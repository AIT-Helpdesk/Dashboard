# @dashboard/today-things

A TV Boards page ("Today Things"), by request -- meant to be glanced at on a wall display, not clicked through like a normal work page. Service Calls is the first section ("Let's put Service calls on this page first"); more sources are expected to be added here later, same "start with one, grow it" spirit External Page Builder/Tab Page Builder already follow for other kinds of pages.

- `client.js` -- frontend module. Exports `id`, `label`, and `mount(container)`.
- `server.js` -- Express router mounted by the shell at `/api/today-things`. Read-only -- see "No writes of its own" below.

Everything renders inside a `.today-things-page` wrapper, doubled in size via `zoom: 2` (by request, "make all the text on Today Things twice as big") -- same convention Workshop's own Rotation View uses for this identical need. `zoom` scales the whole rendered subtree as one multiplier, unlike a plain font-size bump, which would only hit text that happens to inherit it directly and leave everything else (pills, gaps, padding) at their normal size -- most of this page's own font-sizes are in `rem`, always relative to the document ROOT font-size, not any ancestor's.

## Three day-scoped groups, each two views side by side

Three rows of two columns each, by request:

1. **Today** -- every incomplete call scheduled today.
2. **Tomorrow** -- every incomplete call scheduled tomorrow.
3. **Overdue** -- incomplete calls from before today (a rolling 2-week lookback), whose linked ticket is still open. Same `requireOpenTicket`/2-week-window reasoning as What's On's own past-incomplete service call group (`packages/whats-on/server.js`) -- confirmed against real data that dropping this filter pulls in well over a thousand ancient rows on tickets that closed ages ago, noise rather than anything actionable on a wall display. Today and Tomorrow deliberately do NOT apply this filter -- both are recent enough that a still-open appointment is worth seeing even before anyone's had a chance to react to it.

Each of the three groups is shown as two columns side by side:

- **Chronological** (left) -- sorted by start time, same default order Service Calls' own page and What's On both already use. Overdue is the one exception: sorted latest-first (by request-equivalent reasoning to What's On's own identical ordering) -- the most recently missed call surfaces at the top rather than the bottom. Every row here additionally shows two bold-labeled detail lines, by request (previously available only via hover tooltip): **Ticket Number:** `<number> -- <title>` (or "No ticket linked"), then **Service Call / Ticket Status:** `<service call status> / <ticket status>` (just the service call status alone when there's no linked ticket).
- **Grouped by Allocated Resource** (right) -- the SAME rows, grouped by resource instead, **Unallocated sorting first** (by request), each named resource's own group after it alphabetically. A call with more than one resource forms its own combined-name group (`resourceNames.join(', ')`) rather than being split across each individual resource's group -- picking one grouping key per call, not fanning it out, same simplicity every other join on this dashboard defaults to absent a specific request to do otherwise. Each group's own heading is colored -- blue for a real resource name, red for "Unallocated" -- same `var(--accent)`/`#dc2626` convention `.text-highlight-blue`/`.text-highlight-red` use for that identical distinction everywhere else on this dashboard. Rows in this view don't repeat the allocated-name/Unallocated text before the description (by request) -- the group heading already says who's allocated, and don't show the two detail lines either -- those are chronological-list-only.

Each column's header is a colored pill (by request) -- green **Today**, amber **Tomorrow**, red **Overdue** -- the same 3-color `.tt-tag--today`/`--tomorrow`/`--overdue` palette What's On's own day tags already use, just promoted to the column title itself rather than a per-row tag. The right-hand column additionally shows a small muted "by Resource" label next to its pill. The header row itself has no background fill and just enough padding to fit the pill (by request) -- a deliberately thin bar, not the bigger card-title look `.resource-group-header` normally has elsewhere (scoped to this page's own columns via `.today-things-column .resource-group-header`, not a change to that shared class itself). No `<h1>` page title either (removed by request) -- a wall-display board doesn't need one; the Refresh button sits alone, right-aligned.

No day tag/date badge on individual Today/Tomorrow rows (unlike What's On's identical row shape, which mixes today/tomorrow/overdue in one list and needs one) -- each of those two tables is already single-day via its own column pill, so a tag would just repeat what the header already says; their rows show a plain `.tt-time`. Overdue rows are the one exception -- since that table alone can span up to 2 weeks of different dates, each row's date+time together (e.g. "30 Aug, 02:00") replace the plain time inside the same red `.tt-tag--overdue` pill, by request.

An empty column (nothing scheduled) is left as a plain empty box, by request -- no "Nothing scheduled." message. A wall display reads an empty box as "nothing here" on its own; the count badge in the header (e.g. "(0)") already says so too.

Boxes sit close together, by request -- a 3px gap between columns and between the three row groups (`.today-things-columns`' own `gap`/`margin-bottom`), with `.resource-group`'s usual 1rem trailing margin overridden back to 0 on this page's own columns (Grid doesn't collapse a child's margin against the container's own gap/margin the way normal block flow would, so left alone it would silently double up).

## Row shape and formatting -- a direct port of What's On's own Service Calls section

By request ("Use similar formatting as the Service Calls section on the What's On page including the links to Ticket, Change Date and Status Updates"). `client.js`'s `serviceCallRowHtml()`/`openServiceCallMenu()`/`openChangeDateTimeModal()` are near-duplicates of that page's own copies (`packages/whats-on/client.js`) -- not shared code, just the same established shape, since these are separate page packages (same convention every other near-identical modal/row on this dashboard already follows, e.g. Service Calls' and What's On's own two copies of this exact same popup).

- Blue `<resource names>` / red "Unallocated" allocation text on the chronological (left) list, same `.text-highlight-blue`/`.text-highlight-red` classes used dashboard-wide (the by-Resource list carries this same distinction on its group heading instead -- see above).
- Hovering a row shows the linked ticket's number/title/status (when there is one) plus the service call's own status, via a plain native tooltip -- kept even on the chronological list (whose rows also show this visibly now), and still the only way to see it on the by-Resource list.
- Clicking anywhere on a row opens a popup menu: **Open ticket** (only when a ticket is actually linked), **Change Date/Time**, **Mark Complete/Mark Incomplete**, **Mark as Onsite TBA**, **Mark as Onsite Arranged**.

## No writes of its own -- every action is a cross-page call to Service Calls' own routes

This page's own `server.js` is entirely read-only. Every mutation from the popup menu above (`toggleServiceCallComplete()`, `setServiceCallStatus()`, the Change Date/Time modal's own save) calls straight through to `packages/service-calls/server.js`'s already-live routes (`PATCH /api/service-calls/:id/complete`, `/status`, `/datetime`) -- the exact same cross-page pattern What's On's own Service Calls section already uses for these identical actions. There's nothing about `ServiceCalls.isComplete`/`status`/dates that's specific to this page, so there's no reason to duplicate those writes here; see that package's own `server.js` for the full "why" behind each one (the PATCH-to-collection-endpoint shape, the real Autotask status values for Onsite TBA/Arranged, etc).

## Data fetch -- `buildServiceCallRows()`/`fetchTodayTomorrowOverdue()`

Same join/resolution logic as What's On's own `buildServiceCallRows()` (`packages/whats-on/server.js`) -- see that function's own comment for the full "why" (`ServiceCalls` has no resource field of its own; `ServiceCallTickets`/`ServiceCallTicketResources` have to be joined to find who's allocated). Trimmed down from that copy: no `currentUserResourceId` -- this page has no "Just Mine" filter (not asked for). `requireOpenTicket` IS carried over, used only by the Overdue query (see above).

Today's, Tomorrow's, and Overdue's calls are fetched and shaped **separately** (not merged into one list the way What's On's identical fetch does) -- this page renders them as genuinely separate tables, not one mixed list with a day tag telling them apart, so there's no reason to combine them here just to split them again client-side.

`isComplete = false` in all three queries, by request-equivalent reasoning to What's On's own identical filter -- an already-finished call isn't useful on a "what's happening" board the way it still is on Service Calls' own full calendar (which shows completed calls too, behind its own opt-in "Show Completed" toggle).

10-minute server-side cache (`CACHE_TTL_MS`), same reasoning Service Calls' own `REPORT_CACHE_TTL_MS` gives for its own identical window -- a staffing gap fixed within the hour should stop showing as unallocated promptly on a board meant to be glanced at through the day, shorter than the default 20-minute window most other pages here use.

## Not yet built

- Anything beyond Service Calls -- the page was deliberately started with just this one section, by request, more to follow later.
