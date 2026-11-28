# @dashboard/tc-essentials-seat-check

Every current "Tech Cover Essentials" client (`Companies.classification` label,
active clients only), with its 3 real Kaseya 365 contract lines' CONTRACTED
units checked against two independent, LIVE counts: **Workstations** from
Datto RMM and **Licensed Users** from SaaS Alerts. Read-only -- this page
never writes to Autotask (no "Update" button, unlike Check Client's own
Contract column).

- `client.js` -- frontend module. Exports `id`, `label`, and `mount(container)`.
- `server.js` -- Express router mounted by the shell at `/api/tc-essentials-seat-check`.

**Not to be confused with Check Client's own TC Calc column** (the same
"Essentials Check Summary" section on that page) -- that one compares
against M365 Tenancy's own per-license-level user count and ALL 4 Datto
device categories combined (D*), for one client at a time, reading a
manually-typed `[U*]`/`[D*]`-style tag off the contract line's own Internal
Description. This page is a deliberately DIFFERENT, second check, by
explicit request: Datto RMM **workstations only** (Desktop + Laptop, no
servers/network gear) against SaaS Alerts' own **Monitored Users** count,
across every Essentials client at once, with no tag to read -- the 3
service names ARE the formula.

## The 3 lines checked

Exact Autotask Service/ServiceBundle names (same 3 real catalog items Check
Client's own `ESSENTIALS_DEFAULT_TAGS` already recognizes):

- **Kaseya 365 User & Endpoint Bundle**
- **Kaseya 365 Endpoint**
- **Kaseya 365 User**

A "... Bundle Credit" line (a real, separate Autotask line that exists
purely to cancel the paired Bundle line 1:1 for invoicing -- see Check
Client's own `ESSENTIALS_BUNDLE_CREDIT_NAME`) is NOT one of these 3 and is
silently ignored.

## The expected seat allocation formula

By explicit request, given **W** = real Workstation count (Datto RMM) and
**U** = real Licensed User count (SaaS Alerts):

- **Bundle** is expected to be `min(W, U)` -- the overlap. Every seat in
  that overlap is covered once by the bundle; it's never also counted again
  on a stand-alone line.
- **Endpoint** is expected to be `max(0, W - U)` -- only the EXCESS
  workstations beyond what the bundle already covers.
- **User** is expected to be `max(0, U - W)` -- only the EXCESS licensed
  users beyond what the bundle already covers.

So when W and U are equal, the bundle alone covers everything and BOTH
stand-alone lines are expected to be 0. A company missing one of the 3
lines entirely is treated as 0 CONTRACTED for that line (not blank) for
comparison purposes -- "should have a line and doesn't" is as real a gap as
"has the wrong count on a line it does have," and is flagged the same way
(shown as "None" rather than a number, still red when a non-zero count was
expected).

## Workstations (Datto RMM)

Desktop + Laptop device-category devices ONLY (NOT the 4-category D* sum
Check Client's own TC Calc uses) at whichever Datto RMM site(s) resolve to
this Autotask company, via the exact same 3-source priority resolution RMM
Filters already proved out live: Datto's own native PSA Company link on
the site (by `siteUid`, the most authoritative source, confirmed live to
survive a stale cached site name), then the "Name:Datto RMM" UDF, then an
exact site-name == company-name match. See
`@dashboard/rmm-filters/server.js`'s own `resolveCompanyForSite()` for the
full reasoning -- reused directly here, not re-implemented. A client with
no resolvable Datto RMM site shows "Not available" (a data gap), not 0 (a
real, confirmed count).

## Licensed Users (SaaS Alerts)

**"Licensed users" means exactly SaaS Alerts' own "Monitored Users" figure**
-- `billingUsers.count`, the same number `@dashboard/saasalerts-customers`
already shows -- confirmed LIVE this session that this equals
`COUNT(isBillable === true)` on SaaS Alerts' own per-customer user list
(`GET /reports/users?customerId=...`, exact match against 3 real sampled
customers: 8/8, 71/71, 10/10). This is deliberately NOT the per-license-SKU
field (`products[].licenseDetails`) SaaS Alerts Customers' own README
explicitly calls out as a DIFFERENT number it doesn't show -- that field's
real shape has never been parsed anywhere in this codebase and would need
separate live confirmation; this page was explicitly asked to use the
already-confirmed Monitored Users number instead.

Company<->SaaS-Alerts-customer matching uses the vendor's own `mappedToPSA`
link (the same real, authoritative id-based field
`@dashboard/saasalerts-customers` already uses) -- no fuzzy name matching
needed here, unlike Datto RMM's own site-name resolution. A client with no
matching SaaS Alerts customer shows "Not available", same as an unmatched
Datto RMM site.

### Admin/break-glass exclusion -- a real caveat, by request

By explicit request ("leave Break Glass and O365Admin and M365Admin
accounts/users out of the SaaS Alerts count"), the billable-user count above
has 3 categories of account subtracted back out. **SaaS Alerts' own
`GET /reports/users` has NO structured field for this** -- confirmed live
this session against 365 real users across 3 real customers: `role` is
always `null` and `isServiceAccount` is always `undefined`, on every real
account checked. So this is a plain NAME/EMAIL **text match**, not a
vendor-provided flag, built from real confirmed examples on this account:

- **Break Glass**: `/break[\s-]?glass/i` -- confirmed real examples "AIT
  Break Glass 1"/"AIT  Break Glass 2" (`ait-bg1@...`/`ait-bg2@sleepysptyltd.onmicrosoft.com`).
- **O365Admin**: `/[o0]365\s*admin/i` -- confirmed real examples "O365
  Admin" (`o365admin@tvto.onmicrosoft.com`) AND a real digit-zero typo
  variant, "0365 Admin" (`o365admin@vanlieshoutau.onmicrosoft.com`) -- the
  pattern treats a leading `0`/`o` as interchangeable specifically because
  of that confirmed real typo.
- **M365Admin**: `/m365\s*admin/i` -- confirmed live against the FULL real
  Essentials run (not just the earlier 3-customer sample): a real "M365
  Admin" account was excluded on effectively every one of the 183 real
  Essentials clients checked.

Deliberately NOT matching plain "Admin" -- real accounts seen live like
"Richard | Admin", "Richard Global Admin", and "Admin @ Sleepy's" are left
IN the count; only the 3 specific categories asked for are excluded, not
every account with "admin" somewhere in its name.

**This is a heuristic, not a guarantee** -- a client whose break-glass/admin
accounts don't match any of these 3 patterns will still have them counted.
Every excluded account is returned back from the server and shown in the
Licensed Users cell's own hover tooltip (name + count), by design, so a
naming convention this doesn't recognize stays visible to review rather
than invisibly wrong either way (over- or under-excluding).

## Caching

10-minute TTL on the whole built report, same reasoning TC Services' own
cache gives -- expensive enough (contracts/services/contract-service-units
queries + the whole Datto RMM device/site list + a per-matched-client SaaS
Alerts users fetch) that it shouldn't re-run on every page view, but should
still go stale faster than this dashboard's usual 20-minute default.
Refresh forces a genuine re-fetch.

## Why this doesn't reuse `@dashboard/contract-services`' own `buildReport()`

Confirmed LIVE this session: calling it with no client filter (this page
needs ALL 183 Essentials companies at once, and that function only accepts
a single company name/wildcard, not an arbitrary company-ID set) takes its
slow, system-wide path -- `Contracts.companyID` is only folded into the
query when a client filter is given, so with none it fetches EVERY active
contract system-wide (confirmed ~1,900 of them) regardless of the "Kaseya
365" search term (that param only narrows the Services/ServiceBundles
catalog query, not Contracts itself). A real call timed out past 120
seconds. This page instead scopes its own Contracts fetch by companyID from
the start -- the same `fetchByFieldIn()` pattern `@dashboard/tc-elite-
services`' own `buildContractPills()` already uses -- confirmed live, well
under 5 seconds for all 183 real Essentials companies.

## Confirmed live against the real account (183 Tech Cover Essentials clients)

- **110 of 183 clients flagged with a seat-count mismatch** (133 had both
  a Datto RMM match and a SaaS Alerts match to compare at all; 110 of
  those 133 disagreed with the expected allocation). This is a genuinely
  high rate -- worth knowing before trusting this page's numbers at a
  glance: most real mismatches sampled look like Essentials contracts
  billing a single Bundle line sized to roughly the FULL headcount (e.g.
  Bundle contracted near the real licensed-user count) rather than the
  min/max overlap-and-excess split this page checks against, not an
  overall count that's simply wrong. Worth deciding whether that's a real
  cleanup backlog or whether the expected-allocation rule itself needs
  revisiting for how contracts are actually written today.
- 45 of 183 clients had no resolvable Datto RMM site ("Not available");
  9 of 183 had no matching SaaS Alerts customer. Both counts are in the
  same range Live Health Scores/RMM Filters already tolerate as normal
  real-world matching gaps on this account, not something this page's own
  matching logic introduced.
- 221 real admin/break-glass accounts were excluded across all 183
  clients -- "AIT Break Glass 1"/"AIT Break Glass 2" and "M365 Admin" each
  appeared on nearly every client (a standardized Ambient iT convention
  across the fleet); one client ("All Safe Financial") had two separate
  real accounts both matching "M365 Admin".
- The full report (all 3 data sources, 183 companies) completed in ~42
  real seconds, cold-cache.

## Still open

- `GET /reports/users` showed no pagination for the customers sampled
  (largest seen: 287 users, no truncation signal) -- unconfirmed at a much
  larger customer's real scale.
- No "Update contract units" action exists here (unlike Check Client's own
  Contract column) -- this page is read-only by design; add one later if
  it turns out to be wanted.
