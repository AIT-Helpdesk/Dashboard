# @dashboard/rmm-filters

Dashboard page: checks the membership of the three Datto RMM saved filters this MSP actually relies on for Tech Cover tiering ("TC Elite Servers Filter", "TC Elite Workstations Filter", "TC ESS Workstations Filter") against the real set of Autotask clients that classification says *should* be in each one -- flagging clients Missing from a filter, sites Wrongly Included in one, and (for completeness) the clients Correctly Present. Reads from Datto RMM (`@dashboard/datto-rmm`, filters/sites/devices) and Autotask (`@dashboard/autotask-client`, company classification + the "Name:Datto RMM" UDF); Allowed Exceptions are stored in the central shell database, not here.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`.
- `server.js` - Express router mounted by the shell at `/api/rmm-filters`, plus `getRmmFilters()` exported directly (in-process reuse) for `@dashboard/whats-on`'s own "Today's Brief" box.

## The three filters checked, and what each targets

Matched by **name**, not Datto RMM filter ID -- a filter renamed/recreated on Datto's side just logs a warning and omits that tab rather than breaking the page:

| Filter | Target Autotask Classification | Device categories it's about |
|---|---|---|
| TC Elite Servers Filter | Tech Cover Elite | Server |
| TC Elite Workstations Filter | Tech Cover Elite | Desktop, Laptop |
| TC ESS Workstations Filter | Tech Cover Essentials | Desktop, Laptop |

## Resolving a Datto RMM site to its real Autotask company

A Datto RMM site's name doesn't always exactly match its Autotask company name (e.g. "Sleepy's Caringbah" is one of several real stores under the "Sleepy's" company). Three sources are tried in priority order:

1. **Datto RMM's own native PSA Company link** for the site (`autotaskCompanyId` on `/v2/account/sites`) -- the most authoritative source, resolved by **ID**, not Datto's own cached company name. Confirmed live this session that the cached name can go stale: a real site's PSA link still pointed at a long-disabled company even though its live replacement existed in Autotask under a different name -- resolving by id survives that drift even though it can't fix a genuinely stale PSA link on Datto's own side.
2. This dashboard's own hand-maintained mapping -- the "Name:Datto RMM" Company UDF (semicolon-separated for a company with multiple Datto sites).
3. An exact site-name == company-name guess, as a last resort.

## The three result sections (and why "Missing" excludes some genuine non-matches)

- **Missing** -- an active customer/prospect company with the right classification that has no site in the filter at all. **Not** flagged Missing if the company has devices elsewhere in Datto RMM but genuinely none of the device category this filter is about (confirmed live: 48 of 50 initially-flagged "missing" Servers-filter companies turned out to have zero real Server-category devices anywhere on the account -- not an actual gap). A company with **no devices in Datto RMM at all** is deliberately *not* excluded by that same check -- flagging a brand-new/pending client as Missing is what prompts adding their site to the filter ahead of their first real device, and it also means a client whose devices are being mis-attributed elsewhere (e.g. a stale PSA link) surfaces here instead of silently vanishing from the whole report.
- **Wrongly Included** -- a site in the filter whose resolved company's classification doesn't match the filter's target (or that resolves to no company at all, e.g. a non-customer site like "Ambient iT" itself, confirmed live as a real filter member).
- **Correct** -- a site in the filter whose resolved company's classification matches, shown for completeness (no Allowed Exceptions concept on this section).

## Allowed Exceptions

Missing and Wrongly Included rows can each be marked an Allowed Exception (small checkmark icon per row) to stop them cluttering the main list -- stored in the shell's own SQLite database (`@dashboard/shell/rmm-filter-exceptions-db.js`), keyed by filter name + sub-tab + a `subjectKey` (`company:<id>` when a real company resolved, `site:<siteName>` as a fallback for an unresolved Wrongly-Included site). Exceptions are applied **fresh on every request**, deliberately outside the expensive cache described below -- marking or removing one takes effect on the very next load regardless of how long is left on the 15-minute cache, since it's a cheap local SQLite read, not a Datto/Autotask re-fetch.

## Caching

The expensive Datto RMM/Autotask build (a full per-filter device list -- up to ~700+ real devices for the largest filter -- plus a full company pull) is cached for 15 minutes with in-flight de-duplication. `force=true` bypasses it. The Allowed Exceptions split is never part of this cached blob, for the reason above.
