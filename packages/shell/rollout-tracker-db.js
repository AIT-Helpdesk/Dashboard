// Shared, generic rollout-tracker datastore factory -- extracted from
// tc-elite-rollout's own db.js. Originally simple-column only; now also
// carries tc-elite-rollout's own compound-column/stages/detail-sheet
// feature (by request, Oct 2026), ported across rather than left as a
// TC-Elite-only capability -- a compound column here behaves exactly like
// one there: a column whose own master-grid cell is an auto-computed
// rollup over a set of per-row "stages" (its own detail sheet), not a
// directly-editable status. Each generated tracker package calls
// createRolloutTrackerDb(path.join(__dirname, 'data.db')) once, at require
// time, from its own thin server.js -- same "one process-lifetime
// DatabaseSync per page" shape tc-elite-rollout uses.
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
  // rollout-tracker-client.js; the schema itself stays generic. `kind` and
  // `stages`/`stage_status` mirror tc-elite-rollout/db.js's own
  // clients/columns/stages shape exactly, just renamed to the generic
  // rows/columns terms this engine already uses everywhere else.
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
      kind TEXT NOT NULL DEFAULT 'simple' CHECK (kind IN ('simple','compound')),
      sort_order INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      created_by_email TEXT NOT NULL,
      created_by_name TEXT NOT NULL
    );

    -- Only meaningful for kind='compound' columns. type='status' feeds the
    -- parent column's rollup (see recomputeRollup() below); type='text' is
    -- a free-text field (e.g. tc-elite-rollout's AutoElevate "Domain"/
    -- "WHO") that's purely informational and never part of the rollup.
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

    -- Current status per (row, stage) -- only for stages of compound
    -- columns. type='text' stages store their value here too, reusing the
    -- reason column as the free-text field (status left NULL for those),
    -- same convention tc-elite-rollout/db.js uses.
    CREATE TABLE IF NOT EXISTS stage_status (
      row_id INTEGER NOT NULL REFERENCES rows(id),
      stage_id INTEGER NOT NULL REFERENCES stages(id),
      status TEXT CHECK (status IN ('not_done','started','done','na','cancelled','issue','note')),
      reason TEXT,
      updated_at TEXT NOT NULL,
      updated_by_email TEXT NOT NULL,
      updated_by_name TEXT NOT NULL,
      PRIMARY KEY (row_id, stage_id)
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY,
      changed_at TEXT NOT NULL,
      changed_by_email TEXT NOT NULL,
      changed_by_name TEXT NOT NULL,
      row_id INTEGER,
      column_id INTEGER,
      stage_id INTEGER,
      old_status TEXT,
      new_status TEXT,
      old_reason TEXT,
      new_reason TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_audit_cell ON audit_log(row_id, column_id, changed_at);
  `);

  // Two migrations for a tracker's data.db created BEFORE this compound-
  // column port (every tracker generated prior to Oct 2026) -- CREATE
  // TABLE IF NOT EXISTS above doesn't touch an already-existing table, so
  // `columns.kind` and `audit_log.stage_id` need an explicit ALTER TABLE
  // the first time this runs against one of those older files. Same
  // idempotent "check sqlite_master's own stored CREATE statement" guard
  // tc-elite-rollout/db.js's own migrateAddCancelledStatus()/
  // migrateAddIssueStatus() use -- cheap and accurate without a separate
  // migrations table, and a no-op on every run after the first. Must run
  // BEFORE idx_audit_stage_cell is created below -- confirmed the hard
  // way (against a copy of the real update-break-glass-accounts-mfa-
  // tracker/data.db): an index on audit_log.stage_id fails outright if
  // that column doesn't exist on this table yet.
  function migrateAddColumnKind() {
    const current = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'columns'`).get();
    if (!current || current.sql.includes('kind')) return;
    db.exec(`ALTER TABLE columns ADD COLUMN kind TEXT NOT NULL DEFAULT 'simple' CHECK (kind IN ('simple','compound'))`);
  }
  migrateAddColumnKind();

  function migrateAddAuditStageId() {
    const current = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'`).get();
    if (!current || current.sql.includes('stage_id')) return;
    db.exec('ALTER TABLE audit_log ADD COLUMN stage_id INTEGER');
  }
  migrateAddAuditStageId();

  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_stage_cell ON audit_log(row_id, stage_id, changed_at)');

  function nowIso() {
    return new Date().toISOString();
  }

  // Same slugify/uniqueKey pure helpers rollout-tracker-server.js already
  // has of its own (for column keys) -- duplicated here rather than
  // shared, same "small pure helper, independent copy per file" convention
  // this dashboard already follows elsewhere (e.g. tc-elite-rollout/
  // server.js and this engine's own server.js each keep their own copy).
  // Needed here so addColumn()/addStage() below can derive a stage's key
  // without the caller having to do it.
  function slugify(label) {
    return label
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }
  function uniqueKey(baseKey, existingKeys) {
    if (!existingKeys.has(baseKey)) return baseKey;
    let n = 2;
    while (existingKeys.has(`${baseKey}_${n}`)) n++;
    return `${baseKey}_${n}`;
  }

  // `actor` is always { email, name } -- req.session.user, same shape
  // every page on this dashboard already reads it in (requireAuth
  // guarantees a signed-in session before any generated tracker's router
  // ever runs).
  function recordAudit({ rowId = null, columnId = null, stageId = null, oldStatus = null, newStatus = null, oldReason = null, newReason = null, actor }) {
    db.prepare(
      `INSERT INTO audit_log (changed_at, changed_by_email, changed_by_name, row_id, column_id, stage_id, old_status, new_status, old_reason, new_reason)
       VALUES ($changedAt, $email, $name, $rowId, $columnId, $stageId, $oldStatus, $newStatus, $oldReason, $newReason)`
    ).run({
      $changedAt: nowIso(),
      $email: actor.email,
      $name: actor.name,
      $rowId: rowId,
      $columnId: columnId,
      $stageId: stageId,
      $oldStatus: oldStatus,
      $newStatus: newStatus,
      $oldReason: oldReason,
      $newReason: newReason,
    });
  }

  // The rollup rule -- identical to tc-elite-rollout/db.js's own
  // computeRollupStatus(), plus 'note' (this engine's 7th status, which
  // tc-elite-rollout doesn't have): over a compound column's status-type
  // stages only (text-type stages never participate) --
  //   all na (or zero status-type stages at all) -> na
  //   ignoring any na/cancelled stages, all remaining done -> done
  //   none of the remaining started/done -> not_done
  //   otherwise -> started
  // 'cancelled' is ignored the same way 'na' is, except when EVERY
  // ignored stage is specifically 'cancelled' (not a mix with 'na', and
  // not zero stages) -- then the rollup is 'cancelled' itself. 'issue' is
  // never ignored and wins first (a single flagged problem shouldn't get
  // diluted into a generic "started" reading); 'note' is checked right
  // after issue, same reasoning but one notch lower -- an annotation
  // still deserves its own visible rollup rather than disappearing into
  // "started".
  function computeRollupStatus(stageStatuses) {
    if (stageStatuses.length === 0) return 'na';
    const relevant = stageStatuses.filter((s) => s !== 'na' && s !== 'cancelled');
    if (relevant.length === 0) {
      if (stageStatuses.every((s) => s === 'cancelled')) return 'cancelled';
      return 'na';
    }
    if (relevant.some((s) => s === 'issue')) return 'issue';
    if (relevant.some((s) => s === 'note')) return 'note';
    if (relevant.every((s) => s === 'done')) return 'done';
    if (relevant.every((s) => s === 'not_done')) return 'not_done';
    return 'started';
  }

  // Recomputes and (if changed) persists a row's cell_status for a
  // compound column, from its current stage_status rows. Called after
  // every stage_status write. Writes its own audit_log entry (row_id +
  // column_id, no stage_id -- same shape an ordinary simple-cell edit
  // writes, so getCellHistory below picks it up identically) only when the
  // rollup actually changes, attributed to whoever triggered the
  // underlying stage edit.
  function recomputeRollup(rowId, columnId, actor) {
    const stageRows = db
      .prepare(
        `SELECT ss.status FROM stage_status ss
         JOIN stages s ON s.id = ss.stage_id
         WHERE ss.row_id = ? AND s.column_id = ? AND s.type = 'status'`
      )
      .all(rowId, columnId);
    const newStatus = computeRollupStatus(stageRows.map((r) => r.status));

    const existing = db.prepare('SELECT status FROM cell_status WHERE row_id = ? AND column_id = ?').get(rowId, columnId);
    const oldStatus = existing ? existing.status : null;
    if (oldStatus === newStatus) return; // no real change -- don't pollute the audit log

    db.prepare(
      `INSERT INTO cell_status (row_id, column_id, status, reason, updated_at, updated_by_email, updated_by_name)
       VALUES ($rowId, $columnId, $status, NULL, $updatedAt, $email, $name)
       ON CONFLICT(row_id, column_id) DO UPDATE SET
         status = excluded.status, reason = NULL, updated_at = excluded.updated_at,
         updated_by_email = excluded.updated_by_email, updated_by_name = excluded.updated_by_name`
    ).run({ $rowId: rowId, $columnId: columnId, $status: newStatus, $updatedAt: nowIso(), $email: actor.email, $name: actor.name });

    recordAudit({ rowId, columnId, oldStatus, newStatus, actor });
  }

  // Every stage (status OR text type) always gets a stage_status row the
  // moment both the stage and the row exist -- same confirmed-necessary
  // reasoning as tc-elite-rollout/db.js's own seedOneStageStatus(): a
  // text-type stage that never got an initial row would 404 the first
  // time anyone tried to fill it in, since PATCH .../stages/:id is an
  // UPDATE, not an upsert.
  function seedOneStageStatus(rowId, stage, actor) {
    const status = stage.type === 'status' ? 'not_done' : null;
    db.prepare(
      `INSERT INTO stage_status (row_id, stage_id, status, updated_at, updated_by_email, updated_by_name)
       VALUES ($rowId, $stageId, $status, $updatedAt, $email, $name)`
    ).run({ $rowId: rowId, $stageId: stage.id, $status: status, $updatedAt: nowIso(), $email: actor.email, $name: actor.name });
    recordAudit({ rowId, stageId: stage.id, newStatus: status, actor });
  }

  // Seeds not_done for one newly-added row across every EXISTING column --
  // mirrors tc-elite-rollout's own seedNewClient(). For a compound column,
  // seeds every one of its stages first, then derives cell_status via
  // recomputeRollup() rather than hardcoding not_done directly -- keeps
  // this in sync with the one real rollup rule instead of duplicating it,
  // which also makes the zero-stages-yet edge case correctly land on 'na'.
  // Runs inside a transaction so a half-seeded row is never left behind by
  // a crash partway through.
  function seedNewRow(rowId, actor) {
    db.exec('BEGIN');
    try {
      const columns = db.prepare('SELECT id, kind FROM columns').all();
      for (const col of columns) {
        if (col.kind === 'simple') {
          db.prepare(
            `INSERT INTO cell_status (row_id, column_id, status, updated_at, updated_by_email, updated_by_name)
             VALUES ($rowId, $columnId, 'not_done', $updatedAt, $email, $name)`
          ).run({ $rowId: rowId, $columnId: col.id, $updatedAt: nowIso(), $email: actor.email, $name: actor.name });
          recordAudit({ rowId, columnId: col.id, newStatus: 'not_done', actor });
          continue;
        }
        const stages = db.prepare('SELECT id, type FROM stages WHERE column_id = ?').all(col.id);
        for (const stage of stages) seedOneStageStatus(rowId, stage, actor);
        recomputeRollup(rowId, col.id, actor);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // Seeds not_done for one newly-added column across every EXISTING row --
  // the column-based mirror of seedNewRow() above. `stages` is this
  // column's own freshly-created stages (each { id, type }, empty for a
  // simple column or a compound column with none yet).
  function seedNewColumn(columnId, kind, stages, actor) {
    db.exec('BEGIN');
    try {
      const rows = db.prepare('SELECT id FROM rows').all();
      for (const row of rows) {
        if (kind === 'simple') {
          db.prepare(
            `INSERT INTO cell_status (row_id, column_id, status, updated_at, updated_by_email, updated_by_name)
             VALUES ($rowId, $columnId, 'not_done', $updatedAt, $email, $name)`
          ).run({ $rowId: row.id, $columnId: columnId, $updatedAt: nowIso(), $email: actor.email, $name: actor.name });
          recordAudit({ rowId: row.id, columnId, newStatus: 'not_done', actor });
          continue;
        }
        for (const stage of stages) seedOneStageStatus(row.id, stage, actor);
        recomputeRollup(row.id, columnId, actor);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // Seeds one newly-added stage (added to an already-existing compound
  // column) across every existing row, then recomputes each row's rollup
  // for that column if it's a status-type stage -- a freshly added status
  // stage can change what "all done" means for rows that were previously
  // fully done on that column; a text stage never affects the rollup.
  function seedNewStage(stage, columnId, actor) {
    db.exec('BEGIN');
    try {
      const rows = db.prepare('SELECT id FROM rows').all();
      for (const row of rows) {
        seedOneStageStatus(row.id, stage, actor);
        if (stage.type === 'status') recomputeRollup(row.id, columnId, actor);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // Adds one row (name required, unique), seeding every existing column.
  // Returns the new row id, or null if the name is already taken (caller
  // returns 409).
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

  // Adds one column -- kind 'simple' (no stages) or 'compound' (an
  // initial stage list, each { label, type: 'status'|'text' }, same shape
  // tc-elite-rollout's own POST /columns accepts). `key` is the caller's
  // already-derived unique column key (rollout-tracker-server.js's own
  // uniqueKey(slugify(label), ...), same convention as before this
  // change); each stage's own key is derived here instead, scoped to
  // "unique within this column" rather than dashboard-wide. Seeds every
  // existing row. Returns the new column id.
  function addColumn(label, key, kind, stagesInput, actor) {
    const sortRow = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS maxSort FROM columns').get();
    const sortOrder = sortRow.maxSort + 1;
    const info = db
      .prepare(
        `INSERT INTO columns (key, label, kind, sort_order, created_at, created_by_email, created_by_name)
         VALUES ($key, $label, $kind, $sortOrder, $createdAt, $email, $name)`
      )
      .run({ $key: key, $label: label, $kind: kind, $sortOrder: sortOrder, $createdAt: nowIso(), $email: actor.email, $name: actor.name });
    const columnId = Number(info.lastInsertRowid);
    recordAudit({ columnId, newStatus: null, actor });

    const createdStages = []; // { id, type } for every stage just created, status AND text
    if (kind === 'compound' && Array.isArray(stagesInput)) {
      const existingStageKeys = new Set();
      let stageSort = 0;
      for (const s of stagesInput) {
        if (!s.label || !String(s.label).trim()) continue;
        const type = s.type === 'text' ? 'text' : 'status';
        const stageKey = uniqueKey(slugify(s.label), existingStageKeys);
        existingStageKeys.add(stageKey);
        const stageInfo = db
          .prepare(
            `INSERT INTO stages (column_id, key, label, type, sort_order, created_at, created_by_email, created_by_name)
             VALUES ($columnId, $key, $label, $type, $sortOrder, $createdAt, $email, $name)`
          )
          .run({ $columnId: columnId, $key: stageKey, $label: s.label.trim(), $type: type, $sortOrder: stageSort++, $createdAt: nowIso(), $email: actor.email, $name: actor.name });
        const stageId = Number(stageInfo.lastInsertRowid);
        recordAudit({ columnId, stageId, actor });
        createdStages.push({ id: stageId, type });
      }
    }

    seedNewColumn(columnId, kind, createdStages, actor);
    return columnId;
  }

  // Adds one stage to an already-existing compound column -- the "Add
  // Stage" action on a detail sheet. Seeds it across every existing row
  // and recomputes rollups per seedNewStage() above. Returns { id, key }.
  function addStage(columnId, label, type, actor) {
    const stageType = type === 'text' ? 'text' : 'status';
    const existingKeys = new Set(db.prepare('SELECT key FROM stages WHERE column_id = ?').all(columnId).map((r) => r.key));
    const key = uniqueKey(slugify(label), existingKeys);
    const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM stages WHERE column_id = ?').get(columnId).m;
    const info = db
      .prepare(
        `INSERT INTO stages (column_id, key, label, type, sort_order, created_at, created_by_email, created_by_name)
         VALUES ($columnId, $key, $label, $type, $sortOrder, $createdAt, $email, $name)`
      )
      .run({ $columnId: columnId, $key: key, $label: label.trim(), $type: stageType, $sortOrder: maxSort + 1, $createdAt: nowIso(), $email: actor.email, $name: actor.name });
    const stageId = Number(info.lastInsertRowid);
    recordAudit({ columnId, stageId, actor });
    seedNewStage({ id: stageId, type: stageType }, columnId, actor);
    return { id: stageId, key };
  }

  // Re-numbers every column's sort_order to match `orderedColumnIds`'
  // own position (0, 1, 2, ...) -- by request ("Dragging a column left or
  // right... Each column will need to be numbered to retain order after
  // refresh"). The caller (rollout-tracker-server.js's own PUT
  // /columns/order) already validates this is exactly the current set of
  // column ids, just reordered -- this function trusts that and just
  // writes the new positions, wrapped in one transaction so a half-
  // renumbered table is never left behind by a crash partway through.
  // Unaffected by kind -- a compound column reorders exactly like a
  // simple one, only its master cell's editability differs.
  function reorderColumns(orderedColumnIds) {
    db.exec('BEGIN');
    try {
      orderedColumnIds.forEach((columnId, index) => {
        db.prepare('UPDATE columns SET sort_order = ? WHERE id = ?').run(index, columnId);
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // Single-cell edit -- a SIMPLE column only (the caller/server.js is
  // responsible for rejecting a compound column's cell before reaching
  // here, same "never trust the client alone" rule every other admin-
  // gated action on this dashboard follows). Returns the { status, reason }
  // written, or null if no such row/column cell exists (caller returns
  // 404).
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

  // Updates one stage's value (a status for type='status' stages, or free
  // text in `reason` for type='text' stages -- the caller/server.js has
  // already shaped status/reason correctly per the stage's own type,
  // same convention setCell() above is trusted with). Triggers a rollup
  // recompute for the parent column afterward when it's a status-type
  // stage. Returns the { status, reason } written, or null if no such
  // row/stage cell exists (caller returns 404); undefined if the stage
  // itself doesn't exist (caller returns 404 too, with a different
  // message).
  function setStage(rowId, stageId, status, reason, actor) {
    const stage = db.prepare('SELECT * FROM stages WHERE id = ?').get(stageId);
    if (!stage) return undefined;
    const existing = db.prepare('SELECT * FROM stage_status WHERE row_id = ? AND stage_id = ?').get(rowId, stageId);
    if (!existing) return null;
    db.prepare(
      `UPDATE stage_status SET status = $status, reason = $reason, updated_at = $updatedAt, updated_by_email = $email, updated_by_name = $name
       WHERE row_id = $rowId AND stage_id = $stageId`
    ).run({ $status: status, $reason: reason, $updatedAt: nowIso(), $email: actor.email, $name: actor.name, $rowId: rowId, $stageId: stageId });
    recordAudit({ rowId, stageId, oldStatus: existing.status, newStatus: status, oldReason: existing.reason, newReason: reason, actor });
    if (stage.type === 'status') recomputeRollup(rowId, stage.column_id, actor);
    return { status, reason };
  }

  // Sets every SIMPLE column's cell for one row to the same status/reason
  // -- mirrors tc-elite-rollout's own bulkSetCells(). Compound columns are
  // skipped entirely -- their cell_status is never directly settable,
  // only ever derived from their own stages (see bulkSetStages() below
  // for the detail-sheet equivalent). Returns the affected column ids.
  function bulkSetRow(rowId, status, reason, actor) {
    const columns = db.prepare(`SELECT id FROM columns WHERE kind = 'simple'`).all();
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
  // bulkSetColumnCells(). Caller/server.js rejects a compound column
  // before reaching here, same as setCell() above. Returns the affected
  // row ids.
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

  // Sets every STATUS-type stage's stage_status for one row, within one
  // compound column, to the same status/reason -- the detail-sheet
  // equivalent of bulkSetRow() above. text-type stages are skipped (they
  // hold free text, not a status). Recomputes the column's rollup for
  // this row afterward. Returns the affected stage ids.
  function bulkSetStages(rowId, columnId, status, reason, actor) {
    const stages = db.prepare(`SELECT id FROM stages WHERE column_id = ? AND type = 'status'`).all(columnId);
    db.exec('BEGIN');
    try {
      for (const stage of stages) {
        const existing = db.prepare('SELECT status, reason FROM stage_status WHERE row_id = ? AND stage_id = ?').get(rowId, stage.id);
        if (!existing) continue;
        db.prepare(
          `UPDATE stage_status SET status = $status, reason = $reason, updated_at = $updatedAt, updated_by_email = $email, updated_by_name = $name
           WHERE row_id = $rowId AND stage_id = $stageId`
        ).run({ $status: status, $reason: reason, $updatedAt: nowIso(), $email: actor.email, $name: actor.name, $rowId: rowId, $stageId: stage.id });
        recordAudit({ rowId, stageId: stage.id, oldStatus: existing.status, newStatus: status, oldReason: existing.reason, newReason: reason, actor });
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    recomputeRollup(rowId, columnId, actor);
    return stages.map((s) => s.id);
  }

  // Sets one stage's stage_status for a set of rows to the same value in
  // one go -- the column-based mirror of bulkSetStages() above (which
  // sets a whole row within one detail sheet). DOES support text-type
  // stages (setting every row's free-text field to the same string) --
  // server.js shapes status/reason correctly per stage.type first, same
  // convention PATCH .../stages/:rowId/:stageId already uses. Recomputes
  // the rollup for every affected row afterward, only if it's a
  // status-type stage. Returns the affected row ids.
  function bulkSetStageColumn(stageId, status, reason, actor, rowIds = null) {
    const stage = db.prepare('SELECT * FROM stages WHERE id = ?').get(stageId);
    const rows = rowIds ? rowIds.map((id) => ({ id })) : db.prepare('SELECT id FROM rows').all();
    db.exec('BEGIN');
    try {
      for (const row of rows) {
        const existing = db.prepare('SELECT status, reason FROM stage_status WHERE row_id = ? AND stage_id = ?').get(row.id, stageId);
        if (!existing) continue;
        db.prepare(
          `UPDATE stage_status SET status = $status, reason = $reason, updated_at = $updatedAt, updated_by_email = $email, updated_by_name = $name
           WHERE row_id = $rowId AND stage_id = $stageId`
        ).run({ $status: status, $reason: reason, $updatedAt: nowIso(), $email: actor.email, $name: actor.name, $rowId: row.id, $stageId: stageId });
        recordAudit({ rowId: row.id, stageId, oldStatus: existing.status, newStatus: status, oldReason: existing.reason, newReason: reason, actor });
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    if (stage.type === 'status') {
      for (const row of rows) recomputeRollup(row.id, stage.column_id, actor);
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
  // Purges stage_status rows too now, not just cell_status -- a row with
  // any compound-column stages would otherwise leave orphaned stage_status
  // rows behind referencing a now-gone row_id.
  function deleteRow(rowId) {
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM audit_log WHERE row_id = ?').run(rowId);
      db.prepare('DELETE FROM stage_status WHERE row_id = ?').run(rowId);
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
  // its response (columns[] now carrying `kind` too, rows with a `cells`
  // map keyed by column id -- a compound column's cell is just its
  // current rollup, same shape as a simple column's directly-set cell).
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
    return { columns: columns.map((c) => ({ id: c.id, key: c.key, label: c.label, kind: c.kind })), rows, totalRows: rows.length };
  }

  // One compound column's own detail grid -- every row x every stage of
  // that one column, unfiltered (rollout-tracker-server.js's own GET
  // .../columns/:columnId/detail applies the same "what's waiting to be
  // done" default filter the master grid uses, scoped to this column's
  // own status-type stages). Returns null if the column doesn't exist or
  // isn't compound (caller returns 404/400).
  function getColumnDetail(columnId) {
    const column = db.prepare('SELECT * FROM columns WHERE id = ?').get(columnId);
    if (!column || column.kind !== 'compound') return null;
    const stages = db.prepare('SELECT * FROM stages WHERE column_id = ? ORDER BY sort_order, id').all(columnId);
    const rowRows = db.prepare('SELECT id, name FROM rows ORDER BY name COLLATE NOCASE').all();
    const stageStatusRows = db.prepare(`SELECT ss.* FROM stage_status ss JOIN stages s ON s.id = ss.stage_id WHERE s.column_id = ?`).all(columnId);

    const cellsByRow = new Map();
    for (const row of stageStatusRows) {
      if (!cellsByRow.has(row.row_id)) cellsByRow.set(row.row_id, {});
      cellsByRow.get(row.row_id)[row.stage_id] = { status: row.status, reason: row.reason };
    }
    const rows = rowRows.map((r) => ({ id: r.id, name: r.name, cells: cellsByRow.get(r.id) || {} }));

    return {
      column: { id: column.id, key: column.key, label: column.label },
      stages: stages.map((s) => ({ id: s.id, key: s.key, label: s.label, type: s.type })),
      rows,
      totalRows: rows.length,
    };
  }

  // Last 200 audit rows for one cell, most recent first -- mirrors
  // tc-elite-rollout's own GET /cells/:clientId/:columnId/history.
  function getCellHistory(rowId, columnId) {
    return db.prepare('SELECT * FROM audit_log WHERE row_id = ? AND column_id = ? ORDER BY changed_at DESC LIMIT 200').all(rowId, columnId);
  }

  // Same, for one stage of a compound column's detail sheet.
  function getStageHistory(rowId, stageId) {
    return db.prepare('SELECT * FROM audit_log WHERE row_id = ? AND stage_id = ? ORDER BY changed_at DESC LIMIT 200').all(rowId, stageId);
  }

  return {
    db,
    nowIso,
    recordAudit,
    computeRollupStatus,
    recomputeRollup,
    seedNewRow,
    seedNewColumn,
    seedNewStage,
    addRow,
    addColumn,
    addStage,
    reorderColumns,
    setCell,
    setStage,
    bulkSetRow,
    bulkSetColumn,
    bulkSetStages,
    bulkSetStageColumn,
    renameRow,
    deleteRow,
    getGrid,
    getColumnDetail,
    getCellHistory,
    getStageHistory,
  };
}

module.exports = { createRolloutTrackerDb };
