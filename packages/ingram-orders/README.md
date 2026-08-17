# @dashboard/ingram-orders

Dashboard page: pick a date, optionally filter by client name (wildcards with `*`, same convention as Ingram Subscriptions), see every Ingram Micro Cloud Marketplace order placed **since** that date, grouped by client -- **every status included**, by request (not just completed orders). Same shape as Ingram Subscriptions: no auto-load, license/PO-style detail fetched on demand per client rather than up front.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`, picked up automatically by the shell.
- `server.js` - Express router mounted by the shell at `/api/ingram-orders`.

## Data source

Same Ingram Micro Cloud Marketplace API as Ingram Subscriptions/Subscriptions Expiring, via the shared `@dashboard/ingram-client` package. `GET /orders` is a genuinely large endpoint -- confirmed against the real API: ~20,600 total orders system-wide, spanning years, with no documented (or discoverable) way to filter by date server-side.

## "Since" date filtering -- no server-side filter param exists

Every plausible query parameter was tested against the real API (`startDate`, `endDate`, `fromDate`, `toDate`, `dateFrom`, `dateTo`, `creationDateFrom`, `creationDateTo`, `from`, `to`, `creationDate`, `orderDateFrom`) -- every single one was silently ignored; `pagination.total` never changed regardless of what was sent. The API's own documentation site (`apidocs.cloud.im`) consistently refused to load during investigation (connection reset on every attempt), so this isn't confirmed as "definitely unsupported," just "not discoverable."

What **is** confirmed against real data: `/orders` returns its full ~20,600-row history sorted **newest-first by `creationDate`** by default, and that descending order holds across page boundaries (a page 2's first date is never after page 1's last date), not just within a single page. `fetchOrdersSince()` in `server.js` relies on this: it paginates from offset 0 and stops the moment it encounters an order older than the "since" date, rather than walking the entire history. This is efficient (a recent date range only ever touches the first few pages) and correct as long as the API's default ordering stays stable -- if Ingram ever changes that default, this would need revisiting (there'd be no error, just wrong/incomplete results, so it's worth remembering if this page's numbers ever look suspiciously low for a date range that should have more).

"Since" is anchored to **AEST**, not UTC (`aestDayBoundsIso()`, `@dashboard/autotask-client`) -- the selected date's AEST midnight is the actual cutoff compared against each order's real `creationDate` timestamp.

## Every status included, by request

Unlike Ingram Subscriptions (which defaults to active+pending only, with an "All Statuses" toggle), this page always includes every order regardless of status -- no toggle, no filtering. `status`/`statusCode` values seen in real data include `completed`/`CP` and `processing`/`AS`; anything other than `completed` is flagged blue in the Status column (same convention Subscriptions uses for `pending`), not hidden. The summary line's status breakdown is built generically from whatever keys the server's `statusCounts` map actually has, not a hardcoded list, since the full set of possible statuses isn't documented.

## Table columns

**Order #**, **Type** (`change`, `renewal`, `sales`, `cancellation` confirmed in real data -- shown as-is, not enumerated as a fixed list), **Status**, **Created** (`creationDate`, a real timestamp -- shown as full date+time, browser-local, unlike Ingram Subscriptions' plain-date fields), **Provisioned** (`provisioningDate`, blank until Ingram actually provisions the order -- most non-`completed` orders won't have one yet), **PO #**, **Product**, **Licenses** (the last column, right-justified -- see below). Group headers show just the client name, nothing else -- no order count, by request.

## Show Renewal Orders (checkbox, off by default)

Renewals are typically the highest-volume, least-actionable order type (automatic, no real decision behind them -- confirmed against real data: for one test week, 40 of 57 total orders were renewals), so they're excluded by default. Sent as `includeRenewals=true` when checked, filtered server-side (`buildReport()`) before grouping/counting -- excluded orders don't just get hidden client-side, they're left out of `totalCount`/`statusCounts`/client groupings entirely, same as how Ingram Subscriptions' "All Statuses" toggle works. Part of the cache key (`cacheKeyFor()`) alongside the since-date and client filter, so toggling it always fetches/serves the right variant rather than showing stale results from the other state. The summary line and empty-state message both note "(renewals excluded)" when the box is unchecked, so it's clear the totals shown aren't the full picture.

## PO number, Product, and Licenses -- on demand, per client

Deliberately not part of the base report, same rationale as Ingram Subscriptions' license counts: the list endpoint's rows don't carry a PO number, product name, or quantity, only the single-order **detail** endpoint (`GET /orders/{id}`) does -- confirmed against the real API, where a detail response also included the full price/tax/discount breakdown per line item (not surfaced here, out of scope for this page). Fetching that for every order up front would mean one request per order regardless of whether anyone looks at it, so instead:

1. Each client's name in the results is a **button**. Clicking it calls `GET /api/ingram-orders/detail?ids=<comma-separated order IDs for that client>`.
2. The server resolves each ID's detail (`fetchOrderDetailWithRetry()`, same bounded-concurrency + 429-retry-with-backoff pattern Ingram Subscriptions' `fetchLicenseCount()` uses -- Ingram's per-item detail endpoints are assumed to share the same time-window rate-limit behavior confirmed for `/subscriptions/{id}`, though not separately re-confirmed for `/orders/{id}`).
3. Only **that client's** table rows are replaced in the DOM -- every other client group on screen is left exactly as it was.

`poNumber` is Ingram's own field name for what shows up in real data as an Autotask ticket number (e.g. `T20260727.0038`) -- useful for tying an Ingram order back to the Autotask ticket that triggered it, though this page doesn't attempt to resolve it into an actual Autotask deep link (no confirmed way to go from a ticket number string to a ticket ID without a lookup query, unlike the numeric IDs Ticket Times/Completed Tickets already have in hand). Product/Licenses are two separate, position-matched columns built from the same `products` array (each line item's `name` in Product, its `quantity` in Licenses) -- multiple line items join with commas in both columns, in the same order, rather than mashing name+quantity together into one cell.

**`renewal` and `cancellation` type orders carry no `products` (or `details`) array on the order itself at all** -- confirmed against real data, unlike `change`/`sales` orders, which do. Every order type seen still carries a `subscriptionId`, though, and that subscription's own `name` field (via `getSubscriptionDetail()`, the same lookup Ingram Subscriptions' on-demand license counts use) is exactly the product name -- confirmed this resolves correctly even for an already-cancelled subscription. `fetchOrderDetailWithRetry()` falls back to this automatically whenever `products` comes back empty, rather than leaving Product/Licenses blank for these order types. If that subscription lookup itself fails, both columns are left blank for just that one order rather than failing the whole client's detail fetch.

The subscription's own `products[].quantity` is also carried through in this fallback case (summed across its product lines, almost always exactly one) -- **not a delta** the way a `change` order's quantity is (there's no "before/after" for a renewal/cancellation), just the current total seat count, so a renewal at least shows how many items were involved (Licenses column shows `450`, e.g.) rather than leaving it blank. Left `null` only if the subscription itself genuinely carries no product lines.

## What the Licenses column actually means

A `change`-type order's `products[].quantity` is a **signed delta**, not a total -- confirmed against real data: a downgrade (removing a seat) came back as `quantity: -1`, adding a seat came back positive. Carried through as `{name, quantity}` pairs (not squashed into one string) so the Licenses column can show what actually happened. For any other order type (including the subscription-name fallback case above), the plain quantity is shown instead (`18` for a fresh sale of 18 seats, or `450` for a renewal's current seat count) -- not a signed delta, since it isn't one; only `change` orders get the `+`/`-` treatment (`formatLicenseEntry()`, the plain fallback formatter used for anything that isn't the single-product `change` case below).

**A `change` order with exactly one product line shows the delta colored, plus the resulting total** -- `licensesCellHtml()` renders it as e.g. a green `+1 = 22` or a red `-1 = 32` (`.cell-flag-green`/`.cell-flag-red`, same classes used for the Auto-Renews column on Subscriptions Expiring). Only the delta itself is colored/bold; the `= N` part is deliberately plain text, by request. The `N` is the subscription's own **current** total quantity (`totalQuantity()` in `server.js`, resolved via a second `getSubscriptionDetail()` call for `change` orders specifically) -- Ingram's order detail has no "resulting quantity" field of its own (confirmed against real data), so this is the best available proxy for "the total after this change." It's accurate as long as no *later* change has since altered that same subscription further -- there's no way to get an exact-at-the-time historical snapshot from this API, only the subscription's live state. A `change` order with more than one product line, or where the subscription lookup itself fails, falls back to the plain (uncolored, no `= N`) rendering instead.

A client's `detailLoaded` flag (set client-side, in-memory) makes a repeat click on an already-loaded client a no-op; a failed fetch resets nothing but the button label ("... click to retry").

## Load All Products & Licenses (button)

Sits next to Refresh, hidden until there's at least one client group to load. Loads every still-un-loaded client's PO/Product/Licenses **in one request** (`loadAllDetails()`) rather than clicking each client name individually -- every un-loaded client's order IDs are gathered into a single comma-separated list and sent to the same `/detail` route the per-client click uses, so it's still one round trip regardless of how many clients that covers, just a bigger one (the server's own bounded-concurrency batching, already in place for the per-client case, absorbs the larger batch the same way). Clients already loaded (from an earlier individual click) are skipped. A full re-render (`render(lastData)`) is the simplest correct way to reflect every group's table and button label at once afterward, rather than patching each one individually.

## Grouping and sorting

Grouped by resolved client name. Unlike Ingram Subscriptions (alphabetical by name, since subscriptions don't have a natural chronological axis worth prioritizing over their name), client groups here are sorted by **most recent order first**, and orders within a client are also sorted most-recent-first -- orders are inherently a chronological/activity feed, so recency is the more useful ordering than alphabetical.

## Caching

Cached in-process, keyed by the since-date, filter term, AND the renewals toggle together (20-min TTL), same convention as Ingram Subscriptions. The page's **Refresh** button always sends `force=true`, bypassing the cache. Order detail (PO#/products) is cached separately, per order ID, same 20-min TTL.

## No auto-load

Same as Ingram Subscriptions, by request -- waits for an explicit Refresh click. `lastData` (module-scope) still restores the last result instantly on a same-session re-mount, including any detail already loaded per-client.
