# @dashboard/whats-on

Dashboard page (first page the dashboard opens to): Strety **Scorecards** -- the Helpdesk Task Tracker team's daily/weekly/monthly metrics, followed by the signed-in user's own personal-space metrics -- each cadence shown as a matrix, up to 8 columns wide (Daily/Weekly on a fixed calendar window; Monthly on real check-in activity -- see "Matrix layout" below).

- `client.js` -- frontend module. Exports `id`, `label`, and `mount(container)`, picked up automatically by the shell.
- `server.js` -- Express router mounted by the shell at `/api/whats-on`.

## Hiding a metric -- "NOT READY:" title prefix, not a real API field

Strety's own Scorecard UI has a category concept, but confirmed against real data it does **not** exist anywhere on `/metrics` via the API -- every attribute and relationship key on every real metric was dumped and there's nothing resembling a category, and the real category grouping isn't exposed to API clients at all. So there's no way for this page to read or display it.

By request, a metric that shouldn't show on this page is instead marked directly in Strety by prefixing its own **title** with `NOT READY:` -- a manual workaround, not a real field. `isNotReady()` in `server.js` matches that prefix (case-insensitive, tolerant of leading whitespace) and filters those metrics out **before** fetching their check-in history at all, in `fetchScorecardsFor()` -- not just hidden client-side -- so a metric marked this way costs zero extra Strety API calls too, not just zero screen space.

**The title prefix is the ONLY criterion, by explicit request** -- a metric's check-in history (or lack of it) plays no part in whether it's shown. Confirmed against real data: 3 real Helpdesk daily metrics were marked `NOT READY:` as of writing, and are correctly excluded -- that they also happened to have zero check-ins each is coincidental to why someone marked them that way, not something this code checks for or relies on. A metric with a normal title and zero check-ins still shows (with blank cells), exactly as before.

## Bold highlighting -- just the meaningful part, not the whole string

By request, two spots highlight only a PART of a larger text in bold (`.text-highlight-green`/`.text-highlight-red` in `styles.css`, same colors as `.section-heading--nav`/`.cell-flag-green`/`.cell-flag-red` but inline, not block-level):

- A scorecard table's own heading (e.g. "Helpdesk Task Tracker -- Daily") only colors the cadence suffix ("Daily"/"Weekly"/"Monthly", always green), not the whole line. `scorecardTable()` in `client.js` takes the prefix (`group.label`) and suffix (`FREQUENCY_LABELS[freq]`) as **separate** parameters and wraps only the suffix in its own span -- deliberately not built by splitting the combined heading text on `" -- "` after the fact, since the Personal group's own `group.label` already contains its own `" -- "` (`Personal -- <Name>`), which would make string-splitting ambiguous about which occurrence is meant.
- A metric's own title highlights up to and including its first colon (e.g. `THURSDAY:` in `"THURSDAY: Check for Errors on Sleepy's Unifi NVRs and Cloudkeys"`) -- confirmed against real data this is an existing naming convention on this account (same shape as the `NOT READY:` prefix above, though unrelated to it -- this one is purely visual, it doesn't hide anything). By request, this one is a status signal, not just decoration: **green** if the metric's most recent column (`cells[0]` -- columns are always most-recent-first, both the fixed Daily/Weekly window and Monthly's data-driven one) has a real value, **red** if that most recent column is empty -- a quick "is this metric current" cue at a glance. `titleHtml()` in `client.js` -- a title with no colon at all still renders unstyled either way, as before.

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

## Matrix layout -- real shared period columns; Daily/Weekly on a fixed window, Monthly data-driven

Each scorecard table has one row per metric and up to 8 period columns (dates in the header row), most recent first -- every row lines up against the exact same real periods, not its own independent "last 8 check-ins" (a naive per-row "last 8" would NOT line up row to row -- confirmed against real data, different metrics in the same cadence check in at different actual times).

Two different strategies, by request:

- **Daily and Weekly get a fixed calendar window**, always exactly `HISTORY_LIMIT` (8) columns, regardless of whether any metric has a check-in in a given one: Daily is today back 8 calendar days; Weekly is this ISO week back 8 weeks. Both are generated directly from real dates in `fetchScorecardsFor()` (`todayAestDate()` stepping backward day-by-day or week-by-week), not derived from check-in data at all -- a metric with zero check-ins in a shown period just renders a blank cell in that column, rather than the column being omitted.
- **Monthly stays data-driven**, unchanged: the most recent periods that **any** metric in the group actually has a check-in for (a union across the group, not a fixed window) -- so Monthly's columns reflect real activity rather than mostly-empty calendar slots if check-ins lag. Only Daily/Weekly were asked to become fixed windows.

Each check-in still gets one shared **period key** so real data lines up against these columns correctly: Weekly/Monthly use the check-in's own `iso_week`/`iso_week_year`/`month`/`year` attributes directly (confirmed present on every real check-in, so no date math needed or risked for MATCHING real data); Daily has no such attribute, so its period key is `created_at` converted to an AEST calendar day. If a period genuinely has more than one check-in for the same metric (confirmed against real data this happens -- see below), the most-recently-created one wins as "the" value for that period.

### Weekly's column header is the Monday date, not the week number -- and the ISO week math is now ours, verified against real data

By request, a Weekly column header shows the Monday of that ISO week (e.g. `17/08`) instead of `Wk 34`. Generating the fixed 8-week window requires computing which real calendar week is "this week" and each week before it -- the standard ISO 8601 week algorithm (`isoWeekInfo()` in `server.js`; the week containing a date's nearest Thursday is that date's ISO week), anchored to **AEST** "today" (`todayAestDate()`), same AEST-anchoring convention as Daily and every other date-scoped page on this dashboard.

This was verified against real data before shipping, not just trusted as textbook-correct: fetched a real weekly metric's actual check-in history and compared this dashboard's own `isoWeekInfo()` (fed each check-in's `created_at`) against that check-in's real `iso_week`/`iso_week_year` attributes. Most matched outright; the ones that didn't were informative rather than a bug:

- One mismatch resolved exactly once the AEST offset was applied before computing the week (a check-in logged late Sunday UTC was already Monday AEST) -- confirming Strety's own `iso_week` is computed against something close to AEST/local time, not raw UTC, and validating the AEST-anchoring choice.
- A few mismatches persisted even with the AEST offset applied -- these turned out to be genuine backdated/catch-up entries (two real check-ins on this account were logged five seconds apart but carry `iso_week` values one week apart -- a deliberate "log a value for a missed week" feature, not a timing artifact). This doesn't affect correctness here at all: real check-in matching (`periodKeyFor()`) always trusts Strety's own `iso_week`/`iso_week_year` directly rather than computing it, so a backdated entry still correctly lands in whichever column matches its own stated period. The fixed-window generator only needs to get "what are the last 8 real weeks counting back from today" right, which the AEST-anchored calculation does.

### Daily backdating -- a real `date` field exists, but it's write-only

Weekly check-ins can be logged "for" an earlier week than when they're actually typed -- confirmed against real data (see above): `iso_week`/`iso_week_year` is set independently of `created_at`, so a backdated weekly entry still lands in the correct column. Daily check-ins were first assumed to have no equivalent field at all -- confirmed by direct investigation of a real backdated daily entry ("PM: Test this"), whose GET response was:

```json
{
  "value": 1,
  "iso_week": 34, "iso_week_year": 2026,
  "month": 8, "quarter": 3, "year": 2026,
  "created_at": "2026-08-21T01:52:26.620Z",
  "context": "Test green"
}
```

No `date` field, and `created_at` is when it was actually typed, not the date it was "for." Confirmed by exhausting every other reasonable read-side avenue too: three guessed filter params on `/metrics/:id/check_ins` all failed as unsupported; a single-record GET returns the same attribute set as the list endpoint; a top-level `/metric_check_ins` resource doesn't exist at all (404).

**Correction, discovered while writing a real check-in (see "Writing a check-in" below): a `date` attribute DOES exist -- it's required on `POST .../check_ins` for a daily metric** (`422 BLANK "date required for daily metrics"` when omitted), and a real write with `date` set succeeds. But confirmed against the very check-in this created: reading it back afterward via GET still shows **no `date` field anywhere** in the response -- it's accepted on write and simply never echoed back on read, not merely undiscovered.

**Practical effect, unchanged:** this page's own `periodKeyFor()` still has no way to read which date an existing Daily check-in is "for" -- only `created_at` (converted to an AEST calendar day) is visible, so a Daily entry backdated by hand in Strety's own UI still displays under the day it was actually submitted, not the day it's "for." What DOES change: any check-in **this dashboard itself creates** (see below) can set the correct `date` on write and have it land in the right column immediately, since a same-day write's `created_at` and intended `date` are identical anyway. The gap is specifically about correctly *displaying* someone else's backdated entry after the fact, not about this dashboard's own ability to write one correctly.

### Writing a check-in -- confirmed one-time, by request; not automated

`@dashboard/strety-client` now exports `post()` (same throttle/retry handling as `get()`) alongside the read-only functions this page otherwise uses exclusively. Confirmed against the real API:

- Strety's write endpoints are real JSON:API and need the actual `application/vnd.api+json` Content-Type -- a plain `application/json` body gets a `415`.
- The connection this dashboard had been using only carried a `read` OAuth scope -- a real write attempt got `403 INVALID_SCOPE`. Fixed in `packages/shell/server.js`'s `/auth/strety/connect`, which now requests `scope=read write`; **existing connections needed a fresh re-authorization** to actually pick up the new scope (refreshing an old token doesn't grant scopes it was never issued with).
- Body shape: `{ data: { type: 'metric_check_in', attributes: { value, context, date } } }` -- `date` (`YYYY-MM-DD`) is required for a daily metric (see above).

By explicit request, this was done as a **one-time manual write** (a real Autotask ticket count -- open tickets, priority `!! SET PRIORITY`, this dashboard's standard "open" definition -- logged once against "NOT READY: EOD - Tickets at Set Priority - Should be None"), not an ongoing scheduled job. There is no automation, cron, or recurring write anywhere in this codebase as of writing -- `post()` exists as reusable infrastructure for if/when that's asked for, but nothing currently calls it automatically.

## Pass/fail flagging and value formatting

- A cell is flagged green/red (`.cell-flag-green`/`.cell-flag-red`, same "needs attention" convention used elsewhere on this dashboard) by comparing the check-in's value against the metric's own `target_type`/`target_value` -- confirmed against real data `target_type` is one of `gte`/`gt`/`eq`/`lte`/`lt`. No flag at all when there's no target to judge against.
- `number_format` confirmed against real data: `number` (plain), `currency` (a real decimal dollar amount, e.g. `9027.26` -- not cents), `percentage` (already a whole percentage, e.g. `12` means 12%, not `0.12`). `time` has **zero** real check-ins anywhere on this account as of writing, so its unit (seconds? minutes?) is unconfirmed -- rather than guess a conversion that might be wrong, it falls back to plain-number formatting like anything unrecognized.
- **A check-in record can exist with `value: null`** -- confirmed against real data (editing a check-in's value in Strety can clear it without deleting the record). The cell-building code in `fetchScorecardsFor()` treats this exactly like no check-in existing for that period at all (a blank cell), not a "populated" cell with an empty display string -- the latter was a real bug: an existing-but-empty cell object is still truthy (`Boolean(cell)`), which made the metric title's green/red "has recent data" highlight (see "Bold highlighting" below) stay green for a metric whose latest value had actually been cleared.

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

## Two distinct connection-broken states, not one generic error

By request: a stale/revoked Strety refresh token (`err.strety_reauth_required`, see `@dashboard/strety-client`'s README) gets its own status, `reauth-required`, distinct from `not-connected` (nobody has ever connected at all). Both need the same fix -- a human redoes the browser login at `/auth/strety/connect` -- but they're different situations (this page was working and stopped, vs. it's never been set up), so `client.js` shows different wording for each rather than one generic "Strety isn't connected" message that would be misleading for the "it broke" case. Neither shows the raw underlying error -- both are things with a known, simple remedy, not something to go digging into a stack trace for.

The `reauth-required` message names WHICH Strety account needs reconnecting, when known -- `server.js` includes `connectedIdentity()`'s result (see `@dashboard/strety-client`'s README, "Recording WHICH Strety account a connection belongs to") as `connectedAs` in the response. This matters once more than one Strety connection exists on this dashboard (the plan discussed for an automated Autotask -> Strety write, using a separate limited-access account) -- without this, a broken-connection message would be ambiguous about which of possibly several connections it's even talking about. `connectedAs` is `null` for a connection made before this feature existed (recorded only from the next reconnect onward, not retroactively), and the message just omits the "(currently connected as ...)" parenthetical in that case rather than showing a confusing blank.

Both the `not-connected` and `reauth-required` messages render their fix as a real button (`.button-link`, same style used elsewhere on this dashboard for an `<a>` that needs to read as a call-to-action rather than an inline text link), by request.
