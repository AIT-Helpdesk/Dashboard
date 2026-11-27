# @dashboard/admin

Dashboard page: a small, tabbed ops console for the dashboard's own infrastructure -- not Autotask data. Two tabs today: **Scheduled Tasks** (what this dashboard's own automation looks like in Windows Task Scheduler, decoded into plain English) and **UDF Name Mapping** (a live cross-check of the Autotask Companies UDFs this dashboard relies on to cross-reference clients in other systems). `package.json` sets no `restrictedTo`, so visibility follows whatever category this page is filed under, the same as any other page.

- `client.js` -- frontend module. Exports `id`, `label`, and `mount(container)`. Renders both tabs with the same `.rmmf-tabs`/`.rmmf-tab` "real browser tab" look as RMM Filter Checks, by request.
- `server.js` -- Express router mounted by the shell at `/api/admin`. One `GET /` builds both tabs in parallel and returns them together.

## Scheduled Tasks

Shells out to `powershell -Command` (via `execFile`) and runs `Get-ScheduledTask -TaskName 'Ambient*'` plus `Get-ScheduledTaskInfo` for each match -- scoped deliberately to just this dashboard's own "Ambient*"-named tasks (confirmed live: a real dev/production box has 200+ unrelated scheduled tasks, this page isn't an OS-wide task auditor). `Get-ScheduledTask`'s structured trigger objects are used rather than `schtasks /query`'s plain-text output specifically because they're what makes a real Weekly/Daily schedule (day-of-week bitmask, repetition interval) decodable at all; `schtasks` just prints "Weekly" with no further detail.

Only Weekly and Daily triggers get a real human-readable description (`describeTrigger()`) -- the only two schedule types this dashboard's own jobs actually use per DEPLOYMENT.md. Anything else (logon/boot/idle/event/session-state triggers) falls back to a plain label. Dates come back from PowerShell in the WCF-era `"/Date(1234567890000)/"` format, not ISO, and are parsed accordingly (`parseWcfDate()`).

The table itself shows only Name and Schedule, by request -- State, Last run (with result code), and Next run are available as a hover tooltip (`title` attribute) on each row rather than their own columns.

This tab only works where PowerShell and Task Scheduler are available, i.e. on Windows. It will not function on a non-Windows host.

## UDF Name Mapping

Cross-checks two sources:

1. The **documented** list of "Name:*" Companies UDFs this dashboard reads/writes to cross-reference a client's identity in another system (e.g. `Name:TPP` holding a TPP Wholesale account reference) -- the authoritative hand-maintained table in `@dashboard/shell/udf-system-matches-db.js`'s own `SEED_ROWS`.
2. A **live** pull of every real `Name:*` UDF currently defined on Companies in Autotask, via `getUserDefinedFieldDefinitions()`.

Any live UDF not present in the documented set is flagged in red ("Not yet documented") rather than silently shown as a normal row -- the intended signal is "someone added a UDF by hand in Autotask and `udf-system-matches-db.js` needs a new entry for it."

## Caching

Neither tab is cached -- every page load/refresh re-runs the PowerShell query and re-fetches the live UDF definitions. `lastData` is kept at module scope in `client.js` so a same-session remount restores the last result instantly before a fresh load replaces it, the same convention most pages on this dashboard use.
