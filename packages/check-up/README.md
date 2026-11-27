# @dashboard/check-up

Dashboard page: a live "how's the Support Desk doing right now" board for team leads -- the Helpdesk Handler for the day, today's/this week's/last week's billable performance per Support Desk resource, and a 13-week trend chart per resource. Reads only from Autotask (via `@dashboard/autotask-client`, plus an in-process call into `@dashboard/times`' own report-building functions for the underlying hours math).

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`.
- `server.js` - Express router mounted by the shell at `/api/check-up`.
- `helpdesk-handler.json` - the currently-set Helpdesk Handler, persisted to disk (see below). Not committed to git -- it's live operational state, not source.

## Sections, and why each loads the way it does

The page loads four tiers of data, deliberately **sequentially, not in parallel** -- confirmed live ("429 errors everywhere") that firing every section's Autotask calls at once roughly tripled this page's concurrent Autotask traffic on every mount/Refresh:

1. **Helpdesk Handler + Weekly Hours %** (`load()`) -- a dropdown of real Support Desk/Professional Services/Leadership resources (Professional Services and Leadership are shown but greyed-out via CSS, not `disabled`, so they're still pickable if genuinely needed) plus the team-wide Client Hours %/Billable Hours % for the current week.
2. **Billable Today** -- always a live, uncached fetch. The % denominator is "8:30am AEST to now", not each resource's total tech hours (which would swing wildly early in the day), and it freezes once 4:00pm AEST passes rather than continuing to grow into the evening.
3. **Billable This Week / Billable Last Week** -- same shape (Billable %, billable hours as HH:MM, estimated $, Tickets Closed) for the current and most recently completed Monday-Sunday week. This Week folds in today's own figures only once 4:00pm AEST has passed; before that it's Monday..yesterday only, with today treated as too partial to count. Both are served from an hourly cache shared across every browser, not re-fetched per page load.
4. **13-Week Trends** -- a dual-line chart (Billable % left axis, Tickets Closed right axis, both fixed scales -- 0-100% and 0-30 by default, the right-axis scale configurable via `.env`'s `13_WEEK_TREND_TICKET_COUNT_SCALE`) per resource, covering the last 13 full completed Monday-Sunday weeks (never the current in-progress week). This is the heaviest computation on the page (confirmed live at ~90 seconds for 5 resources, fully sequential server-side to stay under Autotask's rate limit), so it's cached for an hour server-side and, once loaded client-side, never re-fetched again within the same session.

## Helpdesk Handler persistence

The selected Handler is written to `helpdesk-handler.json` on disk, by request: it should be seen by every browser that loads the page and survive a server restart. There's no live push to an already-open tab -- a change is only picked up the next time a tab (re)loads the page, same convention as other file-backed shared settings on this dashboard (e.g. `nav-layout.json`).

## Resource $ estimate is a simplification, not a real chargeable value

The $ figure shown under Billable Today/This Week/Last Week is `billableHours * the resource's current Role's hourly rate` -- a deliberate simplification, not the full per-TimeEntry chargeable-value formula (`resolveChargeableValue()`) that Times/Ticket Times/Completed Tickets use. That fuller formula needs extra per-TimeEntry/BillingItems/WorkTypeModifier lookups this already rate-limit-sensitive page's lightweight auto-loading sections don't need. It can genuinely differ from a real invoice when Onsite/Emergency rate modifiers applied.

Each resource's Role is resolved from `ResourceRoles`, not `Resources.defaultServiceDeskRoleID` -- confirmed live that field is `null` for some real, actively billing Support Desk resources, so it isn't usable.

## Weekly Hours %, Tickets Closed moved in from Tickets Dashboard

The "Client Hours %"/"Billable Hours %" tiles and the Tickets Closed count were moved here verbatim from `@dashboard/tickets-dashboard`, by request ("Move the 2 Client Hours and Billable hours over to the new page from Tickets Dashboard"). Tickets Closed counts a ticket as closed on status 5 (Complete) using `completedDate`, OR status 20 (Billing - Contract) using `resolvedDateTime` instead -- status 20 never gets `completedDate` populated (Autotask only sets that on the transition to status 5). Monitoring Alert tickets (`issueType = 14`) are excluded client-side (`excludeMonitoringAlerts()`), never via an Autotask query filter -- a `noteq` filter was confirmed elsewhere on this dashboard to silently drop every not-yet-triaged ticket too.

## Caching tiers, summarized

- Handler options / Role hourly rates: 10 minutes (department membership and rates rarely change; this just avoids re-fetching the same thing 3-4x on one page load).
- This Week / Last Week figures: 1 hour, shared across every browser.
- 13-Week Trends: 1 hour, shared across every browser, with in-flight de-duplication so two concurrent cold-cache requests share one ~90s computation rather than each running their own.
- Today's figures and the Handler itself: always live/uncached.

A `force=true` query param threads all the way down through every one of these layers (including the handler-options cache nested inside the hourly caches) -- confirmed live as a real bug fix: a resource deactivated in Autotask kept showing a square for up to 10 minutes after the change even when every outer cache was being force-refreshed, because `force` wasn't originally passed into the nested handler-options lookup.
