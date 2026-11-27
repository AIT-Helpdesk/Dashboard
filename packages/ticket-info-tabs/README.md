# @dashboard/ticket-info-tabs

Dashboard page: "Ticket Info" -- the original tabbed-page experiment on this dashboard (the shared mechanism every tabbed page now uses was extracted out of what was originally this page's own `client.js`). Instead of four separate sidebar entries, it mounts all four as tabs, each one the real underlying page's own `client.js` module, unmodified. The shared mechanism itself (drag-to-reorder, admin-only add/remove/reorder, the permanent-tabs/removed-default-tabs/tab-order settings) now lives in `@dashboard/shell`'s `tab-page-client.js`/`tab-page-server.js` -- see those files for the full implementation, not repeated here.

- `client.js` - calls `createTabbedPageMount()` with this page's own `id`/`label`/`apiBase` and its four default tabs.
- `server.js` - re-exports `createTabPageRouter(__dirname)`.

## Default tabs

Each tab shows Autotask ticket activity for a chosen day or week -- a fast daily check rather than a full report.

- **Asked for Review** (`asked-for-review`) -- pick a week to see which tickets had a Google review request sent (the "Ask For Review" ticket UDF), broken out one section per day, so it can be followed up.
- **Tickets Created** (`tickets-created-today`) -- pick a date to see every ticket created that day, grouped by client.
- **Completed Tickets** (`completed-tickets`) -- pick a date to see every ticket completed that day, grouped by the technician who closed it, with logged hours and $ value per ticket.
- **Ticket Times** (`ticket-times`) -- pick a date to see every ticket with time logged against it that day, grouped by the technician who logged it.

See each page's own README for the full definitions used (what counts as "completed", the Monitoring-Alert exclusion, AEST day boundaries, etc.) -- this page doesn't change any of them, it just mounts their existing `client.js` module in a tab.

## A fifth default tab was removed

`times` ("Time Summaries") used to be a fifth default tab here. It was removed when that page moved into the admin-only "Builders" category and picked up its own `restrictedTo`. `createTabbedPageMount()`'s own default tabs render unconditionally (unlike dragged-in/permanent tabs, which are filtered against the live page registry), so leaving a now-restricted page in this list would have shown every non-admin viewer a tab whose `client.js`/API 404s the moment they click it.
