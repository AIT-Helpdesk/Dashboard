// TC Elite Rollout's own persistent data -- the first page on this
// dashboard with real, writable application data of its own (every other
// page here is a thin read view over an external system -- Autotask,
// Strety, Ingram, Teams -- with at most a short in-memory cache). This
// needs a real datastore: clients, the rollout columns tracked for each,
// per-cell status, and a full audit trail of who changed what and when.
//
// Uses node's own built-in `node:sqlite` (DatabaseSync), not a third-party
// package -- confirmed working on this machine (Node v24.18.0; DatabaseSync
// needs Node >=22.5) with a real CREATE TABLE/INSERT/SELECT round trip
// before committing to it. Zero new runtime dependencies this way, and no
// native-binary-on-Windows risk the way better-sqlite3 would have carried.
// If this is ever deployed to a box running an older Node, this is the one
// thing to check first (`node --version`, needs >=22.5).
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.db');
const db = new DatabaseSync(DB_PATH);

// WAL (write-ahead logging), not the default rollback journal -- multiple
// staff editing around the same time is the whole point of this page, and
// WAL lets readers and a writer proceed concurrently instead of readers
// blocking on a writer's lock the way the default journal mode would.
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// Idempotent -- CREATE TABLE IF NOT EXISTS, run on every startup, no
// separate migration framework for this first version. Matches the shape
// approved in the plan: clients/columns/stages hold the STRUCTURE (which
// clients and rollout items exist at all); cell_status/stage_status hold
// the CURRENT value for each (client, item) pair; audit_log is the
// append-only history everything else is really justified by.
db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    active_contract TEXT,
    comment TEXT,
    contract_signed TEXT,
    created_at TEXT NOT NULL,
    created_by_email TEXT NOT NULL,
    created_by_name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS columns (
    id INTEGER PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('simple','compound')),
    sort_order INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    created_by_email TEXT NOT NULL,
    created_by_name TEXT NOT NULL
  );

  -- Only meaningful for kind='compound' columns. type='status' feeds the
  -- parent column's rollup (see recomputeRollup() below); type='text' is
  -- a free-text field (e.g. AutoElevate's "Domain"/"WHO") that's purely
  -- informational and never part of the rollup calculation.
  CREATE TABLE IF NOT EXISTS stages (
    id INTEGER PRIMARY KEY,
    column_id INTEGER NOT NULL REFERENCES columns(id),
    key TEXT NOT NULL,
    label TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('status','text')),
    sort_order INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    created_by_email TEXT NOT NULL,
    created_by_name TEXT NOT NULL,
    UNIQUE(column_id, key)
  );

  -- Current status per (client, column) on the master grid. For a
  -- 'simple' column this is directly editable (see PATCH /cells/:id/:id
  -- in server.js). For a 'compound' column this is the AUTO-COMPUTED
  -- rollup from that client's stage_status rows -- recomputeRollup()
  -- below is the only thing that ever writes it, never a direct user edit.
  CREATE TABLE IF NOT EXISTS cell_status (
    client_id INTEGER NOT NULL REFERENCES clients(id),
    column_id INTEGER NOT NULL REFERENCES columns(id),
    status TEXT NOT NULL CHECK (status IN ('not_done','started','done','na','cancelled','issue')),
    reason TEXT,
    updated_at TEXT NOT NULL,
    updated_by_email TEXT NOT NULL,
    updated_by_name TEXT NOT NULL,
    PRIMARY KEY (client_id, column_id)
  );

  -- Current status per (client, stage) -- only for stages of compound
  -- columns. type='text' stages store their value here too, reusing
  -- the reason column as the free-text field (status left NULL for
  -- those), rather than a separate table just for text-type stages.
  CREATE TABLE IF NOT EXISTS stage_status (
    client_id INTEGER NOT NULL REFERENCES clients(id),
    stage_id INTEGER NOT NULL REFERENCES stages(id),
    status TEXT CHECK (status IN ('not_done','started','done','na','cancelled','issue')),
    reason TEXT,
    updated_at TEXT NOT NULL,
    updated_by_email TEXT NOT NULL,
    updated_by_name TEXT NOT NULL,
    PRIMARY KEY (client_id, stage_id)
  );

  -- Append-only history -- the real reason this page exists rather than
  -- just staying a spreadsheet. Every cell_status/stage_status change (and
  -- client/column/stage creation) writes a row here FIRST, before the
  -- current-value tables above are updated. Powers the "Started by <name>
  -- on <date>" hover tooltip and the derived Commenced/Completed dates (no
  -- separate columns for those -- Commenced is the first non-not_done
  -- change for a client, Completed is when a client's last outstanding
  -- item became done/na, both computed from this table on demand).
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY,
    changed_at TEXT NOT NULL,
    changed_by_email TEXT NOT NULL,
    changed_by_name TEXT NOT NULL,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('client','column','stage','cell','stage_cell')),
    client_id INTEGER,
    column_id INTEGER,
    stage_id INTEGER,
    old_status TEXT,
    new_status TEXT,
    old_reason TEXT,
    new_reason TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_audit_cell ON audit_log(client_id, column_id, changed_at);
  CREATE INDEX IF NOT EXISTS idx_audit_stage_cell ON audit_log(client_id, stage_id, changed_at);
`);

// One real migration, run every startup but a no-op after the first time
// -- CREATE TABLE IF NOT EXISTS above doesn't touch an already-existing
// table's CHECK constraint, so adding 'cancelled' as a 5th status needed
// an actual schema change against the real data.db already populated
// from the spreadsheet import. SQLite has no ALTER TABLE for CHECK
// constraints -- the standard workaround (recreate the table with the
// new constraint, copy every row across, drop the old one, rename) is
// exactly what this does, guarded by checking the table's own stored
// CREATE statement (sqlite_master.sql) for whether 'cancelled' is
// already in it, cheap and accurate without a separate migrations table.
function migrateAddCancelledStatus() {
  const current = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cell_status'`).get();
  if (!current || current.sql.includes('cancelled')) return;

  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE cell_status_new (
        client_id INTEGER NOT NULL REFERENCES clients(id),
        column_id INTEGER NOT NULL REFERENCES columns(id),
        status TEXT NOT NULL CHECK (status IN ('not_done','started','done','na','cancelled')),
        reason TEXT,
        updated_at TEXT NOT NULL,
        updated_by_email TEXT NOT NULL,
        updated_by_name TEXT NOT NULL,
        PRIMARY KEY (client_id, column_id)
      );
      INSERT INTO cell_status_new SELECT * FROM cell_status;
      DROP TABLE cell_status;
      ALTER TABLE cell_status_new RENAME TO cell_status;

      CREATE TABLE stage_status_new (
        client_id INTEGER NOT NULL REFERENCES clients(id),
        stage_id INTEGER NOT NULL REFERENCES stages(id),
        status TEXT CHECK (status IN ('not_done','started','done','na','cancelled')),
        reason TEXT,
        updated_at TEXT NOT NULL,
        updated_by_email TEXT NOT NULL,
        updated_by_name TEXT NOT NULL,
        PRIMARY KEY (client_id, stage_id)
      );
      INSERT INTO stage_status_new SELECT * FROM stage_status;
      DROP TABLE stage_status;
      ALTER TABLE stage_status_new RENAME TO stage_status;
    `);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
migrateAddCancelledStatus();

// Same pattern as migrateAddCancelledStatus() above, for adding 'issue' as
// a 6th status -- an outstanding item is now distinguishable from one that
// specifically has a known problem someone's flagged. Deliberately the
// OPPOSITE of na/cancelled: never ignored in the rollup (see
// computeRollupStatus() below) and never treated as resolved (see
// RESOLVED_STATUSES in server.js) -- an issue needs to stay visible until
// it's actually fixed.
function migrateAddIssueStatus() {
  const current = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cell_status'`).get();
  if (!current || current.sql.includes('issue')) return;

  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE cell_status_new (
        client_id INTEGER NOT NULL REFERENCES clients(id),
        column_id INTEGER NOT NULL REFERENCES columns(id),
        status TEXT NOT NULL CHECK (status IN ('not_done','started','done','na','cancelled','issue')),
        reason TEXT,
        updated_at TEXT NOT NULL,
        updated_by_email TEXT NOT NULL,
        updated_by_name TEXT NOT NULL,
        PRIMARY KEY (client_id, column_id)
      );
      INSERT INTO cell_status_new SELECT * FROM cell_status;
      DROP TABLE cell_status;
      ALTER TABLE cell_status_new RENAME TO cell_status;

      CREATE TABLE stage_status_new (
        client_id INTEGER NOT NULL REFERENCES clients(id),
        stage_id INTEGER NOT NULL REFERENCES stages(id),
        status TEXT CHECK (status IN ('not_done','started','done','na','cancelled','issue')),
        reason TEXT,
        updated_at TEXT NOT NULL,
        updated_by_email TEXT NOT NULL,
        updated_by_name TEXT NOT NULL,
        PRIMARY KEY (client_id, stage_id)
      );
      INSERT INTO stage_status_new SELECT * FROM stage_status;
      DROP TABLE stage_status;
      ALTER TABLE stage_status_new RENAME TO stage_status;
    `);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
migrateAddIssueStatus();

function nowIso() {
  return new Date().toISOString();
}

// `actor` is always { email, name } -- req.session.user, shaped the same
// way every other page on this dashboard already reads it (requireAuth
// guarantees a signed-in session before any route runs).
function recordAudit({ entityType, clientId = null, columnId = null, stageId = null, oldStatus = null, newStatus = null, oldReason = null, newReason = null, actor }) {
  db.prepare(
    `INSERT INTO audit_log (changed_at, changed_by_email, changed_by_name, entity_type, client_id, column_id, stage_id, old_status, new_status, old_reason, new_reason)
     VALUES ($changedAt, $email, $name, $entityType, $clientId, $columnId, $stageId, $oldStatus, $newStatus, $oldReason, $newReason)`
  ).run({
    $changedAt: nowIso(),
    $email: actor.email,
    $name: actor.name,
    $entityType: entityType,
    $clientId: clientId,
    $columnId: columnId,
    $stageId: stageId,
    $oldStatus: oldStatus,
    $newStatus: newStatus,
    $oldReason: oldReason,
    $newReason: newReason,
  });
}

// The rollup rule (see the plan/README for the full reasoning): over a
// compound column's status-type stages only (text-type stages never
// participate) --
//   all na (or zero status-type stages at all) -> na
//   ignoring any na stages, all remaining done -> done
//   none of the remaining started/done -> not_done
//   otherwise -> started
// 'cancelled' is treated the same as 'na' here -- ignored when deciding
// what the rest of the stages add up to (a cancelled stage isn't
// outstanding work either). The one difference: if EVERY stage that's
// being ignored is specifically 'cancelled' (not a mix with 'na', and not
// zero stages), the rollup reflects 'cancelled' itself rather than
// falling back to 'na' -- "this whole item was cancelled" is worth
// showing distinctly from "this whole item doesn't apply."
// 'issue' is the opposite kind of special case -- never ignored. If ANY
// relevant stage has a flagged issue, the whole column's rollup surfaces
// as 'issue' too, ahead of the ordinary done/not_done/started checks --
// a single problem stage shouldn't get diluted into a generic "started"
// reading on the master grid.
function computeRollupStatus(stageStatuses) {
  if (stageStatuses.length === 0) return 'na';
  const relevant = stageStatuses.filter((s) => s !== 'na' && s !== 'cancelled');
  if (relevant.length === 0) {
    if (stageStatuses.every((s) => s === 'cancelled')) return 'cancelled';
    return 'na';
  }
  if (relevant.some((s) => s === 'issue')) return 'issue';
  if (relevant.every((s) => s === 'done')) return 'done';
  if (relevant.every((s) => s === 'not_done')) return 'not_done';
  return 'started';
}

// Recomputes and (if changed) persists a client's cell_status for a
// compound column, from its current stage_status rows. Called after every
// stage_status write -- see PATCH /stages/:clientId/:stageId in server.js.
// Writes its own audit_log 'cell' entry when the rollup actually changes,
// attributed to whoever triggered the underlying stage edit (`actor`) --
// the master cell's own state genuinely changed, even though no one
// clicked that cell directly.
function recomputeRollup(clientId, columnId, actor) {
  const stageRows = db
    .prepare(
      `SELECT ss.status FROM stage_status ss
       JOIN stages s ON s.id = ss.stage_id
       WHERE ss.client_id = ? AND s.column_id = ? AND s.type = 'status'`
    )
    .all(clientId, columnId);
  const newStatus = computeRollupStatus(stageRows.map((r) => r.status));

  const existing = db.prepare('SELECT status FROM cell_status WHERE client_id = ? AND column_id = ?').get(clientId, columnId);
  const oldStatus = existing ? existing.status : null;
  if (oldStatus === newStatus) return; // no real change -- don't pollute the audit log

  db.prepare(
    `INSERT INTO cell_status (client_id, column_id, status, reason, updated_at, updated_by_email, updated_by_name)
     VALUES ($clientId, $columnId, $status, NULL, $updatedAt, $email, $name)
     ON CONFLICT(client_id, column_id) DO UPDATE SET
       status = excluded.status, reason = NULL, updated_at = excluded.updated_at,
       updated_by_email = excluded.updated_by_email, updated_by_name = excluded.updated_by_name`
  ).run({ $clientId: clientId, $columnId: columnId, $status: newStatus, $updatedAt: nowIso(), $email: actor.email, $name: actor.name });

  recordAudit({ entityType: 'cell', clientId, columnId, oldStatus, newStatus, actor });
}

// Every stage (status OR text type) always gets a stage_status row the
// moment both the stage and the client exist -- confirmed necessary
// against a real bug found while testing this: PATCH /stages/:c/:s is an
// UPDATE, not an upsert, so a text-type stage that never got an initial
// row (the original version of this file only seeded status-type stages,
// on the assumption text stages "start blank") returned a confusing 404
// "No such client/stage" the first time anyone tried to fill it in.
// status-type stages seed 'not_done'; text-type stages seed NULL status /
// NULL reason (nothing to default free text to).
function seedOneStageStatus(clientId, stage, actor) {
  const status = stage.type === 'status' ? 'not_done' : null;
  db.prepare(
    `INSERT INTO stage_status (client_id, stage_id, status, updated_at, updated_by_email, updated_by_name)
     VALUES ($clientId, $stageId, $status, $updatedAt, $email, $name)`
  ).run({ $clientId: clientId, $stageId: stage.id, $status: status, $updatedAt: nowIso(), $email: actor.email, $name: actor.name });
  recordAudit({ entityType: 'stage_cell', clientId, stageId: stage.id, newStatus: status, actor });
}

// Seeds not_done for one newly-added client across every EXISTING column --
// "new client rows mark all columns as Not Done", by request. For a
// compound column, seeds every stage (see seedOneStageStatus above) FIRST,
// then derives cell_status via recomputeRollup() rather than hardcoding
// not_done directly -- keeps this in sync with the one real rollup rule
// (computeRollupStatus()) instead of duplicating its logic, which also
// makes the zero-stages-yet edge case correctly land on 'na' rather than a
// wrong not_done. Runs inside a transaction so a half-seeded client is
// never left behind by a crash partway through.
function seedNewClient(clientId, actor) {
  db.exec('BEGIN');
  try {
    const columns = db.prepare('SELECT id, kind FROM columns').all();
    for (const col of columns) {
      if (col.kind === 'simple') {
        db.prepare(
          `INSERT INTO cell_status (client_id, column_id, status, updated_at, updated_by_email, updated_by_name)
           VALUES ($clientId, $columnId, 'not_done', $updatedAt, $email, $name)`
        ).run({ $clientId: clientId, $columnId: col.id, $updatedAt: nowIso(), $email: actor.email, $name: actor.name });
        recordAudit({ entityType: 'cell', clientId, columnId: col.id, newStatus: 'not_done', actor });
        continue;
      }
      const stages = db.prepare(`SELECT id, type FROM stages WHERE column_id = ?`).all(col.id);
      for (const stage of stages) seedOneStageStatus(clientId, stage, actor);
      recomputeRollup(clientId, col.id, actor);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Seeds not_done for one newly-added column across every EXISTING client.
// For a compound column, `stages` (its own freshly-created stages, each
// { id, type }) get seeded first, then cell_status is derived via
// recomputeRollup() -- same "single source of truth for the rollup rule"
// reasoning as seedNewClient() above.
function seedNewColumn(columnId, kind, stages, actor) {
  db.exec('BEGIN');
  try {
    const clients = db.prepare('SELECT id FROM clients').all();
    for (const client of clients) {
      if (kind === 'simple') {
        db.prepare(
          `INSERT INTO cell_status (client_id, column_id, status, updated_at, updated_by_email, updated_by_name)
           VALUES ($clientId, $columnId, 'not_done', $updatedAt, $email, $name)`
        ).run({ $clientId: client.id, $columnId: columnId, $updatedAt: nowIso(), $email: actor.email, $name: actor.name });
        recordAudit({ entityType: 'cell', clientId: client.id, columnId, newStatus: 'not_done', actor });
        continue;
      }
      for (const stage of stages) seedOneStageStatus(client.id, stage, actor);
      recomputeRollup(client.id, columnId, actor);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Seeds one newly-added stage (added to an already-existing compound
// column, status OR text type) across every existing client, then
// recomputes each client's rollup for that column if it's a status-type
// stage -- a freshly added status stage can change what "all done" means
// for clients that were previously fully done on that column; a text
// stage never affects the rollup at all.
function seedNewStage(stage, columnId, actor) {
  db.exec('BEGIN');
  try {
    const clients = db.prepare('SELECT id FROM clients').all();
    for (const client of clients) {
      seedOneStageStatus(client.id, stage, actor);
      if (stage.type === 'status') recomputeRollup(client.id, columnId, actor);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Sets every SIMPLE column's cell_status for one client to the same
// status/reason in one go -- by request, for a client where "everything's
// N/A, they're too small" (or similar) is true across the board and
// clicking each cell individually is needless repetition. Compound
// columns are skipped entirely -- their cell_status is never directly
// settable, only ever derived from their own stages (see
// bulkSetStages() below for the detail-sheet equivalent of this same
// idea). Returns the list of affected column ids.
function bulkSetCells(clientId, status, reason, actor) {
  const columns = db.prepare(`SELECT id FROM columns WHERE kind = 'simple'`).all();
  db.exec('BEGIN');
  try {
    for (const col of columns) {
      const existing = db.prepare('SELECT status, reason FROM cell_status WHERE client_id = ? AND column_id = ?').get(clientId, col.id);
      if (!existing) continue; // no cell for this client/column -- shouldn't happen, but skip rather than fail the whole batch
      db.prepare(
        `UPDATE cell_status SET status = $status, reason = $reason, updated_at = $updatedAt, updated_by_email = $email, updated_by_name = $name
         WHERE client_id = $clientId AND column_id = $columnId`
      ).run({ $status: status, $reason: reason, $updatedAt: nowIso(), $email: actor.email, $name: actor.name, $clientId: clientId, $columnId: col.id });
      recordAudit({ entityType: 'cell', clientId, columnId: col.id, oldStatus: existing.status, newStatus: status, oldReason: existing.reason, newReason: reason, actor });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return columns.map((c) => c.id);
}

// Sets every STATUS-type stage's stage_status for one client, within one
// compound column, to the same status/reason -- the detail-sheet
// equivalent of bulkSetCells() above. text-type stages are skipped (they
// hold free text, not a status -- "set them all to N/A" doesn't mean
// anything for those). Recomputes the column's rollup for this client
// afterward, same as any other stage_status write.
function bulkSetStages(clientId, columnId, status, reason, actor) {
  const stages = db.prepare(`SELECT id FROM stages WHERE column_id = ? AND type = 'status'`).all(columnId);
  db.exec('BEGIN');
  try {
    for (const stage of stages) {
      const existing = db.prepare('SELECT status, reason FROM stage_status WHERE client_id = ? AND stage_id = ?').get(clientId, stage.id);
      if (!existing) continue;
      db.prepare(
        `UPDATE stage_status SET status = $status, reason = $reason, updated_at = $updatedAt, updated_by_email = $email, updated_by_name = $name
         WHERE client_id = $clientId AND stage_id = $stageId`
      ).run({ $status: status, $reason: reason, $updatedAt: nowIso(), $email: actor.email, $name: actor.name, $clientId: clientId, $stageId: stage.id });
      recordAudit({ entityType: 'stage_cell', clientId, stageId: stage.id, oldStatus: existing.status, newStatus: status, oldReason: existing.reason, newReason: reason, actor });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  recomputeRollup(clientId, columnId, actor);
  return stages.map((s) => s.id);
}

// Hard delete -- by request (removing a test client added while trying
// this page out), not a soft-delete-with-history-preserved model. Purges
// the client's own audit_log rows too, not just cell/stage_status --
// deliberate: this is for cleaning up a mistake, not recording that a real
// client's tracking was discontinued, so there's no lingering trace meant
// to survive the deletion. Revisit if a real client ever needs removing
// and preserving "they used to be tracked" history turns out to matter.
function deleteClient(clientId) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM audit_log WHERE client_id = ?').run(clientId);
    db.prepare('DELETE FROM stage_status WHERE client_id = ?').run(clientId);
    db.prepare('DELETE FROM cell_status WHERE client_id = ?').run(clientId);
    db.prepare('DELETE FROM clients WHERE id = ?').run(clientId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Same hard-delete reasoning as deleteClient() above. Recomputes every
// client's rollup for the stage's parent column afterward IF it was a
// status-type stage (a text-type stage's removal can never change a
// rollup -- it never participated in one).
function deleteStage(stageId, actor) {
  const stage = db.prepare('SELECT * FROM stages WHERE id = ?').get(stageId);
  if (!stage) return;
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM audit_log WHERE stage_id = ?').run(stageId);
    db.prepare('DELETE FROM stage_status WHERE stage_id = ?').run(stageId);
    db.prepare('DELETE FROM stages WHERE id = ?').run(stageId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  if (stage.type === 'status') {
    const clients = db.prepare('SELECT id FROM clients').all();
    for (const c of clients) recomputeRollup(c.id, stage.column_id, actor);
  }
}

module.exports = {
  db,
  nowIso,
  recordAudit,
  computeRollupStatus,
  recomputeRollup,
  seedNewClient,
  seedNewColumn,
  seedNewStage,
  bulkSetCells,
  bulkSetStages,
  deleteClient,
  deleteStage,
};
