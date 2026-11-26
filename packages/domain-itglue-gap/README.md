# @dashboard/domain-itglue-gap

A standalone weekly job (`run.js`, a CLI script) that finds TPP Wholesale
domains missing from IT Glue and raises/updates one Autotask ticket
summarising them, PLUS a small dashboard page (`client.js`/`server.js`) where
the full, currently-open list can actually be viewed and ticked off. IT
Glue's own Domains resource is read-only via its public API (confirmed
live), so this can only detect and report the gap, never fix it.

Run manually for now:
```
node packages/domain-itglue-gap/run.js [--dry-run]
```
`--dry-run` does every real read (TPP, IT Glue, Autotask ticket search) but
never writes to Autotask -- it prints the exact ticket title/body/CSV it would
create or update, and which ticket number (if any) it would update.

## Production setup (Windows Task Scheduler)

Scheduled weekly (Monday 6am) via Windows Task Scheduler, same mechanism
`@dashboard/strety-autotask-sync`/`@dashboard/contract-checks`/`@dashboard/invoice-intake`
already use -- see `DEPLOYMENT.md`'s own "Setting up the Domain / IT Glue Gaps
weekly job" section for the full `Register-ScheduledTask` command, verify
steps, and how to change the schedule later. Runs `run.js` for real (no
`--dry-run`) -- it genuinely creates/updates the Autotask ticket each week.

## Matching

Each TPP domain's `accountReference` (e.g. `"CLI-862"`) is resolved to a real
Autotask Client via the existing `Name:TPP` UDF on Companies -- the exact same
`getCompanyUdfValueToNameMap(client, 'Name:TPP')` call
`@dashboard/coming-soon` and `@dashboard/data-matching` already use, so this
job can never disagree with either of those about what counts as matched.

- **Resolved + not in IT Glue** -> a gap, listed with the domain, expiry
  date, and the resolved Autotask Client name.
- **No `Name:TPP` match for that accountReference** -> listed separately as
  "no matching Autotask Client", with the domain, expiry date, and TPP's own
  raw `accountReference` code. Confirmed live: TPP's bulk domain list has NO
  customer-name field at all (only `domainId`, `domainName`,
  `accountReference`, `expiryDate`, `createdDate`, `modifiedDate`, `login`,
  `autoRenew`) -- the account reference code is shown as-is, by request,
  rather than presenting it as if it were a real name.
- **Resolved + in IT Glue, but its own tracked Expires date doesn't match
  TPP's real one** -> "Expiry Mismatch", by request ("checks the 'Expires'
  date in the IT Glue Domain Tracker against the 'Expiry Date' in TPP
  Wholesale"). Independent of every other check here -- a domain can be
  Wrong Client AND Expiry Mismatch at once, confirmed live (14 real
  domains on this account are both). IT Glue's own `expires-on` attribute
  (confirmed live: a real `YYYY-MM-DD` string, same format TPP's own
  `expiryDate` already uses -- or the literal non-date string
  `"Processing"`, IT Glue's own in-progress sync placeholder, or genuinely
  blank) is compared directly; a blank/"Processing" value is flagged too
  (IT Glue simply not knowing this domain's expiry at all is itself worth
  a person's attention, confirmed by request), shown as "Not set in IT
  Glue" rather than silently skipped. A real 1-calendar-day difference is
  split into its own "Expiry Mismatch -- 1 Day Difference" section, hidden
  behind a button by default (same convention Email Domain Mismatch
  below already established) -- confirmed live that the overwhelming
  majority of real differences on this account (251 of 487) are exactly
  one day apart, almost certainly a timezone/date-boundary display quirk
  between the two systems, not a genuine discrepancy; the 1-day tolerance
  still correctly surfaces a real stale record in the main section (e.g.
  `setmaritime.com.au`, confirmed live: IT Glue said `2025-02-11`, TPP
  said the real `2027-02-10` -- already over a year stale). The main
  section starts minimised, by request -- click its header to expand
  (same `.resource-group-header--toggle` convention this dashboard already
  uses elsewhere, not the separate show/hide-behind-a-button convention
  its own 1-day sibling section uses). Dashboard-only, by request ("Don't
  add the expiry discrepancies to the ticket at all ... it's all too
  crappy") -- NEITHER bucket is ever mentioned in the ticket body or the
  attached CSV, unlike every other category on this list; see "Ticket"
  below. There's no way to fix this FROM the dashboard either way -- IT
  Glue's own Domains resource is confirmed read-only via its public API
  (no documented PATCH/update for it, confirmed against IT Glue's own
  developer docs and its official PowerShell wrapper), so a real mismatch
  still has to be corrected by hand in IT Glue's own UI.
- **Resolved + in IT Glue, but under the WRONG organisation** -> "Wrong
  Client in IT Glue", by request ("If a domain appears on an IT Glue Client
  but that Client is not the same client as the Autotask Client on which
  the TPP Account appears in the UDF"). `itglue-domains.js`'s own
  `fetchAllDomainsGroupedByOrg()` gives each IT Glue domain's real
  organisation, compared (exact, case-insensitive, trimmed -- same "never
  guess past an exact match" convention this job already follows
  elsewhere) against the Name:TPP-resolved Client name. A real mismatch
  found live on this account: `disipioauto.com.au` sits under "Di Sipio
  Auto Electrical" in IT Glue, but its own TPP account reference resolves
  to Autotask Client "Paul Crooks Advertising". Shown with both the
  correct Client (linked to that Client's own IT Glue org) and the wrong
  organisation it's actually filed under (linked to that org instead).
- **A Client's own nominated Primary Domain in IT Glue doesn't match its
  Primary Contact email domain** -> "Email Domain Mismatch", by request
  ("List where Domain is different from the domain of the Primary
  Contact's email address in Autotask ... only do this match for
  nominated primary domains in IT Glue"). Scoped to ONLY the one domain
  each organisation has tagged as its own "Primary Domain" Flexible Asset
  in IT Glue (`@dashboard/itglue-client`'s own new
  `getAllPrimaryDomainsByOrganizationId()`, one bulk fetch, same Flexible
  Asset Type the existing "Clients missing a Primary Domain" section
  already reads) -- NOT every domain a Client happens to own. Confirmed
  live this was the right call: checking every matched domain first
  produced 319 mostly-noise rows (a Client legitimately owning several
  domains showed up for every one that wasn't its Primary Contact's own);
  scoped to just the nominated Primary Domain, the same real account
  produces 49 -- a much tighter, more trustworthy list (real finds
  include a Primary Contact on a personal gmail/hotmail address, and a
  couple of genuine near-miss domain spellings). Batched `Contacts` fetch
  (`primaryContact = true`, same real flag/convention
  `@dashboard/client-details` and `@dashboard/client-summary` already use
  for this exact concept), compared (normalised, exact) against the
  domain itself. Shown with the Client (linked to its own IT Glue org)
  and the real Primary Contact email domain that didn't match.

Only active domains are included (`expiryDate` not already in the past --
TPP's own domain list has no separate active/inactive flag, same convention
Coming Soon/Data Matching already established for this exact field), and any
domain whose `category` field is "Not Required" (case-insensitive) is
skipped -- those are known not to belong in IT Glue.

## IT Glue

`itglue-domains.js`'s `fetchAllDomainsGroupedByOrg()` -- confirmed live this
session that IT Glue's flat `GET /domains` resource DOES return across every
organisation on the account (fits in one request at `page[size]: 1000`, IT
Glue's own documented max), so no per-organisation looping is needed (unlike
`@dashboard/live-reports/email-domain-protection.js`'s own `getDomains(orgId)`,
which is scoped to one org for a different purpose). Reads each domain's own
`organization-id`/`organization-name` as well as its name -- originally just
the flat name set (gap rows are labelled with the Autotask Client name
already resolved via `Name:TPP`, not IT Glue's own organisation), but the
real per-domain organisation is now also needed for the "Wrong Client in IT
Glue" check above.

## The dashboard page

`client.js`/`server.js` -- "Domain / IT Glue Gaps" in the sidebar. Reads
`db.js`'s own `domain_gaps` table (one row per (domain, category) pair
currently open -- NOT one row per domain, see db.js's own top comment for
why: a domain can genuinely belong to more than one category's own list at
once) and shows one section per category, each a plain table with a "Done"
checkbox per row, in this order:
- **Missing from IT Glue** -- Domain, Expiry Date, "IT Glue Client Name".
  The Client name is a link to that Client's own IT Glue
  organisation page (not the domain itself -- it's a gap precisely because
  it ISN'T in IT Glue) whenever an exact (case-insensitive) name match is
  found among IT Glue's organisations; `itglue-domains.js`'s own
  `fetchOrganizationUrlsByName()` fetches all ~1,946 organisations once per
  run (confirmed live: IT Glue's organisation resource has no `resource-url`
  attribute, unlike passwords -- see `@dashboard/find-passwords` -- so the
  link is built from `ITGLUE_WEB_BASE_URL` + `/` + the org's own id, a
  format confirmed live against a real organisation's own address-bar URL).
  No exact match -> plain text, never a guessed/possibly-wrong link.
- **No matching Autotask Client** -- Domain, Expiry Date, TPP Account
  Reference. No Client name here at all (nothing's been resolved), so no
  link.
- **Expiry Mismatch** -- Domain, Expiry Date (TPP), IT Glue Expires (red
  when it's a real, differing date -- a genuine conflict, by request;
  plain "Not set in IT Glue" when IT Glue has none at all -- a different,
  less urgent problem), TPP Acc, IT Glue Client Name. Sorted with real
  conflicts first by default (by request), a blank IT Glue value always
  sorting last. Its own "-- 1 Day Difference" sibling section sits right
  after it, hidden behind a button by default (see "Matching" above).
- **Wrong Client in IT Glue** -- Domain, Expiry Date, TPP Acc, "Autotask
  Client UDF" (links to Autotask, by request), "Domain Tracker (IT Glue)"
  (links to the wrong org it's actually filed under).
- **Email Domain Mismatch** -- hidden behind a "View ... (N)" button by
  default (by request -- "turns out most of them are ok"), still fully
  computed/persisted/ticketed every run regardless of whether it's shown.

**The page's own Refresh button is a real LIVE pull**, by request -- clicking
it hits `GET /api/domain-itglue-gap?force=true`, which calls `job.js`'s own
`refreshLive()`: a real TPP + IT Glue + Autotask pull (the same
`computeGaps()` the scheduled/manual job itself uses), updating `db.js`'s
stored state. A plain page load (no button click) just reads that stored
state instantly, same `?force=true` convention
`@dashboard/tc-elite-services`'s own `GET /` already uses.

**Deliberately narrower than the scheduled/manual job's own ticket write,
by request** ("update the ticket with what's been fixed... Only provide a
whole new list if the scheduled job... runs"): `refreshLive()` NEVER creates
a new ticket and NEVER replaces the ticket body with a fresh full
summary/CSV -- that "whole new list" behaviour belongs to `run()` (via
`run.js`) alone, whether that's the eventual scheduled task or a manual CLI
run. If the live pull finds that one or more domains have dropped out of
the list since the last stored state AND there's already an open ticket, it
adds one small note on that ticket naming just the domains that are no
longer present (without guessing *why* -- found in IT Glue? matched? simply
expired? -- same "never guess" convention this job follows elsewhere). If
nothing changed, or there's no open ticket, no Autotask write happens at
all -- only `db.js`'s own state updates.

Ticking a checkbox (`POST /api/domain-itglue-gap/:domainName/tick`, body
`{ category, ticked }`) is **per (domain, category), not per run or per
ticket** -- `category` is required in the body, not just the URL's own
domainName, because the same domain can have more than one currently-open
row (see above); ticking the Wrong Client row for a domain that's ALSO
Expiry Mismatched leaves that other row's own tick state untouched
(confirmed live). By request, ticking off a row that's STILL a gap on a
LATER run keeps its tick (no lost progress) rather than resetting; the row
is instead flagged "still showing as missing" in red so staff notice it
wasn't actually fixed, same "never auto-resolve, let a person decide"
convention this dashboard already follows elsewhere. A (domain, category)
pair that genuinely stops being a gap in that category (now found in IT
Glue, now resolves to a Client, now matches TPP's expiry, etc.) just
disappears from both the table and the ticket's next summary -- `db.js`'s
own `replaceCurrentGaps()` deletes exactly that pair once it's no longer
in the freshly computed set for that category (a different category's own
row for the same domain is untouched either way), so presence in the
table IS the "still open" signal; there's no separate resolved/history
table. `data.db` (per-(domain, category) state) is updated on EVERY run,
including dry runs -- it's this job's own local state, not an Autotask
write.

## Ticket

Title (exact, used for the dedup search too): `FIX Domains in IT Glue (Found
in TPP Wholesale)`. Company "Ambient IT" (id `0` -- Autotask's own reserved
id for this account's own "home company", confirmed live, not a bug), Queue
"Helpdesk", Priority `!! SET PRIORITY`, Ticket Type "Change Request", Status
"New", Due Date = run date + 7 days. All four picklist values are resolved by
LABEL at runtime (`ticket-picklists.js`), not hardcoded IDs, so a relabel in
Autotask doesn't silently break this.

**Body is a short summary, not the full list** -- by request: at 155 items
the full per-domain list was about to exceed Autotask's own confirmed-live
8000-character description limit, which would have silently hidden most of
the "no matching client" section from anyone just reading the ticket. The
body is now just the run date, the four counts, and a link to the dashboard
page above (`http://dashboard.ambientit.com.au/#domain-itglue-gap` --
hardcoded, by request, deliberately NOT read from `APP_BASE_URL`/env, so a
manual run from a dev machine never puts a `localhost` link in a real
ticket) -- the full, tickable list lives there instead. A CSV of all four
lists is still attached as an offline copy.

**Only four of the dashboard page's six categories ever reach Autotask** --
Expiry Mismatch and its own 1-day-difference sibling are deliberately left
out of both the ticket body and the CSV (see "Matching" above) -- dashboard-
only, by request.

**Dedup/update, not one ticket per run**: searches for an open ticket (status
not in `[5, 20]` -- Complete / Billing-Contract, the same open/closed
convention `client-summary/server.js` and `strety-autotask-sync/metrics.js`
already use) with the exact title.
- Found + gaps remain -> adds a note with the refreshed summary and attaches
  a freshly dated CSV, rather than creating a second ticket.
- Found + everything now resolved -> adds a note saying so; never closes it
  automatically.
- Not found + gaps exist -> creates a new ticket. If a ticket with this exact
  title was closed recently and gaps still remain, the new ticket's body
  quotes that earlier ticket number, so a wrongly-closed ticket is visible.
- Not found + no gaps -> does nothing.

CSV attachment uses the proven `POST /Tickets/{id}/Attachments` shape
`@dashboard/workshop/server.js` already established live for this tenant
(base64 `data`, `attachmentType: 'FILE_ATTACHMENT'`) -- a failure to attach
is logged but never fails the whole run, since the dashboard page already
carries the full list.

## Logging

- `run-log.jsonl` -- one JSON line per stage (tpp-pull, itglue-pull,
  comparison, autotask-search, ticket-create/ticket-update, csv-attach),
  including a success line at the end of every run. Never logs API
  keys/headers. Not committed (see `.gitignore`).
- `last-run.json` -- overwritten each run, same shape
  `@dashboard/strety-autotask-sync/status.js` already established
  (`readLastRunStatus()`/`writeLastRunStatus()`), so a future Dashboard page
  can show "did the last run succeed" the same way `@dashboard/whats-on`
  already does for that job -- nothing reads it yet.

An empty TPP or IT Glue response is treated as a FAILED pull (logged,
stage stopped), never as "everything is a gap" -- per the brief's own
instruction that missing data must never silently create tickets.
