# @dashboard/client-financials

Dashboard page: type a client name, see a 12-month invoiced-amounts summary (Labour / Recurring Services / Charges, by month plus a 12-month total) and the list of invoices issued in that window. Single-client only -- unlike every other page on this dashboard, which aggregates across however many clients match a filter, mixing invoices from multiple companies into one financial summary would misstate every number, so a wildcard that matches more than one company is reported back to the user to narrow down rather than silently picked or merged.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`, picked up automatically by the shell.
- `server.js` - Express router mounted by the shell at `/api/client-financials`.

## Data model

- **Companies** - resolves the client-name wildcard (`parseWildcard()`, shared convention) to exactly one company. Zero matches returns `status: 'not-found'`. More than one returns `status: 'ambiguous'` with a `matches: [{id, companyName}]` list -- `client.js` renders each as a clickable link-styled button; clicking one re-requests with `companyId` set, which resolves that exact company directly (`client.companies.get(companyId)`) rather than re-running the still-ambiguous name wildcard. The client-name input field is then updated to the resolved company's exact name, so it matches what's on screen.
- **Invoices** - non-voided invoices for that company in the last 12 calendar months (ending with the current, partial month). Drives both the invoice list and which month each BillingItem's amount is bucketed into.
- **BillingItems** - the line-item detail behind an invoice, fetched by `invoiceID in [...]` (chunked) for the matched invoices. `billingItemType` is a fixed Autotask-wide picklist (not org config), mapped here to the three requested buckets:
  - **Labour** - types 1 (Labor), 2 (Labor Adjustment).
  - **Recurring Services** - type 6 (Recurring Service/Bundle).
  - **Charges** - everything else: 3 (Cost -- ticket/project/contract), 4 (Expense), 5 (Subscription), 7 (Recurring Contract Setup Fee), 8 (Milestone). Type 7 reads like a recurring category by name but is actually a one-off fee tied to setting up a recurring contract, so it's bucketed as Charges, not Recurring Services.

  Charges is further split in two, by request: a Charge line whose `billingCodeID` resolves to a BillingCode named exactly **"Labour in Charges"** (what Autotask's UI labels "Material Code" on a Charge line -- labour billed as a one-off Charge rather than through normal Ticket Labor time entries) becomes the **Labour in Charges** row; every other Charge line is **Other Charges**. The billing code's ID is resolved by name once per process (`getBillingCodeIdByName()`, shared, cached) rather than hardcoded, so it stays correct if the code is ever recreated with a new ID.

  Recurring Services is also split in two, by request: a recurring line on a CONTRACT whose name starts with **"Tech Cover"** (e.g. "Tech Cover Essentials", "Tech Cover Elite") becomes the **Tech Cover** row; every other recurring line is **Recurring Services**. "Tech Cover" is a CONTRACT naming convention, not a Service/ServiceBundle name -- confirmed against a real example (Redlands Sporting Club Inc's "Tech Cover Essentials" contract invoices its recurring line as "Kaseya 365 User & Endpoint Bundle", which doesn't mention "Tech Cover" anywhere in its own item name or description) -- so this joins each BillingItem's `contractID` to `Contracts.contractName` and matches THAT via the dashboard's standard wildcard convention (`matchesWildcard()`, beginsWith), not the item's own itemName/description.

A BillingItem is bucketed into a MONTH by its parent invoice's `invoiceDateTime`, not the item's own `itemDate` -- this is a summary of *invoiced* amounts, and an item can be incurred in one month but invoiced in a later one.

## Last 12 months

Calendar months, not a rolling 365-day window: from 11 months before the current month through the current (partial) month, inclusive. Recomputed from the current date on every request, same moving-window approach as Client Details' "no invoice since" cutoff. "Current month" and each BillingItem's month bucket are both **AEST**, not UTC (`last12MonthKeys()`/`monthKeyOf()`, `@dashboard/autotask-client`) -- otherwise an invoice dated in the first ~10 AEST hours of a new month would still bucket into the previous month, since UTC hadn't reached that month yet.

## Summary table

Rows, alphabetical by category (by request), with the bolded Total row (the sum of the other five, not requested explicitly but a natural completion of a financial summary) always pinned last rather than sorted in with the rest: Labour, Labour in Charges, Other Charges, Recurring Services, Tech Cover, Total. Columns: the 12 months plus a 12-Month Total column. Wrapped in its own `overflow-x: auto` container rather than widening the page -- 13 columns is wide on a normal window.

The header row and the Total row are shaded with the shared `.shaded-row` class (`packages/shell/public/styles.css`) -- the same blue as Completed Tickets' per-technician `.resource-group-header` bar, both drawing on the `--section-header-bg` custom property so light/dark mode stay in sync.

## Invoice list column

Links to the invoice itself in Autotask (`getInvoiceUrl()`, shared with Client Details), sorted newest first.
