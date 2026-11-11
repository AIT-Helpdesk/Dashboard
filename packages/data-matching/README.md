# @dashboard/data-matching

A page for surfacing cross-system matching GAPS -- not renewals (that's
`@dashboard/coming-soon`). Each route is one "concept": a specific pair of
systems whose client/account references should line up, with a report of
where they currently don't. Expected to grow more concepts over time (per
the page's own name), each as one more route + one more client.js section,
rather than folding unrelated matching checks into Coming Soon.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`.
- `server.js` - Express router mounted by the shell at `/api/data-matching`.

## Concept 1: TPP Domains Without an Autotask Match

`GET /tpp-domains-unmatched`. Every domain in our TPP Wholesale reseller
account (`@dashboard/tpp-client`'s `fetchAllDomains()`) that hasn't yet
expired, whose `accountReference` (e.g. `"SHE-696"`) does **not** appear as
a value anywhere in the "Name:TPP" UDF across all Autotask companies --
i.e. the exact rows `@dashboard/coming-soon`'s own Domains table would show
as "Not matched" in its Autotask Client column. Uses the same shared
`@dashboard/autotask-client` helper (`getCompanyUdfValueToNameMap`) Coming
Soon uses, so the two pages can never quietly disagree about what counts as
matched.

Grouped by TPP Client (the `accountReference` code), by request -- each
client appears once as a group header (with its domain count), with its
own domains listed underneath (Domain, Category, Expiry Date, Days,
Auto-Renews). Same "resource-group" per-client convention
`@dashboard/ingram-subscriptions` already uses for its own per-client
sections. No separate Autotask Client column -- every domain on this page
is unmatched by definition, so the group's own TPP Client code already IS
the "not matched" information.

"Active" = not yet expired. TPP's own `/domains` list is the reseller
account's full inventory with no separate active/inactive flag of its own
(see `@dashboard/tpp-client`'s own comments); an already-expired domain's
account reference is far less worth chasing down for a matching gap, so
those are excluded here.

Cached in-process, 20-min TTL, same convention as every other
Autotask/TPP-backed page.

## What this is for

The real work that follows from this page is writing more "Name:TPP"
UDF values on the matching Autotask companies, the same way the first 284
TPP account references were written (see Coming Soon's own README/history)
-- this page exists to find which ones still need it, not to do the writing
itself (Phase 1, read-only, same convention as Coming Soon).
