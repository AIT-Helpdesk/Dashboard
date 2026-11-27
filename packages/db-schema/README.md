# @dashboard/db-schema

Dashboard page: a read-only structure viewer for every real SQLite database this monorepo itself uses -- a quick way to see what tables/columns/foreign keys/indexes any page's own `.db` file actually has, without opening a separate DB browser tool or reading each page's own `db.js` by hand. Pick a database from a dropdown (grouped by package), then expand any table to see its columns, foreign keys, and indexes; an optional "Show Data" button on each table reveals a capped sample of its actual rows.

- `client.js` -- frontend module. Exports `id`, `label`, and `mount(container)`. Builds the database picker, renders each table as a collapsible `<details>` card, and lazy-loads row data only when a table's own Show Data button is clicked.
- `server.js` -- Express router mounted by the shell at `/api/db-schema`, with `GET /databases`, `GET /databases/:id/schema`, and `GET /databases/:id/tables/:table/rows`.
- `lib.js` -- the actual scan/schema/row-reading logic, split out as plain functions (no Express/session involved) so it can be required and tested directly.

## How databases are found

`lib.js`'s `scanDatabases()` recursively walks the whole `packages/` tree looking for files ending in `.db`, `.sqlite`, or `.sqlite3` (case-insensitive), skipping `node_modules`/`dist`/`build`. SQLite's own WAL/SHM/journal sidecar files (`*.db-wal`, `*.db-shm`, `*.db-journal`) are excluded automatically, just by construction -- they don't end in one of those three extensions. The scan result is cached for 10 minutes; a brand-new database file can take up to that long to show up in the dropdown.

Every database opens through `node:sqlite`'s `DatabaseSync`, deliberately not `better-sqlite3` -- the same "zero new runtime dependencies, no native-binary-on-Windows risk" reasoning every other SQLite-backed page on this dashboard already follows. Every connection here is opened `{ readOnly: true }`, confirmed live to actually throw on a write attempt, not just a UI-level convention.

## Structure only, by request -- with one deliberate exception

Schema results (`GET /databases/:id/schema`) come straight from `PRAGMA table_info`/`foreign_key_list`/`index_list`/`index_info` against `sqlite_master` -- never a `SELECT` against a table's own rows, and never cached (every selection is a fresh read).

The one exception is the per-table **Show Data** button: `GET /databases/:id/tables/:table/rows` does run a real `SELECT * ... LIMIT ?`, capped server-side at 500 rows regardless of what's requested (default 100). The requested table name is validated against that database's own real table list (fresh off `sqlite_master`) before it's ever interpolated into SQL -- never trusted straight off the URL, the same rule the database `id` itself is held to (see below).

## A database `id` is never used to build a filesystem path directly

Every `:id` in a route is matched against the current cached scan's own list (`findDatabase()`) -- never passed through something like `path.join(root, req.params.id)`, which would let a crafted id with `../` segments escape `packages/` entirely. The real filesystem path used for any read is always the one the scan itself already found on disk.
