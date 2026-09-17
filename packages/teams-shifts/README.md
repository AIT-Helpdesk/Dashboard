# @dashboard/teams-shifts

Sidebar label is **"Shifts and Schedules"**, by request -- the package/directory name, `dashboardPage.id`, route (`/api/teams-shifts`), and `TEAMS_SHIFTS_*` env var prefix all stayed `teams-shifts`/`TEAMS_SHIFTS` deliberately; only the user-visible label (`package.json`'s `dashboardPage.label`, `client.js`'s own `label` export and page `<h1>`) changed. Renaming the folder/id/env-var prefix too would have been a much bigger, riskier change (env vars on the deployed production server would need renaming in lockstep) for what was asked as a display-name-only change.

Dashboard page: browse the **General** Team's Shifts schedule as a real month calendar (prev/next/Today nav, one cell per day) -- every real **shift** (On Call, Helpdesk Handler, etc.) AND every real **time-off** entry (Vacation, Sick/Other Leave, etc. -- see "Shifts vs. time off" below) shown together as colored entries, click a day's number to pop up full detail on every entry that day (person, exact time, label, scheduling group, notes, activities, published/draft status, created/last-modified timestamps). Same month-calendar shape (`gridDates`/`byDay`, Monday-start weeks, day-popup) as Service Calls (`packages/service-calls`) -- reused deliberately so this dashboard has one calendar convention, not two.

**No team picker, by request** -- this originally had a dropdown covering every Team in the tenant; now it's locked to `TEAM_NAME = 'General'` in `client.js`, resolved by NAME (not a hardcoded id) against the same `GET /api/teams-shifts/teams` endpoint the dropdown used to populate, just filtered to one team client-side instead of listed for a human to pick. Same not-a-hardcoded-id convention (and the same team) as What's On's own Team Shifts excerpt. If "General" is ever renamed or removed in Teams, this shows a clear error rather than silently rendering an empty calendar -- same `notFound` handling What's On's excerpt already has for this case. The server's own `/teams` and `/:teamId/month` routes are unchanged (still generic, still accept any team id) -- only the client no longer offers a choice.

- `client.js` - frontend module: month calendar (`calendar-table`/`calendar-cell` classes from `packages/shell/public/styles.css`, the same ones Service Calls' own calendar uses) + a day-popup window built client-side from already-loaded data. Exports `id`, `label`, and `mount(container)`, picked up automatically by the shell.
- `server.js` - Express router mounted by the shell at `/api/teams-shifts`.
- `lib.js` - the actual Graph client (token, `/shifts`, `/timesOff`, `/schedulingGroups`, `/timeOffReasons`, `/users/{id}` name resolution). Shared with What's On's own 2-week Team Shifts excerpt (`packages/whats-on/server.js`) -- see "Shifts vs. time off" below for why both matter.

## Shifts vs. time off -- two SEPARATE Graph resources, both needed

Found via a real user report: a real, booked Vacation entry wasn't showing anywhere on this page even though the person and date were correct. Root cause was **not** a matching/coloring bug -- it was that Microsoft Teams Shifts keeps regular shifts (On Call, Helpdesk Handler, etc.) and time-off bookings (Vacation, Sick/Other Leave, Unpaid, RDO/Time in Lieu, etc.) in **two entirely separate Graph resources**, `/teams/{id}/schedule/shifts` and `/teams/{id}/schedule/timesOff`, and this page originally only ever queried the first. The missing Vacation entry was real, correctly entered, and simply never fetched.

`lib.js`'s `getResolvedShifts()` now fetches both and returns one combined, tagged list (`kind: 'shift'` or `kind: 'timeOff'`) so this bug class can't recur for either consumer of this file. Confirmed against real data:

- **`timesOff` uses the same contained-window `$filter` shape as `shifts`** (`sharedTimeOff/startDateTime ge <start> and sharedTimeOff/endDateTime le <end>`, distinct properties, no milliseconds -- see `fetchAllTimesOff()`). Needs the same `Schedule.Read.All` permission.
- **Graph will NOT accept an "overlaps the window" filter here** -- confirmed against the real API: `startDateTime le X and endDateTime ge Y` gets a real `400 BadRequest`, *"Only the 'GreaterThanOrEqual' operator is allowed on entity property 'sharedTimeOff/startDateTime'"* (and, symmetrically, only `LessThanOrEqual` on `endDateTime`). A contained-window filter is the **only** shape the API allows -- not a choice made here.
- **A time-off entry can span multiple real AEST days as ONE entry** -- confirmed against real data (a real 2-day Vacation booking, and a real 2-day Unpaid booking). `getShiftsByDay()` places a multi-day `timeOff` entry on **every** real day it covers (not just its first), the same way any normal calendar app would render a multi-day event. Regular shifts stay single-day -- confirmed every real shift on this team is same-AEST-day, so a shift's own precomputed `dayKey` is trusted directly and never expanded.
- **`timeOffReasonId` resolves via `/teams/{id}/schedule/timeOffReasons`** -- confirmed against real data: 11 real reasons on the General team, several spelling their own intended color directly in the name (`"Vacation (green)"`, `"Sick/Other Leave (purple)"`, `"RDO / Time in Lieu (grey)"`, `"Helpdesk Handler (blue)"`, `"ON CALL (yellow)"`) -- strong real-data confirmation that What's On's fixed category legend (see that page's README) is matching real intent, not a guessed taxonomy.
- **`timesOff` has no `notes` or `activities` field, and no scheduling group** -- confirmed absent on every real entry. `getResolvedShifts()` sets these `null`/`[]` for `kind: 'timeOff'` rows so every consumer can read the resolved-row shape uniformly regardless of `kind`.

**KNOWN GAP, not fixable from this side:** because Graph only accepts a contained-window filter (see above), a multi-day time-off entry that starts before *or* ends after whichever window is queried (a calendar month here, or What's On's 2-week slice) is invisible in that fetch -- there is no filter shape the API accepts that would catch a boundary-straddling entry. Narrow in practice (it only affects an entry that happens to cross a month/fortnight boundary), but real and unavoidable given the API's own restriction.

## Colouring switched from raw Teams theme to the same real legend What's On uses

Originally coloured by Microsoft Teams Shifts' own raw `theme` enum (`THEME_COLORS`, a plain enum-name-to-hex map with no real-world meaning attached to each colour). Switched, by request ("Apply this colouring also to the 'Shifts and Schedules' page and add the colour legend from the Team Shifts to Shifts and Schedules also"), to the exact same `SHIFT_CATEGORIES` list `@dashboard/whats-on`'s own Team Shifts excerpt already uses -- matched against each entry's own `displayName` (a shift's own label, or a time-off entry's resolved reason name), not `theme`. A visible legend (`#shifts-legend`, the same `.shifts-legend`/`.shifts-legend-item`/`.shifts-legend-swatch` classes What's On's own excerpt uses) now sits under the calendar too -- What's On's own excerpt has one; this page didn't, by request now it does. `THEME_COLORS` itself was removed -- duplicated, not imported, same "separate page package" convention every other small shared UI piece on this dashboard follows; see `@dashboard/whats-on`'s own client.js/README for the real-data confirmation story behind every category/colour/match pattern (7 categories: On Call yellow, Helpdesk Handler blue, Vacation green, Unpaid leave red, Sick/Other Leave purple, RDO/Time in Lieu grey, Public Holiday white-with-border).

## Leave, from Autotask -- merged into the same month calendar

By request ("can you get Leave from Autotask and add it to the Shifts
data and calendars where it appears having it look just like the Shifts
entries and using that same colour scheme"). Real Autotask
`TimeEntries` rows tagged with the same `timeEntryType` picklist
`@dashboard/times`' own README documents as Leave (15 PersonalTime, 16
VacationTime, 17 SickTime, 18 PaidTimeOff; `LEAVE_TIME_ENTRY_TYPES` in
`server.js`), no `ticketID`/`taskID`, `dateWorked` inside the queried
month -- merged straight into the same `byDay` rows real Graph
shifts/timesOff already fill (`kind: 'leave'`, alongside `'shift'` and
`'timeOff'`), rendered through the exact same `entryHtml()`/
`categorizeShift()`/legend path, so a real leave day looks like any
other calendar entry, by request.

**Unscoped by Teams team** -- a deliberate choice, not an oversight.
Autotask resources aren't organised into a "General" Teams-Shifts
roster the way real shifts are, and this tenant's whole staff is small
enough that showing every real leave entry in the queried month
(`fetchLeaveEntries()`, no resourceID filter) is the honest default
rather than guessing which Autotask resources "belong" to whichever
Teams team is selected.

**No real start/end clock time** -- a leave entry is a whole
`dateWorked` day with an `hoursWorked` total (confirmed against real
data: every real entry seen is exactly `7.6`, same full-day figure
`@dashboard/times`' own Normal Hours uses), not a Graph shift with real
`startDateTime`/`endDateTime`. `entryHtml()`/`dayPopupEntryHtml()` both
special-case `kind === 'leave'` to show that hours total instead of the
blank `formatTime(null)` pair a real shift's own fields would otherwise
produce.

**Colour mapping**: real confirmed billing code names in this tenant are
"Vacation", "Sick Time", and "Floating Holiday" (`billingCodeID`
resolved via the real `BillingCodes` entity, same reason
`@dashboard/accrued-time`'s own `resolveBillingCodeNames()` gives --
`billingCodeID` is a record reference, not a small-int picklist).
"Vacation" and "Sick Time" match the shared `SHIFT_CATEGORIES` legend's
own `vacation`/`sickOther` regexes directly, no extra mapping needed.
"Floating Holiday" doesn't literally say "public" so `publicHoliday`'s
own regex wouldn't catch it -- folded into `rdoTil` instead (a
floating/discretionary day off reads closer to an individually-earned
RDO/Time in Lieu than to an actual gazetted, company-wide Public
Holiday), by widening that category's own regex rather than guessing it
into the wrong bucket. Same widened regex duplicated into
`@dashboard/about-me`'s and `@dashboard/whats-on`'s own `client.js`
copies of this legend, for the same reason.

**Same real person can appear twice for the same day** -- confirmed
against real data (Hamza Mahmood, 28 Sep 2026): a real Autotask Leave
entry AND a real Teams Shifts time-off request for the same real
Vacation day, both genuine records in two separate systems. Not
deduplicated -- see `@dashboard/about-me`'s own README for the full
reasoning (same real example, same choice).

## Public Holidays, from Autotask -- merged into the same month calendar

By request ("can you get the Public Holidays? Show on the Public Holiday
which Holiday Set it's From"). Real Autotask **Holiday Sets**, not a
hardcoded Australian public-holiday list -- the real chain, confirmed
against real data (`fetchPublicHolidayEntries()` in `server.js`):

- `InternalLocations` (`client.internalLocations`) carries `holidaySetId`,
  linking a real office location to one Holiday Set. Confirmed real
  locations: Geebung (QLD, 35 resources), Sri Lanka, Perth (WA), Grafton
  (NSW).
- `HolidaySets` (`client.holidaySets`) carries the real set's own name
  (`holidaySetName` -- confirmed real: "QLD", "WA", "NSW", "Sri Lanka").
- `Holidays` (`client.holidays`) carries the real `holidayDate`/
  `holidayName`, linked back via `holidaySetID` -- **capitalised
  differently from `InternalLocations.holidaySetId`, confirmed as two
  genuinely distinct real field names, not a typo.**

**One calendar entry per (holiday set, date), NOT per resource.** A public
holiday applies to everyone sharing that location/set at once; one entry
per resource would pile up as many identical "Christmas Day" entries as
there are staff at that location, on the same real day -- real noise, not
real information. `userName` is set to the real Holiday Set name (not a
person) so it renders on the same line real shift/leave entries already
use for "who this is" -- doubling as the answer to "which Holiday Set
it's from" with no new field needed.

`displayName` is prefixed `"Public Holiday - "` so every Autotask-sourced
holiday matches `SHIFT_CATEGORIES`' own `publicHoliday` regex (see
"Colouring switched..." above) even for a real holiday name that regex
wouldn't otherwise catch on its own -- confirmed real: "Ekka" (QLD-only),
"WA Day", "Bank Holiday" (NSW-only), "Tamil Thai Pongal" (Sri Lanka) --
none of which mention "public holiday" or any of the specific day names
the regex already knows. Means every real Holiday Set's own holidays
reach the same white/bordered Public Holiday look with zero changes
needed to `categorizeShift()` itself.

**Unscoped by Teams team**, same deliberate reasoning as Leave above --
shows every real Holiday Set actually in use at once, not just whichever
team happens to be selected. (`@dashboard/about-me`'s own Shifts section
is the one place this IS scoped, to just the selected person's own
location -- see that package's README.)

**Further merged when the SAME real holiday name falls on the SAME real
day across multiple Holiday Sets**, by request ("where a specifically
named public holiday applies to multiple Holiday Sets, Show the Public
holiday once with all of the Set Names in the one calendar item").
Grouped by `(dayKey, holidayName)` -- confirmed real data, December 2026:
Christmas Day (25 Dec) merges into ONE entry with `holidaySetName: "NSW,
QLD, Sri Lanka, WA"`; Boxing Day (26 Dec) merges into `"NSW, QLD, WA"`
(correctly excluding Sri Lanka, which has no real Boxing Day holiday);
Sri Lanka's own unique 23 Dec "Unduvap Full Moon Poya Day" stays its own
single-set entry. Grouping by NAME too (not day alone) means a same-day
coincidence between two differently-named holidays would still show as
two entries, and the earlier "King's Birthday" example (5 Oct for QLD vs.
28 Sep for WA -- same name, genuinely different real date) still shows as
two separate entries, one per its own real date.

## Confirmed against the real account (Ambient IT's own tenant, `General` team)

- Token, group listing, scheduling-group listing, and shift fetching all round-trip successfully with `Group.Read.All` + `Schedule.Read.All` + `User.Read.All` app-only permissions -- no extra/narrower permission needed.
- **An unfiltered `/schedule/shifts` call returns the ENTIRE shift history**, not just current/upcoming ones -- confirmed against real data: an unfiltered page came back with shifts from **2020**. This is why a month is always required (`month=YYYY-MM`, 400 without it) and every fetch is date-scoped to that one AEST calendar month (`aestToUtcIso` bounds, same helper Service Calls uses for its own month query).
- **`$filter` needs `startDateTime` and `endDateTime` as two DISTINCT properties.** `sharedShift/startDateTime ge X and sharedShift/startDateTime le Y` (the same property twice) is rejected outright: `400 BadRequest`, *"A property is allowed to appear at most once in the $filter query."* The working form is `sharedShift/startDateTime ge <start> and sharedShift/endDateTime le <end>`. Filter values are bare ISO datetimes without milliseconds (`2026-08-01T00:00:00Z`) -- `aestToUtcIso()`'s millisecond-bearing output is trimmed before use, since only the no-milliseconds form has actually been confirmed accepted.
- **`userId` is genuinely `null` on real shifts** -- confirmed against real data: on one unfiltered page, 78 of 200 shifts had `userId: null` and a `schedulingGroupId` instead. These are real open/unassigned shift slots (the Shifts UI's "Open shift" concept), not broken records -- surfaced as `userName: null` server-side and rendered as "(Open shift)" client-side, never fired at `/users/null`.
- **`schedulingGroupId` resolves via `/teams/{id}/schedule/schedulingGroups`** -- confirmed against real data: 10 groups, e.g. "On Call" and "On Call Roster", several with a blank `displayName` (shown as no group label rather than an empty string).
- **`notes` is real, meaningful data** -- confirmed against real data, e.g. a shift's notes field holding `"Bris PUB HOL"` (a public-holiday flag on that shift). Shown in the day popup.
- Four real theme values seen in real data: `yellow`, `purple`, `darkPink`, `pink` -- no longer used for colouring (see "Colouring switched..." above), kept here only as the historical record of what was actually observed while this page still read `theme` directly.

## Data source: Microsoft Graph `/teams/{id}/schedule/shifts`, `/schedulingGroups`, `/users/{id}`

There's no delegated vs. app-only choice-free shortcut here the way CSP Customers had with `/contracts`:

- **Listing teams**: there is no plain `/teams` list endpoint for app-only calls -- that shape (`GET /me/joinedTeams`) only exists for a delegated, signed-in user. The app-only way to enumerate every Team in the tenant is `GET /groups?$filter=resourceProvisioningOptions/Any(x:x eq 'Team')`, since every Team is backed by a Microsoft 365 Group. Confirmed against the real tenant: 10 teams came back this way. Needs **`Group.Read.All`**.
- **Shifts**: `GET /teams/{team-id}/schedule/shifts`, month-filtered (see above) and paginated via `@odata.nextLink` (same shape as CSP Customers' `/contracts` walk). Needs **`Schedule.Read.All`**. A team whose Shifts app has never been opened has no provisioned schedule -- expected to 404 (not yet hit against a real never-opened team, but this is handled as "zero shifts" rather than an error either way).
- **Scheduling groups**: `GET /teams/{team-id}/schedule/schedulingGroups`, fetched in full (small list, confirmed 10 groups) rather than resolved id-by-id. Needs the same **`Schedule.Read.All`**.
- **Names**: a shift only carries the assignee's raw `userId` (or `null` -- see above), not a display name -- resolved per unique id via `GET /users/{id}?$select=displayName`. Needs **`User.Read.All`**.

All three are **application** permissions (this is an app-only client-credentials connection, like CSP Customers -- there's no interactive user for a background page load to act as), and all three need admin consent once granted.

## Credentials (`.env`)

`TEAMS_SHIFTS_CLIENT_ID`, `TEAMS_SHIFTS_CLIENT_SECRET`, `TEAMS_SHIFTS_TENANT_ID` -- a **dedicated** Entra app registration, separate from the dashboard's own Microsoft 365 sign-in app (`AUTH_CLIENT_ID` etc., see `packages/shell/auth.js`) and separate from the CSP Customers app (`CSP_CLIENT_ID` etc.). It's deliberately its own registration rather than bolting `Schedule.Read.All` onto the sign-in app -- that app is delegated-only (`openid`/`profile`/`email`/`User.Read`) and has no reason to also carry broad app-only read access to the whole tenant's schedules just for this one page.

`TEAMS_SHIFTS_TENANT_ID` is Ambient IT's own tenant -- Teams Shifts data lives there, not a customer's (unlike the CSP app, which is registered directly in the CSP tenant via Partner Center).

Setup, in the Azure Portal (this one doesn't need Partner Center's own app-management page the way CSP Customers did -- a plain Entra app registration is enough):

1. **Entra ID -> App registrations -> New registration.** Any name (e.g. "Dashboard - Shifts and Schedules"). Single tenant.
2. **Certificates & secrets -> New client secret.** Copy the secret's **value** immediately.
3. **API permissions -> Add a permission -> Microsoft Graph -> Application permissions**: add `Group.Read.All`, `Schedule.Read.All`, `User.Read.All`. Then **Grant admin consent** -- application permissions don't work until an admin explicitly consents, unlike some delegated scopes.
4. Note the **Application (client) ID** and **Directory (tenant) ID** from the app's Overview page.

**Auth**: app-only client credentials against the same v2.0 token endpoint as CSP Customers (`https://login.microsoftonline.com/{TEAMS_SHIFTS_TENANT_ID}/oauth2/v2.0/token`, `grant_type=client_credentials`, `scope=https://graph.microsoft.com/.default`). Token cached in-process, refreshed 60s before expiry -- identical shape to `csp-customers/server.js`'s `getToken()`.

## Every field an entry carries, shown

By request, this page surfaces the full entry, not a trimmed summary -- `id`, `kind` (`shift`/`timeOff`), assignee (`userId`/`userName`, or "Open shift" -- shifts only, every real time-off entry seen has a real assignee), `published` (was this a `sharedShift`/`sharedTimeOff` or only ever a draft), `startDateTime`/`endDateTime`, `displayName` (a shift's own label, e.g. "On Call"; a time-off entry's resolved reason name, e.g. "Vacation (green)"), `theme` (drives the calendar entry's color), `notes`/`activities`/`schedulingGroupId`/`schedulingGroupName` (shifts only -- `null`/`[]` on a `timeOff` row, see "Shifts vs. time off" above), `createdDateTime`, `lastModifiedDateTime`. The calendar cell itself is a compact 2-3 line summary (time, person, label); the day popup (click a day's number) is where every field is shown in full.

## Published vs. draft shifts

A Shifts entry can have a `sharedShift` (published, visible to the team) and/or a `draftShift` (manager-only, not yet published). This page prefers `sharedShift` when present and falls back to `draftShift` otherwise, flagging the row `published: false` (rendered with a "Draft" badge and the same left-border accent Service Calls uses for "needs attention" entries) rather than silently dropping an unpublished-but-real shift. Every shift seen in real testing so far had `sharedShift` populated and `draftShift: null` -- whether this app-only token can even see a genuinely draft-only shift is still unconfirmed (none existed in any tested window).

## Caching

The team list is cached in-process for 20 minutes (`TEAMS_CACHE_TTL_MS`), same convention as CSP Customers. Each team+month's report is cached for 10 minutes (`REPORT_CACHE_TTL_MS`), same TTL and same reasoning as Service Calls' own report cache -- a roster change is the kind of thing that should show up within the hour, not stay stale as long as a slow-moving customer list would. `?force=true` (the Refresh button) bypasses both.

## Still open

- Whether `Group.Read.All` is really required just to list Teams, or whether a narrower permission (`Team.ReadBasic.All`) also works app-only for this filter shape -- not tried, since `Group.Read.All` already works.
- The 404-on-unprovisioned-schedule handling is unexercised -- every team tried so far has a real schedule.
- Draft-shift/draft-time-off visibility, and real shift `activities` data (see above).
- The boundary-straddling multi-day time-off gap noted above -- real but narrow; not fixed since the API itself doesn't allow it.
