# @dashboard/contract-services

Dashboard page: search for a service by name (with * wildcards) and pick a month, see every matching, active service item active during that month, on active contracts only. Grouped by company.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`, picked up automatically by the shell.
- `server.js` - Express router mounted by the shell at `/api/contract-services`.

## Data model

Autotask spreads this across three entities, joined here in application code (the REST API has no cross-entity joins):

- **Contracts** - filtered to `status = 1` (Active).
- **Services** - the service catalog. Filtered to `isActive = true` and, if a search term is given, by name.
- **ContractServiceUnits** - the per-period record of how many units of a service were active on a contract, with its own `startDate`/`endDate`.

A result row exists only where all three line up: the contract is active, the service is active (and matches the search), and a ContractServiceUnits row for that contract+service qualifies for the selected month under the rule below.

## Month-matching rule

A unit is included if either:

- its period **starts** in the selected month (covers monthly services, and any longer-period service that happens to kick off this month), or
- it **started before** the month and is still running (`endDate >= monthStart`), **and** its period is **longer than a month** (`endDate - startDate > 35 days`).

The second condition is what picks up quarterly, semi-annual, and annual contracts that were already active going into the selected month. It deliberately excludes short monthly periods that merely spill a day or two into the month from an earlier start (a period has to be genuinely longer than ~35 days to qualify), so a normal monthly service never gets double-counted across two months.

## Last Changed column

`ContractServiceUnits` has no modification timestamp of its own (Autotask doesn't track that at the line-item level). The "Last Changed" column shows the parent **Contract**'s `lastModifiedDateTime` instead - the closest thing available, but it reflects changes to the contract record generally, not specifically to that service/period line. It's shown in red/bold when more than a month old.

## Search syntax

- No `*` - substring match (same as `*term*`).
- `term*` - starts with.
- `*term` - ends with.
- `*term*` - contains.
- Blank - all active services.