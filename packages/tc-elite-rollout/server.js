const express = require('express');
const {
  db,
  nowIso,
  recordAudit,
  recomputeRollup,
  seedNewClient,
  seedNewColumn,
  seedNewStage,
  bulkSetCells,
  bulkSetStages,
  bulkSetColumnCells,
  bulkSetStageColumn,
  deleteClient,
  deleteStage,
} = require('./db.js');

const STATUSES = ['not_done', 'started', 'done', 'na', 'cancelled', 'issue'];
// Statuses that can carry an optional comment -- na's existing "why
// doesn't this apply" reason, cancelled's "why was this cancelled"
// comment, and issue's "what's the issue" comment. All stored in the
// same `reason` column.
const STATUSES_WITH_COMMENT = ['na', 'cancelled', 'issue'];

// { email, name } for whoever's making this request -- requireAuth (see
// packages/shell/auth.js) already guarantees a signed-in session before
// any route on this router runs, same as every other page's server.js.
function actorFrom(req) {
  return { email: req.session.user.email, name: req.session.user.name };
}

// Adding a whole new column to the grid, or a new stage to an existing
// compound column's detail sheet, changes what every client/staff member
// sees, unlike an ordinary status edit -- by request, both are restricted
// to a single person rather than every signed-in user. A single
// hardcoded email rather than a role/permissions table -- this is a
// one-person allowlist, not a general auth system; if that changes, this
// is the one place to generalise. Checked server-side (not just
// hidden/disabled client-side in client.js) since the client is just a
// UI convenience layer over this API, not the enforcement point.
const COLUMN_ADMIN_EMAIL = 'amber@ambientit.com.au';
function isColumnAdmin(actor) {
  return actor.email && actor.email.toLowerCase() === COLUMN_ADMIN_EMAIL;
}

// Column `key` is a stable slug derived from its label at creation time
// (used for joins/lookups, never shown to a user) -- lowercased,
// non-alphanumerics collapsed to underscores, and de-duplicated against
// whatever keys already exist so two columns can't silently collide (e.g.
// "RMM Policies" and "RMM  Policies" both wanting "rmm_policies").
function slugify(label) {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
// Validates the optional `clientIds` field a "Set Column" request can
// send to restrict a bulk-column-set to a specific set of clients (in
// practice: whichever rows client.js currently has rendered, respecting
// the Show All toggle -- see wireBulkColumnButtons()). true/array means
// valid (array is null for "field omitted -- every client", the
// pre-existing behaviour); false means malformed, caller should 400.
function isValidOptionalClientIds(body) {
  if (body.clientIds === undefined) return true;
  return Array.isArray(body.clientIds) && body.clientIds.every((id) => Number.isInteger(id));
}

function uniqueKey(baseKey, existingKeys) {
  if (!existingKeys.has(baseKey)) return baseKey;
  let n = 2;
  while (existingKeys.has(`${baseKey}_${n}`)) n++;
  return `${baseKey}_${n}`;
}

// A cell is "resolved" (nothing left to do) if done, na, or cancelled;
// "outstanding" otherwise. The default view hides columns where EVERY
// client's cell is resolved, then -- among the columns still visible
// after that -- hides client rows where every one of THOSE cells is
// resolved too. This is "what's waiting to be done" (see README): a
// client fully done except for one column everyone else has also already
// resolved shouldn't still clutter the default view.
const RESOLVED_STATUSES = ['done', 'na', 'cancelled'];
function applyDefaultFilter(columns, clients) {
  const visibleColumns = columns.filter((col) => clients.some((c) => {
    const cell = c.cells[col.id];
    return cell && !RESOLVED_STATUSES.includes(cell.status);
  }));
  const visibleColumnIds = new Set(visibleColumns.map((c) => c.id));
  const visibleClients = clients.filter((c) =>
    Object.entries(c.cells).some(([colId, cell]) => visibleColumnIds.has(Number(colId)) && !RESOLVED_STATUSES.includes(cell.status))
  );
  return { columns: visibleColumns, clients: visibleClients };
}

const router = express.Router();
router.use(express.json());

// The master grid -- every client x every column's current status.
// ?all=true bypasses the default "hide resolved columns/rows" filtering
// (applyDefaultFilter above) -- same "Show All" convention Service Calls'
// own "Show Completed" toggle uses (packages/service-calls/client.js).
router.get('/', (req, res) => {
  try {
    const columns = db.prepare('SELECT * FROM columns ORDER BY sort_order, id').all();
    const clientRows = db.prepare('SELECT * FROM clients ORDER BY name COLLATE NOCASE').all();
    const cellRows = db.prepare('SELECT * FROM cell_status').all();

    const cellsByClient = new Map();
    for (const row of cellRows) {
      if (!cellsByClient.has(row.client_id)) cellsByClient.set(row.client_id, {});
      cellsByClient.get(row.client_id)[row.column_id] = {
        status: row.status,
        reason: row.reason,
        updatedAt: row.updated_at,
        updatedByName: row.updated_by_name,
      };
    }

    let clients = clientRows.map((c) => ({
      id: c.id,
      name: c.name,
      activeContract: c.active_contract,
      comment: c.comment,
      contractSigned: c.contract_signed,
      cells: cellsByClient.get(c.id) || {},
    }));
    let shapedColumns = columns.map((col) => ({ id: col.id, key: col.key, label: col.label, kind: col.kind }));

    // Captured before filtering -- the true total, for the "(visible/
    // total)" count next to the Client header (client.js), regardless of
    // whether this request itself is filtered or ?all=true.
    const totalClients = clients.length;

    if (req.query.all !== 'true') {
      const filtered = applyDefaultFilter(shapedColumns, clients);
      shapedColumns = filtered.columns;
      clients = filtered.clients;
    }

    res.json({ columns: shapedColumns, clients, totalClients });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// One compound column's own detail grid -- every client x every stage of
// that one column. Used when a "Show <X> detail" button below the master
// table is clicked (client.js shows only one of these at a time).
router.get('/columns/:columnId/detail', (req, res) => {
  try {
    const columnId = Number(req.params.columnId);
    const column = db.prepare('SELECT * FROM columns WHERE id = ?').get(columnId);
    if (!column) return res.status(404).json({ error: 'Column not found.' });
    if (column.kind !== 'compound') return res.status(400).json({ error: 'Column has no detail sheet -- it is not compound.' });

    const stages = db.prepare('SELECT * FROM stages WHERE column_id = ? ORDER BY sort_order, id').all(columnId);
    const clientRows = db.prepare('SELECT id, name FROM clients ORDER BY name COLLATE NOCASE').all();
    const stageStatusRows = db
      .prepare(
        `SELECT ss.* FROM stage_status ss JOIN stages s ON s.id = ss.stage_id WHERE s.column_id = ?`
      )
      .all(columnId);

    const cellsByClient = new Map();
    for (const row of stageStatusRows) {
      if (!cellsByClient.has(row.client_id)) cellsByClient.set(row.client_id, {});
      cellsByClient.get(row.client_id)[row.stage_id] = { status: row.status, reason: row.reason, updatedAt: row.updated_at, updatedByName: row.updated_by_name };
    }

    let clients = clientRows.map((c) => ({ id: c.id, name: c.name, cells: cellsByClient.get(c.id) || {} }));
    const totalClients = clients.length; // captured before filtering, same reasoning as GET / above

    // Same "what's waiting to be done" default filtering as the master
    // grid (applyDefaultFilter above), just scoped to one column's own
    // stages instead of every column -- rows only (a detail sheet has no
    // separate "columns" to hide beyond its own stages, and hiding a
    // whole STAGE by request wasn't asked for here, only rows). Only
    // status-type stages count -- text-type ones (WHO, Domain, Comment)
    // are informational and never "outstanding" in their own right, same
    // exclusion the rollup itself uses.
    if (req.query.all !== 'true') {
      const statusStageIds = stages.filter((s) => s.type === 'status').map((s) => s.id);
      clients = clients.filter((c) =>
        statusStageIds.some((stageId) => {
          const cell = c.cells[stageId];
          return cell && !RESOLVED_STATUSES.includes(cell.status);
        })
      );
    }

    res.json({
      column: { id: column.id, key: column.key, label: column.label },
      stages: stages.map((s) => ({ id: s.id, key: s.key, label: s.label, type: s.type })),
      clients,
      totalClients,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Set every STATUS-type stage's status for one client, within one
// compound column's detail sheet, in one go -- the detail-sheet
// equivalent of PATCH /clients/:clientId/bulk-cells above. See
// bulkSetStages() in db.js -- text-type stages are silently skipped.
router.patch('/columns/:columnId/clients/:clientId/bulk-stages', (req, res) => {
  try {
    const columnId = Number(req.params.columnId);
    const clientId = Number(req.params.clientId);
    const column = db.prepare('SELECT * FROM columns WHERE id = ?').get(columnId);
    if (!column) return res.status(404).json({ error: 'Column not found.' });
    if (column.kind !== 'compound') return res.status(400).json({ error: 'Only compound columns have a detail sheet to bulk-set.' });
    const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(clientId);
    if (!client) return res.status(404).json({ error: 'Client not found.' });
    const { status, reason } = req.body || {};
    if (!STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}.` });
    const newReason = STATUSES_WITH_COMMENT.includes(status) ? reason || null : null;
    const stageIds = bulkSetStages(clientId, columnId, status, newReason, actorFrom(req));
    res.json({ status, reason: newReason, stageIds });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Add a client row -- seeds not_done (or na, if a compound column
// genuinely has zero stages yet) across every existing column, per
// seedNewClient() in db.js.
router.post('/clients', (req, res) => {
  try {
    const { name, activeContract, comment, contractSigned } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required.' });
    const actor = actorFrom(req);

    const existing = db.prepare('SELECT id FROM clients WHERE name = ?').get(name.trim());
    if (existing) return res.status(409).json({ error: `A client named "${name.trim()}" already exists.` });

    const info = db
      .prepare(
        `INSERT INTO clients (name, active_contract, comment, contract_signed, created_at, created_by_email, created_by_name)
         VALUES ($name, $activeContract, $comment, $contractSigned, $createdAt, $email, $createdByName)`
      )
      .run({
        $name: name.trim(),
        $activeContract: activeContract || null,
        $comment: comment || null,
        $contractSigned: contractSigned || null,
        $createdAt: nowIso(),
        $email: actor.email,
        $createdByName: actor.name,
      });
    const clientId = Number(info.lastInsertRowid);
    recordAudit({ entityType: 'client', clientId, newStatus: null, actor });
    seedNewClient(clientId, actor);
    res.status(201).json({ id: clientId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Set every SIMPLE column's status for one client in one go -- by
// request, for a client where the same value genuinely applies across
// the board (e.g. "too small" N/A everywhere) rather than clicking each
// cell individually. See bulkSetCells() in db.js -- compound columns are
// silently skipped, never directly settable.
router.patch('/clients/:clientId/bulk-cells', (req, res) => {
  try {
    const clientId = Number(req.params.clientId);
    const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(clientId);
    if (!client) return res.status(404).json({ error: 'Client not found.' });
    const { status, reason } = req.body || {};
    if (!STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}.` });
    const newReason = STATUSES_WITH_COMMENT.includes(status) ? reason || null : null;
    const columnIds = bulkSetCells(clientId, status, newReason, actorFrom(req));
    res.json({ status, reason: newReason, columnIds });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Set one SIMPLE column's status for a set of clients in one go -- the
// column-based mirror of PATCH /clients/:clientId/bulk-cells above (which
// sets a whole row). Optional `clientIds` in the body restricts to just
// those (client.js sends whichever rows are currently rendered, i.e.
// "visible" respecting the Show All toggle); omit it for every client.
// See bulkSetColumnCells() in db.js. Compound columns are rejected
// outright -- their cell_status is never directly settable, only ever
// derived from their own stages.
router.patch('/columns/:columnId/bulk-cells', (req, res) => {
  try {
    const columnId = Number(req.params.columnId);
    const column = db.prepare('SELECT * FROM columns WHERE id = ?').get(columnId);
    if (!column) return res.status(404).json({ error: 'Column not found.' });
    if (column.kind !== 'simple') return res.status(400).json({ error: `This column is compound -- edit its stages instead, not the whole column directly.` });
    const body = req.body || {};
    const { status, reason } = body;
    if (!STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}.` });
    if (!isValidOptionalClientIds(body)) return res.status(400).json({ error: 'clientIds must be an array of integers if provided.' });
    const newReason = STATUSES_WITH_COMMENT.includes(status) ? reason || null : null;
    const affectedIds = bulkSetColumnCells(columnId, status, newReason, actorFrom(req), body.clientIds || null);
    res.json({ status, reason: newReason, clientIds: affectedIds });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Set one stage's value for a set of clients in one go -- the
// column-based mirror of PATCH /columns/:columnId/clients/:clientId/bulk-stages
// above (which sets a whole row within one detail sheet). Same optional
// `clientIds` restriction as PATCH /columns/:columnId/bulk-cells above.
// Unlike that route, this one DOES accept text-type stages (setting
// every client's WHO/Domain/Comment field to the same string), same
// status/text shaping PATCH /stages/:clientId/:stageId already uses per
// stage.type. See bulkSetStageColumn() in db.js.
router.patch('/stages/:stageId/bulk-status', (req, res) => {
  try {
    const stageId = Number(req.params.stageId);
    const stage = db.prepare('SELECT * FROM stages WHERE id = ?').get(stageId);
    if (!stage) return res.status(404).json({ error: 'Stage not found.' });

    const body = req.body || {};
    if (!isValidOptionalClientIds(body)) return res.status(400).json({ error: 'clientIds must be an array of integers if provided.' });

    let newStatus;
    let newReason;
    if (stage.type === 'text') {
      newStatus = null;
      newReason = body.reason || null;
    } else {
      const { status, reason } = body;
      if (!STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}.` });
      newStatus = status;
      newReason = STATUSES_WITH_COMMENT.includes(status) ? reason || null : null;
    }

    const affectedIds = bulkSetStageColumn(stageId, newStatus, newReason, actorFrom(req), body.clientIds || null);
    res.json({ status: newStatus, reason: newReason, clientIds: affectedIds });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Hard delete -- see deleteClient()'s own comment in db.js for why this
// purges the client's audit history too rather than leaving a trace.
router.delete('/clients/:clientId', (req, res) => {
  try {
    const clientId = Number(req.params.clientId);
    const existing = db.prepare('SELECT id FROM clients WHERE id = ?').get(clientId);
    if (!existing) return res.status(404).json({ error: 'Client not found.' });
    deleteClient(clientId);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Add a column -- kind 'simple' (no stages) or 'compound' (an initial
// stage list, each { label, type: 'status'|'text' }). Seeds every
// existing client per seedNewColumn() in db.js.
router.post('/columns', (req, res) => {
  try {
    const actor = actorFrom(req);
    if (!isColumnAdmin(actor)) return res.status(403).json({ error: 'See Amber to authorise this function.' });

    const { label, kind, stages } = req.body || {};
    if (!label || !String(label).trim()) return res.status(400).json({ error: 'label is required.' });
    if (kind !== 'simple' && kind !== 'compound') return res.status(400).json({ error: `kind must be "simple" or "compound".` });

    const existingKeys = new Set(db.prepare('SELECT key FROM columns').all().map((r) => r.key));
    const key = uniqueKey(slugify(label), existingKeys);
    const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM columns').get().m;

    const info = db
      .prepare(
        `INSERT INTO columns (key, label, kind, sort_order, created_at, created_by_email, created_by_name)
         VALUES ($key, $label, $kind, $sortOrder, $createdAt, $email, $name)`
      )
      .run({ $key: key, $label: label.trim(), $kind: kind, $sortOrder: maxSort + 1, $createdAt: nowIso(), $email: actor.email, $name: actor.name });
    const columnId = Number(info.lastInsertRowid);
    recordAudit({ entityType: 'column', columnId, actor });

    const createdStages = []; // { id, type } for every stage just created, status AND text
    if (kind === 'compound' && Array.isArray(stages)) {
      const existingStageKeys = new Set();
      let stageSort = 0;
      for (const s of stages) {
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
        recordAudit({ entityType: 'stage', columnId, stageId, actor });
        createdStages.push({ id: stageId, type });
      }
    }

    seedNewColumn(columnId, kind, createdStages, actor);
    res.status(201).json({ id: columnId, key });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Add a stage to an already-existing compound column -- seeds not_done for
// every existing client and recomputes their rollup for this column (see
// seedNewStage() in db.js -- a freshly added stage can change what "all
// done" means for clients that were previously fully done on it).
router.post('/columns/:columnId/stages', (req, res) => {
  try {
    const actor = actorFrom(req);
    if (!isColumnAdmin(actor)) return res.status(403).json({ error: 'See Amber to authorise this function.' });

    const columnId = Number(req.params.columnId);
    const column = db.prepare('SELECT * FROM columns WHERE id = ?').get(columnId);
    if (!column) return res.status(404).json({ error: 'Column not found.' });
    if (column.kind !== 'compound') return res.status(400).json({ error: 'Only compound columns can have stages.' });

    const { label, type } = req.body || {};
    if (!label || !String(label).trim()) return res.status(400).json({ error: 'label is required.' });
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
    recordAudit({ entityType: 'stage', columnId, stageId, actor });

    seedNewStage({ id: stageId, type: stageType }, columnId, actor);
    res.status(201).json({ id: stageId, key });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Hard delete -- see deleteStage()'s own comment in db.js. Recomputes
// every client's rollup for the parent column afterward if it was a
// status-type stage.
router.delete('/stages/:stageId', (req, res) => {
  try {
    const stageId = Number(req.params.stageId);
    const stage = db.prepare('SELECT id FROM stages WHERE id = ?').get(stageId);
    if (!stage) return res.status(404).json({ error: 'Stage not found.' });
    deleteStage(stageId, actorFrom(req));
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Update a SIMPLE column's status directly. Compound columns are rejected
// here -- their cell_status is only ever derived by recomputeRollup(), see
// PATCH /stages/:clientId/:stageId below for the actual editable surface.
router.patch('/cells/:clientId/:columnId', (req, res) => {
  try {
    const clientId = Number(req.params.clientId);
    const columnId = Number(req.params.columnId);
    const { status, reason } = req.body || {};
    if (!STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}.` });

    const column = db.prepare('SELECT * FROM columns WHERE id = ?').get(columnId);
    if (!column) return res.status(404).json({ error: 'Column not found.' });
    if (column.kind !== 'simple') return res.status(400).json({ error: 'This column is compound -- edit its stages instead, not the cell directly.' });

    const existing = db.prepare('SELECT * FROM cell_status WHERE client_id = ? AND column_id = ?').get(clientId, columnId);
    if (!existing) return res.status(404).json({ error: 'No such client/column.' });

    const actor = actorFrom(req);
    const newReason = STATUSES_WITH_COMMENT.includes(status) ? reason || null : null;
    db.prepare(
      `UPDATE cell_status SET status = $status, reason = $reason, updated_at = $updatedAt, updated_by_email = $email, updated_by_name = $name
       WHERE client_id = $clientId AND column_id = $columnId`
    ).run({ $status: status, $reason: newReason, $updatedAt: nowIso(), $email: actor.email, $name: actor.name, $clientId: clientId, $columnId: columnId });

    recordAudit({
      entityType: 'cell',
      clientId,
      columnId,
      oldStatus: existing.status,
      newStatus: status,
      oldReason: existing.reason,
      newReason,
      actor,
    });
    res.json({ status, reason: newReason });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Update one stage's value -- a status (Not Done/Started/Done/N/A + reason)
// for type='status' stages, or free text (stored in `reason`, status left
// null) for type='text' stages. Triggers a rollup recompute for the
// parent column afterward.
router.patch('/stages/:clientId/:stageId', (req, res) => {
  try {
    const clientId = Number(req.params.clientId);
    const stageId = Number(req.params.stageId);
    const stage = db.prepare('SELECT * FROM stages WHERE id = ?').get(stageId);
    if (!stage) return res.status(404).json({ error: 'Stage not found.' });

    const existing = db.prepare('SELECT * FROM stage_status WHERE client_id = ? AND stage_id = ?').get(clientId, stageId);
    if (!existing) return res.status(404).json({ error: 'No such client/stage.' });

    const actor = actorFrom(req);
    let newStatus;
    let newReason;
    if (stage.type === 'text') {
      newStatus = null;
      newReason = (req.body && req.body.reason) || null;
    } else {
      const { status, reason } = req.body || {};
      if (!STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}.` });
      newStatus = status;
      newReason = STATUSES_WITH_COMMENT.includes(status) ? reason || null : null;
    }

    db.prepare(
      `UPDATE stage_status SET status = $status, reason = $reason, updated_at = $updatedAt, updated_by_email = $email, updated_by_name = $name
       WHERE client_id = $clientId AND stage_id = $stageId`
    ).run({ $status: newStatus, $reason: newReason, $updatedAt: nowIso(), $email: actor.email, $name: actor.name, $clientId: clientId, $stageId: stageId });

    recordAudit({
      entityType: 'stage_cell',
      clientId,
      stageId,
      oldStatus: existing.status,
      newStatus,
      oldReason: existing.reason,
      newReason,
      actor,
    });

    if (stage.type === 'status') recomputeRollup(clientId, stage.column_id, actor);
    res.json({ status: newStatus, reason: newReason });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Recent history for one master-grid cell -- fetched on demand (hover for
// the most-recent-change tooltip on every cell, and again for the "view
// full history" window). Limited to 200 -- generous enough to be "the
// full history" for any real cell in practice, without an unbounded
// query against a table that's genuinely append-only forever.
router.get('/cells/:clientId/:columnId/history', (req, res) => {
  try {
    const clientId = Number(req.params.clientId);
    const columnId = Number(req.params.columnId);
    const rows = db
      .prepare(`SELECT * FROM audit_log WHERE client_id = ? AND column_id = ? AND entity_type = 'cell' ORDER BY changed_at DESC LIMIT 200`)
      .all(clientId, columnId);
    res.json({ history: rows.map(shapeAuditRow) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/stages/:clientId/:stageId/history', (req, res) => {
  try {
    const clientId = Number(req.params.clientId);
    const stageId = Number(req.params.stageId);
    const rows = db
      .prepare(`SELECT * FROM audit_log WHERE client_id = ? AND stage_id = ? AND entity_type = 'stage_cell' ORDER BY changed_at DESC LIMIT 200`)
      .all(clientId, stageId);
    res.json({ history: rows.map(shapeAuditRow) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

function shapeAuditRow(row) {
  return {
    changedAt: row.changed_at,
    changedByName: row.changed_by_name,
    oldStatus: row.old_status,
    newStatus: row.new_status,
    oldReason: row.old_reason,
    newReason: row.new_reason,
  };
}

module.exports = router;
