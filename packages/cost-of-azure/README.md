# Cost of Azure

Lists recurring billing items on every Contract whose name matches
"Sync - Cost of Azure*" (a trailing wildcard, by request -- there are 16
real contracts matching this, one per company), scoped to items dated
1 July 2026 (AEST) through the end of the current month (recomputed on
every request, not a fixed date -- see `untilEndOfCurrentMonthIso()` in
server.js). A dropdown picks which of three real states
to show (Unposted / Posted - Not Invoiced / Invoiced); each uses a
DIFFERENT real Autotask data source underneath -- see below. Read-only
throughout, by request; filters the list to just $0 rows or just >$0
rows, and shows a Client Totals popup.

## The two real data sources -- confirmed live against real data

**Posted - Not Invoiced and Invoiced** both come from `BillingItems`,
unchanged from how this page was first built:

| State | Filter |
|---|---|
| Posted - Not Invoiced | `exist postedDate` AND `notExist invoiceID` |
| Invoiced | `exist invoiceID` |

**Unposted does NOT come from `BillingItems` at all.** Autotask's own
REST API documentation defines that entity as "an approved and posted
billable item" -- by definition, a genuinely unposted row can never
exist there, confirmed live (zero rows with `postedDate` unset, across
ALL time, on every one of these 16 contracts). The real source is
**`ContractServiceUnits`** -- one row per service per billing period,
with `approveAndPostDate` null until Approve and Post happens:

```
notExist approveAndPostDate   AND   startDate >= 1 July 2026 (AEST)
```

Confirmed with an exact match against a real screenshot of Autotask's
own Unposted Items screen: querying this filter on Cloud King Hosting's
"Sync - Cost of Azure Remote Desktop" contract returned a row with
`price: 315.68` and another with `price: 371.42` -- the same two amounts
shown on screen.

`exist`/`notExist`, not `eq`/`notEq`, are required for both
`postedDate`/`invoiceID` on `BillingItems` and `approveAndPostDate` on
`ContractServiceUnits` -- confirmed live that Autotask's query API
doesn't accept `eq 0`/`eq null` as a real "no value" filter on any of
these reference-style fields (returns zero rows even when real matching
data exists). Same convention this dashboard already uses elsewhere
(e.g. `notExist ticketID`).

## Read-only, by request

Nothing on this page writes to Autotask. Two separate reasons, one per
data source:

- `BillingItems` rows (Posted - Not Invoiced / Invoiced) can't be edited
  in Autotask once posted -- confirmed by request ("Note posted items
  can't be edited").
- `ContractServiceUnits` (Unposted) is documented by Autotask as
  query-only -- "Can Create"/"Can Update" are both blank in its own API
  docs, only "Can Query" is checked -- and by request ("I don't need to
  update ContractServiceUnits"), no write was attempted or built against
  it.

If a future need to edit Billable Amount from this page comes up, it'd
need its own investigation at that point -- this page intentionally
doesn't guess at it.

## Original vs. edited Billable Amount

By request ("differentiate original value in billable amount and
billable amount (edited)"): `originalBillableAmount` is
`ContractServices.unitPrice * quantity` -- the contract's own standard
rate for that service, independent of whatever this specific row's own
amount currently says (`BillingItems.extendedPrice` for Posted/Invoiced,
`ContractServiceUnits.price` for Unposted). When the two differ by more
than a cent, the Billable Amount cell shows an `(edited)` tag.

## Fields

- **Invoice Description** is `ContractServices.invoiceDescription`,
  joined via `contractServiceID` -- present on both `BillingItems` and
  `ContractServiceUnits` rows, same join either way. NOT a field on
  either entity directly; `BillingItems.lineItemFullDescription`/
  `lineItemGroupDescription` looked like candidates by name but are
  always `null` pre-invoicing.
- Client name is resolved via `Contracts.companyID` -> `Companies
  .companyName` (neither `BillingItems` nor `ContractServiceUnits` has
  a company field directly). The main table's Client cell links to that
  row's own Contract instead, by request.
- `BillingItems.billingItemType === 6` ("Recurring Service/Bundle" --
  see `@dashboard/client-financials`' own comment for the full picklist)
  scopes the Posted/Invoiced branch to recurring items only;
  `ContractServiceUnits` needs no equivalent filter -- every row there
  is inherently a Recurring Service contract's own unit count.
