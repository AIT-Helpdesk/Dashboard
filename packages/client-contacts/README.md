# @dashboard/client-contacts

Dashboard page: pick which contacts to show (primary, main billing, both, or all), optionally filter by Client / Contracts / Classification (wildcards with `*`), see the matching contacts across active clients. No date scoping -- this is a live snapshot, not a per-period report.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`, picked up automatically by the shell.
- `server.js` - Express router mounted by the shell at `/api/client-contacts`.

## Contact type

- **Primary contacts** - `Contacts` where `primaryContact = true`.
- **Main billing contacts** - `Contacts` where `billingContact = true`.
- **Both** - the union of the two above, not an intersection -- a contact is included once if it has EITHER flag set, even if it happens to have both flags set for the same company (which is common; see Client Details' Primary Contact / Main Billing Contact columns for real examples).
- **All active contacts** - every active contact at a matching company, no `primaryContact`/`billingContact` filter at all.

Only active contacts (`Contacts.isActive = 1` -- an integer field, not a boolean, unlike `Companies.isActive`) are included -- that restriction always applies, regardless of the checkbox below. Companies default to active-only too (`Companies.isActive = true`), unticked by default; ticking **Show Inactive Clients** drops that restriction (substituting Autotask's own `id gte 0` no-op filter convention, since its query API requires at least one filter condition) so inactive companies' contacts are included as well.

## Client name filter

Same wildcard convention (`parseWildcard()`, shared with Contract Services and Client Details) folded into the initial `Companies` query itself, not applied afterward in JS.

## Contracts search field

Matched directly against `Contracts.contractName` (plain text, not a picklist) using the standard wildcard convention (`parseWildcard()`), not against `Companies` at all. The matching contracts' `companyID`s are collected into a set and folded into the `Companies` query as an `id in [...]` filter, so a contact is returned if their company holds AT LEAST ONE contract whose name matches -- not necessarily an active one; no `status` restriction is applied, since the request is for "a contract matching that name", not an active one specifically. A search term matching zero contracts short-circuits to an empty result rather than sending an empty `in` filter.

## Classification search field

`classification` is a picklist field on `Companies` storing an integer code, not the text typed into the search box. Since the search term is matched against the LABEL, not the stored code, this can't be expressed as a single Autotask API filter -- the field's label map is resolved first (`getPicklistLabels()` in `@dashboard/autotask-client`, cached), the wildcard is matched against each label in JS (`matchesWildcard()`, the local-matching counterpart to `parseWildcard()`), and the resulting list of matching codes is folded into the `Companies` query as an `in` filter. A search term matching zero labels (e.g. a typo) short-circuits to an empty result rather than sending an empty `in` filter.

## Table columns

**Company Name** (linked to the company's Detail page in Autotask, `getCompanyUrl()`), **First Name**, **Last Name**, **Email** (`Contacts.emailAddress`), **Phone** (`Contacts.phone`), **Mobile** (`Contacts.mobilePhone`). Phone/Mobile are shown as Autotask stores them, with no reformatting -- blank when the contact record has no value set.

## Export CSV

The button next to Search downloads the currently-displayed result set as a CSV (same columns as the table). Client-side only, same pattern as Client Details: re-serializes `lastData` from the last successful search rather than making a new request, and shows an inline error instead of downloading an empty file if nothing's been searched yet.

## Resolve Duplicates for Mailing List

A separate button opens a popup with one compact table listing every "duplicate incident" in the current result set -- contacts sharing the same First Name + Last Name (trimmed, case-insensitive match), grouped next to each other (a top border marks where one name group ends and the next begins). Non-duplicate (uniquely-named) contacts aren't listed at all, since there's nothing to resolve for them. The popup itself is wider/taller than this dashboard's default modal, since the list can run long. A filter box above the table for each of First Name/Last Name/Company Name/Email narrows which rows are shown (display-only, client-side substring match -- it never changes what gets ticked or exported).

Each row has an **Eliminate** checkbox -- ticking it marks that one specific contact line for exclusion from the mailing-list export only; it does nothing else (the main table/CSV export are unaffected). The popup's own "Export Mailing List CSV" button downloads every contact from the full result set EXCEPT whichever lines got ticked Eliminate -- i.e. all the unticked ones, duplicates and uniques alike -- as a separate CSV (same columns, filename suffixed `-mailing-list` instead of the plain contact-type suffix the regular Export CSV button uses).

Eliminate ticks are tracked client-side only (a `contactKey()` -- the real `Contacts.id` the server now includes on each row, falling back to a composite of the displayed fields for older cached results with no `contactId`) and reset on every new search, so duplicate resolution has to be redone each time the filters change.

A "Mark Inactive" button (setting the contact's real `Contacts.isActive` to `0` in Autotask directly from this popup) was built and then removed, by request, after confirming live that this tenant's Autotask API rejects every conventional update shape for Contacts -- see the comment above `module.exports` in `server.js` for the full trail of confirmed HTTP responses (two different 405s, two different 404s, and a side-by-side control test proving the identical call shape works for Companies). If Autotask API access is revisited later, that's the place to pick it back up.

## Filter form layout

Two side-by-side columns, by request: Client (with Contracts/Classification stacked underneath it) on the left, Show (with Show Inactive Clients stacked underneath it) on the right -- rather than every field stacking in a single column like most of this dashboard's other filter forms. The Show Inactive Clients checkbox sits to the left of its own label text (`<input> Show Inactive Clients`, not the reverse).

## Shared utilities

This page is what prompted moving the repeated "chunked `in` filter" pattern (previously duplicated in both Contract Services and Client Details) into `fetchByFieldIn()` in `@dashboard/autotask-client` -- both of those pages were refactored to use the shared version rather than adding a third copy here.
