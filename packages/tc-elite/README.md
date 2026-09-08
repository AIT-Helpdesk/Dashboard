# @dashboard/tc-elite

A first pass, by request ("let's start with that and see what we get") -- every client currently on a "Tech Cover Elite" contract, with a seat count summed from that contract's own TC Elite service lines. Lives in the "Contract Mgmt" menu category (`update-contracts` in `nav-layout.json`), alongside Contract Checks/Ingram Subscriptions/etc.

- `client.js` -- frontend module. Exports `id`, `label`, and `mount(container)`.
- `server.js` -- Express router mounted by the shell at `/api/tc-elite`. Read-only.

**Not to be confused with `@dashboard/tc-elite-rollout`** -- that page tracks per-client ROLLOUT/IMPLEMENTATION status of TC Elite (and other) products via a staff-editable colour-coded grid, backed by its own SQLite database. This page is a live, read-only report over real Autotask billing data -- who currently HAS TC Elite and how many seats, not whether the rollout steps are done.

## Confirmed against real data before writing any of this

Autotask's own naming for this is **"Tech Cover Elite"**, not the literal abbreviation "TC Elite" -- a Services-catalog search for "TC Elite" returns nothing; the real branding ("Tech Cover Elite") is used consistently across contracts, services, and invoice descriptions.

There are actually **two separate same-client contracts** that both have "TC Elite" in the name, and only one of them matters here:

- **`T&M TC Elite [tier]`** (e.g. "T&M TC Elite Platinum") -- a **Time & Materials** contract (`contractType` 1). This is the client's default service-desk contract governing the hourly billing rate. Confirmed against a real one: it carries **zero** `ContractServices`/`ContractServiceUnits` rows of its own -- there's nothing to report on here.
- **`Tech Cover Elite`** (exact name, no tier suffix) -- a **Recurring Service** contract (`contractType` 7). This is the one that actually carries the seat/unit billing this page reports on. `fetchTcEliteContracts()` in `server.js` matches on this exact name.

Exactly **three** real Services carry the "Tech Cover Elite" branding in this Autotask instance (confirmed via a Services-catalog search, not guessed) -- `TC_ELITE_SERVICE_IDS` in `server.js`:

- `207` "Tech Cover Elite - Managed Support Plan" -- the main seat line on almost every contract.
- `471` "Tech Cover Elite Discount/Credit".
- `478` "Tech Cover Elite - Specialist Service".

## The rule, exactly as requested

For every client with an active (`status` 1) "Tech Cover Elite" contract:

1. Find that contract's own `ContractServices` rows whose `serviceID` is one of the three above.
2. For each, find its **current** `ContractServiceUnits` period -- the row whose own `startDate`/`endDate` actually contains today's AEST calendar date (`isCurrentPeriod()`), not a specific selected month (there's no month picker on this page -- it's a present-tense "who has it right now" snapshot).
3. Keep only lines whose current period has a **positive `price`** (excludes a $0 placeholder/comment line, and any credit/discount line that nets to zero).
4. Sum `units` across every qualifying line, per company -- that's the Seats column.

Sorted by seats descending (the biggest TC Elite clients are the most useful to see at a glance), company name as the tiebreak.

## Worth knowing honestly: "units" isn't always a literal person-seat count

This is a deliberate first pass, not a refined "user seats only" rule -- it counts whatever `units` says on any line tagged with one of the three TC Elite service IDs, by request ("count of units...for TC Elite services...count only the TC Elite lines"). Confirmed against real data that this isn't always literally "one unit = one person": a handful of real contracts reuse the SAME service ID (`207`) under a custom `invoiceDescription` for a genuinely different kind of unit entirely -- e.g. a server count or a website count, not a user seat. The Lines column's own hover tooltip shows every qualifying line's own description/units/$/period per client, specifically so this is easy to spot and sanity-check against what actually shows up here.

## Caching

10-minute TTL, same reasoning Service Calls'/Today Things' own report caches give for their own short windows -- a contract change (client added/removed, seats adjusted) should stop showing stale within the hour, not linger for this dashboard's more usual 20-minute default. Refresh forces a genuine re-fetch.

## Not yet built

- A refined "user seats only" filter (e.g. matching on `invoiceDescription` text, not just the service ID) -- once this first pass has been reviewed against what it actually surfaces.
- Any historical/trend view (seat counts over time) -- this is a live current-period snapshot only.
- A month picker (à la Contract Services) -- "current period" only, by request, for this first pass.
