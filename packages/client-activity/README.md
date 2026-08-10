# @dashboard/client-activity

Dashboard page: type a client name, see ticket volume and logged hours for the last 12 months, a currently-open ticket snapshot, and the list of tickets created in that window. Single-client only, same reasoning and resolution flow as Client Financials (`resolveSingleCompany()` in `@dashboard/autotask-client`, shared) -- a wildcard matching more than one company returns a clickable list to pick from rather than guessing or merging.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`, picked up automatically by the shell.
- `server.js` - Express router mounted by the shell at `/api/client-activity`.

## Ticket scope

Every ticket ever raised for the resolved company is fetched up front (not just ones in the 12-month window), excluding "Monitoring Alert" (`issueType = 14`, same convention as Completed Tickets / Tickets Created). The full set is needed for two reasons beyond the "Created" count: a ticket opened well before the window can still be open today (the snapshot section), and it can have fresh `TimeEntries` logged against it this month even though the ticket itself is old.

## What counts as "done"

Autotask has a per-status "SLA Event" admin setting (None / First Response / Resolution Plan / Resolved), and the intent here is "any status whose SLA Event is Resolved counts as done" -- but that mapping is NOT exposed anywhere in the REST API's field or picklist metadata (confirmed by grepping the full `Tickets` `entityInformation/fields` response for "sla" and finding nothing; it's admin-config-only, e.g. the Ticket Categories/Statuses screen). Absent API access to the real mapping, `DONE_STATUS_PATTERNS` in `server.js` matches by status LABEL instead, using the dashboard's standard wildcard convention (`matchesWildcard()`, shared): `complete`, `fix*`, `maybe done*`, `needs*`, `close if no reply`, `shipping confirmation`, `ready*`, `billing - *`, `rewst - stage done`. `computeDoneStatusIds()` resolves these against the live status picklist once per request, so a status renamed or added later that matches one of these patterns is picked up automatically -- no hardcoded ID list to maintain.

## Ticket volume table

**Created** counts tickets whose `createDate` falls in the window. **Completed** date: status 5 ("Complete") uses `completedDate`, the one status Autotask actually populates it for; every other done status (per the patterns above) falls back to `resolvedDateTime`. Both are bucketed into the 12-month window's **AEST** months, not UTC (`monthKeyOf()`, `@dashboard/autotask-client` -- same helper Client Financials uses).

## Currently Open snapshot

"Open" = not one of the done statuses above. This org's `Tickets.status` picklist has around 60 custom values (many sales/reception/workflow states, not just a clean "open vs closed" pair), so rather than hardcode a taxonomy for what counts as open, every non-done ticket's actual status label is counted and shown, sorted by count descending -- same "let the real data speak" approach as Clients by Classification's "Unclassified" bucket. Priority gets the same treatment (`Tickets.priority` is similarly a large custom list). Not date-scoped -- this is a right-now snapshot, so an old ticket that's still open belongs in it regardless of when it was created.

By request, every `TO DO*` status (`TO DO`, `TO DO - Configure`, `TO DO - Investigate`, `TO DO - Renewal`, ...) collapses into a single `TO DO` row in the STATUS breakdown only (`groupToDoStatuses()` in `server.js`, via `matchesWildcard()`) -- the priority breakdown is unaffected.

## Hours Logged table

Billable vs non-billable (`TimeEntries.isNonBillable`), summed from `hoursWorked`, bucketed by `dateWorked` into the same 12 months as the ticket table. `TimeEntries` has no `companyID` of its own -- only `ticketID`/`taskID` -- so it's joined via the full company ticket-ID set described above (`fetchByFieldIn()`, chunked). **Scope limit:** only time entries linked to a *ticket* are counted; time logged against project tasks (`taskID`, no `ticketID`) isn't covered here, since that would need a separate Tasks -> Projects -> companyID join this page doesn't do yet.

## Recent Tickets: Incomplete / Completed split

The list of tickets created in the window is split into two sections -- **Incomplete** and **Completed** -- using the same done-status check as the Currently Open snapshot above (`doneStatusIds`/`DONE_STATUS_PATTERNS`), not a separate rule. Each ticket carries a `done` boolean in the API response for this.

## Recent Tickets: Priority and Time to Close columns

**Priority** shows only the first word of the ticket's priority label, and only when that word is exactly 2 characters (e.g. `P2 - CLIENT ADVISED` -> `P2`, `!! SET PRIORITY` -> `!!`) -- anything that doesn't reduce to a short code (`Information`, `ONBOARDING`, ...) shows blank. This is deliberately a display simplification for this one column only; the Currently Open snapshot's "By Priority" breakdown still uses full labels, since collapsing distinct priorities to blank there would make the breakdown meaningless.

**Time to Close** is `Tickets.resolvedDateTime` minus `Tickets.resolutionPlanDateTime` -- both are direct fields on the ticket holding the actual timestamp each SLA event fired (not a running history of every time a status was entered), so this is already "from the *last* Resolution Plan event to Resolved" by construction, with no separate history/audit lookup needed. Blank when either event never fired, or on the (data-anomaly) case where Resolved precedes Resolution Plan. Formatted as `Xd Yh` when 24 hours or more, `Xh Ym` otherwise.

## Adding more criteria / sections

This page follows Client Financials' shape closely (single-client resolution, 12-month window, month-by-month summary table(s) plus a list). If the two pages' structure keeps converging, the shared frontend rendering logic (currently duplicated in each page's `client.js`, unlike the server-side helpers already in `@dashboard/autotask-client`) would be a reasonable next consolidation.
