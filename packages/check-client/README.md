# Check Client

A single read-only page for looking up everything the dashboard already tracks about one client, without visiting three separate pages. Search a client once and see:

1. **Orders** -- the same data Contract Checks tracks for that client (every checkbox shown, but disabled -- this page never writes anything), no bulk-update column, just Client + Since Date as search options.
2. **Subscriptions** -- the same data Ingram Subscriptions shows for that client, active + pending only (no "All Statuses" toggle here).
3. **Contract Services** -- the same data Contract Services shows for that client, defaulted to the current month, with its own Month picker.

## Design: reuse, don't duplicate

This package has no database and no business logic of its own. Every route in `server.js` is a thin wrapper calling straight into the matching sibling page's own already-existing report-building function, in-process:

- `GET /orders` -> `@dashboard/contract-checks/server.js`'s `loadEnrichedItems()` + `buildResponse()` (with `includeAllRenewals`/`includeCancelled`/`showAllDone` all forced on, and `hideRenewalOrProcessingOnly` off, so this always shows the full picture for that client rather than a working-checklist subset).
- `GET /subscriptions` -> `@dashboard/ingram-subscriptions/server.js`'s `getReport()` (no subscription-name filter, `allStatuses` forced off).
- `GET /services` -> `@dashboard/contract-services/server.js`'s `buildReport()` (no service-name filter).

Each of those three functions is attached to its own package's exported Express router as a named property (`router.loadEnrichedItems = loadEnrichedItems`, etc.) specifically so this page can reuse them without an HTTP round-trip and without duplicating any of that logic -- see the comment at the bottom of each sibling `server.js` for the "why" of that pattern. For the exact data semantics (what counts as a renewal, how license deltas are computed, how a contract's month-overlap is resolved, etc.), see those three packages' own READMEs -- this page adds no new semantics of its own.

`client.js` similarly reuses each source page's own row-rendering code, adapted only where "read-only, one client, no bulk update" requires a difference (see the comments in `client.js` at each such spot).
