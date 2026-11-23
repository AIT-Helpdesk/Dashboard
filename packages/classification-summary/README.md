# @dashboard/classification-summary

Dashboard page: active clients, grouped by one of 5 real Autotask dimensions,
one tab each -- By Classification, By Market Segment, By Referrer, By Contract
Name, By Service. Each group starts collapsed (count only); click to expand
its own client list. No date scoping -- a live snapshot, auto-loaded per tab
(with a Refresh button), same "nothing to wait for" reasoning the original
single-chart version of this page already had.

- `client.js` - frontend module: tabs (reusing RMM Filter Checks' own
  `.rmmf-tabs`/`.rmmf-tab` convention), a wildcard search box, and a
  collapsible `.resource-group` per group (same `.resource-group-header--toggle`
  convention Check Client's Datto device-type breakdown already uses).
  Exports `id`, `label`, and `mount(container)`, picked up automatically by
  the shell.
- `server.js` - Express router mounted by the shell at
  `/api/classification-summary?dimension=<key>&q=<wildcard>`.

Supersedes the original page's own single bar chart (classification only,
split by has-parent/no-parent) -- that chart and its drill-down are gone,
replaced entirely by this tabbed design, by request.

## Scope

Active companies only, restricted to `companyType` Customer (1) or Prospect
(3) -- the same "clients" definition Client Details and Client Contacts use.

## The 5 dimensions

- **Classification** - `Companies.classification`, a picklist. Resolved via
  `getPicklistLabels()` (shared with Client Details/Client Contacts, cached).
- **Market Segment** - `Companies.marketSegmentID`, a picklist -- confirmed
  live via a real `entityInformation/fields` lookup (17 real values on this
  account: Healthcare, Financial, Real Estate, Services, ...).
- **Referrer** - `Companies`' own `Referrer Organisation` User Defined Field,
  read the same way every other Companies UDF on this dashboard is
  (`c.userDefinedFields`, included by default on every bulk list/query
  result -- no special include-param needed). Confirmed live with real,
  substantial data: 468 of 1029 active companies have it set (real values
  include "BNI Aurora", "BNI Affordable Staff", "BNCC", etc.). Opportunities'
  own `leadSource` field and its `Referrer Organisation`/`Referrer Name`/
  `Referrer Comment` UDFs were checked FIRST and ruled out -- confirmed live
  that none of the 2852 real Opportunities on this account have any of those
  set at all; the real, populated field turned out to live on Companies
  instead, not Opportunities.
- **Contract Name** - `Contracts.contractName`, scoped to contracts with
  `status = 1` ("In Effect" -- confirmed live, same convention
  `@dashboard/contract-services`' own `buildActiveContracts()` already
  established; a terminated contract isn't something a client currently
  has). A company holding several differently-named active contracts
  appears once under EACH of those contract names, by request -- these are
  membership groups, not a single-valued field the way Classification/
  Market Segment/Referrer are.
- **Service** - resolved via each company's active (`status = 1`) Contracts
  -> `ContractServices` -> `Services.name` (active services only, same
  `isActive` convention `@dashboard/contract-services` already uses for this
  exact entity). Same "appears under every one they have" membership
  reasoning as Contract Name.

A company with nothing set for Classification/Market Segment/Referrer falls
into its own "Unclassified"/"No Market Segment"/"No Referrer" bucket rather
than being dropped -- every active client is accounted for somewhere. There
is no equivalent bucket for Contract Name/Service -- a company with zero
active contracts (or zero services on those contracts) simply doesn't appear
in any group for that dimension, since "has no contract" isn't itself a
named group the way "has no classification set" is.

## Wildcard search

A blank search box returns every group ("retrieve all"); typing narrows
which GROUP NAMES are shown (`*` leading/trailing wildcard, same convention
`@dashboard/autotask-client`'s own `parseWildcard()`/`matchesWildcard()`
established dashboard-wide) -- e.g. "Tech*" on the Classification tab shows
only "Tech Cover Essentials"/"Tech Cover Elite". Filtered entirely
client-side against whichever dimension's groups are already loaded (no
extra request per keystroke) -- `client.js` duplicates a small local
`matchesWildcard()` rather than sharing the server-only module across the
browser/server boundary, same "copy the small shared logic" convention this
dashboard already follows elsewhere (e.g. the widget-rendering functions in
`report-widgets.js`).

## Client list columns

Client Name, Classification, Market Segment, Primary Contact, Contracts --
the SAME columns on every tab, by request, regardless of which dimension
that tab is actually grouped by (so e.g. the Classification tab still
shows each row's own Classification column, even though that's also the
grouping key). Primary Contact is the `Contacts` row (scoped to the
matched companies, one query) with `primaryContact = true` set, same
flag/convention Client Details already uses; first match wins if more than
one contact somehow has it set (Autotask doesn't enforce uniqueness).

- **Contracts** - the count of this client's own active (`status = 1`)
  Contracts -- the same contracts fetched for every dimension now (not just
  Contract Name/Service's own grouping use of them).

A "Seats" column (Microsoft/M365 contract licence count) was attempted and
then pulled back out -- fetching `ContractServiceUnits` for the ~250 real
active M365-named contracts on top of everything else this route already
does made the page fail outright (500, no data) rather than merely slow.
Not re-added yet; see this package's own git history for the attempt.
