# @dashboard/test-tracker-tracker

This is leftover test scaffolding, not a real feature anyone uses -- say so plainly rather than writing it up as a finished page.

Both `client.js` and `server.js` are untouched output of **Rollout Tracker Builder** (`packages/rollout-tracker-builder`): the generic rollout-tracker grid mechanism (`@dashboard/shell/rollout-tracker-server.js` / `@dashboard/shell/public/rollout-tracker-client.js`), wired up here with this one tracker's own `rowNoun` ("Thing to track"). Reading its `data.db` directly confirms this: the five rows are named "Client A", "Item B", "Fred Flintstone", "New Thing" and "TEST 4", and the three columns are "Allocated", "Do Step 1" and "Something Else" -- generic placeholder names created in a single few-minute burst on 2026-09-23, with no sign of being touched since. There's no real client, task, or rollout behind any of it.

- `client.js` - thin wrapper around the shared `createRolloutTrackerMount()` grid, pointed at this tracker's own `apiBase`.
- `server.js` - thin wrapper around the shared `createRolloutTrackerRouter()`, scoped to this package's own directory.
- `data.db` (+ `-shm`/`-wal`) - this tracker's own SQLite database (rows, columns, cell statuses, audit log), created the first time the generated `server.js` ran. Holds only the placeholder content described above.

The generic grid mechanism itself -- status cycling, columns, audit log, compound rows -- is documented where it actually lives, in `@dashboard/shell` and in Rollout Tracker Builder's own code; it isn't re-explained here since there's nothing tracker-specific to add.
