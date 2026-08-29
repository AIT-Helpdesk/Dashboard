# @dashboard/ingram-orders

Dashboard page: pick a date, optionally filter by client name, status, and/or product (wildcards with `*`, same convention as Ingram Subscriptions), see every Ingram Micro Cloud Marketplace order placed **since** that date, grouped by client -- **every status included**, by request (not just completed orders). Same shape as Ingram Subscriptions: no auto-load, license/PO-style detail fetched on demand per client rather than up front (except when the Product filter is used -- see below).

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`, picked up automatically by the shell.
- `server.js` - Express router mounted by the shell at `/api/ingram-orders`.

## Data source

Same Ingram Micro Cloud Marketplace API as Ingram Subscriptions/Subscriptions Expiring, via the shared `@dashboard/ingram-client` package. `GET /orders` is a genuinely large endpoint -- confirmed against the real API: ~20,600 total orders system-wide, spanning years, with no documented (or discoverable) way to filter by date server-side.

## "Since" date filtering -- no server-side filter param exists

Every plausible query parameter was tested against the real API (`startDate`, `endDate`, `fromDate`, `toDate`, `dateFrom`, `dateTo`, `creationDateFrom`, `creationDateTo`, `from`, `to`, `creationDate`, `orderDateFrom`) -- every single one was silently ignored; `pagination.total` never changed regardless of what was sent. The API's own documentation site (`apidocs.cloud.im`) consistently refused to load during investigation (connection reset on every attempt), so this isn't confirmed as "definitely unsupported," just "not discoverable."

What **is** confirmed against real data: `/orders` returns its full ~20,600-row history sorted **newest-first by `creationDate`** by default, and that descending order holds across page boundaries (a page 2's first date is never after page 1's last date), not just within a single page. `fetchOrdersSince()` in `server.js` relies on this: it paginates from offset 0 and stops the moment it encounters an order older than the "since" date, rather than walking the entire history. This is efficient (a recent date range only ever touches the first few pages) and correct as long as the API's default ordering stays stable -- if Ingram ever changes that default, this would need revisiting (there'd be no error, just wrong/incomplete results, so it's worth remembering if this page's numbers ever look suspiciously low for a date range that should have more).

"Since" is anchored to **AEST**, not UTC (`aestDayBoundsIso()`, `@dashboard/autotask-client`) -- the selected date's AEST midnight is the actual cutoff compared against each order's real `creationDate` timestamp.

## Every status included, by request

Unlike Ingram Subscriptions (which defaults to active+pending only, with an "All Statuses" toggle), this page always includes every order regardless of status -- no toggle, no filtering by default. `status`/`statusCode` values seen in real data include `completed`/`CP`, `processing`/`AS`, and `cancelled`; anything other than `completed` is flagged blue in the Status column (same convention Subscriptions uses for `pending`), not hidden. The summary line's status breakdown is built generically from whatever keys the server's `statusCounts` map actually has, not a hardcoded list, since the full set of possible statuses isn't documented.

## Status and Product filters

Two more optional wildcard filters, alongside Client, combinable with each other and with Show Renewals: **Status** (`completed`, `processing`, `cancelled`, etc.) and **Product** (matches against a resolved order's product name(s)).

Status is "free" -- it runs directly against a field already present on the base `/orders` list response, applied server-side in `buildReport()`'s main filtering loop, right after the "Show Renewals" checkbox's own exclusion and before the Client filter. Order matters here: the checkbox is the outer gate (excluded renewal orders never reach the Status filter at all -- Status only narrows within whatever the checkbox already allows through).

Product is different -- **it isn't on the base list endpoint at all**, only on each order's individual detail (or, for `renewal`/`cancellation` orders, their subscription's detail -- see below). So setting a Product filter makes the server fetch detail (`getOrderDetailCached()`, the same bounded-concurrency + 429-retry machinery the per-client "click to load" and "Load All" buttons use) for every order that survives the Client/Status/renewals filtering first -- deliberately the already-narrowed candidate set, not the full history, to keep the cost down. Confirmed against real data this correctly resolves product names for `change`/`sales` orders (their own `products[]`) as well as `renewal`/`cancellation` orders (via the subscription-name fallback). Matched rows come back from the API with `poNumber`/`products`/`currentTotal` already populated (`detailPreloaded: true` in the response), so the client shows Product/Licenses immediately -- no further click needed, and the "Load All Products & Licenses" button is hidden in this case since there'd be nothing left to load.

Both are part of the cache key (`cacheKeyFor()`) alongside since-date/client/renewals, so each distinct filter combination gets its own 20-min cache entry. The summary line lists every active filter (`matching client "X", status "Y", product "Z"`), only including the clauses that are actually set.

## Table columns

**Order #**, **Type** (`change`, `renewal`, `sales`, `cancellation` confirmed in real data -- shown as-is, not enumerated as a fixed list, and not filterable -- see below), **Status**, **Created** (`creationDate`, a real timestamp -- shown as full date+time, browser-local, unlike Ingram Subscriptions' plain-date fields), **Provisioned** (`provisioningDate`, blank until Ingram actually provisions the order -- most non-`completed` orders won't have one yet; for a still-`processing` order, shows a projected date instead once detail's loaded -- see "Provisioned column for pending orders" below), **PO #**, **Product**, **Licenses** (the last column, right-justified -- see below). Group headers show just the client name, nothing else -- no order count, by request.

## Provisioned column for pending orders

A `status: 'processing'` order (this page's "not final yet" status -- same one the Status and Licenses columns already flag blue, see "What the Licenses column actually means" below) has no `provisioningDate` yet, since Ingram hasn't actually provisioned it. By request, the Provisioned column shows **when the change will take effect** instead, once that order's detail has been loaded (click the client's name, "Load All Products & Licenses", or a Product filter -- same on-demand detail fetch as PO#/Product/Licenses, resolved in `fetchOrderDetailWithRetry()`). Blank before detail is loaded, same as PO#/Product/Licenses.

Two sources, in order:

1. **The order's own line-item description** -- a `change` order's `details[].description` spells out the new billing period as free text, confirmed against real data, e.g. `"Microsoft 365 Business Premium Recurring (1 Month(s) term) from 2026-09-18 through 2026-10-17"`. The `from` date is the date the change actually activates, extracted with a regex (`/from\s+(\d{4}-\d{2}-\d{2})\s+through/`) against the first line that matches.
2. **The subscription's own next `renewalDate`** (via `getSubscriptionDetail()`) -- used whenever no such date can be found on the order itself, which is expected for `renewal`/`cancellation`-type orders (confirmed against real data these carry no `details` array at all, same gap the Product-column fallback below works around).

Either way, shown in **red** (`.cell-flag-red`) to mark it as a projected/not-yet-provisioned date, distinct from a real `provisioningDate`. The subscription lookup used for this fallback is the same memoized per-order fetch (`getSubOnce()`) the product-name fallback and the `change`-order current-total lookup already use -- resolved at most once per order regardless of how many of the three need it.

## Show Renewals / Show ALL Renewals (two checkboxes, both off by default)

Renewals are typically the highest-volume, least-actionable order type (automatic, no real decision behind them -- confirmed against real data: for one test week, 40 of 57 total orders were renewals), so they're excluded by default. Two independent checkboxes control how much of that noise gets pulled back in:

- **Show Renewals** -- a *partial* include: a renewal order is shown only if that client already has at least one other, non-renewal order surviving the Client/Status/Show Cancelled filters -- i.e. a client isn't pulled onto the page SOLELY because of a renewal, but if they're already going to be listed for a real, actionable order, their renewals are shown too for context. Sent as `includeRenewals=true`.
- **Show ALL Renewals** -- the page's original/unconditional behavior: every renewal order is included, for every client, regardless of what else that client has. Sent as `includeAllRenewals=true`.

**If both are checked, Show ALL Renewals wins** -- it's the strict superset, so the partial rule never has anything left to narrow.

`buildReport()` implements the partial rule with a first pass over the fetched orders (ignoring the renewal-type gate itself) to build the set of customer IDs that have a surviving non-renewal order, then the real filtering/grouping pass checks a renewal order's customer ID against that set. Excluded orders don't just get hidden client-side either way -- both checkboxes affect `buildReport()` before grouping/counting, so excluded renewals are left out of `totalCount`/`statusCounts`/client groupings entirely, same as how Ingram Subscriptions' "All Statuses" toggle works. Both flags are part of the cache key (`cacheKeyFor()`) alongside the since-date and client filter, so toggling either always fetches/serves the right variant rather than showing stale results from another state. The summary line and empty-state message note "(renewals excluded)" when neither box is checked, or "(renewals limited to clients with other orders)" when only Show Renewals is checked -- nothing is noted when Show ALL Renewals is on, since nothing's held back. There's no filter on Type itself (only these two checkboxes for renewals specifically) -- Type is shown as a column but isn't otherwise searchable.

## Show Cancelled (checkbox, off by default)

A third, independent checkbox on the same row as Show Renewals/Show ALL Renewals (its own row, under the Status/Product row -- all three "Show" checkboxes are grouped together there), same off-by-default/outer-gate pattern, but keyed on **status**, not type: hides any order whose `status` is `cancelled`, regardless of its `type`. This is deliberately a *different* concept from `type: 'cancellation'` (an order that cancels a subscription) -- confirmed against real data across a 90-day sample these are mostly disjoint sets (10 `type: 'cancellation'` orders vs. 18 `status: 'cancelled'` orders, only 1 order was both). A `status: 'cancelled'` order is typically a `change`/`sales`/`cancellation`-type order attempt that itself got cancelled/withdrawn before completing -- noise similar in spirit to renewals, just a different axis, which is why it gets its own toggle rather than being folded into either renewals checkbox or treated as part of the Status filter. Sent as `includeCancelled=true` when checked, part of the cache key alongside `includeRenewals`/`includeAllRenewals`. See "Show Renewals / Show ALL Renewals" above for exactly what the summary/empty-state suffix says for each combination of the three boxes.

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

**A `change` order with exactly one product line shows the delta colored, plus the subscription's current total in parentheses** -- `licensesCellHtml()` renders it as e.g. a green `+1 (22)` or a red `-1 (32)` (`.cell-flag-green`/`.cell-flag-red`, same classes used for the Auto-Renews column on Subscriptions Expiring). Only the delta itself is colored/bold; the bracketed total is deliberately plain text, by request. The bracketed number is the subscription's own **current, live** total quantity (`totalQuantity()` in `server.js`, resolved via a second `getSubscriptionDetail()` call for `change` orders specifically) -- it is **not** the total right after this specific order. Confirmed this can't be derived reliably: Ingram's order detail has no "resulting quantity" field of its own, and attempting to reconstruct a historical total by working backwards through every later change order on the same subscription doesn't hold up against real data either -- one real subscription's change-order quantities came back as `20, 19, 20, 1, 1` in sequence, swings too large and irregular to trust a simple running-total reconstruction, and doing so per row would also mean fetching a subscription's entire order history rather than just what's on screen. Parentheses (not `= N`) are used specifically so the number doesn't read as "the result of this order" -- it's frankly just "the current count, for reference." A `change` order with more than one product line, or where the subscription lookup itself fails, falls back to the plain (uncolored, no bracketed total) rendering instead.

**A positive delta is colored blue instead of green when the order's own Status is `processing`** -- `.cell-flag-blue`, the same "not final yet" color the Status column already uses for anything other than `completed`. A seat *addition* that hasn't actually completed isn't a confirmed win the way green implies, so it's flagged as still-pending instead, and shown without its `+` prefix (just `1 (22)`, not `+1 (22)`) as a second visual cue that it isn't a done deal yet. A negative delta stays red with its `-` prefix regardless of status, by request -- a seat removal is treated as noteworthy from the moment it's requested, not just once Ingram confirms it. Confirmed this case is real, not hypothetical: real data includes `change` orders with a positive quantity and `status: 'processing'` at the same time.

**A pending (blue) quantity smaller than the subscription's current total is recast as a downgrade, shown red, instead of shown blue** -- confirmed against real data (order `CH005810`, subscription `1369491`): the order's `quantity` was `10`, its `scheduledOn` was `"renewal"`, and the subscription's current total was `11`. A pending order that's genuinely *adding* seats can never be smaller than a total that doesn't yet include those seats, so this case only fires for Ingram's "scheduled at renewal" orders -- there, `quantity` actually means the TARGET total once the change takes effect, not a delta to add on top of the current total. `10` in that context means "seats will be 10 as of the next renewal," i.e. a **reduction of 1** from the current 11, not an addition of 10. `licensesCellHtml()` detects this (`qty < currentTotal` while still a pending/blue case) and shows `quantity - currentTotal` instead (a negative number, e.g. `-1`), colored red like any other removal, still followed by `(currentTotal)`.

A client's `detailLoaded` flag (set client-side, in-memory) makes a repeat click on an already-loaded client a no-op; a failed fetch resets nothing but the button label ("... click to retry").

## Load All Products & Licenses (button)

Sits next to Refresh, hidden until there's at least one client group to load. Loads every still-un-loaded client's PO/Product/Licenses **in one request** (`loadAllDetails()`) rather than clicking each client name individually -- every un-loaded client's order IDs are gathered into a single comma-separated list and sent to the same `/detail` route the per-client click uses, so it's still one round trip regardless of how many clients that covers, just a bigger one (the server's own bounded-concurrency batching, already in place for the per-client case, absorbs the larger batch the same way). Clients already loaded (from an earlier individual click) are skipped. A full re-render (`render(lastData)`) is the simplest correct way to reflect every group's table and button label at once afterward, rather than patching each one individually.

## Grouping and sorting

Grouped by resolved client name. Orders within a client are always sorted **most-recent-first** -- orders are inherently a chronological/activity feed, so recency is the more useful ordering than alphabetical, and this part of the ordering isn't affected by the **Sort** control below at all.

Client GROUPS, though, can be ordered either of two ways via the **Sort** dropdown next to the checkboxes:

- **Latest Order** (default) -- whichever client has the single most recent order appears first, same as Ingram Orders' original/only behavior.
- **Client: A-Z** -- alphabetical by client name, same convention Ingram Subscriptions uses.

This is a pure client-side, no-refetch display choice -- `client.js`'s `render()` re-sorts a shallow copy of the already-fetched `data.byClient` array (server response, or `lastData` on a same-session re-mount) rather than requesting anything new, so switching it is instant and isn't part of the cache key. `data.byClient` itself always arrives from the server sorted most-recent-order-first (see `server.js`'s `buildReport()`); the client only re-sorts when "Client: A-Z" is selected.

## Caching

Cached in-process, keyed by the since-date, filter terms, AND both the renewals and cancelled toggles together (20-min TTL), same convention as Ingram Subscriptions. The page's **Refresh** button always sends `force=true`, bypassing the cache. Order detail (PO#/products) is cached separately, per order ID, same 20-min TTL.

## No auto-load

Same as Ingram Subscriptions, by request -- waits for an explicit Refresh click. `lastData` (module-scope) still restores the last result instantly on a same-session re-mount, including any detail already loaded per-client.
