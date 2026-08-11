# @dashboard/client-contacts

Dashboard page: pick which contacts to show (primary, main billing, both, or all), optionally filter by Client / Company Type / Classification (wildcards with `*`), see the matching contacts across active clients. No date scoping -- this is a live snapshot, not a per-period report.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`, picked up automatically by the shell.
- `server.js` - Express router mounted by the shell at `/api/client-contacts`.

## Contact type

- **Primary contacts** - `Contacts` where `primaryContact = true`.
- **Main billing contacts** - `Contacts` where `billingContact = true`.
- **Both** - the union of the two above, not an intersection -- a contact is included once if it has EITHER flag set, even if it happens to have both flags set for the same company (which is common; see Client Details' Primary Contact / Main Billing Contact columns for real examples).
- **All active contacts** - every active contact at a matching company, no `primaryContact`/`billingContact` filter at all.

Only active contacts (`Contacts.isActive = 1` -- an integer field, not a boolean, unlike `Companies.isActive`) at active companies (`Companies.isActive = true`) are included, per request.

## Client name filter

Same wildcard convention (`parseWildcard()`, shared with Contract Services and Client Details) folded into the initial `Companies` query itself, not applied afterward in JS.

## Company Type / Classification search fields

Both `companyType` and `classification` are picklist fields on `Companies` storing an integer code, not the text typed into the search box (e.g. `companyType = 1` means "Customer"). Since the search term is matched against the LABEL, not the stored code, this can't be expressed as a single Autotask API filter -- the field's label map is resolved first (`getPicklistLabels()` in `@dashboard/autotask-client`, cached), the wildcard is matched against each label in JS (`matchesWildcard()`, the local-matching counterpart to `parseWildcard()`), and the resulting list of matching codes is folded into the `Companies` query as an `in` filter. A search term matching zero labels (e.g. a typo) short-circuits to an empty result rather than sending an empty `in` filter.

Unlike Client Details, there is no hardcoded restriction to Customer/Prospect company types here -- Company Type is a free-text (wildcard) search field by request, not a fixed restriction.

## Table columns

**Company Name** (linked to the company's Detail page in Autotask, `getCompanyUrl()`), **First Name**, **Last Name**, **Email** (`Contacts.emailAddress`), **Phone** (`Contacts.phone`), **Mobile** (`Contacts.mobilePhone`). Phone/Mobile are shown as Autotask stores them, with no reformatting -- blank when the contact record has no value set.

## Export CSV

The button next to Search downloads the currently-displayed result set as a CSV (same columns as the table). Client-side only, same pattern as Client Details: re-serializes `lastData` from the last successful search rather than making a new request, and shows an inline error instead of downloading an empty file if nothing's been searched yet.

## Shared utilities

This page is what prompted moving the repeated "chunked `in` filter" pattern (previously duplicated in both Contract Services and Client Details) into `fetchByFieldIn()` in `@dashboard/autotask-client` -- both of those pages were refactored to use the shared version rather than adding a third copy here.
