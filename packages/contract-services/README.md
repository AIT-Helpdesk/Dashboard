# @dashboard/contract-services

Dashboard page: search for a service (or service bundle) by name (with * wildcards) and pick a month, see every matching, active service/bundle item active during that month, on contracts whose date range covers that month. Grouped by company.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`, picked up automatically by the shell.
- `server.js` - Express router mounted by the shell at `/api/contract-services`.

## Data model

Autotask spreads this across three entities, joined here in application code (the REST API has no cross-entity joins):

- **Contracts** - filtered by date range covering the selected month (`startDate < monthEnd AND endDate >= monthStart`, both **AEST** month boundaries via `aestToUtcIso()`, not UTC), NOT by `status`. A contract since cancelled/terminated (`status = 0`) but genuinely active during the selected month must still show for that month -- status reflects the contract's current state, not whether it was valid back then. When a client filter is given, matching company IDs are resolved first and folded into this query as a `companyID in [...]` filter (chunked) -- there are ~1,900 contracts overlapping a typical month system-wide, so querying all of them and filtering by client in JS afterward dominated request time regardless of how narrow the filter was.
- **Services** - the service catalog. Filtered to `isActive = true` and, if a search term is given, by name.
- **ContractServiceUnits** - the per-period record of how many units of a service were active on a contract, with its own `startDate`/`endDate`. Queried scoped to the candidate contract IDs (`in` filter, chunked at 450) rather than system-wide -- a client filter narrows the contract set first, so it also narrows this query, instead of pulling every contract's units for the month regardless of filter and discarding most of it in JS.

Independent queries run via `Promise.all` rather than one after another (Contracts/Services/ServiceBundles as one group; the two ContractServiceUnits/ContractServiceBundleUnits candidate fetches as another; the next-period lookups and ContractServices/ContractServiceBundles fetches as a third) -- each Autotask API round trip carries its own latency regardless of result size, so this matters even when none of the individual queries return much data.
- **ContractServices** - the per-contract-service override record, joined via ContractServiceUnits' own `contractServiceID` foreign key (NOT by contract+service pair -- a pair can have more than one ContractServices row, e.g. a leftover one-time proration row alongside the ongoing recurring row, so joining on the pair can silently pick the wrong one). Its `invoiceDescription`, when set, replaces the Service's own `invoiceDescription` as the display text (falling back further to the Service's `name` if neither is set). Its `internalDescription` is shown as a secondary line beneath the service name, if present.

Autotask also has a **completely parallel set of entities for Service Bundles** -- `ServiceBundles`, `ContractServiceBundles`, `ContractServiceBundleUnits` -- mirroring the four above field-for-field (`serviceBundleID` instead of `serviceID`, `contractServiceBundleID` instead of `contractServiceID`, etc). A contract can use plain Services, Service Bundles, or a mix; a contract that only uses bundles has zero rows in the plain Services entities. Both families are queried and merged into the same result set, using the same month-matching rule, active-service, and `units > 0` filters.

The Contract column links to the contract's Summary page in Autotask, via the `OpenContract` command in Autotask's `ExecuteCommand` deep-link API (`getContractUrl()` in `@dashboard/autotask-client`) rather than a raw web UI route, since those routes aren't documented/stable.

A result row exists only where all three line up: the contract's date range covers the selected month, the service is active (and matches the search), and a ContractServiceUnits row for that contract+service qualifies for the selected month under the rule below.

## Month-matching rule

A unit is included if either:

- its period **starts** in the selected month (covers monthly services, and any longer-period service that happens to kick off this month), or
- it **started before** the month and is still running (`endDate >= monthStart`), **and** its period is **longer than a month** (`endDate - startDate > 35 days`).

The second condition is what picks up quarterly, semi-annual, and annual contracts that were already active going into the selected month. It deliberately excludes short monthly periods that merely spill a day or two into the month from an earlier start (a period has to be genuinely longer than ~35 days to qualify), so a normal monthly service never gets double-counted across two months.

Units of `0` or less (e.g. a service that's been zeroed out on a contract but not removed) are excluded regardless of whether the period otherwise qualifies.

## Units column: next-period figure

The Units column shows the selected month's unit count, and in brackets, the count for the day after the CURRENT ROW'S OWN period ends -- its actual renewal date, e.g. `8 (10)`. This is per-row, not a fixed calendar month: a monthly service's period happens to end the day before next calendar month starts, so for those it lines up with "next month" -- but an annual/quarterly line (e.g. a period of `01/07/2026-30/06/2027`) renews a year later, not next calendar month, and the lookup follows that line's own end date, not the page's selected month.

Implementation: for each matched line, its full period history is fetched by its own `contractServiceID`/`contractServiceBundleID` (there are only ever a handful of periods per line), then whichever period covers `endDate + 1 day` is picked in application code. Not filtered to `units > 0` (a drop to zero next period is itself worth surfacing). If Autotask hasn't created that future period's row yet, no bracketed figure is shown. The bracketed figure is bold and colored red (decrease) or green (increase) when it differs from the current count.

Joined by `contractServiceID` / `contractServiceBundleID` (the units' own foreign key), NOT by contract+service, for the same reason as the invoice-description join: a contract can carry more than one line against the same underlying Service (e.g. a full-price line and a separate 50%-discount credit line both pointing at the same Service), which would otherwise collide and mismatch one line's current units against a different line's next-period units.

## Last Changed column

`ContractServiceUnits` has no modification timestamp of its own (Autotask doesn't track that at the line-item level). The "Last Changed" column shows the parent **Contract**'s `lastModifiedDateTime` instead - the closest thing available, but it reflects changes to the contract record generally, not specifically to that service/period line. It's shown in red/bold when the change was within the last 30 days (i.e. red flags *recent* activity, not staleness).

## Cost / Sell / Total columns

`ContractServiceUnits` stores `cost`/`price` as totals for the full unit quantity in
that period, not a per-item rate. The Cost/Sell columns show the per-item figure
(`cost`/`price` divided by `units`) so it's directly comparable to the service's
list price. The Total column (after Sell) shows `price` itself, undivided --
the actual total sell amount for that line, matching what the client is billed.

## Search syntax

`parseWildcard()` lives in `@dashboard/autotask-client`, shared with the Client Details page's client-name filter -- keep the convention identical if it ever changes.

- No `*` - substring match (same as `*term*`).
- `term*` - starts with.
- `*term` - ends with.
- `*term*` - contains.
- Blank - all active services.