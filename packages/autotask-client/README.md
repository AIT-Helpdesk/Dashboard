# @dashboard/autotask-client

Shared Autotask REST API client and helpers, wrapping the `autotask-node` SDK. Nearly every page package on this dashboard depends on this one -- `getClient()` for the underlying connection, plus a growing set of shared lookups/formulas that would otherwise get reimplemented (and drift) per page: resource/company name resolution, wildcard search parsing, AEST date helpers, picklist label resolution, real chargeable-$-value resolution for `TimeEntries`, and real Leave/Time Off billing-code resolution.

- `index.js` -- the whole package, one file. No `server.js`/`client.js` -- this isn't a dashboard page, it's a library every page's own `server.js` requires.

This README currently documents just the chargeable-$-value and Leave/Time Off additions in depth; the rest of the file's many smaller helpers (`resolveResourceName`, `getPicklistLabels`, `aestToUtcIso`, `mapWithConcurrency`, etc.) are each documented inline at their own definition, not repeated here.

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

## Real Leave/Time Off billing codes -- `resolveLeaveBillingCodeIds()`

Used by `@dashboard/times` (Leave Hours) only -- `@dashboard/teams-shifts`/`@dashboard/whats-on`/`@dashboard/about-me` moved to `fetchLeaveTimeOffRequests()` below instead, after a further real bug report. Times keeps this TimeEntries-based approach for its own numeric Leave Hours total (see that section below for why).

**Two superseded attempts before this one, both real bug reports in sequence:**

1. **Original**: infer Leave from `TimeEntries.timeEntryType` in `[15 PersonalTime, 16 VacationTime, 17 SickTime, 18 PaidTimeOff]`, with no `ticketID`/`taskID`. Correct for real Vacation/Sick Time/Floating Holiday/Personal Time entries, but a real bug report ("how did you come up with... Peter Kiem's leave isn't showing") found this can't catch "Unpaid" leave at all: every real Unpaid entry in this tenant instead carries `timeEntryType: 10` (CompanyTask) AND a real `taskID` -- Autotask mirrors it differently than the other leave types, for reasons outside this dashboard's control.
2. **Second attempt**: match by `BillingCodes.useType === 3` ("Internal"), narrowed by name to the 9 that look like real Leave (Vacation, Sick Time, Floating Holiday, Holiday, Personal Time, Jury Duty, RDO, Bereavement Leave, Unpaid) vs. the other `useType === 3` codes that are real internal WORK, not leave (Travel Time, Internal Meeting, Office Management, HR/Recruiting, Training, Research). Confirmed to catch Peter Kiem's Unpaid days correctly -- but by request ("There is a list of Billing Codes identified as Internal... stop making up your own reasoning"), this was itself judgment-based guessing at billing code names, not a real authoritative source.
3. **Current**: Autotask's own Internal Time admin screen has a real "Display In Time Off" checkbox that's the actual authoritative flag for this -- confirmed it has **no REST API equivalent at all** (the full real field list for `BillingCodes` was pulled via `/entityInformation/fields`: 15 real fields, nothing close; no UserDefinedFields either; no separate "Internal Time" entity anywhere in the `autotask-node` SDK's own entity list). So Amber's own real list, read directly off that admin screen, is kept in **`.env`** (`LEAVE_TYPES`, a comma-separated list of exact real `BillingCodes.name` values) instead -- not a JS array, so it can be updated there with no code change or redeploy if that real list is ever changed in Autotask. Real confirmed value at the time this was written: `Vacation, Unpaid, RDO, Sick Time, Personal Time, Jury Duty, Holiday, Floating Holiday, Bereavement Leave`.

`resolveLeaveBillingCodeIds(client)` parses `LEAVE_TYPES`, resolves each name to its real `BillingCodes.id` fresh every call (not cached), and returns the id list -- resolved by NAME every time so a renamed code in Autotask (or an edited `LEAVE_TYPES` value) takes effect immediately, without a server restart, same "don't bake in a number that lives in Autotask" reasoning every other named-lookup on this dashboard already follows. Callers then match Leave directly by `billingCodeID` (with only `notExist ticketID` as a safety filter -- deliberately NO `timeEntryType` or `notExist taskID` constraint, since the billing code itself is what makes an entry Leave regardless of which internal `timeEntryType` or task-linkage Autotask happens to record it under).

Confirmed live at the time this fix shipped: Peter Kiem's 2 real Unpaid days (17-18 Sep 2026) now show correctly in Times' own Leave Hours (`15.2`). A leave type whose name doesn't match any of the 7 fixed `SHIFT_CATEGORIES` colours (e.g. Personal Time, Jury Duty, Holiday, Bereavement Leave) still renders -- just with the same plain, uncoloured pill every other unmatched label already got before this change; extending that fixed legend to cover every real `LEAVE_TYPES` name wasn't part of this fix.

## Real Leave, sourced directly from TimeOffRequests -- `fetchLeaveTimeOffRequests()`

Used by `@dashboard/teams-shifts` ("Shifts and Schedules"), `@dashboard/whats-on` (Team Shifts excerpt), and `@dashboard/about-me` (Shifts card) -- all three need the exact same real definition and must never quietly disagree. **Not** used by `@dashboard/times`, which keeps `resolveLeaveBillingCodeIds()`/TimeEntries above for its own numeric Leave Hours total -- folding in real not-yet-approved hours would change what that subtraction-based total actually means, a bigger, separate change than what was asked for here.

**Superseded** the `resolveLeaveBillingCodeIds()`/TimeEntries approach above (for these three calendar/schedule pages only) after a further real bug report: Damon Kirkpatrick's real Vacation request for 19-23 Oct 2026 wasn't showing on "Shifts and Schedules" at all. Investigated live: no real TimeEntries row existed for him in that window, and no real Teams Graph Shifts/timeOff row either -- both genuinely empty. Root cause found by querying `TimeOffRequests` directly: his real request existed there, but sat at real **`status: 2` (Submitted)** -- Autotask only mirrors a Time Off Request into a matching plain TimeEntries row once it's actually **Approved** (`status: 3`), so a real pending request has no TimeEntries row to find yet, no matter how that query is tuned. This confirmed the same root cause as the earlier "Peter Kiem's Unpaid leave" bug -- TimeEntries is a lossy, secondhand mirror of the real leave data, not the source of truth.

Querying `TimeOffRequests` directly sidesteps the whole mirroring question, and -- by a follow-up request ("can we display the Unapproved data with the right colour but with stripes or something so that it's obviously different") -- surfaces real pending leave too, visually distinguished rather than hidden:

- Real confirmed `status` picklist: `1` Unsubmitted, `2` Submitted, `3` Approved, `4` Rejected, `5` Canceled, `6` Partially Approved. Only Approved and Submitted are fetched -- Unsubmitted/Rejected/Canceled are never real, actionable leave. Partially Approved is treated the same as Submitted (`approved: false`) since its own `hours` isn't confirmed to reflect just the approved portion rather than the full original request, and no real example exists in this tenant to confirm which.
- `resolveLeaveTimeOffRequestTypeIds(client)` resolves the same real `.env` `LEAVE_TYPES` names to real `timeOffRequestType` picklist ids (a *different* picklist from `BillingCodes`, resolved via `getPicklistLabels(client.timeOffRequests, 'timeOffRequestType')`) -- a name with no real match (an inactive/legacy type id not present in the active picklist, confirmed real: ids `7582`/`7583` turn up on old historical rows with no resolvable label) is simply never matched, same as an unmatched name would be against `BillingCodes`.
- `fetchLeaveTimeOffRequests(client, startISO, endISO, resourceId?)` -- `resourceId` omitted for an unscoped, company-wide fetch (Shifts and Schedules/What's On, same deliberate "show every real leave entry, don't guess who belongs to this team" reasoning `@dashboard/teams-shifts`' own README documents), or passed to scope to one resource (About Me). Returns `{ id, resourceID, dayKey, displayName, hoursWorked, approved }` per real request -- `dayKey` from `requestDate` (a real date-only field, matched with bare ISO strings same as `TimeEntries.dateWorked`, no AEST conversion needed), `displayName` from the resolved `timeOffRequestType` label, `approved: true` only for real `status: 3` rows.

Confirmed live after the fix: Damon's 5 real Submitted Vacation days (19-23 Oct 2026) now show on "Shifts and Schedules" and What's On's own week view with `approved: false`; a real known-Approved entry (Amber Worth, 23 Oct 2026) still shows `approved: true` alongside it, in the same real day. Each consuming page's own `client.js` renders an `approved: false` Leave entry with a diagonal stripe through its own category colour (`repeating-linear-gradient`, same colour identity, just visually unmistakable from a solid Approved entry) plus a "Not yet approved" note in its tooltip/day-popup.
