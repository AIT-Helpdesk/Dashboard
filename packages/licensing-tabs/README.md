# @dashboard/licensing-tabs

Dashboard page: "Licensing" -- a tabbed bundle of the dashboard's Microsoft/Ingram licensing pages, covering all clients, pre-populated from the existing "Licensing" category's own pages. The actual tab-strip mechanism (drag-to-reorder, admin-only add/remove/reorder, the shared permanent-tabs/removed-default-tabs/tab-order settings) lives in `@dashboard/shell`'s `tab-page-client.js`/`tab-page-server.js`, reused by every tabbed page on this dashboard -- see those files for the full implementation, not repeated here.

- `client.js` - calls `createTabbedPageMount()` with this page's own `id`/`label`/`apiBase` and its four default tabs.
- `server.js` - re-exports `createTabPageRouter(__dirname)`.

## Default tabs

- **Ingram Subscriptions** (`ingram-subscriptions`) -- search by client and/or subscription name to see active/pending Ingram Micro licensing; click a client's name to load license counts for their subscriptions on demand.
- **Ingram Orders** (`ingram-orders`) -- pick a date to see Ingram Micro orders placed since then -- new sales, seat changes, cancellations -- every status included by default.
- **M365 Environment** (`m365-environment`) -- type a client name to see their Microsoft 365 tenant snapshot from IT Glue: domains, licenses, and privileged (Global Administrator) role membership.
- **CSP Customers** (`csp-customers`) -- browse or search the full list of CSP customers and their Microsoft tenant IDs, via Microsoft Graph's `/contracts` endpoint.

See each page's own README for the full data-source/caching/matching behaviour of each tab (`packages/ingram-subscriptions/README.md`, `packages/ingram-orders/README.md`, `packages/m365-environment/README.md`, `packages/csp-customers/README.md`) -- this page doesn't change any of them, it just mounts their existing `client.js` module in a tab.
