// Shared, generic rollout-tracker datastore factory -- extracted from
// tc-elite-rollout's own db.js (that page keeps its own independent copy,
// untouched, with its own compound-column/stages feature this shared
// engine deliberately does not replicate -- Rollout Tracker Builder only
// ever needs one status per cell, no sub-stage breakdown). Each generated
// tracker package calls createRolloutTrackerDb(path.join(__dirname,
// 'data.db')) once, at require time, from its own thin server.js -- same
// "one process-lifetime DatabaseSync per page" shape tc-elite-rollout uses.
const { DatabaseSync } = require('node:sqlite');

function createRolloutTrackerDb(dbPath) {
  const db = new DatabaseSync(dbPath);

  // WAL, not the default rollback journal -- same reasoning as
  // tc-elite-rollout/db.js: concurrent staff edits are the whole point,
  // and WAL lets readers and a writer proceed without readers blocking on
  // a writer's lock.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  // Generalised rows/columns (not clients/columns) -- `rowNoun` (e.g.
  // "Client", "Project", "Site") only ever affects display copy in
  // rollout-tracker-client.js; the schema itself stays generic. No
  // stages/stage_status tables at all -- every column here is what
  // tc-elite-rollout would call "simple".
  db.exec(`
    CREATE TABLE IF NOT EXISTS rows (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      created_by_email TEXT NOT NULL,
      created_by_name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS columns (
      id INTEGER PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      created_by_email TEXT NOT NULL,
      created_by_name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cell_status (
      row_id INTEGER NOT NULL REFERENCES rows(id),
      column_id INTEGER NOT NULL REFERENCES columns(id),
      status TEXT NOT NULL CHECK (status IN ('not_done','started','done','na','cancelled','issue','note')),
      reason TEXT,
      updated_at TEXT NOT NULL,
      updated_by_email TEXT NOT NULL,
      updated_by_name TEXT NOT NULL,
      PRIMARY KEY (row_id, column_id)
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY,
      changed_at TEXT NOT NULL,
      changed_by_email TEXT NOT NULL,
      changed_by_name TEXT NOT NULL,
      row_id INTEGER,
      column_id INTEGER,
      old_status TEXT,
      new_status TEXT,
      old_reason TEXT,
      new_reason TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_audit_cell ON audit_log(row_id, column_id, changed_at);
  `);

  function nowIso() {
    return new Date().toISOString();
  }

  // `actor` is always { email, name } -- req.session.user, same shape
  // every page on this dashboard already reads it in (requireAuth
  // guarantees a signed-in session before any generated tracker's router
  // ever runs).
  function recordAudit({ rowId = null, columnId = null, oldStatus = null, newStatus = null, oldReason = null, newReason = null, actor }) {
    db.prepare(
      `INSERT INTO audit_log (changed_at, changed_by_email, changed_by_name, row_id, column_id, old_status, new_status, old_reason, new_reason)
       VALUES ($changedAt, $email, $name, $rowId, $columnId, $oldStatus, $newStatus, $oldReason, $newReason)`
    ).run({
      $changedAt: nowIso(),
      $email: actor.email,
      $name: actor.name,
      $rowId: rowId,
      $columnId: columnId,
      $oldStatus: oldStatus,
      $newStatus: newStatus,
      $oldReason: oldReason,
      $newReason: newReason,
    });
  }

  // Seeds not_done for one newly-added row across every EXISTING column --
  // mirrors tc-elite-rollout's own seedNewClient() (simple-column branch
  // only). Runs inside a transaction so a half-seeded row is never left
  // behind by a crash partway through.
  function seedNewRow(rowId, actor) {
    db.exec('BEGIN');
    try {
      const columns = db.prepare('SELECT id FROM columns').all();
      for (const col of columns) {
        db.prepare(
          `INSERT INTO cell_status (row_id, column_id, status, updated_at, updated_by_email, updated_by_name)
           VALUES ($rowId, $columnId, 'not_done', $updatedAt, $email, $name)`
        ).run({ $rowId: rowId, $columnId: col.id, $updatedAt: nowIso(), $email: actor.email, $name: actor.name });
        recordAudit({ rowId, columnId: col.id, newStatus: 'not_done', actor });
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // Seeds not_done for one newly-added column across every EXISTING row --
  // the column-based mirror of seedNewRow() above.
  function seedNewColumn(columnId, actor) {
    db.exec('BEGIN');
    try {
      const rows = db.prepare('SELECT id FROM rows').all();
      for (const row of rows) {
        db.prepare(
          `INSERT INTO cell_status (row_id, column_id, status, updated_at, updated_by_email, updated_by_name)
           VALUES ($rowId, $columnId, 'not_done', $updatedAt, $email, $name)`
        ).run({ $rowId: row.id, $columnId: columnId, $updatedAt: nowIso(), $email: actor.email, $name: actor.name });
        recordAudit({ rowId: row.id, columnId, newStatus: 'not_done', actor });
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // Adds one row (name required, unique), seeding not_done across every
  // existing column. Returns the new row id, or null if the name is
  // already taken (caller returns 409).
  function addRow(name, actor) {
    const existing = db.prepare('SELECT id FROM rows WHERE name = ?').get(name);
    if (existing) return null;
    const info = db
      .prepare(
        `INSERT INTO rows (name, created_at, created_by_email, created_by_name)
         VALUES ($name, $createdAt, $email, $name2)`
      )
      .run({ $name: name, $createdAt: nowIso(), $email: actor.email, $name2: actor.name });
    const rowId = Number(info.lastInsertRowid);
    seedNewRow(rowId, actor);
    return rowId;
  }

  // Adds one column (label required; key derived by the caller via
  // uniqueKey(slugify(label), ...), same convention as tc-elite-rollout's
  // own POST /columns), seeding not_done across every existing row.
  // Returns the new column id.
  function addColumn(label, key, actor) {
    const sortRow = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS maxSort FROM columns').get();
    const sortOrder = sortRow.maxSort + 1;
    const info = db
      .prepare(
        `INSERT INTO columns (key, label, sort_order, created_at, created_by_email, created_by_name)
         VALUES ($key, $label, $sortOrder, $createdAt, $email, $name)`
      )
      .run({ $key: key, $label: label, $sortOrder: sortOrder, $createdAt: nowIso(), $email: actor.email, $name: actor.name });
    const columnId = Number(info.lastInsertRowid);
    recordAudit({ columnId, newStatus: null, actor });
    seedNewColumn(columnId, actor);
    return columnId;
  }

  // Single-cell edit. Returns the { status, reason } written, or null if
  // no such row/column cell exists (caller returns 404).
  function setCell(rowId, columnId, status, reason, actor) {
    const existing = db.prepare('SELECT status, reason FROM cell_status WHERE row_id = ? AND column_id = ?').get(rowId, columnId);
    if (!existing) return null;
    db.prepare(
      `UPDATE cell_status SET status = $status, reason = $reason, updated_at = $updatedAt, updated_by_email = $email, updated_by_name = $name
       WHERE row_id = $rowId AND column_id = $columnId`
    ).run({ $status: status, $reason: reason, $updatedAt: nowIso(), $email: actor.email, $name: actor.name, $rowId: rowId, $columnId: columnId });
    recordAudit({ rowId, columnId, oldStatus: existing.status, newStatus: status, oldReason: existing.reason, newReason: reason, actor });
    return { status, reason };
  }

  // Sets every column's cell for one row to the same status/reason --
  // mirrors tc-elite-rollout's own bulkSetCells(). Returns the affected
  // column ids.
  function bulkSetRow(rowId, status, reason, actor) {
    const columns = db.prepare('SELECT id FROM columns').all();
    db.exec('BEGIN');
    try {
      for (const col of columns) {
        const existing = db.prepare('SELECT status, reason FROM cell_status WHERE row_id = ? AND column_id = ?').get(rowId, col.id);
        if (!existing) continue;
        db.prepare(
          `UPDATE cell_status SET status = $status, reason = $reason, updated_at = $updatedAt, updated_by_email = $email, updated_by_name = $name
           WHERE row_id = $rowId AND column_id = $columnId`
        ).run({ $status: status, $reason: reason, $updatedAt: nowIso(), $email: actor.email, $name: actor.name, $rowId: rowId, $columnId: col.id });
        recordAudit({ rowId, columnId: col.id, oldStatus: existing.status, newStatus: status, oldReason: existing.reason, newReason: reason, actor });
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return columns.map((c) => c.id);
  }

  // Sets one column's cell for a set of rows (or every row, if `rowIds` is
  // null) to the same status/reason -- mirrors tc-elite-rollout's own
  // bulkSetColumnCells(). Returns the affected row ids.
  function bulkSetColumn(columnId, status, reason, actor, rowIds = null) {
    const rows = rowIds ? rowIds.map((id) => ({ id })) : db.prepare('SELECT id FROM rows').all();
    db.exec('BEGIN');
    try {
      for (const row of rows) {
        const existing = db.prepare('SELECT status, reason FROM cell_status WHERE row_id = ? AND column_id = ?').get(row.id, columnId);
        if (!existing) continue;
        db.prepare(
          `UPDATE cell_status SET status = $status, reason = $reason, updated_at = $updatedAt, updated_by_email = $email, updated_by_name = $name
           WHERE row_id = $rowId AND column_id = $columnId`
        ).run({ $status: status, $reason: reason, $updatedAt: nowIso(), $email: actor.email, $name: actor.name, $rowId: row.id, $columnId: columnId });
        recordAudit({ rowId: row.id, columnId, oldStatus: existing.status, newStatus: status, oldReason: existing.reason, newReason: reason, actor });
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return rows.map((r) => r.id);
  }

  // Renames a row -- mirrors tc-elite-rollout's own renameClient(). Dedupe
  // check (excluding self) is the caller's job, same convention as
  // tc-elite-rollout/server.js's own PATCH /clients/:clientId/name.
  function renameRow(rowId, newName, actor) {
    const row = db.prepare('SELECT name FROM rows WHERE id = ?').get(rowId);
    if (!row) return null;
    db.prepare('UPDATE rows SET name = $name WHERE id = $id').run({ $name: newName, $id: rowId });
    recordAudit({ rowId, oldStatus: row.name, newStatus: newName, actor });
    return newName;
  }

  // Hard delete -- same reasoning as tc-elite-rollout's own deleteClient():
  // for removing a mistaken/test row, not recording a real one's removal.
  function deleteRow(rowId) {
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM audit_log WHERE row_id = ?').run(rowId);
      db.prepare('DELETE FROM cell_status WHERE row_id = ?').run(rowId);
      db.prepare('DELETE FROM rows WHERE id = ?').run(rowId);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // The master grid -- every row x every column's current status, shaped
  // the same way tc-elite-rollout/server.js's own GET / already shapes
  // its response (columns[], rows with a `cells` map keyed by column id).
  function getGrid() {
    const columns = db.prepare('SELECT * FROM columns ORDER BY sort_order, id').all();
    const rowRows = db.prepare('SELECT * FROM rows ORDER BY name COLLATE NOCASE').all();
    const cellRows = db.prepare('SELECT * FROM cell_status').all();
    const cellsByRow = new Map();
    for (const cell of cellRows) {
      if (!cellsByRow.has(cell.row_id)) cellsByRow.set(cell.row_id, {});
      cellsByRow.get(cell.row_id)[cell.column_id] = { status: cell.status, reason: cell.reason };
    }
    const rows = rowRows.map((r) => ({ id: r.id, name: r.name, cells: cellsByRow.get(r.id) || {} }));
    return { columns: columns.map((c) => ({ id: c.id, key: c.key, label: c.label })), rows, totalRows: rows.length };
  }

  // Last 200 audit rows for one cell, most recent first -- mirrors
  // tc-elite-rollout's own GET /cells/:clientId/:columnId/history.
  function getCellHistory(rowId, columnId) {
    return db
      .prepare('SELECT * FROM audit_log WHERE row_id = ? AND column_id = ? ORDER BY changed_at DESC LIMIT 200')
      .all(rowId, columnId);
  }

  return {
    db,
    nowIso,
    recordAudit,
    seedNewRow,
    seedNewColumn,
    addRow,
    addColumn,
    setCell,
    bulkSetRow,
    bulkSetColumn,
    renameRow,
    deleteRow,
    getGrid,
    getCellHistory,
  };
}

module.exports = { createRolloutTrackerDb };
