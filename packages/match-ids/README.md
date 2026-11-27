# @dashboard/match-ids

Dashboard page: for every client with an active or pending Microsoft subscription through Ingram Micro, cross-references three separately-billed/tracked systems in one table -- Ingram Micro's own customer/subscription IDs, that client's real Microsoft 365 tenant ID, and the matching Rewst client record (name + Organisation ID, the field other Rewst webhooks actually need -- see the Rewst Webhook Test page's own comments for why Organisation ID specifically, not the top-level customer `id` or `csp_tenant_id`). Reads from Ingram Micro (`@dashboard/ingram-client`) and Rewst (a fixed webhook call, `axios`) -- no Autotask or Datto involvement at all.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`.
- `server.js` - Express router mounted by the shell at `/api/match-ids`.

## Where the tenant ID actually comes from

Ingram's API never names a field "tenant" anywhere on the list endpoint, subscription detail, or customer endpoint (confirmed live against all three) -- but a subscription's own **detail** endpoint returns a `fulfillmentParameters` array containing one entry named `ms_customer_id`, which IS the real Microsoft tenant ID. Confirmed by cross-checking it against Rewst's own `tenant_id` field for two real clients and getting an identical GUID both times. This is available for every Microsoft-subscription client straight from Ingram, matched to Rewst or not -- unlike Rewst's own `tenant_id`, which is only known for clients Rewst also has a record of. One detail call is made per *client* (using that client's first Microsoft subscription), not per subscription -- confirmed the tenant ID is the same regardless of which of that client's subscriptions it's read off, including a trial subscription.

"Microsoft subscription" means a literal case-insensitive `microsoft` match in the subscription name -- the same reading used by the earlier one-off "Ingram x Rewst Matchup" artifact this page formalizes, deliberately not widened to catch Windows 365/Teams-style names that don't literally say "Microsoft."

## Matching an Ingram client name to a Rewst customer

A four-stage cascade (`matchRewstCustomer()`), each stage tried in order, the first stage with exactly one candidate winning:

1. Exact match on Rewst's `company_name`.
2. Exact match on any of that Rewst customer's `linked_organizations[].name`.
3. Fuzzy substring match (either direction) on `company_name`.
4. Fuzzy substring match (either direction) on a linked organization's name.

More than one candidate at any stage is flagged **ambiguous** (every candidate's name/tenant ID/org ID is returned for a human to pick from) rather than guessed past. No match at any stage is **none** ("NO MATCH"). Name normalization strips apostrophes entirely (not collapsed to a space) -- confirmed live that Ingram's "Sleepys" only matches Rewst's "Sleepy's Pty Ltd" once the apostrophe is gone outright, since "sleepys" vs. "sleepy s" never matches as a substring.

## The four match buckets

Every row lands in exactly one of: **exact** (matched), **fuzzy** (fuzzy match), **ambiguous**, or **none** (no match) -- shown as filterable chips above the table (each with its own count) and as a colored badge per row, plus a "Match Detail" column spelling out either the specific matching rule that fired (e.g. "matched via linked org name") or, for an ambiguous row, every candidate name found.

## Caching

The whole report is cached for 1 hour -- a cold build costs one Ingram subscription-detail call per client (confirmed at 150-250+ real clients) plus one Rewst webhook call, deliberately not something to redo on every page visit. Subscription-detail calls run with bounded concurrency (20 at a time) and retry with exponential backoff on a 429, since Ingram's rate limit here is confirmed to be a time-window budget rather than a concurrency cap. `force=true` (the Refresh button) bypasses the cache and can take a minute or two to complete. The whole result set is sent to the browser in one response and filtered/searched entirely client-side -- no further round trips for typing in the filter box or clicking a bucket chip.
