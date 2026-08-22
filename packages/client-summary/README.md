# @dashboard/client-summary

Dashboard page: type a client name, see a single-client "at a glance" landing page pulling together company details, a condensed financial snapshot, active contracts, open ticket activity, and a 1-month Security Alerts summary -- one page instead of jumping between Client Details, Client Financials, Contract Services, and the standalone Security Alerts page. Single-client only, same reasoning as Client Financials: mixing more than one company's data into one summary would misstate every number, so an ambiguous wildcard is reported back to the user to narrow down rather than merged or silently picked.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`, picked up automatically by the shell.
- `server.js` - Express router mounted by the shell at `/api/client-summary`.

## Company resolution

Identical pattern to Client Financials: `resolveSingleCompany()` (`@dashboard/autotask-client`) resolves the client-name wildcard to exactly one company. Zero matches returns `status: 'not-found'`. More than one returns `status: 'ambiguous'` with a `matches: [{id, companyName}]` list -- `client.js` renders each as a clickable button; clicking one re-requests with `companyId` set, resolving that exact company directly rather than re-running the still-ambiguous wildcard.

## Company details header

- **Classification** - `Companies.classification`, resolved to its label via `getPicklistLabels()` (org-specific custom picklist, e.g. "Tech Cover Essentials" -- confirmed against real data).
- **Active/Inactive** - `Companies.isActive`, shown as a green/red badge.
- **Address / Phone** - `Companies.address1/address2/city/state/postalCode` and `Companies.phone`, joined into one line.
- **Primary Contact / Main Billing Contact** - the `Contacts` row (scoped to this company) with `primaryContact`/`billingContact` set `true`, same flags Client Details uses. If more than one contact has the same flag set (Autotask doesn't enforce uniqueness), the first one found wins. Shown as name + email.
- **Contact UDFs** - three specific Company-level User Defined Fields, by request: **Contact - Primary IT**, **Contact - IT Security**, **Contact - Sales Approvals**. Confirmed against real data (`Companies/178`) these live on `Companies.userDefinedFields`, **not** `Contacts.userDefinedFields`, despite the "Contact - " naming prefix -- each one holds a free-text name (or is blank) for who fills that role at the client, not an actual foreign key to a Contact record. Read via the same generic `{name, value}` array lookup `getTicketUdf()` already uses for tickets (that helper works unchanged on any entity carrying a `userDefinedFields` array, ticket-specific naming aside).

## Financial snapshot

A condensed version of Client Financials' 12-month invoice breakdown: the same category bucketing (Labour, Labour in Charges, Other Charges, Recurring Services, Tech Cover -- see that page's README for the full billingItemType/BillingCode/"Tech Cover" contract-naming rationale, reused here unchanged), shown as the **last 4 months individually, plus a 12-Month Total column** -- narrower than Client Financials' full 13-column (12 months + total) grid, but still shows recent month-to-month trend rather than collapsing straight to one flat number. `buildFinancialSnapshot()` in `server.js` buckets every billing item into its own month first (`monthTotals`, a `Map` keyed by month, same shape Client Financials builds), then derives BOTH the last-4-months slice and the 12-month total from that same per-month data -- the two are never computed two different ways, so they can't disagree with each other. Also shows the most recent invoice (number, date, total, linked to Autotask) rather than the full invoice list.

## Active contracts

`Contracts` for this company where `status = 1` ("In Effect" -- confirmed via field info a 2-value picklist, 1 In Effect / 3 Terminated). A live current-state snapshot, not the date-range-overlap logic Contract Services' month-scoped report uses -- there's no "which month" question on a landing page like this, just "what's active right now". Shows contract name (linked), type (`contractType` picklist label), start date, end date. Sorted alphabetically by contract name.

## Recent ticket activity

"Open" is the same definition Completed Tickets uses for "done", inverted: any ticket whose status is **not** 5 (Complete) or 20 (Billing - Contract) counts as open here, rather than a separately-invented list. `issueType = 14` (Monitoring Alert) is excluded, same as every other ticket-listing page on this dashboard -- client-side via `excludeMonitoringAlerts()` (`@dashboard/autotask-client`), not an Autotask query filter, since a `noteq` query filter was confirmed to silently drop every not-yet-triaged ticket too (Autotask's REST API treats `NULL != 14` as unknown, not true -- see Tickets Created's README for the real-data story). The open-ticket count reflects every open ticket for the company; the table below it shows only the 8 most recently active (`lastActivityDate` descending), with a note when there are more than that.

## Security Alerts (1 month)

Mirrors Security Alerts' own severity scope (critical + medium only, no low -- confirmed there that `low` is ~99.8% of all events, routine noise, so this page inherits the same "genuine alerts, not a raw activity log" framing). Covers the trailing month ending today (AEST).

The matching SaaS Alerts customer is found via that customer's own `mappedToPSA` entry for **this exact company ID** (`/reports/customers`, same source Security Alerts and SaaS Alerts Customers use), not by name-wildcard matching -- an id match is exact where the standalone Security Alerts page has to fall back on a name wildcard (it has no Autotask company to start from). If the company has no SaaS Alerts mapping at all, the section says so plainly rather than showing an empty/misleading zero.

Shows total alert count (critical/medium split, color-flagged same as elsewhere) plus the top 5 alert names by count for the period -- a "what's been going on" glance, not the full filterable detail table Security Alerts itself provides for deeper investigation.

## Caching

None -- every load is a live fetch across five independent sources (Contacts, Invoices/BillingItems, Contracts, Tickets, SaaS Alerts), same as Client Financials/Contract Services. `lastData` (module-scope) restores the last result instantly on a same-session re-mount, same convention as every other page.
