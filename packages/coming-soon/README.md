# @dashboard/coming-soon

Renewals early-warning page -- Phase 1, by request ("let's start by getting
the info on a page and then work from there"). **Read-only.** No
notifications, ticket creation, invoicing/payment automation, or
auto-renew toggling yet -- those are real, intended next phases, just not
this one.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`.
- `server.js` - Express router mounted by the shell at `/api/coming-soon`,
  with two sub-routes: `GET /domains` and `GET /licensing`.

Two sections so far, picked via the page's own Section dropdown (NOT the
generic `tab-page-server.js` "-tabs" wrapper every page under
Licensing uses -- that wrapper just bundles several already-independent
pages as tabs; this page's sections share one set of window controls and
are meant to eventually cross-reference each other and feed shared
automation):

## Domains

Every domain in our own TPP Wholesale reseller account, via
`@dashboard/tpp-client`'s `fetchAllDomains()` -- confirmed live against the
real account: paginated (`GET /domains?page=N`), 564 domains total as of
this writing. **Important gotcha already hit once:** TPP's own `pageCount`
field in that response is NOT the total number of pages despite the name --
it's actually the page SIZE. `fetchAllDomains()` loops on `totalCount` and
an empty page instead, not `pageCount`.

Each domain's `accountReference` (e.g. `"SHE-696"`) repeats across every
domain belonging to the same client -- confirmed live -- so it's shown as
the "TPP Client" column. It's also resolved to a real Autotask company,
shown FIRST as its own "Autotask Client" column, via the "Name:TPP" UDF on
Companies (populated by hand, via a one-off fuzzy-match-then-review pass
against TPP's own customer export; see `@dashboard/autotask-client`'s
`getCompanyUdfValueToNameMap()`, shared with `@dashboard/data-matching`).
Not every account reference has been matched yet, so "Not matched" shows
for any row whose UDF value hasn't been written -- `@dashboard/data-matching`'s
own "TPP Domains Without an Autotask Match" check is specifically for
finding and chasing down those gaps.

## Microsoft Licensing

Two systems joined per client, confirmed live against real data:

1. **Renewal date + auto-renew + term**: Ingram Micro subscriptions, via
   `@dashboard/ingram-client` -- the exact same `fetchAllPages`/day-window
   pattern `@dashboard/subscriptions-expiring` already proved out, filtered
   to Microsoft-ish subscription names (`MS_LICENSE_NAME_PATTERN` in
   `server.js`). Confirmed live: this account's Ingram catalog is almost
   entirely Microsoft CSP licensing (1456 of 1659 total subscriptions match).
2. **Current contracted quantity**: a dedicated, simpler query in this
   package's own `server.js` (`fetchCompanyContractedQty`) against Autotask
   Contracts/ContractServiceUnits -- deliberately NOT a reuse of
   `@dashboard/contract-services`' own `buildReport()`, which is scoped to a
   specific billing month and carries next-period/bundle logic this page
   doesn't need; this just wants "what's contracted as of today." Each
   Ingram subscription is matched to its own specific contracted line (not
   just dumped as a list) via `findMatchingContractedLine()`, which strips
   each side's own differently-spelled term suffix (Ingram's "(NCE COM ANN)"
   vs. Autotask's "(Annual)") before comparing -- confirmed live against
   real rows, e.g. "Microsoft 365 Business Standard (NCE COM ANN)" correctly
   matched to the Autotask line "Microsoft 365 Business Standard (Annual)".
   The matched quantity is its own right-justified "#" column, placed
   before "Autotask Contracted" (which shows the matched line's name).

**Licenses actually in use** (the M365 tenancy itself, via
`@dashboard/m365-environment`) is deliberately NOT wired in yet, by
request -- "Don't look up the M365 licenses at the moment, we will bring
that in when we've worked it all out so we aren't making so many calls."
`@dashboard/m365-environment` does already expose a reusable
`fetchM365LicencesForCompany()` (same convention
`@dashboard/contract-services` uses for `buildReport`) for whenever that's
ready to wire in -- real column shapes confirmed live for reference: "Licence
Name", "Available Units", "Consumed Units", "MS SKU ID", "MS SKU Part Number".

### Annual vs. Monthly, and the "Show Monthly Renewing" button

By request ("Show Annuals Renewing or Expiring in the required timeframe
and Monthly licenses expiring. Leave Monthly licenses renewing out but
have a button at the bottom to get them if the user wants to."), the
default view (`showsByDefault()` in `server.js`) is:

- **Annual** licenses, regardless of renewing or expiring -- there's a real
  yearly decision point either way.
- **Monthly** licenses ONLY when they're actually expiring (not
  auto-renewing).

Monthly-AND-renewing licenses are excluded by default -- confirmed live this
matters a lot: an unfiltered 60-day window returned **283** rows, almost
entirely routine monthly auto-billing (`subscriptionPeriod.type: 'month'`
with `renewalStatus: true`), down to a genuinely actionable **50** once
filtered. They're still one click away, not unavailable: the client's "Show
Monthly Renewing Licenses" button re-requests the same window with
`includeRenewingMonthly=true`, cached as its own separate key (confirmed
live: returns the full 283 again, exactly 233 more than the default 50).

## Window options

Same `WINDOWS` object (and the same "don't trust `pageCount`"-style of
confirmed gotcha already written up above) as
`@dashboard/subscriptions-expiring`: 7 / 14 / 30 / 60 days forward, or
"Expired Recently" (fixed at the last 7 days). Default is **30 days** --
the longest of the three notification points actually named when this page
was scoped (30/14/7 days out).

## Caching

Each section is cached in-process per window (Microsoft Licensing also
keys on `includeRenewingMonthly`, since that changes the result set), 20-min
TTL, same convention as every other Ingram-backed page on this dashboard.
