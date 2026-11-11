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

### Fuzzy suggestions on a failed exact match

The "Update" write (see below) requires an EXACT company name. When that
exact lookup fails, the response carries up to 6 fuzzy `suggestions`
(`{id, companyName}`) scored by `findFuzzySuggestions()` -- a plain
Levenshtein ratio, with bonus treatment for a straight substring match
either with or without spaces (confirmed necessary against a real miss:
typing "Cloudking" for the real company "Cloud King Hosting" scored
WORSE on a bare full-string Levenshtein ratio than several unrelated
same-length "Cloud*" names, purely because the real match is a much
longer string overall -- the space-stripped substring check fixes this by
noticing "cloudking" is a literal prefix of "cloudkinghosting"). Shown as
clickable chips on the client -- clicking one only fills the exact real
name into the input, never auto-submits, so the strict exact-match write
path is never bypassed.

## Concept 2: Ingram Client Names Not Matching Autotask

`GET /ingram-clients-unmatched`. Every distinct client name on an ACTIVE
Ingram Micro subscription (`status: 'active'` -- not pending) whose name
doesn't case/whitespace-exactly equal a real Autotask company name.
Unlike Concept 1, there's no UDF or code involved here at all -- Ingram's
own customer name is a real company name that SHOULD just equal the
matching Autotask company's name outright when the two are set up
correctly, so this compares the two systems' own names directly.
Read-only, by request -- just a list (`clientName`, `activeSubscriptionCount`,
fuzzy `suggestions`), no Update/write control like Concept 1's.

Confirmed live: 90 of this account's Ingram clients don't exactly match,
most genuinely close (e.g. "A Grade Plumbing and Gas" vs. the real
"A Grade Plumbing & Gas"; "Any Given Tuesday" vs. the real "Any Given T
Pty Ltd T/A Any Given Tuesday") -- real naming drift this list is meant to
surface, not noise.

## Concept 3: Datto RMM Sites Not Matching Autotask

`GET /datto-sites-unmatched`. Same direct name-to-name comparison as
Concept 2, against every distinct Datto RMM site (deduped by `siteUid`,
via `@dashboard/datto-rmm/lib.js`'s `getAllDevices()` -- there's no
dedicated "list sites" endpoint on Datto's own API, so every Datto RMM
page on this dashboard derives sites from the bulk device list's own
`siteUid`/`siteName` fields instead, same approach Check Client's own
Datto RMM section already uses). Returns `{configured: false}` (not an
error) when Datto RMM credentials aren't set, same convention Check
Client's own Datto RMM section uses.

Confirmed live: 35 sites don't exactly match, several with an obvious,
genuinely useful real cause -- Datto's own `" - On Demand"` site-name
suffix (e.g. "Griffith Corporation - On Demand" vs. the real "Griffith
Corporation"), or a `"Pty Ltd"`/`"Ltd"` difference (e.g. "CMBM Facility
Services Pty Ltd" vs. the real "CMBM Facility Services").

## Fuzzy suggestions on a failed/missing exact match

All three concepts above can return fuzzy `suggestions` (`{id,
companyName}`, up to 6) via the shared `findFuzzySuggestions()`/
`findFuzzySuggestionsFromList()` -- a plain Levenshtein ratio, with bonus
treatment for a straight substring match either with or without spaces
(confirmed necessary against a real miss: typing "Cloudking" for the real
company "Cloud King Hosting" scored WORSE on a bare full-string
Levenshtein ratio than several unrelated same-length "Cloud*" names,
purely because the real match is a much longer string overall -- the
space-stripped substring check fixes this by noticing "cloudking" is a
literal prefix of "cloudkinghosting").

Concept 1's "Update" write (see above) uses this to suggest a correction
after a failed EXACT match -- shown as clickable chips on the client;
clicking one only fills the exact real name into the input, never
auto-submits, so the strict exact-match write path is never bypassed.
Concepts 2 and 3 show the same suggestions as plain text instead (no
input field to fill, since neither has a write control).

## What this is for

The real work that follows from this page is correcting these naming
mismatches on the Autotask side (or, for Concept 1, writing the matching
"Name:TPP" UDF value, the same way the first 284 TPP account references
were written -- see Coming Soon's own README/history) -- this page exists
to find which ones still need it, not to do the writing itself for
Concepts 2/3 (Phase 1, read-only there, same convention as Coming Soon).
