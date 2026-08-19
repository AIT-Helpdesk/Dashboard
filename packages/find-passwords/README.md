# @dashboard/find-passwords

Dashboard page: type a password name (wildcards with `*`), see matching IT Glue password entries -- **metadata only**. This page never requests, stores, logs, or displays the actual password value or its notes field, by explicit design.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`, picked up automatically by the shell.
- `server.js` - Express router mounted by the shell at `/api/find-passwords`.

## What this page deliberately does NOT retrieve

Two fields are never read from IT Glue's response, even though they're present on the same records this page does use:

- **The password value itself.** Confirmed against real data: IT Glue's `GET /passwords` list endpoint doesn't include it at all -- there's no field to accidentally read here even if `toRow()` in `server.js` were careless about it.
- **`notes`.** This field DOES come back with real (sometimes lengthy) content on the list endpoint -- confirmed against real data. `toRow()` simply never reads it; it isn't a redaction step, the field is absent from the mapping entirely, so there's no path for it to leak into a response.

Every column this page shows -- client, password name, username, shareable flag, type, category, whether OTP is configured (a boolean, never the OTP secret itself), and the last-changed date -- is metadata that IT Glue's own UI shows in a password list view, not the credential.

## Columns

| Column | Source field | Notes |
|---|---|---|
| Client Name | `organization-name` | Present directly on the password record -- no separate organization lookup needed, unlike M365 Environment's Autotask-company mapping. |
| Password Name | `name` | |
| Username | `username` | |
| Shareable | `shareable` | Boolean, shown as Yes/No. |
| Type | `cached-resource-type-name` | What IT Glue resource (if any) this password is attached to, e.g. "Configuration" -- confirmed via real data as the only field that reads as a distinct "type" concept, separate from Category. Blank for a standalone login not linked to any specific asset. |
| Category | `password-category-name` | IT Glue's own password category, e.g. "Active Directory", "Microsoft 365", "Network Device", "Domain/DNS". Can be blank. |
| OTP Configured | `otp-enabled` | Boolean, shown as Yes/No -- whether 2FA/OTP is set up on this credential, never the OTP secret itself. |
| Date Last Changed | `password-updated-at` | Deliberately **not** `updated-at` (which bumps on any field edit, e.g. re-categorizing) -- `password-updated-at` specifically tracks when the password value itself was last changed. |

The password name in each row links to the entry's own IT Glue page (`resource-url`) -- safe to include, it's just a deep link, not the credential.

## Search -- client-side matching, no server-side filter available

IT Glue's `filter[name]` is **exact-match only** for passwords, same limitation confirmed on Organizations elsewhere on this dashboard -- confirmed empirically: `filter[name]=admin` matched only records named literally `"admin"`, not `"M365 Admin"` or `"CK\Administrator"`. Every plausible partial-match syntax was tried against the real API (`%wildcard%`, `*wildcard*`, `filter[name][cont]`, `filter[search]`, a plain `search` param) -- none of them filtered anything; the ones that didn't error just silently returned the full unfiltered 3,621-row set.

So there's no way to push a wildcard search term upstream. Instead, `server.js` fetches the **full** password list (metadata only, via `toRow()`) once, caches it for 10 minutes (`getAllPasswords()`), and matches the search term against each entry's `name` in JS using the dashboard-wide wildcard convention (`matchesWildcard()`, shared from `@dashboard/autotask-client` -- the one thing this page imports from there). A search term is required (no browsing the full unfiltered list) -- this is a "find a specific credential" tool, not a password directory.

## Caching

The full password list is cached once (10-minute TTL, shorter than most pages' 20 -- credential metadata is worth not letting go too stale) and reused across every search, rather than one cache slot per search term -- there's only one real upstream fetch regardless of how many different terms get searched, since IT Glue can't narrow it for us anyway. `force=true` bypasses the cache and re-fetches from IT Glue.
