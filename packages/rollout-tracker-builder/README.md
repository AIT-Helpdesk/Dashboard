# @dashboard/rollout-tracker-builder

Dashboard page: creates a brand-new rollout tracker -- a status grid like TC Elite Rollout, with a typed list of rows (often clients, but the row's own "noun" is configurable) down the left and a typed list of columns (the required actions) across the top. Every cell starts as Not Done and can be set to Started, Done, N/A, Cancelled, Issue, or Note (which requires a comment), with a full audit trail, via the shared tracker mechanism every tracker built this way uses.

- `client.js` -- frontend module. Exports `id`, `label`, and `mount(container)`. Renders the builder form (name, row-noun, newline-separated rows, newline-separated columns) and hides it behind a plain notice for anyone who isn't a Tracker Manager.
- `server.js` -- Express router mounted by the shell at `/api/rollout-tracker-builder`, with `GET /can-publish` and `POST /publish`.

## Who can create one

Creating a new tracker is restricted to a **Tracker Manager** (`isTrackerManager()`, from `@dashboard/shell/rollout-tracker-permissions.js`, driven by `TRACKER_MANAGER` in `.env`) -- not the dashboard admin gate used elsewhere. `client.js` calls `GET /can-publish` up front to hide the form entirely for a non-manager, but the real enforcement is `POST /publish`'s own 403; the client-side hide is just a UX nicety. By contrast, *using* an already-created tracker (editing cells, adding a row) is open to the whole service team, same as TC Elite Rollout itself -- only creating a new tracker, adding a column to an existing one, and moving a tracker between "Trackers" and "Trackers - Complete" are Tracker Manager / admin actions.

## What publishing actually does

`POST /publish` writes a new sibling package under `packages/<slug>-tracker/` (slug derived from the tracker name, with a `-tracker` suffix), containing:

- `package.json` -- `dashboardPage: { id, label, client: 'client.js', server: 'server.js' }`, no `restrictedTo`.
- `client.js` -- a thin generated wrapper around `createRolloutTrackerMount()` from the dashboard-wide `/rollout-tracker-client.js`, the shared grid/status-editing UI every tracker built this way reuses.
- `server.js` -- a one-line generated wrapper around `createRolloutTrackerRouter()` from `@dashboard/shell/rollout-tracker-server.js`, the shared API every such tracker's own `/api/<slug>-tracker` mounts.

It then opens that tracker's own `data.db` directly (via `createRolloutTrackerDb()`) and seeds every typed row and column, attributed to whichever Tracker Manager ran the builder -- never an unattributed write. Rows seeded this way are always the plain `'simple'` kind (no sub-rows); columns are always `'simple'`/`'status'` with no initial stages. Either kind can be upgraded to something more structured afterward through that tracker's own Add Row/Add Column controls.

Finally it calls `registerPage()` (live immediately, no restart) and files the new page straight into the shared **"Trackers"** sidebar category (created if it doesn't exist yet) rather than leaving it at the sidebar root -- unlike every other page-generating builder on this dashboard, by request, so trackers accumulate in one place and "Hide Complete" has a real "Trackers - Complete" category to move a finished one into.

## Collision handling

Publishing is refused with a 409 if a package directory with the same slug already exists on disk, or if a page with that id is already in the live `pages` registry -- covering a same-session re-publish that hasn't restarted yet, same check every other builder on this dashboard uses.
