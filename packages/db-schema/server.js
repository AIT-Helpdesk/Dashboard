const express = require('express');
const { getCachedScan, getSchema, getTableRows } = require('./lib.js');

// Read-only database structure viewer, by request -- a quick way to see
// what tables/columns/foreign keys/indexes any of this monorepo's own
// SQLite files actually have, without opening a DB browser tool or
// reading each page's own db.js by hand. Deliberately node:sqlite
// (DatabaseSync), not better-sqlite3 -- same "zero new runtime
// dependencies, no native-binary-on-Windows risk" reasoning every other
// SQLite-backed page on this dashboard already follows (TC Elite
// Rollout/Workshop/Contract Checks/Rollout Tracker Builder's own db.js
// files). Confirmed live this session: `new DatabaseSync(path, {
// readOnly: true })` opens fine and a write against it throws "attempt
// to write a readonly database" -- that's the real enforcement, not
// just a UI convention. See lib.js for the actual scan/schema logic --
// this file is just the HTTP wiring around it.
const router = express.Router();

router.get('/databases', (req, res) => {
  try {
    const { databases, scannedAt } = getCachedScan();
    res.json({ databases: databases.map((d) => ({ id: d.id, packageDir: d.packageDir, relativePath: d.relativePath })), scannedAt });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// `id` must be an EXACT match against the current cached scan's own list
// -- never trusted to build a filesystem path directly (path.join(root,
// req.params.id) would let a crafted id with "../" segments escape
// packages/ entirely). The real path used is always the one the scan
// itself already found on disk, never derived from request input.
function findDatabase(id) {
  const { databases } = getCachedScan();
  return databases.find((d) => d.id === id);
}
const UNKNOWN_DB_ERROR = 'Unknown database. It may have been added after the last scan -- try again shortly (scan refreshes every 10 minutes).';

router.get('/databases/:id/schema', (req, res) => {
  try {
    const match = findDatabase(req.params.id);
    if (!match) return res.status(404).json({ error: UNKNOWN_DB_ERROR });
    const schema = getSchema(match.fullPath);
    res.json(schema);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Show Data, by request -- the one place on this page that reads real
// row data rather than just structure. Still read-only (getTableRows'
// own connection is `{ readOnly: true }`, same as every other read
// here), and still never trusts request input directly: `:table` is
// checked against THIS database's own real table list inside
// getTableRows() before it's interpolated into any SQL, same "validate
// against the real list, never trust the request" rule :id already
// follows one level up.
router.get('/databases/:id/tables/:table/rows', (req, res) => {
  try {
    const match = findDatabase(req.params.id);
    if (!match) return res.status(404).json({ error: UNKNOWN_DB_ERROR });
    const result = getTableRows(match.fullPath, req.params.table, req.query.limit);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
