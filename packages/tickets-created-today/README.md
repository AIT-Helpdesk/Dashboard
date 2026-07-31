# @dashboard/tickets-created-today

Dashboard page: pick a date, see every ticket created that day across all clients, grouped by company.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`, picked up automatically by the shell.
- `server.js` - Express router mounted by the shell at `/api/tickets-created-today`.

## Behavior notes

- Filters on the ticket's `createDate` field, compared against UTC calendar-day boundaries for the selected date. Any status is included (this is about creation, not completion).
- Excludes tickets with issue type 14 ("Monitoring Alert"), same as the Completed Tickets page.
- Company names are resolved via `@dashboard/autotask-client` and cached in memory for the life of the server process.