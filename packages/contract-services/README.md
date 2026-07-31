# @dashboard/contract-services

Dashboard page: search for a service by name (with * wildcards) and pick a month, see every matching, active service item whose billing period starts in that month, on active contracts only. Grouped by company.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`, picked up automatically by the shell.
- `server.js` - Express router mounted by the shell at `/api/contract-services`.

## Data model

Autotask spreads this across three entities, joined here in application code (the REST API has no cross-entity joins):

- **Contracts** - filtered to `status = 1` (Active).
- **Services** - the service catalog. Filtered to `isActive = true` and, if a search term is given, by name.
- **ContractServiceUnits** - the per-period record of how many units of a service were active on a contract, with its own `startDate`/`endDate`. Filtered to units whose `startDate` falls within the selected calendar month.

A result row exists only where all three line up: the contract is active, the service is active (and matches the search), and a ContractServiceUnits row for that contract+service has a `startDate` in the selected month.

## Last Changed column

`ContractServiceUnits` has no modification timestamp of its own (Autotask doesn't track that at the line-item level). The "Last Changed" column shows the parent **Contract**'s `lastModifiedDateTime` instead - the closest thing available, but it reflects changes to the contract record generally, not specifically to that service/period line.

## Search syntax

- No `*` - substring match (same as `*term*`).
- `term*` - starts with.
- `*term` - ends with.
- `*term*` - contains.
- Blank - all active services.