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

## Concept 2: Ingram Client Names Not Matching Autotask

`GET /ingram-clients-unmatched`. Every distinct client name on an ACTIVE
Ingram Micro subscription (`status: 'active'` -- not pending) whose name
doesn't case/whitespace-exactly equal a real Autotask company name, OR
already appear as a value in the "Name:Ingram Micro" UDF (confirmed live:
"AMD Constructions" kept showing as unmatched even though company "AMD
Quality Constructions" already had that exact value written to its own
"Name:Ingram Micro" -- the two companyNames themselves will never match,
that's exactly why the UDF exists). Unlike Concept 1, there's no UDF
involved in the MATCHING itself -- Ingram's own customer name is a real
company name that SHOULD just equal the matching Autotask company's name
outright when things line up correctly, so this compares the two systems'
own names directly; the UDF only comes in once a match is confirmed and
written (see "Writing a confirmed match" below).

Rows whose name matches Ambient IT's own internal naming convention for a
Microsoft 365 subscription tied to a specific underlying client (e.g.
`"Ambient iT - W365 (Blackk Group)"`) are flagged `ignored` -- never a real
company name of its own to match against Autotask -- and hidden by default
behind "Show Ignored Lines" (see below).

## Concept 3: Datto RMM Sites Not Matching Autotask

`GET /datto-sites-unmatched`. Same direct name-to-name comparison as
Concept 2 (plus the same "already in the UDF" check, against
"Name:Datto RMM" here), against every distinct Datto RMM site (deduped by
`siteUid`, via `@dashboard/datto-rmm/lib.js`'s `getAllDevices()` -- there's
no dedicated "list sites" endpoint on Datto's own API, so every Datto RMM
page on this dashboard derives sites from the bulk device list's own
`siteUid`/`siteName` fields instead, same approach Check Client's own
Datto RMM section already uses). Returns `{configured: false}` (not an
error) when Datto RMM credentials aren't set, same convention Check
Client's own Datto RMM section uses.

Rows ending in Datto's own `" - On Demand"` site-name suffix (e.g.
"Griffith Corporation - On Demand" for the real client "Griffith
Corporation") are flagged `ignored` the same way Concept 2's Ambient
IT/W365 rows are -- confirmed live, a large and consistent chunk of this
report, never actually worth chasing down as a real naming gap.

## Concept 4: SaaS Protection Clients Not Matching Autotask

`GET /saas-protection-clients-unmatched`. Same direct name-to-name
comparison (plus "already in the UDF", against "Name:SaaS Backups" here)
as Concepts 2/3, against every Datto SaaS Protection customer
(`@dashboard/saas-protection`'s own `getDomains()` -- one row per
protected domain; confirmed live this account's real data is already 1:1
with customers, 238 domain rows / 238 distinct `saasCustomerId`, no
customer with more than one domain and no two different customers sharing
a display name, so no dedup/grouping is needed here the way Concept 3's
own device-level data needs).

## Ignored rows and "Show Ignored Lines"

Concepts 2 and 3 can flag a row `ignored: true` for a real, known naming
pattern that's never actually worth chasing down (see each concept above).
An ignored row is still returned (never silently dropped), just excluded
from the headline `totalCount`/the table by default -- the client shows a
"Show Ignored Lines (N)" checkbox, unticked by default, only when a
concept actually has any, to reveal them on request.

## Writing a confirmed match

Every concept with a real UDF to write to (all four, now that
"Name:Datto RMM" and "Name:SaaS Backups" both exist in this account) gets a
write path: `POST /match-tpp-client`, `/match-ingram-client`,
`/match-datto-site`, `/match-saas-protection-client` -- all delegating to
one shared `writeNameMatchUdf()`. Requires an EXACT Autotask company name
(`@dashboard/autotask-client`'s own `resolveSingleCompany()` silently does
a `contains` match on a plain string by design, confirmed live as a real
bug for this write path -- bypassed here via a direct `eq` filter instead)
and refuses to overwrite a UDF that's already set (re-checked fresh
immediately before the write, never from a cached value). A failed/missing
exact match returns up to 6 fuzzy `suggestions` (`{id, companyName}`)
scored by `findFuzzySuggestions()` -- a plain Levenshtein ratio, with bonus
treatment for a straight substring match either with or without spaces
(confirmed necessary against a real miss: typing "Cloudking" for the real
company "Cloud King Hosting" scored WORSE on a bare full-string
Levenshtein ratio than several unrelated same-length "Cloud*" names,
purely because the real match is a much longer string overall -- the
space-stripped substring check fixes this by noticing "cloudking" is a
literal prefix of "cloudkinghosting").

On the client, each row/group shows the suggestions as clickable buttons
(Concepts 2-4's own rows have them upfront, from the report itself;
Concept 1's TPP account-reference code has no real name to fuzzy-match
against anything, so its own suggestions only appear reactively after a
failed free-text attempt) plus a free-text input + Update button for a
manual match, all sharing one `buildMatchWidget()`. Every write --
whichever button triggers it -- confirms with the person first, naming
exactly what's about to be written and where.

## Show UDF Matches

A page-level button, next to Load -- for whichever concept is currently
selected in the dropdown, `GET /udf-matches?udfName=...` lists every
Autotask company that ALREADY has a value in that concept's own UDF (the
reverse of the unmatched report above), so an existing match can be
reviewed. Each row has a Clear button (`POST /clear-udf-match`) -- clear
only, never an edit; a wrong value is corrected by clearing it and
re-matching through the normal Update/Possible-Match flow instead, which
keeps exactly one path that can ever SET a UDF's value.

## What this is for

The real work that follows from this page is confirming/correcting these
naming mismatches by writing the matching "Name:*" UDF value on the
right Autotask company (the same way the first 284 TPP account references
were written -- see Coming Soon's own README/history) -- this page exists
to find which ones still need it, offer the write itself with the
confirm/exact-match/no-overwrite safeguards above, and let an existing
match be reviewed and cleared if it turns out to be wrong.
