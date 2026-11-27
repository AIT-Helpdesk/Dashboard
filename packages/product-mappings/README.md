# @dashboard/product-mappings

Dashboard page: view and edit the real `product_mappings` table that `@dashboard/contract-checks` uses for its own Ingram Micro product ↔ Microsoft SKU / Autotask contract-service-or-invoice-name matching elsewhere on this dashboard (Contract Checks, Check Client). This page is a plain front end over that table -- `@dashboard/contract-checks/db.js` is the real source of truth; there's no separate data store here.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`.
- `server.js` - Express router mounted by the shell at `/api/product-mappings`.

## Columns and form fields are generated from the real table structure

Both the list view's columns and the Add/Edit modal's form fields are built entirely from `@dashboard/contract-checks/db.js`'s own `getProductMappingColumns()` (name/label/required/unique/inputType per column), sent down on every `GET /`. There is no second, hardcoded column list in this package -- a column added to `product_mappings` later shows up here automatically, with its input rendered as text/number/a Yes-No dropdown depending on that column's own `inputType`.

## Permissions

Reading the table is open to anyone who can reach this page. Creating, editing, and deleting a mapping is gated server-side to a Contract Manager (`@dashboard/shell/contract-manager-permissions.js`'s `isContractManager()` -- the same allow-list Check Client's own "adjust contract units" feature uses), checked independently on every write route regardless of whether the client's own UI happens to show the Add/Edit/Delete controls. A non-manager never sees those controls at all (`isManager` from the server hides them client-side), but the server-side check is what actually enforces it.
