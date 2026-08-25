# @dashboard/m365-environment

Dashboard page: type a client name, see their Microsoft 365 tenant snapshot as recorded in **IT Glue** -- domains, licenses, license assignments, and privileged (Global Administrator) role membership. First page on this dashboard to use IT Glue as a data source (via the new shared `@dashboard/itglue-client` package).

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`, picked up automatically by the shell.
- `server.js` - Express router mounted by the shell at `/api/m365-environment`.

## Not a live query

This is **not** a live call against the client's own Microsoft 365 tenant -- it reads IT Glue's own **"MS365 Environment (auto)"** flexible asset, a snapshot populated by an org-specific automation (a Rewst workflow, confirmed against real data -- the field literally includes a "Created by Rewst" banner). Data is only as fresh as IT Glue's last sync for that client (`updatedAt`, shown on the page) -- for Redlands Sporting Club Inc, real data showed a sync roughly a few hours before this was tested.

## Client resolution -- Autotask first, then IT Glue

Same single-client wildcard-resolution pattern as Client Financials/Client Summary (`resolveSingleCompany()`), since Autotask is this dashboard's primary source of truth for "which company is this." Once resolved to exactly one Autotask company, that company is mapped to its IT Glue organization -- see below.

## Autotask company <-> IT Glue organization mapping

IT Glue's own PSA (Autotask) sync is exposed via an organization's `adapters-resources` relationship, but **only** reachable via `?include=adapters-resources` on an organization fetch -- every other URL shape tried (`/organizations/{id}/adapters-resources`, `/organizations/{id}/relationships/adapters-resources`, a direct `/adapters_resources/{id}` fetch) 404s, confirmed against the real API.

The included adapter record's `remote-id` **is** the Autotask company id -- confirmed two ways against real data: Ambient IT's own IT Glue org has `remote-id: "0"`, matching Autotask's own internal company id 0 (the same id `resolveCompanyName()` already special-cases as "Ambient IT (internal)"); "Redlands Sporting Club Inc" has `remote-id: "178"`, matching that real Autotask company's id exactly (same org name in both systems, too).

`getOrgMap()` in `server.js` builds this mapping for **all** ~1,941 IT Glue organizations up front (2 requests, at the max page size of 1000) and caches it for 20 minutes, rather than trying to search IT Glue for just one org at a time -- IT Glue's organizations endpoint has no "find the org synced to Autotask company X" filter, and `filter[name]` (confirmed empirically) is an **exact, case-sensitive match only**, no wildcards, so it couldn't be used to look up a client by name reliably anyway even if org names were guaranteed identical between the two systems (which they aren't always).

## The MS365 Environment asset type

Resolved by name (`"MS365 Environment (auto)"`) via `/flexible_asset_types`, not a hardcoded id -- this is an org-specific custom asset type (not a built-in IT Glue feature), so its id could differ across IT Glue accounts. Cached indefinitely for the process lifetime, same rationale as `getBillingCodeIdByName()` in `@dashboard/autotask-client` (asset type definitions are effectively static configuration, confirmed to have 8 fields: Created by Rewst, Default Domain Name, Tenant Display Name, Overview, Domains, Privileged Group Membership, Licences, User Licence Assignment).

## Parsing the HTML tables

Confirmed against a real record: every substantive field on this asset (`overview`, `domains`, `privileged-group-membership`, `licences`, `user-licence-assignment`) is rendered by Rewst as raw HTML table markup with inline styles (a teal-branded panel), not structured JSON. Rather than embed that un-sanitized third-party HTML directly (which would also carry its own hardcoded colors, clashing with this dashboard's light/dark theming), `server.js` parses each one with `cheerio` (this page's one new npm dependency) into a plain `{headers, rows, note}` shape, and `client.js` renders it with the dashboard's own table styling. Overview's own source data is a single row of many columns (Total Users, Total Enabled Users, ...) -- rendered as a **vertical** Field/Value table (one stat per row) rather than one wide row, by request; every other section (Domains, Licences, etc.) genuinely has multiple rows and stays in its natural horizontal shape.

Overview and Domains are also sized to their own content (`.m365-table-compact`, `display: inline-block` on the card) rather than stretching to the full page width like every table does by default on this dashboard -- both are short, narrow tables (a handful of stats, or a domain name + a Yes/No flag), by request.

Three real parsing quirks handled specifically:

- **Data rows that mix `<th>` and `<td>`.** Confirmed against real data: Privileged Group Membership's header row is a normal all-`<th>` row, but each DATA row renders its role name as `<th>Global Administrator</th>` and only the Members list as `<td>...</td>` -- not the all-`<td>` shape every other table on this asset uses. An earlier version of `parseTraitTable()` only collected `<td>` cells for data rows, which silently dropped the role name entirely and left the Members list as the row's only cell -- which then rendered under the "Role Name" column header since it was the only cell present, with "Members" appearing empty. Fixed by collecting every cell (`th` + `td`, in DOM order) per row, and only treating a row as the header when **every** cell in it is a `<th>` -- a data row that merely contains one `<th>` no longer qualifies.
- **Multi-value cells.** The Privileged Group Membership table's "Members" column lists several names in one `<td>`, separated by `<br>` tags -- confirmed against real data (`o365admin<br>Shane Curtis<br>Brett Green<br>`). Cheerio's plain `.text()` would silently concatenate these with no separator at all (`o365adminShane CurtisBrett Green`), so `cellText()` converts `<br>` to a newline before extracting text, then re-joins non-empty lines with `, ` for display.
- **Truncation notes.** The User Licence Assignment table is genuinely capped at the first 10 (alphabetical) users by Rewst itself, with a plain-text note directly after the table -- confirmed against real data: a client with 20 licensed users showed only 10 rows plus "Displaying 10 of 20 users. See attachments for the full list." `parseTraitTable()` extracts that note separately (`/Displaying \d+ of \d+.../i`). By request, `userLicenceAssignmentSection()` in `client.js` (a dedicated renderer for this one section, not the generic `tableSection()` every other section uses) treats that note as a signal the table itself is genuinely partial -- when present, it shows ONLY the "User Licence Assignment" heading plus a link straight to the asset in IT Glue (its `resource-url`, the closest real link available -- IT Glue's API doesn't expose a direct attachment-file URL) instead of the truncated table, so a partial list is never presented as if it were complete. No note means Rewst's own table genuinely is the full list, so it renders normally like every other section. A separate **"View in IT Glue"** link is also shown alongside the synced-date at the top of the page regardless, for jumping to the full record generally.

## When there's no IT Glue data

Two distinct "nothing to show" states, reported separately rather than collapsed into one generic empty message:
- `itglueLinked: false` -- this Autotask company has no matching IT Glue organization at all (no PSA sync record).
- `itglueLinked: true, hasM365Asset: false` -- the company has an IT Glue org, but no "MS365 Environment (auto)" record exists for it (e.g. the client isn't on Microsoft 365, or the sync automation hasn't been set up for them).

## Caching

The org-id map and asset-type id are cached (20 minutes / process lifetime respectively, see above) since they're shared, global lookups. The per-client MS365 asset fetch itself is **not** cached -- same as Client Financials, this is a live on-demand single-client lookup, not a report meant to be refreshed on a schedule.
