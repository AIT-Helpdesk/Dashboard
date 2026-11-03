# @dashboard/tc-elite-services

Every current "Tech Cover Elite" client (`Companies.classification` label, active clients only) in one list, by request -- each client's own row carries the exact same checks Client Summary's own single-client "Installed Services" row already does, so they're never a second, separately-maintained copy of that logic.

- `client.js` -- frontend module. Exports `id`, `label`, and `mount(container)`.
- `server.js` -- Express router mounted by the shell at `/api/tc-elite-services`. Read-only.

**Not to be confused with `@dashboard/tc-elite`** -- that page reports live Autotask billing data (seats/$ on the "Tech Cover Elite" recurring-service contract). This page is about contract/service VERIFICATION per client -- does each one actually have a default contract, a "Tech Cover Elite*" contract, and the expected set of security/backup tools installed -- not billing.

**Not to be confused with `@dashboard/tc-elite-rollout`** either -- that's a staff-editable rollout tracker. This page deliberately does NOT read from it (checked live, by explicit request: "I don't want to get whether Huntress and AutoElevate are installed by checking the TC Elite rollout... I want you to look up the products using APIs" -- that tracker is itself what a page like this is meant to verify against a real source, so reusing it here would be circular).

## Per-row pills, in order

1. **Default** (blue) -- the client's active contract with `Contracts.isDefaultContract` set. Labeled with the matched contract's own name ("Default: None" if none is set), still blue either way, not a warning colour.
2. **Tech Cover Elite** (blue) -- the client's active contract whose name starts with "Tech Cover Elite" (case-insensitive prefix match, same rule Client Summary's own Active Contracts warning uses). Unlike the Default pill, this one keeps a fixed, short label ("Tech Cover Elite") -- the matched contract's own full name (or "None" if not found) is hover-only, by request, since a real contract name here ("Tech Cover Elite - Managed Support Plan") is long enough to otherwise widen every pill in the row.
3. **SaaS Alerts / SaaS Backups / Datto EDR / AutoElevate / Huntress / Rewst** (green = installed, red = not, grey = not yet configured/connected) -- built by `@dashboard/client-summary/installed-services.js`'s own `buildInstalledServices()`, the SAME function Client Summary calls for one client at a time. See that file's own comments for the full per-vendor methodology (SaaS Alerts' exact PSA-id match, SaaS Protection/Datto EDR/AutoElevate/Huntress/Rewst's own name-matching, and why Dark Web ID/INKY aren't included yet).

Hover any pill for its detail (the matched contract/vendor name, seat/agent/location counts, etc.) -- a native `title=` tooltip, same convention Client Summary's own badges use.

## How the data is built

1. Resolve the `classification` picklist code for the label "Tech Cover Elite", then fetch every active (`isActive: true`) company with that code.
2. One BATCHED `fetchByFieldIn()` across every one of those companies' active (`status` 1) contracts -- not one contracts query per company -- to build the 2 contract pills.
3. One bounded fan-out (concurrency 5) across every company's own `buildInstalledServices()` call -- each vendor's own underlying list fetch is still cached on its own TTL (see `@dashboard/client-summary`'s `datto-edr.js`/`autoelevate.js`/`huntress.js`/`rewst.js`/`installed-services.js`), so this mostly just bounds how many run concurrently, not how often the underlying vendor data itself is actually fetched.

## Caching

10-minute TTL on the whole built report (same reasoning `@dashboard/tc-elite`'s own cache gives) -- a contract or installed-service change shouldn't linger stale for the dashboard's more usual 20-minute default, but this report is expensive enough (a per-company fan-out across six vendor APIs) that it shouldn't re-run on every page view either. Refresh forces a genuine re-fetch.
