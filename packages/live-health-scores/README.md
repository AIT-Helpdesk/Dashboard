# @dashboard/live-health-scores

Dashboard page: every current "Tech Cover Elite" Autotask client, each with its own live Overall Health Score, in one sortable table -- so a TAM can see at a glance which clients need attention without opening Live Reports one client at a time. Reads from Autotask (which companies are TC Elite, via `@dashboard/tc-elite-services`) and Datto RMM (devices, asset management/monitoring data, via `@dashboard/datto-rmm`), and reuses `@dashboard/live-reports`' own scoring functions rather than a separate formula.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`.
- `server.js` - Express router mounted by the shell at `/api/live-health-scores`.

## Same scoring formula as Live Reports, by request

The Overall Health Score (and its Workstations/Servers breakdown) is computed by calling straight into `@dashboard/live-reports/server.js`'s own `computeAssetManagementAndMonitoringScores()` and `computeOverallHealth()` -- the exact Device Health 60% / Asset Management 20% / Monitoring 20% formula Live Reports uses for one client at a time, run here for every TC Elite client at once. This replaced an earlier, separate devices-only approximation this page used to have, by request, so the two pages always agree.

## Matching a company to a Datto RMM site, with no human in the loop

Datto RMM has no stored mapping anywhere in this account from an Autotask company to its own site name -- Datto's `siteName` is a third, independent naming system alongside Autotask's and Ingram's own client names. Live Reports sidesteps this by having a human type in the Datto site name per client; this page has no per-row human step, so it auto-matches each TC Elite company's name against every distinct Datto site name using the same normalize-and-match-both-directions convention already in production for Client Summary's Datto EDR location matching (`datto-edr.js`'s `findLocationMatches()`) -- not a new fuzzy-matching approach. One guard added here: a normalized company name under 3 characters requires an exact match rather than a substring match, so a company literally named "IT" or "GH" doesn't `.includes()`-match almost every site name.

A company with no matching Datto site shows up in its own "No Datto RMM Match" section (with `totalDevices`/scores all null) rather than being scored as a misleading 0%.

## Shared-site grouping (franchise collapsing)

Some TC Elite clients share a single real Datto RMM site across several separate Autotask companies, because Datto itself was never set up with one site per location -- confirmed live after a client's 13 separate franchise-store companies all showed up with identical scores: there was really only one Datto site, and therefore one set of real data, behind all 13 rows. `groupBySharedSite()` collapses any rows whose matched site set is identical into one row, labeled "(N locations)", with a tooltip listing every company folded into it. Only rows whose matched sites are an *exact* set match get collapsed -- two unrelated clients that happen to score the same percentage on their own distinct sites are untouched. The collapsed row's name/company link comes from whichever grouped company has no parent company (usually the franchise's head-office/umbrella record), or alphabetically first if none qualifies.

## Sorting

Defaults to worst-score-first (ascending Overall Health Score) so the clients needing attention surface at the top without any interaction -- any column header can be clicked to re-sort, click again to reverse. Rows with a null score (clients with only one device type, so Workstations or Servers has nothing to show) always sort to the bottom regardless of direction, so reversing the sort doesn't make "no servers" jump to the top.

## Caching

Devices (from Datto RMM) and the TC Elite company list (from Autotask) are each cached independently for 20 minutes, with in-flight de-duplication -- the same convention every other Datto RMM-backed page on this dashboard uses, deliberately its own cache instance rather than shared with Live Reports/Check Client/Meeting Prep. `force=true` bypasses both.
