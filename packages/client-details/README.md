# @dashboard/client-details

Dashboard page: pick a criteria from a dropdown, optionally filter by client name (wildcards with `*`, same convention as Contract Services), see the matching clients (companies). Restricted to `companyType` Customer (1) or Prospect (3) -- Leads, Dead, Cancellation, Vendor, and Partner records are excluded. No date scoping -- this is a live snapshot, not a per-period report.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`, picked up automatically by the shell.
- `server.js` - Express router mounted by the shell at `/api/client-details`.

## Criteria

- **All active clients** - `Companies` where `isActive = true`.
- **Inactive clients** - `Companies` where `isActive = false`. Standalone criteria; every other criteria except "Any Client" below implies "active clients missing X", so `isActive` stays `true` for those regardless of this one.
- **Any Client** - every company regardless of `isActive` or `companyType` -- the one criteria that ignores both restrictions described in the intro above. If combined with no client-name filter, `server.js` substitutes a true no-op filter (`id exist`) rather than sending an empty filter array, since Autotask's query API requires at least one filter condition.
- **Clients with no primary contact** - active companies with zero `Contacts` rows where `primaryContact = true`.
- **Clients with no main billing contact set** - active companies with zero `Contacts` rows where `billingContact = true`.
- **Clients with no invoice since 1 Jan {year}** - active companies with zero non-voided `Invoices` rows dated on/after 1 January of the year before last, AND `createDate` before that same cutoff. This is a MOVING two-year window, not a fixed date -- `noRecentInvoiceCutoffISO()` in `server.js` recomputes it from the current date on every request (e.g. evaluated in 2026 the cutoff is 2024-01-01; in 2027 it becomes 2025-01-01), and the dropdown label in `client.js` computes the same year independently so it always matches what the query actually does. A voided invoice doesn't count as "an invoice" for this purpose -- it was reversed/cancelled, not real billing activity. The `createDate` check excludes companies that became clients after the cutoff -- they were never going to have an invoice from before they existed, so including them would be noise rather than a real billing gap.

`primaryContact` and `billingContact` are per-contact boolean flags on the `Contacts` entity, not a direct field on `Companies` (there's no "primary contact ID" field to check against). The "no contact flagged" / "no recent invoice" queries all follow the same shape: fetch every contact-flag-set/invoice row matching the positive condition across all companies in one query, then treat any active company whose ID isn't in that set as a match -- cheaper than checking each company's own history one at a time.

## Client name filter

The wildcard (`parseWildcard()` in `@dashboard/autotask-client`, shared with Contract Services) is folded into the initial `Companies` query itself (`companyName` + `isActive` together), not applied afterward in JS -- with ~1,960 active companies, an unscoped fetch would dominate request time regardless of how narrow the filter is, same lesson as Contract Services' Contracts query.

## Company column

Links to the company's Detail page in Autotask via the `OpenAccount` command in Autotask's `ExecuteCommand` deep-link API (`getCompanyUrl()` in `@dashboard/autotask-client`). Autotask's own documentation names the command `OpenAccount` with parameter `AccountID` -- "Account" is the database/API term for what the UI calls "Company".

## Classification column

`Companies.classification` is a picklist field storing an integer code, not the label shown in Autotask's UI (e.g. "Tech Cover Elite", "Bronze Managed Service" -- these are org-specific custom values, not a fixed Autotask-wide enum like `companyType`). The label is resolved via `getPicklistLabels()` in `@dashboard/autotask-client`, which fetches the field's picklist definition from Autotask's entity-metadata endpoint (`GET /Companies/entityInformation/fields`) and caches it in memory, since picklist definitions rarely change.

## Primary Contact / Main Billing Contact columns

Resolved from `Contacts.primaryContact` / `Contacts.billingContact` (see Criteria above), scoped to just the companies in the current result set (`companyID in [...]`, chunked) rather than fetched globally -- independent of which criteria is selected, since a company excluded by "no primary contact" can still have a billing contact worth showing, and vice versa. If more than one contact has the same flag set for a company (Autotask doesn't enforce uniqueness at the API level), the first one found wins.

## Last Invoice column

The date links to the invoice itself in Autotask (`getInvoiceUrl()` in `@dashboard/autotask-client`), via `/Mvc/Contracts/InvoiceViewer.mvc?invoiceId=...`. Unlike tickets/contracts/companies, there is no documented `ExecuteCommand` for invoices -- this route was confirmed directly against a real Autotask invoice URL (provided by the user) rather than guessed, after an earlier link on a different page (Contract Services' ticket links) turned out wrong from guessing at the URL format.

Resolved the same shape as the criteria queries: every non-voided invoice for the matched companies is fetched in one query (`companyID in [...]`, chunked), then reduced in JS to the single most-recent (`invoiceDateTime`) row per company -- Autotask's query filter has no server-side "latest per group" aggregation, so there's no way to ask for just the last one directly. A voided invoice is excluded here for the same reason it doesn't count toward the "no recent invoice" criteria.

## Row shading on "Any Client"

"Any Client" is the one criteria that mixes active and inactive rows in the same result set (every other criteria is either all-active or all-inactive). Inactive rows are flagged with the `row-no-next-period` CSS class -- the same light-red "needs attention" shading used on Contract Services for rows with no next-period unit figure. It's a shared class purely for the color, not a Contract Services concept leaking into this page; `server.js` includes `isActive` on every row so `client.js` can apply it (`data.criteria === 'any' && c.isActive === false`).

## Export CSV

The button next to Search downloads the currently-displayed result set as a CSV (same columns as the table, using the raw values -- e.g. the resolved classification label, not the numeric code). Client-side only: it re-serializes `lastData` from the last successful search rather than making a new request, so it exports exactly what's on screen. Disabled behavior: if nothing has been searched yet (or the last search returned zero rows), clicking it shows an inline error instead of downloading an empty/nonexistent file.

## Adding more criteria

`CRITERIA` in `server.js` and `CRITERIA_OPTIONS` in `client.js` are the two places a new dropdown option needs to be added -- keep the value strings in sync between them.
