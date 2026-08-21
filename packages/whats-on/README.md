# @dashboard/whats-on

Dashboard page (Daily Dashboards, first page the dashboard opens to): Strety **Scorecards** -- the Helpdesk Task Tracker team's daily/weekly/monthly metrics, followed by the signed-in user's own personal-space metrics -- each cadence shown as a matrix with up to the last 8 real check-in periods as columns.

- `client.js` -- frontend module. Exports `id`, `label`, and `mount(container)`, picked up automatically by the shell.
- `server.js` -- Express router mounted by the shell at `/api/whats-on`.

## Post-mortem: "No scorecards" was a client-side bug, not a Strety/rate-limit problem

Worth recording plainly since it cost a lot of back-and-forth to find: this page showed "No scorecards for Helpdesk Task Tracker" from the "dates on header row" rework onward, and the real cause was one line in `client.js`:

```js
const frequenciesPresent = FREQUENCIES.filter((f) => group.byFrequency[f]?.length);
```

`group.byFrequency[f]` is `{ columns, rows }` (an object), not an array -- it has no `.length`, so this was always `undefined`/falsy regardless of whether real data existed, and every group always fell into the "No scorecards" branch. Server-side logging (added temporarily, then removed once this was confirmed) showed the real API responses were correct the entire time -- real teams, real metrics, real `byFrequency` keys populated. Fixed by checking `.rows.length` instead.

The rate-limit/429 investigation that happened first (retry-with-backoff and request pacing in `@dashboard/strety-client`, sequential-not-concurrent fetches, the catalog cache below) were all real, confirmed-against-the-real-API problems and are worth keeping -- but none of them were THE bug behind "no scorecards ever showing." The lesson: when a page claims "no data" but the server logs show data was fetched successfully, check the rendering condition before chasing the data-fetching layer further.

## "Scorecard" == Strety's `/metrics` + `/metrics/:id/check_ins`

Strety has no `/scorecards` endpoint (404, confirmed against the real API) -- a Scorecard is really just the set of **metrics** (EOS "Measurables") that live in a given space, each with its own history of **check-ins** (one value logged per period). Confirmed against real data:

- `GET /metrics` -- every metric on the account (74 real rows as of writing). Each has `attributes.checkin_frequency` (`daily`/`weekly`/`monthly`/`annual`, all four confirmed present) and `relationships.space` -- same `team`/`person`/`project` shape as a to-do's space (see My Strety Tasks), pointing at whichever team or individual owns that metric. This page only asks for `daily`/`weekly`/`monthly`, by request -- `annual` metrics are deliberately left out.
- `GET /metrics/:id/check_ins` -- that one metric's logged history. `relationships.latest_check_ins` on the metric object itself is **not reliable** -- confirmed against real data it was an empty array on a metric that actually had 16 real check-ins via this nested endpoint, so this page always hits the nested endpoint directly rather than trusting that relationship.
- Order is **not reliable** here either -- confirmed against real data (a 5-entry real check-in history came back in an order that matched neither `created_at` nor `updated_at`, ascending or descending). Same situation as `/todos`' `sort` param (see `@dashboard/strety-client`'s README) -- `server.js` walks every page via `fetchAllPages()` and groups client-side (see "Matrix layout" below) rather than trusting the API's own order.

## The "Helpdesk Task Tracker" team is resolved by name, not a hardcoded id

`findTeamByName()` fetches `/teams` (11 real rows, cheap) live every request and matches `attributes.name === 'Helpdesk Task Tracker'` client-side -- `filter[name]` isn't a confirmed-working filter on `/teams` (unlike `/people`'s confirmed `filter[email]`), so this doesn't guess at an unconfirmed param. If the team is ever renamed or deleted in Strety, that section says so explicitly (`notFound: true`) rather than silently vanishing.

## Personal scorecards -- same signed-in-email match as My Strety Tasks

The "Personal" group resolves the dashboard's own signed-in email against Strety's `/people` directory (`filter[email]`, exact match) and shows THAT person's `person`-type-space metrics -- see My Strety Tasks' README for why this email match is safe. Not every real person has personal metrics (confirmed against real data -- some do, some have none), so an empty Personal group says "No scorecards for Personal -- <Name>" rather than showing nothing unexplained.

## Two headings, not one shared summary

By request, the page has two parallel headline-style headings (`.summary`, same style My Strety Tasks uses for its own single summary line) instead of one generic "Scorecards for `<Name>`": a fixed **"Helpdesk Scorecards"** in `summaryEl` at the top (always visible, matches "as at" wording), and a second **"Your Personal Scorecards"** injected into `resultsEl` itself, positioned right before the Personal group's own content -- `render()` in `client.js` detects this by array index (`data.groups[1]` is always the Personal group; `server.js` pushes Helpdesk first, unconditionally, then Personal, so this ordering is safe to rely on without checking labels). Both carry their own "-- as at `<time>`" using the same `data.asOf` timestamp -- there's only one fetch, so both headings describe the same moment, just placed where each half of the page begins.

## Matrix layout -- real shared period columns, taken from Strety's own data

Each scorecard table has one row per metric and up to 8 period columns (dates in the header row), most recent first -- every row lines up against the exact same real periods, not its own independent "last 8 check-ins."

A naive "last 8 check-ins per metric" would NOT line up row to row -- confirmed against real data, different metrics in the same cadence check in at different actual times (three "Daily Backup Checks" check-ins landed on the very same calendar day while a sibling daily metric's check-ins didn't). So instead of per-row dates, `server.js` derives one shared **period key** per check-in and groups by that:

- **Weekly/monthly** use the check-in's own `iso_week`/`iso_week_year`/`month`/`year` attributes directly -- confirmed present on every real check-in, so no date math needed or risked here.
- **Daily** has no such attribute, so its period key is the check-in's `created_at` converted to an AEST calendar day -- same AEST-anchoring convention every other date-scoped page on this dashboard follows.
- If a period genuinely has more than one check-in for the same metric (confirmed against real data this happens), the most-recently-created one wins as "the" value for that period.

The 8 columns shown are the most recent 8 periods that **any** metric in that cadence group actually has a check-in for (a union across the group, not a fixed calendar window) -- so the columns reflect real activity rather than mostly-empty calendar slots if check-ins lag. A metric with no check-in in a given shown period just renders a blank cell.

**Exception, by request**: a **Daily** table always includes a column for today (`todayKeyAEST()`), even with zero check-ins logged yet today -- added to the period-key set before the most-recent-8 sort/slice, so it naturally takes the "most recent" slot rather than needing separate handling, and the oldest existing column just drops off if that would otherwise make 9. This is also why a Daily group with metrics but literally zero check-ins ever no longer falls into the "No check-ins yet" fallback table (see `scorecardTable()` in `client.js`) -- there's always at least today's column now. Weekly/monthly don't get this treatment -- only Daily was asked for.

## Pass/fail flagging and value formatting

- A cell is flagged green/red (`.cell-flag-green`/`.cell-flag-red`, same "needs attention" convention used elsewhere on this dashboard) by comparing the check-in's value against the metric's own `target_type`/`target_value` -- confirmed against real data `target_type` is one of `gte`/`gt`/`eq`/`lte`/`lt`. No flag at all when there's no target to judge against.
- `number_format` confirmed against real data: `number` (plain), `currency` (a real decimal dollar amount, e.g. `9027.26` -- not cents), `percentage` (already a whole percentage, e.g. `12` means 12%, not `0.12`). `time` has **zero** real check-ins anywhere on this account as of writing, so its unit (seconds? minutes?) is unconfirmed -- rather than guess a conversion that might be wrong, it falls back to plain-number formatting like anything unrecognized.

## Hover shows the check-in's note

Each cell's `title` attribute is the check-in's plain-text `context` (Strety's rich-text note field, already plain text via `attributes.context` -- `context_html` is the rich version and isn't used here) -- a native browser tooltip, same pattern already used elsewhere on this dashboard (e.g. Contract Services' Units column) rather than a custom tooltip widget. Cells with no note get no `title` attribute at all, so nothing pops up.

## Sidebar position

`packages/shell/nav-layout.json` currently lists this page as its own standalone entry, not inside a category (it started out first inside "Daily Dashboards" -- see git history/prior conversation -- but has since been moved; Start Here is what's first in the tree now and is the page a fresh visit lands on).

## Catalog caching -- a deliberate exception to "no caching"

Unlike every other Strety-backed page on this dashboard (see My Strety Tasks' README, "No caching"), `getCatalog()` caches `/teams` + `/metrics` together, in memory, for 60 seconds (`CATALOG_CACHE_TTL_MS`), shared across every request to this page.

This was added after confirmed-against-the-real-API 429 "Too Many Requests" responses under normal use. `/metrics` alone is 74 rows / 4 pages, fetched in full on every single load just to filter down to the ~5 rows the Helpdesk team actually needs -- `filter[space_id]` is **not** a supported filter on `/metrics` (confirmed against the real API: a 400 "not a supported filter for this resource"), so there's no server-side way to ask for less. That one fetch was the single biggest chunk of this page's per-load request count.

The tradeoff is deliberately narrow: team names and metric **definitions** (title, cadence, target) change on the order of "someone edited Strety's setup," not minute to minute, so a 60-second-stale view of those is a non-issue. The actual check-in **history** (`fetchMetricPeriodMap()`, the real data this page exists to show) is explicitly NOT part of this cache and stays a fully live fetch every request -- caching that would risk showing a stale value for something someone just checked in.

`getCatalog()` fetches `/teams` then `/metrics` **sequentially**, not via `Promise.all` -- confirmed against real use, this page got a successful-looking but completely empty response (every group reporting "no scorecards," no error at all) right after firing those two requests concurrently. Retries can't fix that (nothing actually failed), so avoiding concurrent Strety calls in the first place is the fix -- see `@dashboard/strety-client`'s README, "Rate limiting", for the full story and the retry-with-backoff `get()` now does for a genuine 429.

## Client-side: no re-fetch on revisit, by request

Unlike every other page on this dashboard (which all re-fetch live every time the page is opened -- see My Strety Tasks' "No caching"), `client.js`'s module-scope `lastData` isn't just a flash-avoidance cache here: `mount()` only calls `load()` when `lastData` is still `null` (a genuinely first visit this browser tab session, or after an error that never produced real data). Navigating away and back to a page that already loaded real scorecard data just re-renders `lastData` instantly with **no new request at all**. The **Refresh** button still always forces a real live fetch regardless of `lastData`.

This is a deliberate exception -- given how expensive this page's per-load request count already is (see "Catalog caching" and "Rate limiting" above), and that scorecard data changes on the order of "someone checked in a metric," not from one page navigation to the next a few seconds later, re-fetching on every single revisit was pure waste, not freshness anyone actually needed.
