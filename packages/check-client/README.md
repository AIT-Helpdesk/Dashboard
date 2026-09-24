# Check Client

A single read-only page for looking up everything the dashboard already tracks about one client, without visiting three separate pages. Search a client once and see:

1. **Orders** -- the same data Contract Checks tracks for that client (every checkbox shown, but disabled -- this page never writes anything), no bulk-update column, just Client + Since Date as search options.
2. **Subscriptions** -- the same data Ingram Subscriptions shows for that client, active + pending only (no "All Statuses" toggle here).
3. **Microsoft 365 Tenancy** -- that client's real subscribed Microsoft SKUs, via Ingram's tenant ID joined against Rewst (see below).
4. **Contract Services** -- the same data Contract Services shows for that client, defaulted to the current month, with its own Month picker.
5. **Datto RMM** -- that client's own devices (grouped by Datto site, online/offline, patch status, last seen) and any open High/Critical alerts for those sites. Added later, by request, as the first step toward "collect report content from multiple systems, segmented by client" -- see its own section below.

## Design: reuse, don't duplicate

This package has no database and no business logic of its own. Every route in `server.js` is a thin wrapper calling straight into the matching sibling page's own already-existing report-building function, in-process:

- `GET /orders` -> `@dashboard/contract-checks/server.js`'s `loadEnrichedItems()` + `buildResponse()` (with `includeAllRenewals`/`includeCancelled`/`showAllDone` all forced on, and `hideRenewalOrProcessingOnly` off, so this always shows the full picture for that client rather than a working-checklist subset).
- `GET /subscriptions` -> `@dashboard/ingram-subscriptions/server.js`'s `getReport()` (no subscription-name filter, `allStatuses` forced off).
- `GET /services` -> `@dashboard/contract-services/server.js`'s `buildReport()` (no service-name filter).
- `GET /datto-rmm` -> `@dashboard/datto-rmm/lib.js`'s `getAllDevices()` + `getOpenAlerts()` directly (not that package's own `server.js`/router -- see below), filtered to the matching site(s).

Each of the first three functions is attached to its own package's exported Express router as a named property (`router.loadEnrichedItems = loadEnrichedItems`, etc.) specifically so this page can reuse them without an HTTP round-trip and without duplicating any of that logic -- see the comment at the bottom of each sibling `server.js` for the "why" of that pattern. For the exact data semantics (what counts as a renewal, how license deltas are computed, how a contract's month-overlap is resolved, etc.), see those three packages' own READMEs -- this page adds no new semantics of its own.

`client.js` similarly reuses each source page's own row-rendering code, adapted only where "read-only, one client, no bulk update" requires a difference (see the comments in `client.js` at each such spot).

## Datto RMM section

Datto RMM's own dashboard page (`@dashboard/datto-rmm`) is account-wide, not per-client -- there was no existing per-client shape in its `server.js` to reuse the way Orders/Subscriptions/Services do. So this section calls `@dashboard/datto-rmm/lib.js` directly (`getAllDevices()`, added specifically for this -- a purely additive export, every existing Datto RMM behavior/export is unchanged -- and the existing `getOpenAlerts()`), and does its own per-client filtering and 20-minute caching here in `check-client/server.js`, independent of that page's own cache.

**Datto Site is its own search field**, separate from Autotask Client and Ingram Client, because Datto's own `siteName` is a third naming system that isn't guaranteed to match either -- same reasoning as the existing Autotask/Ingram split. It defaults to mirroring Autotask Client (one-way, until manually edited -- same pattern Ingram Client already uses) since Datto sites, in practice, tend to track this MSP's own Autotask naming more closely than Ingram's distributor-catalog names do. Matched with the dashboard-wide `matchesWildcard()` convention (`@dashboard/autotask-client`), same as every other search here -- **not** a bespoke fuzzy-matching cascade like the Rewst tenant match above, since there's no real Datto site-name data available yet to calibrate one against. If a client's real Datto site name diverges from their Autotask name, adjust the Datto Site field directly.

Devices are grouped by their real Datto site (a wildcard search can genuinely match more than one site) and alerts are the account's own High/Critical-only open alerts (see `@dashboard/datto-rmm/README.md`), filtered down to the matching site(s) client-side.

**Not yet built**: this is the first of the "other systems" segments Amber asked for (Datto RMM, Autotask, INKY, SaaS Alerts, dark web monitoring, "whatever else we have" -- collected here by client, for TAMs to review before a client meeting). `@dashboard/saasalerts-alerts` already supports filtering its own alert feed by client name and could be added here the same way; INKY and dark web monitoring have no dashboard integration at all yet.
