# @dashboard/ingram-subscriptions

Dashboard page: every active and pending Ingram Micro Cloud Marketplace subscription (Microsoft 365 licenses, etc.), grouped by client. Not date-scoped -- a live snapshot. Unlike most other snapshot pages on this dashboard, it does **not** auto-load on open -- by request, it only fetches when the **Refresh** button is explicitly clicked.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`, picked up automatically by the shell.
- `server.js` - Express router mounted by the shell at `/api/ingram-subscriptions`.

## Data source

Ingram Micro's **Cloud Marketplace API** (`api.cloud.im`) -- a wholly separate system from Autotask, so this page owns its own small API client directly in `server.js` for actual API access, rather than depending on `@dashboard/autotask-client` for that. Credentials (`.env`): `INGRAM_CLOUD_API_BASE`, `INGRAM_CLOUD_USERNAME`, `INGRAM_CLOUD_PASSWORD`, `INGRAM_CLOUD_SUBSCRIPTION_KEY`, `INGRAM_MARKETPLACE`.

- **Auth**: `POST {base}/token` with HTTP Basic auth (`INGRAM_CLOUD_USERNAME`/`INGRAM_CLOUD_PASSWORD`), an `X-Subscription-Key` header, and a JSON body `{"marketplace": "au"}`. Returns a bearer token valid 1500s (25 min) -- cached in-process (`tokenCache`) and refreshed 60s before actual expiry, not re-requested on every page load.
- **Subscriptions**: `GET {base}/subscriptions?status=active` and a second call with `status=pending` -- confirmed against the real API that `status` takes exactly one value per request (a comma-separated list 400s), so "active and pending" is two requests, not one. Every other status (`hold`, `terminated`, `removed`) is excluded by request.
- **Client names**: a subscription only carries a `customerId`, not a name, so client names come from a *bulk* `GET {base}/customers` (paginated, ~2 requests for ~900 customers) rather than one `GET /customers/{id}` per subscription.
- **Pagination**: Ingram returns `{ data: [...], pagination: { offset, limit, total } }` -- `fetchAllPages()` walks pages at the max confirmed page size (500) until `offset` covers `pagination.total`, since there's no next-page cursor/URL like Autotask's API has.

## Excluded subscription names

`EXCLUDED_NAME_PATTERNS` in `server.js` (currently just `"Windows 11 Home to Pro Upgrade *"`) -- one-off SKUs that aren't meaningful recurring subscriptions to track. Matched via the same wildcard convention as the client filter, and dropped **before** grouping, not just hidden client-side, so a client whose only subscription is an excluded one doesn't show up as an empty group and totals stay honest.

## Client name filter

Optional (not mandatory, by request) -- typing a client name narrows the report to matching clients using the dashboard-wide wildcard convention (`matchesWildcard()`, shared from `@dashboard/autotask-client` -- the one thing this page imports from there, purely for that shared string-matching behavior, not for Autotask data). This is the only dependency this page has on `@dashboard/autotask-client`.

## License counts -- on demand, per client

License count is deliberately **not** part of the base report at all. The list endpoint's rows don't carry a license/seat quantity, and there's no `fields`/`include`/`expand` param that adds one (checked against the real API) -- it only appears in `products[].quantity` on the single-subscription **detail** endpoint (`GET /subscriptions/{id}`), summed across a subscription's products (almost always exactly one, in Ingram's NCE licensing model). Fetching that for every subscription up front meant one detail request per subscription (500+) -- multiple minutes, even with retries -- for data most page visits never actually needed.

Instead, each client's name in the results is a **button**. Clicking it:
1. Calls `GET /api/ingram-subscriptions/licenses?ids=<comma-separated subscription IDs for that client>` -- the client already has those IDs from the base report, so the server doesn't need to re-derive them from a `customerId`.
2. The server resolves each ID's license count (`fetchLicenseCount()`, same bounded-concurrency + 429-retry-with-backoff logic as before, just scoped to a handful of subscriptions instead of hundreds).
3. Only **that client's** table rows are replaced in the DOM (`subscriptionRowsHtml()`, called again with the now-updated subscription objects) -- every other client group on screen is left exactly as it was.

A client's `licensesLoaded` flag (set client-side, in-memory) makes a repeat click on an already-loaded client a no-op rather than a redundant request; a failed fetch resets nothing but the button label ("... click to retry"), so retrying doesn't require reloading the whole page.

**Rate limiting**: confirmed against the real API that Ingram's rate limit on the detail endpoint is a time-window budget, not a pure concurrency cap -- this mattered a lot when license counts were fetched for every subscription up front (500+ requests got ~65% throttled). At the new per-client scale (typically a handful of subscriptions per click) it's a much smaller concern, but `fetchLicenseCount()` still retries on 429 with backoff (the API's own `Retry-After` header when sent, exponential backoff with jitter otherwise, up to 6 attempts) regardless. A subscription whose retries are exhausted, or that genuinely has no `products` entries (seen on non-seat-based lines like Azure Reserved Instances/Savings Plans and Ingram's own internal service plans), shows a blank license count (`null`) rather than a misleading `0`.

License counts are also cached server-side per subscription ID (`licenseCache`, 20-min TTL) -- re-clicking a client (or a subscription that reappears under a different search) after the first successful load doesn't redo the Ingram call.

## Term and billing period

Both come straight off the list-endpoint row (`subscriptionPeriod` -> **Term**, `billingPeriod` -> **Billing Period**) -- unlike license count, no extra request needed, so these are always populated in the base report. They can genuinely differ: a subscription can have a 1-year term billed monthly rather than prepaid annually, so they're shown as two separate columns. Both are `{type, duration}` (e.g. `{type: "month", duration: 1}`), formatted client-side (`formatPeriod()`) as "Monthly"/"Annual"/"Daily" for the common duration-1 cases, or "N months"/"N years" otherwise.

## Grouping

Subscriptions are grouped by resolved client name, sorted alphabetically; within a client, subscriptions are sorted alphabetically by subscription name. Each client group's header shows its subscription count; each row shows the subscription name, status (pending shown in blue via the shared `.cell-flag-blue` class), license count (blank until that client's name is clicked), term, billing period, and creation/renewal/expiration dates.

## Caching (base report)

Each search is cached in-process, **keyed by its filter term** (an empty/no filter is its own key) rather than one single global cache slot -- a repeated search for the same client is instant within the cache window, while a different search does its own build. TTL is 20 minutes (`REPORT_CACHE_TTL_MS`). The page's **Refresh** button always sends `force=true`, which bypasses the cache for the current search and rebuilds from Ingram. Two requests landing for the same filter term while it's cold share one in-flight build (`inFlightByKey`) rather than each kicking off their own fetch. The response's `asOf` timestamp is shown in the page summary.

## No auto-load

This page does **not** fetch on mount, by request -- it waits for an explicit Refresh click. `lastData` (module-scope, survives a same-session re-mount when navigating away and back) still restores the last result instantly, including any license counts already loaded per-client, same convention as every other page.
