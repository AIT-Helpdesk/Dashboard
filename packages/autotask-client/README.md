# @dashboard/autotask-client

Shared Autotask REST API client and helpers, wrapping the `autotask-node` SDK. Nearly every page package on this dashboard depends on this one -- `getClient()` for the underlying connection, plus a growing set of shared lookups/formulas that would otherwise get reimplemented (and drift) per page: resource/company name resolution, wildcard search parsing, AEST date helpers, picklist label resolution, and (as of this section) real chargeable-$-value resolution for `TimeEntries`.

- `index.js` -- the whole package, one file. No `server.js`/`client.js` -- this isn't a dashboard page, it's a library every page's own `server.js` requires.

This README currently documents just the chargeable-$-value addition in depth; the rest of the file's many smaller helpers (`resolveResourceName`, `getPicklistLabels`, `aestToUtcIso`, `mapWithConcurrency`, etc.) are each documented inline at their own definition, not repeated here.

## Chargeable $ value of a `TimeEntries` row

By request ("can you see information in the Autotask API which gets data awaiting Approve and Post and Posted. Can you tell the difference between posted and invoiced. Can you get the actual billable $ values for each of those" -- then "can you use the roleID and billingCodeID to calculate the chargeable value of the time entry" -- then "use these data sources and formulas for 'awaiting approve and post', posted and invoiced to show the dollar value of the times shown"). Consumed by `@dashboard/times` (the Billable $ box), `@dashboard/ticket-times` (every row/table/technician/page total), and `@dashboard/completed-tickets` (the $ column).

### The three real states, and how to actually tell them apart

The obvious first guess -- `TimeEntries.billingApprovalDateTime` (`null` = not yet approved, set = approved/posted) -- is **wrong for this tenant**, confirmed the hard way: a real time entry that was already posted into an **invoiced** `BillingItems` row still had `billingApprovalDateTime: null`. That field isn't tracking what its name suggests here (multi-level formal time-entry approval is a separate, unused Autotask workflow in this tenant, distinct from the simpler Approve and Post action actually used).

The real, verified signal:

| State | How to tell |
|---|---|
| **Awaiting Approve and Post** | A billable `TimeEntries` row with **no** `BillingItems` row referencing it (`BillingItems.timeEntryID`). |
| **Posted** | A `BillingItems` row **exists** -- that entity only ever contains records that have already gone through Approve and Post. |
| **Invoiced** | That `BillingItems` row's `invoiceID` is a real id (> 0). Not yet invoiced = `invoiceID: 0` (a literal `0`, not `null` -- Autotask's own "no value" convention for this field). |

Real check at the time this was built: of 225 recent billable time entries, 128 already had a `BillingItems` row (posted), 97 didn't (still awaiting). Of ~5,000 recent `BillingItems` in one window, ~3,500 were invoiced and ~1,450 posted-not-yet-invoiced.

### The rate formula -- confirmed 100% against real data, zero mismatches

A posted/invoiced entry's real dollar amount (`BillingItems.extendedPrice`) always traces back to exactly:

```
base = Roles.hourlyRate[entry.roleID]
mod  = WorkTypeModifiers row where id === entry.billingCodeID   (a REAL Autotask entity, 1:1 keyed with BillingCodes.id)

rate = mod doesn't exist, or mod.modifierType === 0   -> base                       (no change)
       mod.modifierType === 1                          -> base + mod.modifierValue  (flat add-on)
       mod.modifierType === 3                          -> mod.modifierValue          (flat override, base ignored entirely)

value = rate * entry.hoursToBill   -- NOT hoursWorked; confirmed these can genuinely
                                       differ (e.g. 0.15h worked billed as 0.25h),
                                       and BillingItems.quantity always matches
                                       hoursToBill, never hoursWorked, on every real
                                       row checked.
```

Verified by computing this formula for **every one of 1,863 real posted labour `BillingItems`** in a multi-month window and comparing against the real `rate` Autotask actually posted: **1,863/1,863 matched exactly, zero mismatches, zero unrecognized `modifierType` values.**

Real examples from this tenant's own data:
- `.Standard Support` (`modifierType` 0) -- Helpdesk Service role stays $190/hr as-is.
- `Onsite Support` (`modifierType` 1, `modifierValue` 40) -- Helpdesk Service $190 -> **$230**; Advanced Tech Std $260 -> **$300**; Trainer $280 -> **$320**. Same flat +$40 regardless of which role.
- `Emergency` (`modifierType` 3, `modifierValue` 270) -- **every role bills flat $270/hr**, its own base role rate ignored entirely.

This tenant has **zero rows** in `ContractRoleCosts` (the more obvious-sounding "per-contract rate override" entity) -- no per-client rate overrides are in play here, which is exactly why the Role + WorkTypeModifier formula alone explained every single real case with nothing left over.

### A dead end worth recording: `PriceListWorkTypeModifiers`

The entity name that sounds like the obvious match (`client.priceListWorkTypeModifiers`) is a **different, multi-currency-only** entity -- querying it in this tenant fails outright: `500 { "errors": ["This entity is only available if Multi-Currency functionality is enabled in this system."] }`. The entity actually used above is the plain `WorkTypeModifiers` (`client.workTypeModifiers`, "Category: lookup", GET-only, no multi-currency requirement) -- found by grepping the `autotask-node` SDK's own bundled entity list (`node_modules/autotask-node/dist/entities/*.d.ts`) for `worktype`/`pricelist`/`rolecost` candidates and testing each live, not guessed from the name alone.

### Non-billable entries -- a real bug, found and fixed against a real user report

A real ticket (T20260831.0013, "New User - Andreia") showed **$142.50** on this dashboard, but only **$95** had actually been invoiced for it. The ticket had two real time entries on the same day: one posted at a real $47.50 but flagged `BillingItems.nonBillable: 1` with `invoiceID: 0`, and one invoiced for real at $95. The first version of this function trusted ANY posted `BillingItems.extendedPrice` as-is, even when flagged `nonBillable` -- reasoned (at the time) that "Autotask can and does post a real non-zero amount despite that flag, so the real system value should win." That reasoning was wrong for what this figure is actually FOR: `nonBillable: 1` is Autotask's own explicit "this will not be charged to the client" signal, and that $47.50 entry's own real note ("Checked the current configuration and ticket has been rescheduled to 17th") confirms it -- internal admin time Autotask keeps a cost figure for its own reporting, never destined for an invoice.

Fixed: a `BillingItems` row with `nonBillable: 1` now resolves to `$0` regardless of its own `extendedPrice` (state `posted-non-billable`), REGARDLESS of whether it's technically been invoiced or not -- the flag is authoritative over the number. An AWAITING (not-yet-posted) entry with `TimeEntries.isNonBillable: true` is likewise forced to `$0`, same reasoning -- an estimate for time that's flagged non-billable and has no real posted value yet would be equally misleading.

### The exported functions

- `fetchRoleHourlyRates(client)` -- `Map(roleID -> hourlyRate)` for every active Role.
- `fetchWorkTypeModifiers(client, billingCodeIds)` -- `Map(billingCodeID -> { modifierType, modifierValue })`, chunked-fetched for just the ids actually needed.
- `resolveChargeableRate(roleID, billingCodeID, roleRatesById, workTypeModifiersById)` -- the rate formula above, returns `null` if the role isn't found (unknown/deleted role -- no rate to derive from, not a real `$0`).
- `fetchBillingItemsByTimeEntryId(client, timeEntryIds)` -- `Map(timeEntryID -> BillingItems row)`, the awaiting/posted/invoiced signal itself.
- `resolveChargeableValue(entry, billingItemByTimeEntryId, roleRatesById, workTypeModifiersById)` -- the one function callers actually use: returns `{ state: 'awaiting' | 'posted' | 'invoiced' | 'posted-non-billable', value }` for a single real `TimeEntries` row, sourcing `value` correctly for whichever state it's actually in (a real `BillingItems.extendedPrice` once one exists and isn't flagged non-billable, else `$0`, else the computed estimate).

All four data-fetching functions accept/return plain `Map`s so a caller can fetch once per request and reuse across many entries/rows -- none of them fetch per-entry.

### Consumers, and the "only for the specific person, not the whole ticket" scoping

By request, the $ figure on every consuming page is scoped to the one resource it's actually being attributed to -- never a ticket-wide blend across multiple technicians who happened to log time on the same ticket:

- **Ticket Times** sums `resolveChargeableValue()` per `resourceID:ticketID` pair (same key its own hours total already used).
- **Completed Tickets** sums it per `ticketID:resourceID`, keyed specifically to `completedByResourceID` -- the one resource each row/group is credited to -- deliberately different from that page's own pre-existing Time column, which stays a genuine ticket-wide total across every technician (see that page's own README for why that one column intentionally keeps the wider scope).
- **Times**' Billable $ box sums it per resource per T&M contract classification, replacing what used to be one flat "Helpdesk Service" role rate applied uniformly to every hour regardless of who worked it or what it was billed under.
