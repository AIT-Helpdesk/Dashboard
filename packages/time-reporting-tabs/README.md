# @dashboard/time-reporting-tabs

Dashboard page: "Time reporting" -- a tabbed bundle of the dashboard's two staff time-tracking reports. Generated the same way as every other tabbed page on this dashboard. The actual tab-strip mechanism (drag-to-reorder, admin-only add/remove/reorder, the shared permanent-tabs/removed-default-tabs/tab-order settings) lives in `@dashboard/shell`'s `tab-page-client.js`/`tab-page-server.js` -- see those files for the full implementation, not repeated here.

- `client.js` - calls `createTabbedPageMount()` with this page's own `id`/`label`/`apiBase` and its two default tabs.
- `server.js` - re-exports `createTabPageRouter(__dirname)`.

## Default tabs

- **Time Summaries** (`times` -- the package/route/id all stayed `times`, only the on-page/sidebar label reads "Time Summaries") -- pick a date range and see an Hours Summary (Normal/Leave/Public Holiday/Total/Ticket hours per resource), an AITTIME (internal, non-client time) breakdown, several client-contract hours/billable breakdowns, and an on-demand Work-Type Reconciliation section. A large, heavily real-data-driven page -- see `packages/times/README.md` for the full set of tables and reconciliation checks, including the Team selector and the per-resource Normal Hours overrides.
- **Accrued Time** (`accrued-time`, on-page heading "Accrued Time Checker") -- pick a date range (plus optional Resource/Ticket # filters) to see which tickets have `Accrue-`-prefixed work-type time logged against them, split into Complete/Not Complete lists, with a red/yellow flag on any ticket whose `Accrue--END`-family time doesn't reconcile against its `Accrue--ING` time. See `packages/accrued-time/README.md` for the full column/bucket/reconciliation detail.

See each page's own README for the full behaviour of each tab -- this page doesn't change either of them, it just mounts their existing `client.js` module in a tab.
