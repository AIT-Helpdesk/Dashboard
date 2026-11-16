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

Scheduled later via Windows Task Scheduler, same mechanism
`@dashboard/strety-autotask-sync` already uses -- not wired up yet, by
request ("build it as a single command... but do not build a scheduler yet").

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

Only active domains are included (`expiryDate` not already in the past --
TPP's own domain list has no separate active/inactive flag, same convention
Coming Soon/Data Matching already established for this exact field), and any
domain whose `category` field is "Not Required" (case-insensitive) is
skipped -- those are known not to belong in IT Glue.

## IT Glue

`itglue-domains.js`'s `fetchAllItGlueDomainNames()` -- confirmed live this
session that IT Glue's flat `GET /domains` resource DOES return across every
organisation on the account (556 domains total, fits in one request at
`page[size]: 1000`, IT Glue's own documented max), so no per-organisation
looping is needed (unlike `@dashboard/live-reports/email-domain-protection.js`'s
own `getDomains(orgId)`, which is scoped to one org for a different purpose).
Only `attributes.name` is read -- gap rows are labelled with the Autotask
Client name already resolved via `Name:TPP`, not whichever IT Glue
organisation a domain happens to sit under, so IT Glue's own organisation
attribution is never needed.

## The dashboard page

`client.js`/`server.js` -- "Domain / IT Glue Gaps" in the sidebar. Reads
`db.js`'s own `domain_gaps` table (one row per domain currently open in
either list) and shows two sections, each a plain table with a "Done"
checkbox per row:
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

Ticking a checkbox (`POST /api/domain-itglue-gap/:domainName/tick`) is
**per domain, not per run or per ticket** -- by request, ticking off a
domain that's STILL a gap on a LATER run keeps its tick (no lost progress)
rather than resetting; the row is instead flagged "still showing as
missing" in red so staff notice it wasn't actually fixed, same "never
auto-resolve, let a person decide" convention this dashboard already
follows elsewhere. A domain that genuinely stops being a gap (now found in
IT Glue, or now resolves to a Client) just disappears from both the table
and the ticket's next summary -- `db.js`'s own `replaceCurrentGaps()`
deletes rows that aren't in the freshly computed set, so presence in the
table IS the "still open" signal; there's no separate resolved/history
table. `data.db` (per-domain state) is updated on EVERY run, including dry
runs -- it's this job's own local state, not an Autotask write.

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
body is now just the run date, the two counts, and a link to the dashboard
page above (`http://dashboard.ambientit.com.au/#domain-itglue-gap` --
hardcoded, by request, deliberately NOT read from `APP_BASE_URL`/env, so a
manual run from a dev machine never puts a `localhost` link in a real
ticket) -- the full, tickable list lives there instead. A CSV of both lists
is still attached as an offline copy.

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
