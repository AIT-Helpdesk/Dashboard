# @dashboard/completed-tickets

Dashboard page: pick a date, see every ticket completed that day across all clients, grouped by the technician who closed it.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`, picked up automatically by the shell.
- `server.js` - Express router mounted by the shell at `/api/completed-tickets`.

## Behavior notes

- "Completed" means Autotask ticket status ID 5 (Complete).
- Excludes tickets with issue type 14 ("Monitoring Alert").
- Date filtering uses the ticket's `completedDate` field, compared against UTC calendar-day boundaries for the selected date.
- Resource and company names are resolved via `@dashboard/autotask-client` and cached in memory for the life of the server process.