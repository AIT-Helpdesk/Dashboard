# @dashboard/contract-mgmt-tabs

Dashboard page: "Contract Mgmnt" -- a tabbed bundle of the pages used to review and process contract-related changes (Ingram order changes, today), pre-populated from the existing "Update Contracts" category's own pages. The actual tab-strip mechanism (drag-to-reorder, admin-only add/remove/reorder, the shared permanent-tabs/removed-default-tabs/tab-order settings) lives in `@dashboard/shell`'s `tab-page-client.js`/`tab-page-server.js`, reused by every tabbed page on this dashboard -- see those files for the full implementation, not repeated here.

- `client.js` - calls `createTabbedPageMount()` with this page's own `id`/`label`/`apiBase` and its seven default tabs.
- `server.js` - re-exports `createTabPageRouter(__dirname)`.

## Default tabs

- **Contract Checks** (`contract-checks`) -- the working checklist for contract changes. Every Ingram subscription order/termination is synced into its own database and checked off field by field (Contract, M365 OK, TC ELITE, TC ESS, OTHERS, ALL DONE) as it's confirmed -- the one tab here that actually tracks who reviewed what and when, with a full audit log and a Change Report.
- **Check Client** (`check-client`) -- a combined, read-only lookup of Orders, Subscriptions, and Contract Services for one client, so the other tabs don't need to be visited separately just to check one client.
- **Contract Services** (`contract-services-update-contracts`) -- pick a month (optionally filter by client/service name) to see every active contract service/bundle item billed that month.
- **Ingram Subscriptions** (`ingram-subscriptions-update-contracts`) -- search by client and/or subscription name to see active/pending Ingram Micro licensing.
- **Ingram Orders** (`ingram-orders-update-contracts`) -- pick a date to see Ingram Micro orders placed since then.
- **Match IDs** (`match-ids`) -- every client with a Microsoft subscription through Ingram Micro, matched against the dashboard's Rewst customer list (exact / fuzzy / ambiguous / no match), so a wrong or missing Rewst link can be found and fixed.
- **Product Mappings** (`product-mappings`) -- the admin-maintained table of Ingram Micro products mapped to a real Microsoft SKU and/or Autotask contract service/invoice name; feeds Contract Checks' and Check Client's own product matching elsewhere on this dashboard. Columns are generated from the underlying database schema rather than hardcoded; non-managers get a read-only view, managers can add/edit/delete rows.

## Three of these tabs are second sidebar entries, not separate pages

`contract-services-update-contracts`, `ingram-subscriptions-update-contracts`, and `ingram-orders-update-contracts` have no code of their own -- each is a second sidebar entry pointing at `packages/contract-services`, `packages/ingram-subscriptions`, and `packages/ingram-orders` respectively, by request ("also a copy of these... don't remove them from where they are, just create a copy"). See `packages/ingram-orders-update-contracts/README.md` for the full explanation of why this pattern exists. Their real data/semantics are documented in the original pages' own READMEs (`packages/contract-services/README.md`, `packages/ingram-subscriptions/README.md`, `packages/ingram-orders/README.md`); this page doesn't change any of their behaviour.
