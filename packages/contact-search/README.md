# @dashboard/contact-search

Dashboard page: a general-purpose lookup across every Autotask Contact (active and inactive both -- see below), by four independent search boxes, each wildcard-matched by default (`*`, same convention every other search box on this dashboard uses) with an optional Fuzzy Search tickbox that extends the result set further.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`, picked up automatically by the shell.
- `server.js` - Express router mounted by the shell at `/api/contact-search`.

## Search boxes

Each box matches OR-across-its-own-related `Contacts` fields; filling in more than one box is ANDed (a contact must match EVERY filled box, not just one):

- **Name** - `firstName` OR `lastName`.
- **Phone** - `phone` OR `mobilePhone` OR `alternatePhone`. Spaces are ignored on both sides of the match (`"0412 345 678"` and `"0412345678"` find each other either way) -- Autotask's own query filter has no such normalization, so filling in Phone switches the WHOLE search (every box, not just Phone) to the same full-cached-list/JS-evaluated path Fuzzy Search uses below, rather than Autotask's direct query.
- **Address** - `addressLine` OR `addressLine1` OR `city` (street + suburb/city -- confirmed live against the real `Contacts` entity fields that there's no separate "suburb" field, `city` covers it, and there's no state/postcode box by request -- just street + suburb/city).
- **Email** - `emailAddress` OR `emailAddress2` OR `emailAddress3`. Typing part of a domain (e.g. `acme.com.au`) already works as a plain substring match -- no separate domain-only mode needed.

At least one box must be filled in -- there's no "browse everyone" mode; an empty search is rejected (400) before it would otherwise fetch the whole table.

## Wildcard search (the default)

Same `parseWildcard()`/`matchesWildcard()` convention shared dashboard-wide: no stars at all means "contains", a trailing `*` means "begins with", a leading `*` means "ends with", both means "contains" explicitly. Confirmed live that Autotask's REST query API accepts a nested `{op: 'or', items: [...]}` filter group, so the whole multi-box search runs as ONE query to Autotask, not one request per field.

## Fuzzy Search (optional, additive)

Ticking the box does NOT replace the wildcard search above -- it ADDS close-but-not-exact matches a plain substring would miss entirely (a typo, a transposed digit in a phone number, "Rd" typed for a stored "Road"), unioned into the same result set.

Fuzzy matching can't be expressed as an Autotask query filter, so this works the opposite way around: the full `Contacts` table is fetched once (cached 10 minutes -- confirmed live this account has ~6,100 active contacts alone, ~7 seconds to fetch in full, too slow to redo on every search but fine cached briefly) and scored in plain JS against whichever boxes were filled in, using the same plain Levenshtein-ratio-with-substring-bonus approach `@dashboard/data-matching`'s own `fuzzySimilarity()` already proved out (copied here rather than shared, since that one lives inside a different page's own `server.js` with no shared home yet) -- a contact must still satisfy EVERY filled box (wildcard-contains OR fuzzy-similar on at least one of that box's fields), same AND-across-boxes rule as the fast path. `boxMatches()` in `server.js` is the one shared per-box test both this path and the Phone-present path (above) use, so the two "evaluate everyone in JS" cases can't quietly drift apart.

## Active and inactive contacts

Deliberately NOT filtered to active-only by default, unlike most other pages on this dashboard -- this is a lookup tool, and hiding a real record just because the contact (or their company) is no longer active would defeat the point of searching for them. An inactive contact is still flagged in the results table with the same light-red "needs a second look" row shading `@dashboard/client-details`' own "Any Client" view already uses for the same situation (`row-no-next-period`, a shared CSS class, not a concept specific to either page).

**Ignore Inactive Contacts and Clients** (unticked by default, so the default search behaviour above is unchanged) narrows this back down on request -- excludes a contact whose own `Contacts.isActive` isn't `1`, AND a contact whose own company's `Companies.isActive` isn't `true`, checked independently (a contact can be active while their own company is inactive, or vice versa).

## Table columns / Export CSV

**Company Name** (linked to the company's Detail page in Autotask, `getCompanyUrl()`), **First Name**, **Last Name**, **Email**, **Phone**, **Mobile**, **Address** (the same 3 fields the Address search box matches, joined onto one line). Export CSV (client-side, re-serializes the last successful search) adds **Alternate Phone** and **Active** (Yes/No) as two more columns not shown in the on-screen table.

## Sort and filter on the results table

Every column header has its own click-to-sort button (click again to reverse, same convention `@dashboard/live-health-scores`'s own sortable columns use) and, in its own row directly underneath, a per-column filter box -- a plain case-insensitive substring match against that column's own value (not the `*`-wildcard syntax the search boxes above use; this just narrows what's already on screen, client-side, with no new request to the server). Filling in more than one column's filter box ANDs them together. Both reset to the default (sorted by Company Name, no filters) on every new search.

The `<thead>` (sort buttons + filter inputs) is built once per search and never regenerated -- only `<tbody>` is replaced on a sort click or filter keystroke, so a filter `<input>` never loses focus mid-type the way rebuilding the whole header on every keystroke would cause.
