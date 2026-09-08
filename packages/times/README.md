# @dashboard/times

Sidebar label is **"Time Summaries"**, by request -- the package/directory name, `dashboardPage.id`, route (`/api/times`), and file layout all stayed `times`/`@dashboard/times` deliberately; only the user-visible label (`package.json`'s `dashboardPage.label`, `client.js`'s own `label` export and page `<h1>`) changed, same "rename the display, not the plumbing" convention `teams-shifts` already established. Lives in the **Ticket Info** category (`nav-layout.json`, hidden alongside its siblings) and is also one of the tabs on the **Ticket Info** tabbed page (`ticket-info-tabs`'s own `defaultTabs`), by request.

Dashboard page: pick a From/To date range and (optionally) narrow the resource list, see an Hours Summary table (Normal Hours per day, Leave Hours, Public Holidays, Total Hours, Ticket Hours -- Resources across the top, one row per metric down the side) plus a second table breaking ticket time down by the internal "AITTIME" bucket tickets.

Column headers show each resource's first name only, by request (full name on hover), and every table uses tighter row padding than the dashboard's usual table default -- both by request, since this page's tables can run to many resource columns. The row-label column's own header cell is left blank (no "Resource" label) on every table except the Client Contract Breakdown table's own corner cell, which instead reads **"Total Client Hours Recorded"** in bold blue (`.tm-corner-label`), by request. The AITTIME and Hours-less-AITTIME tables have no heading of their own above them, by request -- they read as a continuation of the page, not separate titled sections.

Every table's header row carries a light green tint (`.tm-hours-table thead th`, same `#16a34a` convention used elsewhere on this dashboard for header/tag shading), but the corner cell itself is excluded from that shading on every table, by request -- only the resource-name columns (and the Total column) carry it.

**Resource columns are pinned to the same width on every table** (`table-layout: fixed` + explicit column widths, `.tm-hours-table` in `styles.css`), by request -- these are three separate `<table>` elements, and a plain auto-layout table sizes its own columns off its own content, which drifted the resource columns out of alignment between tables (the AITTIME table's "Ticket title" column, and row labels like "Recorded Hours less AITTIME", are much wider than a bare resource name). Long first-column labels now wrap instead of forcing the column wider.

- `client.js` -- frontend module. Exports `id`, `label`, and `mount(container)`.
- `server.js` -- Express router mounted by the shell at `/api/times`. Read-only.

## The four Hours Summary rows, exactly as requested

1. **Normal Hours (per day)** -- flat `7.6` for every resource, by request ("for now"). Not yet per-person; there's no per-resource contracted-hours field wired up anywhere on this dashboard.
2. **Leave Hours** -- hours of leave in the period. See "Leave, from Autotask" below for the real, confirmed data source.
3. **Public Holidays** -- zeroed for every resource, by request ("We will add them later, just put zeros for now"). Still a real field in the response shape (`publicHolidayHours`), not omitted, so wiring in a real source later is a one-line change in `server.js`, not a shape change for the client or anyone else.
4. **Total Hours** = `Normal Hours x number of Mon-Fri in the period - Leave - Public Holidays` (`countWeekdays()` in `server.js` -- inclusive of both the From and To date).
5. **Ticket Hours** -- total hours actually recorded on tickets in the period, directly under Total Hours in the same table, by request. See "Hours recorded on tickets" below for the source.

A Total column sums each row across every selected resource -- not explicitly asked for, added since it's a natural at-a-glance read on a wide table; easy to remove if unwanted.

## Leave, from Autotask -- confirmed against real data

Confirmed before writing any of this (by request: "You should be able to get the Leave from Autotask"). Autotask's own `TimeEntries.timeEntryType` picklist carries real, structured leave categories -- no separate "Time Off" entity needed:

| Value | Label |
|---|---|
| 15 | PersonalTime |
| 16 | VacationTime |
| 17 | SickTime |
| 18 | PaidTimeOff |

`LEAVE_TIME_ENTRY_TYPES` in `server.js`. Confirmed against a real month of data: 14 real leave entries, all `ticketID`/`taskID` null (internal time, not logged against client work) and each carrying a real internal billing code -- `VacationTime` entries used the "Vacation" code, `SickTime` used "Sick Time", `PaidTimeOff` used "Floating Holiday" -- and every full-day entry seen was exactly `7.6` hours, the same figure this page uses for Normal Hours (per day), a small real-data cross-check that the two numbers are talking about the same thing. `PersonalTime` (15) and the separate "RDO" internal billing code exist in this tenant's configuration but had zero real entries in the confirmed month -- included anyway since they're the same kind of entry, just unused in that particular window.

The `notExist` filters on `ticketID`/`taskID` in `fetchByFieldIn(... LEAVE_TIME_ENTRY_TYPES ...)` are a confirming double-check, not an assumption -- every real leave entry found already had both null.

## Resources -- active, non-API only

`Resources.licenseType` 7 is "API User" -- confirmed against real data: 25 of this tenant's 38 "active" resources are integration service accounts (Gluh API, Xero API, Cloud Olive API, etc.), not real people, and have nothing meaningful to report hours for. `fetchSelectableResources()` excludes them, leaving 13 resources for both the multiselect and the report itself.

**Filtered client-side, not via a query filter** -- the first version of this filter used `{ op: 'ne', ... }`, which isn't a real Autotask filter operator at all (confirmed against real data: it silently matched everyone, 38 back instead of 13 -- `ne` was simply ignored rather than erroring). The real "not equal" operator is `noteq`, but this codebase already hit a genuine production bug from using `noteq` on a query filter (see `excludeMonitoringAlerts()`'s own comment in `@dashboard/autotask-client`): Autotask's REST API applies SQL three-valued NULL logic to `noteq`, so a record whose field came back `null` gets silently dropped rather than kept. `licenseType` isn't expected to be null here, but the fix follows that same established, already-proven-safe pattern anyway -- fetch every active resource unfiltered, then exclude `licenseType === 7` in plain JS, where `null !== 7` behaves the way anyone reading the code would expect.

**Known gap**: `licenseType` alone doesn't cleanly separate every non-person account -- `Resources` id 4, "Autotask Administrator", is a generic system account (not a real staff member) but carries `licenseType 1`, the same as real Administrator-licensed staff, so it still shows up in the multiselect. Left in rather than guessed at with a fragile name-pattern exclusion; easy to ignore in the picker, and easy to special-case by id later if it turns out to matter.

## Resource multiselect

A plain `<details>`/`<summary>` disclosure (`#resource-picker` in `client.js`) rather than a custom dropdown with its own open/close-on-outside-click JS -- no listener to leak or duplicate across this page's own mount/remount cycle, and native keyboard/click toggle behaviour for free. Populated from its own `GET /api/times/resources` endpoint (kept separate from the main report so the picker can render before a date range has even been chosen). All/None buttons inside the panel. No selection made == every resource, so the report is useful immediately without touching the picker at all.

**Unticked by default**, by request: Damon Kirkpatrick, Melissa Tannock, Amber Worth, Matt Jeavons, "Autotask Administrator" -- matched by exact resolved name (`DEFAULT_UNCHECKED_NAMES` in `client.js`), not id. Everyone else starts ticked. Only applies to the true first render of the picker (no Load submitted yet this session) -- a remount after a real "every box checked" submission restores that "all" state instead of reverting to these defaults.

## Hours recorded on tickets

Same convention as `packages/ticket-times`' own `fetchTimeEntriesOn()` -- `TimeEntries` where `ticketID` exists (time logged against Tasks/project work, not tickets, is excluded), just scoped to the chosen date range and resource set instead of a single day, and shown (in the Hours Summary table's own Ticket Hours row) as one summed total per resource rather than a per-ticket breakdown -- that level of detail is what Ticket Times itself is for; this page's own per-ticket breakdown is scoped specifically to AITTIME tickets (below).

## AITTIME tickets, broken down by title

A second table, by request: every one of this same set of ticket-time entries whose ticket is an "AITTIME" bucket ticket, broken out one row per ticket **title** (not per ticket id), Resources across the top exactly like the Hours Summary table, a per-title Total column, and a bottom Total row summed per resource across every title.

**"AITTIME: ..." tickets are Ambient IT's own internal, recurring, non-client time buckets** -- confirmed against real data: 75 real tickets, every one `companyID: 0` (Autotask's own "internal" convention, same one `resolveCompanyName()` already special-cases), titled `"AITTIME: <category>"` -- real categories seen include Service Team, Business Development, Finance and Administration, Global Systems, Helpdesk Handler, Learning, Teaching, Meeting, Major Rollouts, Training - Giving, Training - Receiving. Fetched via `{ op: 'beginsWith', field: 'title', value: 'AITTIME' }` -- confirmed against the real API this is a genuine, working Autotask query filter operator (unlike the `ne` mistake documented above), returning exactly the expected 75 tickets, nothing extra or missing.

**Grouped by title, not by ticket id, by request** ("Show each ticket title with a time summed for each resource") -- confirmed against real data this is the right key: the SAME title recurs across many separate real ticket records (e.g. four distinct real ticket ids all titled "AITTIME: Service Team"), evidently a fresh ticket per some recurring period rather than one ongoing ticket per category. `server.js` builds a ticketID -> title map from the full AITTIME ticket list, then folds the *already-fetched* ticket-time entries (the same ones the Hours Summary table's Ticket Hours row sums) into their title's row -- no second `TimeEntries` query needed.

Only titles with at least one real hour in the chosen period/resource set are shown -- an all-zero row for a category nobody touched this period is just noise. Sorted alphabetically, same reasoning as the resource list's own name sort.

## Hours less AITTIME

A third, small table, by request: Resources across the top again, two rows -- **Total Hours less AITTIME** (the Hours Summary table's own Total Hours, minus that resource's AITTIME total) and **Recorded Hours less AITTIME** (Ticket Hours, minus the same AITTIME total) -- so AITTIME's own internal, non-client time doesn't inflate either figure when what's wanted is a client-work-only read. Computed client-side in `client.js` (`lessAittimeRow()`) from data the page already has -- no new server request.

## Client contract breakdown

A fourth table, by request: "All recorded ticket time that's not on Ambient IT tickets is client tickets." One row per distinct **Contract** name that starts with "T&M", plus a single catch-all **"Other or Blank (?)"** row for everything else, Resources across the top, Total row underneath.

**Ambient IT's own tickets, excluded entirely** -- matched by company NAME prefix, by request ("All clients whose name starts with Ambient iT should be treated as Ambient iT"), not a single hardcoded id. Confirmed against real data: this tenant has **three** real companies whose name starts with "Ambient iT" under inconsistent real casing -- "Ambient IT" (id 0, the same id `resolveCompanyName()` already special-cases as "internal"), "Ambient iT - Imported" (id 228, confirmed 1200 real tickets), "Ambient iT Loan Equipment" (id 1608, confirmed 46 real tickets) -- matched case-insensitively (`AMBIENT_IT_NAME_PREFIX` in `server.js`) so the real "Ambient IT"/"Ambient iT" casing difference can't itself cause a miss.

**Grouping rule, confirmed against a real week of client ticket time**: 8 of 13 distinct real contract names on client tickets that week started with "T&M" (e.g. "T&M TC Elite Platinum", "T&M Adhoc Client", "T&M TC Essentials") -- each gets its own row, **except every "T&M TC Elite*" variant, which is folded into one row** (`T&M TC Elite*`), by request. Confirmed against real (2026 YTD) data this tenant has seven distinct real contract names under that one prefix -- "T&M TC Elite", "T&M TC Elite Gold", "T&M TC Elite Gold [NO TAM &lt;6 Seats]", "T&M TC Elite Platinum", "T&M TC Elite Platinum [+TAM &gt;5 Seats]", "T&M TC Elite Platinum with TAM", "T&M TC Elite (Sponsorship)" -- the same underlying product at different tiers/add-ons, not seven separate things worth their own row. Every other "T&M ..." contract still gets its own row -- real data even turned up two more distinct near-duplicates worth knowing about: "T&M Adhoc Client" and a real typo'd "T&M Adhco Client" (a different, much smaller real contract, not merged -- a typo in a contract's own name isn't this report's business to silently paper over), plus "T&M TC Adhoc".

Everything that isn't Ambient IT and isn't a "T&M ..." contract -- a real contract name that doesn't start with "T&M" (e.g. "Tech Cover Elite - Managed Service Agreement", "Hosted PBX") or a ticket with no `contractID` at all (12 real tickets in that same week) -- folds into the "Other or Blank (?)" row. That row is always sorted LAST, not alphabetically among the real contract names -- it's meant to be noticed (the label says so), not blend in. A real, non-trivial total showed up there in testing (hours genuinely worth someone's attention, not a zero-row edge case), which is exactly the kind of thing this row exists to surface.

T&M contract rows are otherwise alphabetical, and only rows with at least one real hour in the chosen period/resource set are shown, same "no all-zero noise" convention as the AITTIME table.

## Client contract breakdown -- Billable

A fifth table, by request: **"Total Client Hours Billable"** -- the exact same rows as Total Client Hours Recorded (same contract grouping, same "T&M TC Elite*" merge, same "Other or Blank (?)" catch-all), but restricted to entries Autotask itself flags as billable, and each cell shows two numbers.

**What "billable" means here, confirmed against real data before picking a definition** -- Autotask's own `hoursToBill` field is NOT simply "the billable portion of hoursWorked": confirmed against a real week, `hoursToBill` is set (often to a LARGER value than `hoursWorked`, evidently rounded to a minimum billing increment) on entries flagged `isNonBillable: true` just as often as on genuinely billable ones -- it's computed regardless of whether the entry is ever actually invoiced. `isNonBillable`/`showOnInvoice` agreed on every real entry checked but 3 (an ignorable, real-world edge case) -- `isNonBillable` is the field this table actually filters on. Each cell's real value is a `{worked, toBill}` pair -- the real `hoursWorked` total for that resource/row (entries not flagged non-billable only), and Autotask's own contract-rounded `hoursToBill` total alongside it.

**Shown differently depending on the column, by request** -- a per-resource cell shows only the `worked` figure, with `toBill` available as a hover tooltip on the cell itself (`title="To bill: ..."`) rather than visible text, so the table doesn't read as visually busy. The **Total column** is the one place both numbers show up VISIBLY, side by side on one line (e.g. `19.80 (31.25)`) -- that column is widened and set to never wrap (`.tm-hours-table th:last-child`/`td:last-child` in `styles.css`, which also keeps every table's own Total column the same width, same alignment reasoning as the rest of this page). Confirmed against real data these two numbers can differ substantially even within the billable subset (rounding to a minimum billing increment adds up over many short entries).

Rows only appear here if they had at least one billable hour in the period -- a row that's a Total Client Hours Recorded row but had zero billable time doesn't show up in this table at all (the whole table itself is omitted if nothing in the period was billable).

## Client contract breakdown -- Non-Billable

A sixth table, by request: **"Total Client Hours Non-Billable"**, the exact complement of the Billable table -- same rows, same `{worked, toBill}` cell shape, same tooltip/Total-column-only-bracket treatment, built from the same shared `buildClientContractSplitHours()` in `server.js` (Billable keeps entries where `isNonBillable !== true`, Non-Billable keeps `isNonBillable === true` -- one function, a boolean flag, not two near-duplicate implementations).

**Cross-checked against real data**: for every real contract row in a real week, Billable's own `worked` total plus Non-Billable's own `worked` total add up EXACTLY to that same row's Total Client Hours Recorded total (e.g. "T&M TC Elite*": 19.80 billable + 15.27 non-billable = 35.07 recorded) -- confirms the split is a clean partition of the same underlying entries, not overlapping or dropping any.

## Reconciliation row + mismatch check

A normal (non-blue) row under the Billable table's own Total row, by request: **"Recorded less Billable"** -- each resource's Total Client Hours Recorded total minus that same resource's Billable (worked) total, computed independently client-side (`client.js`, not a new server request). This is what the Non-Billable total *should* be if the three tables agree with each other.

That figure is compared against Non-Billable's own real grand total (worked); a real disagreement (beyond a 0.01hr floating-point tolerance) turns Non-Billable's own Total-column worked figure red (`.tm-mismatch`, same red as `.status.error`). Confirmed against real data (two different real periods, a week and 2026 YTD) these currently always agree exactly -- the check is a regression guard for the future, not a sign anything is currently wrong.

## Hours Summary (overall summary table)

A small table at the very TOP of the page, in its own red box, by request -- **one value per row, not per resource** -- a plain label+value table (`.tm-overall-summary-table`, deliberately its own CSS class rather than reusing `.tm-hours-table` -- that class's column-position rules, e.g. blue shading on `:nth-last-child(2)`, all assume the Resources-across-the-top shape every other table on this page has; with only two columns that rule would land on the label column instead, exactly the kind of bug reusing it here would invite). Its own corner cell reads "Hours Summary" (`.tm-corner-label`, same bold-blue treatment as the Client Contract tables' own corner cells), by request.

Every row shows **Hours** and that same figure as **HH:MM**; the percentage column (headed **"%\*\*"**, shortened by request from "% of Available Hours" -- a footnote reading "\*\* % of Available Hours" sits under the table, small text, explaining it; the percentage itself is rounded to 1 decimal place, by request -- `formatPct()` in `client.js`) is per-row, not uniform -- each row's own real-world meaning decides what it's a percentage OF:

- **Total Tech Hours (at work)** -- Attendance: `sumOf('totalHours')`, the same figure Table 1's own Total Hours row shows. **No percentage** -- by request, since this row IS the baseline every other row measures against ("This is 100% of the hours a resource is at work"), so a number here would only ever read a redundant "100%".
- **Tech Hours Available (After AITTime)** -- Total Tech Hours (at work) minus Table 2's own (AITTIME) grand total.
- **Total Tech Client Hours** -- Total Client Hours Recorded's grand total.
- **Total Tech Hours Billable** -- Total Client Hours Billable's own `worked` grand total.

**Every percentage is a % of Total Tech Hours (at work)**, by request -- Rows 2, 3, and 4 alike, not of Tech Hours Available even for the Client/Billable rows (that was tried first and, by report, "doesn't look right" -- fixed by switching the shared denominator).

Confirmed against real data (31 Aug - 6 Sep 2026, default-ticked resources): Total Tech Hours (at work) 287.80 (no %); Tech Hours Available 202.18 (70.25%); Total Tech Client Hours 96.84 (33.65%); Total Tech Hours Billable 48.70 (16.92%).

## Small caps -- built manually, not via CSS font-variant

Every row label and column header on this page originally used CSS `font-variant: small-caps`. Reportedly that still read as plain ALL CAPS rather than visibly smaller -- a real, known limitation: without a font that ships true OpenType small-caps glyphs, browsers "synthesize" the effect, and the size reduction can end up too subtle to actually look distinct from full-height capitals.

Replaced outright with a manual approach (`smallCapsHtml()` in `client.js`): every run of lowercase letters in a label is upper-cased and wrapped in a `<span class="tm-smcp">` sized at `0.75em`; already-uppercase letters (`AITTIME`, `HH:MM`, `T&M`, etc.) and non-letters are left completely alone, untouched by any span. This guarantees a real, visible size difference regardless of font or browser support -- confirmed by hand against sample labels, e.g. `Leave Hours` -> `L`+small `EAVE` `H`+small `OURS`. The dashboard-wide `th { text-transform: uppercase }` rule (`styles.css`) is still overridden with `text-transform: none` on this page's own table classes -- without it, the plain (non-span) uppercase-already text would render identically sized to the shrunk `.tm-smcp` spans, erasing the same size distinction all over again, just via a different mechanism than the original bug.

## Work-Type Reconciliation (4 tables so far, more planned)

A new page section, marked by its own heading ("Data below this point is for Work-Type Reconciliation") next to a **Show** button, below the two red-bordered boxes -- not itself boxed, at least not yet (4 more tables are planned here).

**Fetched on demand only, by request** ("we can not retrieve it by default so the page is faster") -- this section's own real data (a fresh `TimeEntries` fetch plus `BillingCodes`/`Tickets`/`Companies` lookups) is NOT part of the main `GET /api/times` load at all; clicking Show fires a separate request to its own `GET /api/times/work-type` route (same `from`/`to`/`resourceIds` params, reusing `data.resources`' own resolved id list rather than re-deriving them). A visit that never clicks Show never pays for this section's own extra Autotask calls. `validateDateRange()`/`resolveSelectedResources()` in `server.js` are shared between both routes.

**"Work Type" is `TimeEntries.billingCodeID`**, confirmed against real data (one real week, 583 real ticket time entries): every single entry had one set (no nulls), 13 distinct real work types -- "Administration", "Maintenance", ".Standard Support", "Accrue--ING"/"Accrue--END"/"Accrue--END-No Bill", "Onsite  Support" (double space is real), "Quoted Labour Hours", "Travel - under 50Kms", "REWORK", "Tools, Products, & Rollouts", "Sales", "Emergency". This is a DIFFERENT field from `internalBillingCodeID` (used for non-ticket internal time -- AITTIME, leave) -- `billingCodeID` is specifically the "Work Type" selection Autotask's own UI shows on a ticket-linked time entry.

**Redesigned away from an earlier billable/non-billable split**, by request ("we are going to do these a bit differently"), into four tables instead:

- **Table 1 -- "Work Type - Billable"**: a FIXED list of five named work types (real confirmed names -- the request's own spelling normalized to match: ".STandard Support" -> ".Standard Support", "Onsite Support" -> "Onsite  Support", a real double space in this tenant's data): `.Standard Support`, `Accrue--END`, `Onsite  Support`, `Quoted Labour Hours`, `Emergency`. Shown in this exact order, all five rows always present even at zero hours, by request ("show all nominated work types even if there's no data found") -- `WORK_TYPE_FIXED_LIST` in `server.js`. **Billable entries only** (`isNonBillable !== true`), by request.
- **Table 1-B -- "Billable was Unticked"** (new): the SAME five fixed work types' own NON-billable entries -- by request ("leave out any items where the billable has been unticked [from Table 1] and show these in a new table below this one"). Same fixed order as Table 1, but ONLY rows that actually had non-billable hours are shown (not pre-seeded like Table 1 -- "Show only the rows found... but only for the Work Types in table 1"). Confirmed against real data: only 2 of the 5 fixed work types had any real non-billable hours that week (`.Standard Support` 0.80h, `Quoted Labour Hours` 4.33h) -- and Table 1 + Table 1-B combined, per work type, reconciles exactly to the pre-split totals confirmed earlier (e.g. `.Standard Support` 44.08 + 0.80 = 44.88).
- **Table 2 -- "Work Type - Unbillable"** (renamed from "Work Type - Other", by request -- content unchanged: still every OTHER real work type found regardless of ITS OWN billable flag, not billable-filtered the way Table 1 is): alphabetical, only rows with real hours. Confirmed against real data: 7 real rows for the same test week (Administration, Maintenance, Accrue--END-No Bill, Travel - under 50Kms, REWORK, Tools/Rollouts, Sales), excluding both Table 1's fixed five and Accrue--ING (its own table below).
- **Table 3 -- "Accrue--ING by Status"**: `Accrue--ING` specifically, split into exactly two rows by the ticket's own status. Row labels are **"Complete"** and **"Incomplete"**, by request -- the underlying grouping itself is unchanged: "Complete" means the ticket's status is either of two real labels, `Complete` or `Billing - Contract`; "Incomplete" is everything else. Confirmed against real data both real status labels exist verbatim in this tenant's `Tickets.status` picklist (`Complete` id 5, `Billing - Contract` id 20), and real Accrue--ING entries genuinely exist under both (10.17h / 1.98h combining to the "Complete" row's 12.15h) alongside many other real statuses folding into "Incomplete" (8.15h) -- reconciles exactly to the same 20.30h Accrue--ING total confirmed in earlier testing. Both rows always shown, same "fixed partition, not a dynamic list" reasoning as Table 1.

**Ambient IT's own tickets are excluded from all three**, by request, same name-prefix rule as the Client Contract tables (`isAmbientItCompany()`) -- confirmed this genuinely matters: it was excluding Ambient IT that dropped real "Administration" time from 123+ hours down to a fraction, since almost all of it was logged against Ambient IT's own internal tickets, not client ones.

**More tables still planned** in this section -- the original "7 tables" scope has been revised as the design evolved (2 -> 3 -> 4 tables so far for what was originally going to be 2), so no fixed remaining count is tracked here anymore.

## Client Ticket Times (reconciliation row)

A fifth table, by request: **one row, no table header** (no corner label, no column headers -- just resource columns' worth of data, relying on the tables directly above it for context) -- row label **"Total (matches Total Client Hours)"**. Its value is the four tables above it (Billable, Billable was Unticked, Unbillable, Accrue--ING) summed together, per resource, purely client-side (`client.js`, no new server request -- it already has all four tables' own data from the one `/work-type` fetch).

**Confirmed against real data this genuinely reconciles**: summed, the four tables equal `101.60` for a real test period/resource set -- exactly Total Client Hours Recorded's own grand total (also `101.60`) for the same period. This makes sense by construction (both figures cover the same underlying ticket-time entries, Ambient IT excluded the same way, just grouped differently -- by Contract there, by Work Type here) but is a genuine, useful sanity check that the Work-Type Reconciliation section as a whole hasn't silently dropped or double-counted anything.

**A real disagreement turns the row's own Total-column figure red**, by request (`.tm-mismatch`, same convention as the earlier Billable/Non-Billable reconciliation check) -- `recordedGrandTotal` is already in scope from the main `render()` (no new fetch needed) and compared against this row's own grand total with the same 0.01hr floating-point tolerance. Currently always green/matching in real testing -- this is a regression guard for the future, not a sign anything is wrong today.

The whole row is shaded green with heavier grey top/bottom borders, by request (`.tm-reconciliation-row`, shared with the "Ambient iT Tickets" row below -- had to out-specificity the Total column's own blue-shading rule so the green wins on every cell, not just the label). A small red footnote sits right up close under the table explaining the red coloring.

## Ambient iT Tickets (final table)

A last table in this section, by request: every real time entry whose OWN ticket is an Ambient iT ticket (`isAmbientItCompany()`, the same "Ambient iT\*" name-prefix rule this whole page already uses), split into two ALWAYS-shown rows:

- **AITTime Tickets** -- the ticket's own title starts with "AITTIME" (`fetchAittimeTickets()`, the same lookup the page's own AITTIME breakdown table already uses). Just a total here, by request, no per-title breakdown -- that level of detail is the earlier AIT Time Tickets table's own job.
- **All other Ambient iT tickets** -- every other real Ambient iT ticket (e.g. a real client-work-style ticket that happens to be logged against Ambient iT's own company record instead of an actual client's).

**Its own "TOTAL (matches Total Recorded Hours)" reconciliation row** -- confirmed with the user "Total Recorded Hours" means Table 1's own Ticket Hours row (ALL ticket time for the selected resources, client AND Ambient iT combined, unfiltered by company). Caught and fixed a real bug here before shipping: the row's own SUM has to include the four client Work-Type tables too, not just this Ambient table alone -- Ambient's own total (123.93h in one real test) obviously can't equal ALL ticket time (225.54h) by itself; Ambient + Client together is what reconstructs it. Confirmed against real data at full floating-point precision (not just the 2-decimal display rounding) the two figures come out EXACTLY equal (both `225.5357`, difference `0`) once fixed. Same red-text-plus-red-shading mismatch treatment and red footnote as "Client Ticket Times" above.

## Table grouping boxes

Three separate red-bordered boxes (`.tm-table-group`, `styles.css`), by request, top to bottom: the Hours Summary table alone; the first three per-resource tables (the row-per-metric table, AITTIME, Hours less AITTIME); the second three (Recorded, Billable, Non-Billable). Each box has a 2px gap between the border and the tables/paragraphs inside on every side (the last table's own bottom margin is cancelled so the gap stays a real 2px rather than 2px plus a leftover 1.5rem). Purely visual grouping -- no behavior change.

## HH:MM column

Every table, by request, has one more column after Total -- that row's own Total figure translated into `h:mm` (e.g. `19.80` -> `19:48`), same rounding/rollover convention Ticket Times' own Time column uses (`formatHms()` in `client.js`, round to the nearest minute, rolls into the next hour rather than ever showing `:60`). On the Billable table this reads the `worked` half of the Total column's pair, not the bracketed `toBill` figure.

## Blue shading -- total rows and the Total column

Every total ROW (the bottom `Total` row on every table) and every **Total** column's own body cells carry a light blue tint (`color-mix(in srgb, var(--accent) 15%, transparent)`, `styles.css`), by request -- the same `--accent` blue used for the corner-label text. The header row keeps its own separate green shading (see above) -- this is about the data cells, not the column headers. The HH:MM column is NOT included in this shading (it's a separate, new column, not "the Total column").

## Date handling

`TimeEntries.dateWorked` is a date-only field, confirmed (see Ticket Times' own README) to always be stored as midnight UTC of the calendar date the technician logged against -- no AEST offset conversion needed for the range filter itself, only for what the From/To date pickers default to (`todayISO()`/`mondayOfWeek()`/`addDays()` in `client.js`, same AEST-anchored `+10 hours` trick Ticket Times' own `todayISO()` uses). Defaults to **last week, Mon-Sun** (the most recently completed week, not the current in-progress one) on first load; freely editable.

## Not yet built

- A real Public Holidays source (see above) -- currently zeroed everywhere, by request, pending a decision on where that data should come from.
- Per-resource Normal Hours (currently flat `7.6` for everyone).
