# @dashboard/at-status

Dashboard page: lists every ticket status Autotask has defined, including the metadata that doesn't show up on any Tickets-listing page elsewhere on this dashboard -- whether it's Active or Inactive, the Default value, whether it's a System status (one Autotask itself defines and won't let you delete), and its sort order in Autotask's own picklist. A straightforward field-metadata lookup, not a report over real ticket volume -- nothing here is scoped to a date range or a client.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`, picked up automatically by the shell.
- `server.js` - Express router mounted by the shell at `/api/at-status`.

## Where the data comes from

`server.js` reads the `status` field straight off Tickets' own `entityInformation/fields` endpoint (`GET .../Tickets/entityInformation/fields`) and keeps just that one field's `picklistValues`. This is the same endpoint `@dashboard/autotask-client`'s shared `getPicklistLabels()` helper also reads, but kept as its own separate call here rather than reused -- that shared helper only returns a bare value-to-label `Map`, and this page's whole point is showing everything else Autotask tracks per status, not just the label.

Cached in-process with no expiry -- this is static Autotask configuration, not per-record data, so a real change to the status picklist only shows up here after the dashboard's dev server is restarted.

## Columns

| Column | Source field |
|---|---|
| ID | `value` |
| Status | `label` |
| Active? | `isActive` |
| Default? | `isDefaultValue` |
| System? | `isSystem` |
| Sort Order | `sortOrder` |

## Active filter

The "Active?" dropdown (Yes / No / All, defaulting to Yes) filters the already-loaded list in the browser -- it never re-fetches from Autotask, since the full status list is already on the page after the first load.
