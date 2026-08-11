# @dashboard/subscriptions-expiring

Dashboard page: pick a window (2/7/14/30/60/90 days, or "Expired Recently"), optionally filter by client name (wildcards with `*`, same convention as Ingram Subscriptions), see every Ingram Micro Cloud Marketplace subscription whose `expirationDate` falls in that window -- a renewals watch-list, not a per-status snapshot. Default window: **7 days**. Does not auto-load, by request-following convention (same as every other filter-driven page on this dashboard) -- click Load.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`, picked up automatically by the shell.
- `server.js` - Express router mounted by the shell at `/api/subscriptions-expiring`.

## Data source

Same Ingram Micro Cloud Marketplace API as Ingram Subscriptions, via the shared `@dashboard/ingram-client` package (`getToken()`, `fetchAllPages()`). Every subscription is fetched regardless of status (`fetchAllPages('/subscriptions', token, {})`, no `status` param) -- this is a watch-list keyed on `expirationDate`, not a "currently active" report, so a subscription that's pending, on hold, or already terminated/removed can still be relevant here (e.g. confirming something that lapsed really did stop). Same cheap single paginated pass Ingram Subscriptions' "All statuses" mode uses -- no per-subscription detail calls, so every window (including a client-filtered one) costs the same regardless of how many rows it happens to match.

## Window options

| Dropdown value | Matches |
|---|---|
| 2 / 7 / 14 / 30 / 60 / 90 days | `expirationDate` from **today** (AEST) through **today + N days**, inclusive of both ends |
| Expired Recently | `expirationDate` from **7 days ago** through **yesterday** (AEST), i.e. already passed, not adjustable via the dropdown -- fixed at 7 days by request |

`WINDOWS` in `server.js` is the single source of truth for both the day ranges and their labels; `WINDOW_OPTIONS` in `client.js` mirrors the same keys so the dropdown renders before any request is made (same manual-sync pattern as `CRITERIA`/`CRITERIA_OPTIONS` on Client Details -- keep both in sync when adding an option).

A subscription with no `expirationDate` at all (seen on subscriptions still `pending` that haven't started yet) is skipped entirely -- there's no date to compare against a window.

## Date arithmetic

Ingram's `expirationDate` is a plain `YYYY-MM-DD` calendar date with no time-of-day component (confirmed against real API data), unlike Autotask's timestamped fields elsewhere on this dashboard. `daysBetween()` in `server.js` diffs two such date strings via UTC-midnight math -- pure calendar-day arithmetic, deliberately NOT using the AEST offset helpers (`aestDayBoundsIso()` etc.) that timestamped fields need, since there's no time-of-day to convert here. "Today" is still anchored to the AEST calendar day (`todayAestKey()`, `@dashboard/autotask-client`), since that's the business's own "today" regardless of where the browser happens to be.

## Table columns

**Client**, **Subscription**, **Status**, **Auto-Renews**, **Term**, **Expires**, **Days**.

- **Auto-Renews**: Ingram's `renewalStatus` boolean, shown as Yes (green) / No (red) -- the single most actionable fact on this page. A subscription "expiring soon" that auto-renews needs no follow-up; one that doesn't is the one worth chasing.
- **Days**: `daysUntilExpiry` formatted as "in N days" / "Today" / "N days ago" rather than a bare signed integer, since this page mixes both directions (forward-looking windows vs. Expired Recently).
- **Term**: Ingram's `subscriptionPeriod`, formatted the same way (`formatPeriod()`) as Ingram Subscriptions.

No license-count column -- unlike Ingram Subscriptions, this page never calls the per-subscription detail endpoint (`GET /subscriptions/{id}`), so it stays fast and cheap regardless of row count; license counts aren't relevant to "is this about to expire."

## Terminating / Renewing x Annual / Monthly split

The results are split into up to four sections, by request, in this order:

1. **TERMINATING ANNUAL**
2. **TERMINATING MONTHLY**
3. **RENEWING ANNUAL**
4. **RENEWING MONTHLY**

Auto-Renews is the outer split (Terminating leads -- it's the one that actually needs a human to look at it), Term (`termType()` in `client.js`, from `term.type`: `year` -> Annual, `month` -> Monthly) is the inner split. A term type other than month/year would fall into its own "OTHER" section appended after Monthly within its Terminating/Renewing half, rather than being silently dropped or miscategorized -- not seen in real data as of writing (confirmed: every subscription across a 90-day window was `month:1` or `year:1`), but not assumed impossible.

Each section is its own heading (`.section-heading--red` / `.section-heading--green`, the same reusable full-width-shaded-heading component Ticket Times' Ticket Category sub-groups use) with its own table, sorted by **client name** (`byClientName()`), not the chronological-by-expiration order the server returns rows in. A section with zero matching rows is omitted entirely rather than shown empty -- with four possible sections instead of two, this matters more than it did with just Terminating/Renewing. This split/sort happens client-side from the single `rows` array the server returns -- the server itself still returns everything in one chronological list; `window`/`windowLabel`/`totalCount` in the response describe the whole result set, not any individual section.

## Excluded subscription names

Same `EXCLUDED_NAME_PATTERNS` list as Ingram Subscriptions (currently just `"Windows 11 Home to Pro Upgrade *"`) -- one-off SKUs that aren't meaningful recurring licensing. Not shared as a constant between the two pages (each keeps its own small copy) since it's a single line and the two pages otherwise have no reason to import from each other.

## Caching

Cached in-process per window+filter combination (20-min TTL, same convention as every other Ingram-backed page), so repeat views of the same window are instant while a different window or search always fetches fresh. Concurrent cold-cache requests for the same key share one in-flight build rather than each kicking off their own Ingram fetch.
