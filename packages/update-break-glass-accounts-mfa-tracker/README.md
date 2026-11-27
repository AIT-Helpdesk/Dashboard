# @dashboard/update-break-glass-accounts-mfa-tracker

A real, actively-used **Rollout Tracker** (built via Rollout Tracker Builder -- see `packages/rollout-tracker-builder` and `@dashboard/shell/rollout-tracker-server.js` for the generic grid mechanism this page is generated from) tracking the rollout of Microsoft 365 break-glass accounts and baseline MFA/Conditional Access hardening across every real client. Confirmed directly against `data.db`: 370 rows, one per real client company name (e.g. "A B W Industries", "A Grade Plumbing", "Absolute Books" -- a genuine client list, not placeholder names), over 2,600 audit-log entries recording real status changes since 2026-09-23. This is the genuine article, not test scaffolding.

- `client.js` - thin wrapper around the shared `createRolloutTrackerMount()` grid, pointed at this tracker's own `apiBase` ("Client" is this tracker's own `rowNoun`).
- `server.js` - thin wrapper around the shared `createRolloutTrackerRouter()`, scoped to this package's own directory.
- `data.db` (+ `-shm`/`-wal`) - this tracker's own SQLite database: one row per client, plus the columns below, cell statuses, and a full audit log of every status change.

## Columns

Six status columns, each tracked independently per client rather than one blanket "done" flag, since a client can be partway through this rollout:

- **Security Defaults**
- **Conditional Access Policies**
- **Authentication Methods**
- **Registration Campaigns**
- **M365 Global Admin**
- **Break Glass**

Each is one of this dashboard's standard status cells (not-done / started / done / na / cancelled, with an optional free-text reason) -- the generic cycling/editing mechanism is the same one every rollout tracker uses and is documented in `@dashboard/shell`, not repeated here.
