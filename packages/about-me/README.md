# About Me

A personal-to-you snapshot page: pick a resource (defaults to whoever's
signed in) and see the day/week's worth of things that matter to them,
plus one company-wide section everyone should keep an eye on regardless
of who's picked.

## Resource picker

`GET /api/about-me/resources` returns everyone in the **Support Desk** and
**Professional Services** departments (Leadership Team excluded, same as
Times' Team selector -- see `fetchServiceDeskAndProfessionalServicesMembership`
in `@dashboard/autotask-client`, a shared helper both pages use), API users
excluded, sorted by name. The default selection is the signed-in viewer's
own resource (matched by email via `resolveResourceIdByEmail`) if they're in
that list, else the first resource alphabetically. Switching the dropdown
re-fetches everything for the newly selected resource -- this page can show
*anyone's* view, not just your own, which is deliberate (per Amber: useful
for a lead checking in on a team member).

**Picking someone else is Leadership Team only** (by request). Everyone
else gets a plain "Viewing: <their own name>" label instead of a
`<select>` -- locked to their own resource, no way to switch. This is
enforced on the server, not just hidden client-side: `GET /api/about-me`
re-derives the viewer's own Leadership Team membership from their session
email (`resolveViewerAuthorization()`, reusing the same
`fetchServiceDeskAndProfessionalServicesMembership()` helper's otherwise-
unused `leadership` set) and rejects a `resourceId` that isn't the
viewer's own with a 403 unless they're Leadership, regardless of what a
manually-crafted request sends. A non-Leadership viewer whose own resource
isn't in the Support Desk/Professional Services pool at all sees a plain
"not available for your account" message rather than silently falling
back to showing someone else's page.

## Layout -- two columns

Split into a **left column, 2/3 width** (the date-range-scoped activity:
Completed Tickets, Accrued Time, Ticket Times, Asked for Review) and a
**right column, 1/3 width** (Shifts, moved to the top -- then the four
sections the date range doesn't touch: Service Calls, Deadlines, Strety
Tasks). This is the SWAPPED arrangement -- originally the other way
round (forward-looking on the left, activity on the right) -- flipped by
request ("Put all the sections currently on the right on the left and
all the left items onto the right. put Shifts at the top of the right
side"), and re-proportioned by a later request ("use 2/3 of the page for
the left side and the remaining 1/3 for the right side",
`.about-me-columns`' own `grid-template-columns: 2fr 1fr`). No heading on
either column -- the left one originally read "Upcoming", removed by an
earlier request. Completed Tickets wasn't named in either swap-request
list -- kept leading its own column (unchanged position through the
swap), since it's the same date-range scope as the other three sections
in that column. Collapses to one column under 900px rather than
squeezing two columns of wide tables into too little room.

Two cards that used to sit on this page -- **Tickets Dashboard** and
**Subscriptions Expiring** -- were removed entirely, by request ("Leave
off 'Tickets Dashboard' section and 'Subscriptions Expiring'"). Their
server-side fetchers (and, for Tickets Dashboard, the now-unused Triage
Now/priority-12 query and the `@dashboard/ingram-client` dependency
Subscriptions Expiring needed) were removed along with the cards --
Deadlines below is the one remaining consumer of the shared Critical
(P1) query the old Tickets Dashboard card also used.

Every table on the page except Completed Tickets' and Accrued Time's is
50% wider than its card would otherwise make it (`.about-me-table--wide`,
`min-width: 150%`), by request ("so there's less wrapping") -- it
overflows its card and scrolls horizontally within it (`.about-me-table-
wrap`) rather than breaking the two-column layout. Accrued Time opts out
(`.about-me-table--auto`, `width: auto` instead) -- its other 3 columns
are short, centered numbers with nothing to stretch into, so widening it
just dumped the extra room as blank padding in the Ticket column; same
fix `@dashboard/accrued-time`'s own table already uses for this identical
shape of table.

**Every table stays in its light-mode colours even when the browser/page
is in dark mode**, by request -- background, text, borders, header row,
and alternating rows are all pinned (`:root[data-theme="dark"]
.about-me-table`, plus the matching `prefers-color-scheme` block), same
"colored bits stay pinned to light-mode regardless of theme" precedent
Times/Accrued Time's own tables established earlier this session, just
covering the WHOLE table here instead of only specific cells. The
group-heading strip sitting directly above a table (Service Calls' own
Allocated/Unallocated) is pinned the same way, for visual cohesion with
the now-always-light table underneath.

**Every card has a green outline** (`.about-me-card`, `#16a34a`), by
request ("put green outlines on all tables on the 'About Me' page like
the What's On page has") -- same green-bordered panel look What's On's
own top-level sections (`.tt-section`, `.wo-sc-section`,
`.wo-scorecards-section`) already use. Applied uniformly to all 8 cards,
Shifts' own included even though it's a plain list rather than a table,
for visual consistency across the column.

**Every card's own title is blue** (`.about-me-card h2.section-heading`),
by request ("like most other pages in the dashboard") -- same `--accent`
blue What's On's own Today & Tomorrow column headings already use. Scoped
to the `<h2>` tag specifically so it doesn't touch the `<div>`-based
group headings below a title (Service Calls' own Allocated/Unallocated),
which keep their own red/green.

**Every card's title also carries a row count** (`Service Calls (3)`,
etc.), by request ("Include times and/or counts ... as per other
instances of the same data on other pages") -- same `Title (N)` heading
convention `@dashboard/accrued-time`'s own page already uses. Strety
Tasks additionally carries "-- as of TIME" in its subtitle, matching its
own real source page, which shows the same timestamp; no other section's
own source page shows one.

**Every table's own header row is shaded blue too** (`.shaded-row`, added
to every `<thead><tr>`), by request ("all table heading shaded blue
please except where the colour of the heading has been deliberately set
to green or red") -- pinned to `.shaded-row`'s light value always (same
"tables stay light regardless of theme" policy), and deliberately NOT
applied to the group-level `.section-heading--red`/`--green` divs
(Service Calls' own Allocated/Unallocated), which keep their own real
red/green per the request's own exception.

**Ticket Times carries a sum of its "Time" column in the card's own
title**, next to the row count -- e.g. `Ticket Times (2, 01:51)`.
Originally added to the column's own `<th>` instead, moved up into the
title by request ("REMOVE THIS [the column-header sum]. I WANT IT UP IN
THE HEADING WHERE the sum of items is"). Service Calls' own "Time" column
is a clock time (when a call starts), not a duration, so it's
deliberately left out of this treatment.

**Accrued Time's title shows the ING/END\* discrepancy instead**, e.g.
`Accrued Time (4, Discrepancy 03:39)` -- by request, replacing an earlier
per-column (ING/END/NO Bill/STD/Other) breakdown entirely ("just show the
discrepancy ... only including the lines ... where the --END\* [is] less
than the --INGs ... sum them only"). Same real "Diff" figure
`@dashboard/accrued-time`'s own heading already shows: only rows where
END\* (`accrueEnd + accrueEndNoBill`) is below `accrueIng` by more than
the 5-minute variance (`accruedTimeIsRed(r)`, the same check the red row
shading uses) contribute, each as `accrueIng - endTotal(r)` -- rows that
are yellow or within variance contribute nothing, never a negative.
Verified against real data (Grant Armstrong): 3 of 4 real rows qualified,
summing to a real 03:39.

**Every card carries a "<Item> Page" button, right-justified on its own
title row**, by request -- same `.button-link.button-link--small` pill
look/colouring What's On's own "Show All Service Calls" (etc.) footer
links already use, just placed in the heading here instead of a footer
below the list, and worded "`<Item> Page`" rather than "Show All
{Item}" (also by request). Rendered as a plain `<a>` *inside* the card's
own `<h2>` (after the title/subtitle text in source order), floated
right (`.about-me-card-full-link`, `float: right`) -- the one technique
that keeps it on the SAME line as the title/subtitle AND pinned to that
line's right end at once: an earlier flex-row layout achieved "same
line" but not reliably (the button could drift onto its own visual line
once the title+subtitle text wrapped), and plain inline flow right after
the subtitle achieved "same line" but left-aligned rather than
right-justified. Shown regardless of the card's own state
(error/empty/populated), same reasoning What's On's own `footerLink`
already established. Each jumps to a real page via a plain
`href="#page-id"` (the shell's own hash router, same mechanism What's
On's own links use -- no extra JS needed):

| Card | Label | Links to |
|---|---|---|
| Service Calls | "Service Calls Page" | `#service-calls` |
| Deadlines | "Open Tickets Dashboard" | `#tickets-dashboard` (its own Critical (P1) data, unfiltered by due date -- there's no separate "Deadlines" page) |
| Completed Tickets | "Completed Tickets Page" | `#completed-tickets` |
| Ticket Times | "Ticket Times Page" | `#ticket-times` |
| Asked for Review | "Asked for Review Page" | `#asked-for-review` |
| Accrued Time | "Accrued Time Page" | `#accrued-time` |
| Strety Tasks | "My Strety Tasks Page" | `#my-strety-tasks` -- **note**: that page always shows the *signed-in viewer's own* tasks, not necessarily the resource currently selected on this page |
| Shifts | "Shifts Page" | `#teams-shifts` |

Deadlines is the one deliberate exception to the "`<Item> Page`" wording
rule -- it keeps its original "Open Tickets Dashboard" label, by request
("Leave the two 'Open Tickets Dashboard' as they are"; the other one was
the real Tickets Dashboard card's own button, since removed along with
that card).

## Sections

Seven of the eight sections below are scoped to the **selected
resource**. **Deadlines** is the one exception -- it's company-wide and
NOT resource-filtered, on purpose: it's the kind of thing everyone should
stay on top of regardless of whose page they're looking at (Amber's own
instruction: "Where something is non user specific, we would want to
include it if it's important for people to keep on top of").

0. **Deadlines** -- company-wide, every open ticket with **Priority =
   "P1 - CRITICAL"** (same real selection criteria the Tickets Dashboard
   page's own Critical (P1) widget uses, by request: "Use the selection
   criteria for the first Critical (P1) widget on the Tickets Dashboard
   page"), narrowed to just the ones whose real `Tickets.dueDateTime` has
   already hit or passed today (by request, "Due Today or earlier") --
   same real field `@dashboard/workshop`'s own "Ticket Due Date" column
   already uses.

1. **Service Calls** -- today & tomorrow. Two groups: calls **allocated to
   this resource** (shown first), then **unallocated** calls. Calls
   allocated to someone *else* are excluded entirely -- this is not "all
   calls today", it's "calls this resource should know about". Allocation
   comes from `ServiceCallTicketResources`, keyed by `serviceCallTicketID`
   (the `ServiceCallTickets` join row's own id, not the service call or
   ticket id directly -- easy to get wrong, see `fetchServiceCallsSection`).

2. **Completed Tickets** -- within the picked date range (see "Date range
   picker" below; defaults to today), filtered by `completedByResourceID`.

3. **Ticket Times** -- `TimeEntries` for this resource within the picked
   date range, summed per ticket.

4. **Asked for Review** -- within the picked date range,
   `completedByResourceID` filter plus
   `getTicketUdf(t, 'Ask For Review') === 'ASK'`.

5. **Accrued Time** -- qualifying `Accrue-*` activity within the picked
   date range, but only for tickets that are actually **Complete** (status
   5 matched on `completedDate`, or status 20 "Billing - Contract" matched
   on `resolvedDateTime` -- that status never gets `completedDate` set).
   Same "Complete tickets only" scope the real Accrued Time page defaults
   to. The date range only decides which tickets QUALIFY to show up at
   all -- every column's own sum still reflects each qualifying ticket's
   ENTIRE real history, same as Accrued Time's own table. ING/END/NO-
   Bill/.STD/Other hours all fold in any `TimeEntries.offsetHours` the
   same way that table does. Columns: Ticket, ING, END, NO Bill, STD,
   Other, Client, Ticket Status -- by request, Client/Status sit AFTER
   the time columns here, unlike Accrued Time's own table which puts
   Client/Title/Status first; Ticket Title is left out entirely, by
   request ("to save space"). Every one of those 5 time columns reads
   h:mm here (`formatHoursHM()`), not the plain decimal Accrued Time's
   own table uses, by request ("show as HH:MM instead of decimal
   equivalent").

6. **Strety Tasks** -- see below, its own section.

7. **Shifts** -- next 30 days (widened from an original 7, by request) on
   the "General" Teams-Shifts team, matched to this resource by `userName`
   (case-insensitive) against the resource's Autotask name. There's no
   shared id between Autotask and Teams Shifts, so name-matching is the
   only link, same as elsewhere in this codebase. Each entry renders as a
   coloured pill, by request ("Colour the Shifts Items in a style similar
   to the buttons on this page but using the colour schemes for Shifts
   items from the Team Shifts section of the What's On page") -- see
   "Shifts colouring" below. No legend on this card though, by request
   ("but not on the 'About Me' page") -- see `@dashboard/teams-shifts`
   for where the legend went instead.

   **Widens past 30 days when the date-range picker's own "to" date
   reaches further out**, by a later request ("show Next 30 days plus
   through to the end date on the selectors above if that's later").
   `fetchShiftsSection()` takes the picked `toKey` as an extra argument and
   computes `endKey = toKey > defaultEndKey ? toKey : defaultEndKey` --
   the window only ever gets PUSHED OUT, never pulled in (a "to" date
   inside the next 30 days changes nothing). The picker's own "from" date
   is never consulted -- the window's start stays pinned to today
   regardless. Confirmed live: a "to" 60 days out widens the real fetched
   window to match it exactly; a "to" only 5 days out leaves the window at
   the plain 30-day default. The server echoes back `windowEndKey`/
   `widened` so the card's own subtitle can read "Next 30 days, to {date}"
   instead of the plain "Next 30 days" whenever it actually widened.

   **Consecutive-day grouping is per-LABEL, not a single flat pointer**,
   fixing a real reported bug (Jackson Worth, today-31 Dec): a real
   On Call run and a real Vacation run covering the SAME calendar days
   (confirmed real: both real records exist on 30 Nov-2 Dec) used to
   fragment into many tiny one/two-day groups instead of their own two
   real continuous runs, because the old grouping only ever compared a
   new entry against the single most-recently-closed group, regardless of
   its label -- an interleaved same-day entry of a DIFFERENT label broke
   the run every time. `shiftsGroupConsecutiveDays()` now tracks one open
   run per label independently (`openByLabel`), so same-day entries of
   different labels no longer interrupt each other's own run.

   **"Gaps at weekends is normal"**, by the same request -- real Teams
   shifts/Autotask leave are only ever logged on real work days, so a
   real multi-week run naturally has no Saturday/Sunday entries in the
   middle. `isBridgeableGap()` treats a gap made up ENTIRELY of
   Saturdays/Sundays as still-consecutive; a gap containing even one real
   weekday still breaks the run, same as before. Final groups are sorted
   by each group's own START day for display (confirmed real desired
   order: a Vacation run starting 20 Nov sorts before an On Call run
   starting 30 Nov, even though the On Call run's own last day is later).

   **On Call dates show in red when they overlap a real Vacation/other
   entry on the same real day**, by request ("show the dates in RED on
   any On Call which overlaps with other entries like Vacation") --
   `shiftsGroupConsecutiveDays()` builds a real day -> every distinct real
   label landing on it (`labelsByDay`) BEFORE grouping, so an On Call
   entry (`categorizeShift(label)?.key === 'onCall'`) whose own real day
   also carries another real label sets that day's `overlaps` flag; a
   merged On Call group is flagged `hasOverlap` if ANY of its own real
   days does, and the WHOLE displayed date range goes red (not just the
   overlapping portion) -- the group is one displayed unit, same as its
   own single merged pill. Only On Call is flagged -- two different real
   leave types landing on the same day isn't the scheduling conflict this
   was asking about. Same shared `.text-highlight-red` class every other
   red figure on this dashboard uses, not a new one-off colour.

## Date range picker -- Completed Tickets/Ticket Times/Asked for Review/Accrued Time only

By request ("Add date selectors and buttons to the 'About Me' page
matching what we have on the Time Summaries page"). A From/To date-form
with the same quick-date pill buttons (Today/Yesterday/This Week/Last
Week/This Month/Last Month, highlighting whichever one currently matches
the fields exactly, cleared the moment either field is hand-edited) and
Load button as `@dashboard/times`' own page -- the date-arithmetic
helpers and the highlighting logic are a direct copy of that page's own
`client.js`, not reimplemented from memory. Defaults to today (both
ends) on first load, same default Times uses.

**Explicitly scoped to just four sections** -- Completed Tickets, Ticket
Times, Asked for Review, and Accrued Time. Service Calls, Deadlines,
Strety Tasks, and Shifts are unaffected, by request ("The Service Calls,
Deadlines, Strety Tasks abd Shifts won't be affected by this") -- their
own server-side fetchers never read `from`/`to` at all, so their content
can't change based on what's picked here, even though clicking Load does
still re-fetch the whole combined `/api/about-me` response (there's only
the one endpoint for this page; splitting it into two separate fetches
just to keep four sections' network calls from re-firing wasn't judged
worth the added complexity).

Server-side: `GET /api/about-me` takes optional `from`/`to` (YYYY-MM-DD),
defaulting to today when omitted and validated the same way Accrued
Time's own page validates its own date params (`DATE_RE`, `to` not before
`from`). The four affected fetchers (`fetchCompletedTicketsSection()`,
`fetchTicketTimesSection()`, `fetchAskedForReviewSection()`,
`fetchAccruedTimeSection()`) all take `(client, resourceId, fromKey,
toKey)` now instead of computing their own fixed today/this-week window
internally. The resolved `from`/`to` are echoed back in the response so
each card's own subtitle can show the real range that was actually used
(`dateRangeLabel()` in client.js -- "16 Sep" for a single day, "16 Sep to
20 Sep" for a real range) rather than re-deriving it from the input
fields, which could theoretically drift from what the server actually
used.

## Shifts colouring

The Shifts card's own entries are coloured using the exact same
`SHIFT_CATEGORIES` legend `@dashboard/whats-on`'s own Team Shifts excerpt
defines (On Call yellow, Helpdesk Handler blue, Vacation green, Unpaid
leave red, Sick/Other Leave purple, RDO/Time in Lieu grey, Public Holiday
white-with-border) -- duplicated into this page's own `client.js`, not
imported, same "separate page package" convention every other small
shared UI piece on this dashboard already follows; see that page's own
client.js/README for the full real-data confirmation story behind every
category/colour/match pattern. Rendered as a small pill
(`.button-link.button-link--small`, by request -- "in a style similar to
the buttons on this page"), with the category's own colour applied as an
inline style override (light-mode-pinned, `color-mix(..., white)` not
`transparent`, matching this page's own "everything stays light
regardless of theme" table policy). An unmatched label still gets the
pill SHAPE, just none of the colour override, falling back to
`.button-link--small`'s own plain default tint.

## Leave, from Autotask -- merged into the Shifts card

By request ("can you get Leave from Autotask and add it to the Shifts
data and calendars where it appears having it look just like the Shifts
entries and using that same colour scheme"). Real `TimeOffRequests` rows
(`fetchLeaveTimeOffRequests()`, shared with
`@dashboard/teams-shifts`/`@dashboard/whats-on` -- see that shared
function's own comment in `@dashboard/autotask-client` for the full real
bug story and the `.env`-configured `LEAVE_TYPES` list it resolves
against), scoped here to just this resource (`resourceId` passed through)
and the same next-30-days window the Shifts card already uses
(`fetchLeaveEntries()`, server.js) -- unlike the date-range picker above,
Leave rides on the SAME fixed window Shifts itself uses, not the picked
From/To range, since it's merged into that same list, not a section of
its own.

Each real request's own `timeOffRequestType` is resolved to its own real
label (`getPicklistLabels(client.timeOffRequests, 'timeOffRequestType')`)
and rendered through the exact same `shiftPillHtml()` a real Graph
shift/time-off entry already uses -- by request, "having it look just
like the Shifts entries". The real `.env`-configured `LEAVE_TYPES` list
is "Vacation, Unpaid, RDO, Sick Time, Personal Time, Jury Duty, Holiday,
Floating Holiday, Bereavement Leave"; "Vacation"/"Sick Time"/"Unpaid"
match the shared SHIFT_CATEGORIES legend's own
`vacation`/`sickOther`/`unpaidLeave` regexes directly, "Floating
Holiday"/"RDO" needed that legend's `rdoTil` regex widened (see
`@dashboard/teams-shifts`' own README for the full reasoning, shared
verbatim across all three pages that use this legend).

**Not-yet-approved leave renders striped**, by a follow-up request ("can
we display the Unapproved data with the right colour but with stripes ...
so it's obviously different") after a real bug report (Damon
Kirkpatrick's real Vacation request for 19-23 Oct 2026 wasn't showing on
Shifts and Schedules at all -- it sat at real `status: 2` Submitted, and
Autotask only mirrors an APPROVED request into a plain TimeEntries row,
which every one of these pages used to query instead of TimeOffRequests
directly). `shiftPillHtml(label, approved)` now takes a second argument
-- an `approved: false` pill gets a diagonal `repeating-linear-gradient`
through its own category colour instead of a flat tint, plus a "Not yet
approved" tooltip. `shiftsGroupConsecutiveDays()`'s own grouping key
includes `approved` alongside the label, so a real Approved run and a
real Submitted run of the same leave type never merge into one displayed
group even if their real days happen to be adjacent.

**A real person can show up TWICE for the same leave day** -- confirmed
against real data (Hamza Mahmood, 28 Sep 2026 Vacation): once from this
Autotask Leave time entry, and once from a Teams Shifts time-off request
someone separately booked in Teams for the same day. Both are real,
distinct records in two different systems that just happen to describe
the same real day off -- this page shows both rather than guessing
they're "the same thing" and silently dropping one (a heuristic merge
across two unrelated systems' own primary keys risks hiding a real case
where they genuinely differ, e.g. a half-day logged one way and a
full-day booked the other). Not deduplicated, by design.

## Public Holidays, from Autotask -- scoped to just this ONE resource

By request ("can you get the Public Holidays? ... On the About Me page,
show only Public Holidays that apply to the selected person"). Same real
Autotask Holiday Set chain `@dashboard/teams-shifts`'s own README
documents in full (`InternalLocations.holidaySetId` -> `HolidaySets` ->
`Holidays.holidaySetID`), but resolved to just ONE Holiday Set here --
this resource's own `locationID` (now carried through
`fetchPickerResources()`) -> that one location's own `holidaySetId` ->
that one set's own real holidays in the next-30-days window
(`fetchPublicHolidayEntriesForResource()`, `server.js`). Unlike Shifts
and Schedules / What's On's own Team Shifts excerpt -- neither scoped to
a person, so both show every real Holiday Set at once -- this page IS
already scoped to one person, so only THEIR own applicable set's real
holidays are fetched, not every other location's too.

Confirmed against real data: resources at Geebung (QLD) and most other
Australian offices see `2026-10-05 King's Birthday | set: QLD`, while a
Perth-based (WA) resource sees the same real holiday NAME on a genuinely
different real DATE, `2026-09-28 King's Birthday | set: WA` -- proof the
per-resource scoping resolves to the right set, not just the right
holiday name.

Merged into the exact same `fetchShiftsSection()` rows Leave (above) and
real Teams shifts already share, `kind: 'publicHoliday'`. A resource with
no `locationID`, or a location with no Holiday Set assigned, simply shows
none (real, confirmed case -- not an error).

**Pill label reads "Public Holiday, {Holiday Set}, {Holiday Name}"**, by
request ("On About Me, show the Public Holiday as Public Holiday,
Holiday Set/s, Holiday Name") -- e.g. "Public Holiday, QLD, Christmas
Day". Unlike Teams Shifts/What's On's own calendar cells (which have a
separate line2/tooltip slot for "which Holiday Set it's from"), this
page's Shifts card is a single-line pill, so `shiftsGroupConsecutiveDays()`
composes the full three-part string itself for `kind === 'publicHoliday'`
rows rather than relying on the generic `"Public Holiday - " +
holidayName` prefix trick the other two pages use. It still starts with
the literal words "Public Holiday" so `categorizeShift()`'s own regex
still matches it for the white/bordered styling; `shiftPillHtml()` was
adjusted to show this composed string verbatim for the `publicHoliday`
category specifically, instead of collapsing to the category's own plain
"Public Holiday" label the way every other category still does. Since
About Me scopes fetching to just the one selected resource's own Holiday
Set (see above), `holidaySetName` here is always a single real set name,
never the comma-joined multi-set list `@dashboard/teams-shifts`'s own
same-day/same-name merge can produce.

## Strety Tasks -- cross-person lookup technique

Strety tasks are fetched using the *viewer's own* OAuth connection
(`getPersonalClient(viewerEmail)` from `@dashboard/strety-client`), not a
connection for the selected resource. Confirmed live: querying
`filter[assignee_id]=<any person's Strety id>` returns *that person's* real
todos regardless of whose account is connected, as long as the connected
account has adequate team/space visibility in Strety. This is the same
technique `my-strety-tasks` documents in its own README -- reused here to
let one signed-in viewer look at a teammate's Strety tasks without needing
that teammate's own token.

Three graceful non-error states are surfaced distinctly in the UI rather
than as a raw failure:
- `no-resource-email` -- the selected resource has no email on file to
  match a Strety person against.
- `not-connected` -- the *viewer* hasn't connected their own Strety account
  yet (same "Personal" group link as What's On uses).
- `reauth-required` -- the viewer's Strety connection has gone stale and
  needs reconnecting (`err.strety_reauth_required`, a real, distinct error
  code the Strety client surfaces on a revoked/expired refresh token,
  separate from `strety_not_connected`).
- `person-not-found` -- connected fine, but no Strety person matches the
  resource's email.

(Live note as of this page's build: Amber's own personal Strety token is
currently in the `reauth-required` state -- a genuine pre-existing account
issue, not something this page caused. It now just surfaces cleanly instead
of throwing a raw 400.)

## Table formatting

Every section except Shifts (left as a plain list, by request) renders as a
real `<table>`, matching the column layout AND colour conventions of the
dashboard page that section's data is drawn from, not a bespoke look of its
own:

- Service Calls -- Allocated (green heading) / Unallocated (red heading)
  groups, same red-for-"Unallocated" convention used dashboard-wide.
- Completed Tickets / Ticket Times / Asked for Review -- same Company/
  Ticket #/Title(/Status/Time) columns as their own source pages'
  tables; Asked for Review keeps the blue `.cell-flag-blue` Title flag for
  a Billing - Contract ticket.
- Accrued Time -- same green END/NO Bill column shading
  (`.accrued-time-end-col`) and red/yellow row shading
  (`.accrued-time-red-row`/`--yellow-row`, same 5-minute-variance rule) as
  `@dashboard/accrued-time`'s own table.
- Strety Tasks -- same coloured Today/Tomorrow/Overdue due-date tag
  (`.tt-tag`/`--today`/`--tomorrow`/`--overdue`) as `@dashboard/my-strety-
  tasks`'s own table.
- Deadlines -- same Status/Ticket #/Client/Title/Resource columns
  `@dashboard/tickets-dashboard`'s own Critical (P1) widget table uses
  (`ticketsDashboardStatusCellHtml()`/`ticketsDashboardResourceCellHtml()`
  in client.js -- kept even after the Tickets Dashboard card itself was
  removed, since Deadlines still needs them), every row red (every row
  here IS a Critical (P1) ticket), with a "Due <date>" subtext under the
  Ticket # instead of that page's own create-time one.

Redundant columns a source page's table needs but this personal card
doesn't (e.g. Asked for Review's own "Completed By" -- always the same
person here) are dropped rather than reproduced verbatim.

## Two real bugs found while building this page

Both caught by reading `@dashboard/teams-shifts/lib.js`'s actual source
before wiring it up, not by a live failure:

- `getTeams()` returns `[{id, name}]`, **not** `{id, displayName}` --
  matching against `.displayName` silently never found the team.
- `getShiftsByDay(teamId, startKey, endKeyExclusive)` returns
  `{byDay, totalCount}`, **not** a bare `byDay` object -- destructure it.

## Verification

Every section was checked against real live data across multiple real
resources (Jett Filmer, Hamza Mahmood, Thishan Rasangika, Grant Armstrong,
Peter Kiem) during development, including a couple of results that looked
like false-empties at first glance and turned out to be correct once
checked directly against the underlying data (e.g. a resource with no
allocated/unallocated service calls today when every real call that day was
genuinely allocated to someone else; a resource with real `Accrue-*` time
this week whose ticket just isn't in Complete status yet).
