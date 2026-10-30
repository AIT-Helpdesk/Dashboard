const express = require('express');
const fs = require('fs');
const path = require('path');
const { createRolloutTrackerDb } = require('./rollout-tracker-db.js');
const { readNavLayout, writeNavLayout, unregisterPage } = require('./registry.js');
const {
  TRACKERS_CATEGORY_ID,
  TRACKERS_CATEGORY_LABEL,
  TRACKERS_COMPLETE_CATEGORY_ID,
  TRACKERS_COMPLETE_CATEGORY_LABEL,
  movePageToCategory,
  removePageNode,
} = require('./rollout-tracker-nav.js');
const { isTrackerManager } = require('./rollout-tracker-permissions.js');

// Compound columns and their own detail-sheet "stages" -- ported from
// tc-elite-rollout/server.js (by request, Oct 2026), so every tracker
// built with Rollout Tracker Builder gets the same "simple column or
// compound column (with its own stages)" choice TC Elite Rollout's own
// Add Column already had. Stage edits (PATCH .../stages/:rowId/:stageId,
// the two bulk-stage routes) are open to every signed-in user, same as an
// ordinary simple-column cell edit -- only STRUCTURAL changes (adding the
// column/stage itself) are Tracker Manager-gated below, matching the
// existing "adding a row stays open to everyone, adding a column doesn't"
// split this file already follows.

// Shared, generic rollout-tracker router factory -- extracted from
// tc-elite-rollout's own server.js, simple-column subset only (see
// rollout-tracker-db.js's own comment for why no stages/compound
// columns). createRolloutTrackerRouter(storageDir, { rowNoun }) is called
// once per generated tracker's own thin server.js, passing that package's
// own __dirname -- each tracker gets its own independent data.db living
// alongside it, same as tc-elite-rollout's own single-page db.js.
//
// req.session.user is guaranteed present -- every generated page's router
// is mounted behind the dashboard-wide requireAuth (see
// mountPageRouterImpl in shell/server.js), same as every other page here.
const STATUSES = ['not_done', 'started', 'done', 'na', 'cancelled', 'issue', 'note'];
// Same optional-comment set as tc-elite-rollout, plus 'note' -- but note's
// comment is REQUIRED (checked separately in PATCH /cells below), not
// merely accepted like na/cancelled/issue's.
const STATUSES_WITH_COMMENT = ['na', 'cancelled', 'issue', 'note'];
// A cell is "resolved" (nothing left to do) if done, na, or cancelled --
// same RESOLVED_STATUSES rule tc-elite-rollout/server.js uses. 'issue' and
// 'note' both stay visible in the default filtered view until cleared --
// a note is an annotation someone still needs to see, not a completed
// action.
const RESOLVED_STATUSES = ['done', 'na', 'cancelled'];

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

function isValidOptionalRowIds(body) {
  if (body.rowIds === undefined) return true;
  return Array.isArray(body.rowIds) && body.rowIds.every((id) => Number.isInteger(id));
}

function actorFrom(req) {
  return { email: req.session.user.email, name: req.session.user.name };
}

function applyDefaultFilter(columns, rows) {
  const columnById = new Map(columns.map((c) => [c.id, c]));
  // A text column (free-text master cell, by request) is purely
  // informational, same as a compound column's own text-type stage --
  // never hidden by the default filter, and never what makes a ROW count
  // as "outstanding" either (its placeholder status never actually
  // means anything, see cell_type's own comment in rollout-tracker-db.js).
  const visibleColumns = columns.filter((col) => {
    if (col.cellType === 'text') return true;
    return rows.some((r) => {
      const cell = r.cells[col.id];
      return cell && !RESOLVED_STATUSES.includes(cell.status);
    });
  });
  const visibleColumnIds = new Set(visibleColumns.map((c) => c.id));
  const visibleRows = rows.filter((r) =>
    Object.entries(r.cells).some(([colId, cell]) => {
      const id = Number(colId);
      if (!visibleColumnIds.has(id)) return false;
      const col = columnById.get(id);
      if (col && col.cellType === 'text') return false;
      return !RESOLVED_STATUSES.includes(cell.status);
    })
  );
  return { columns: visibleColumns, rows: visibleRows };
}

// Same "what's waiting to be done" default filtering as applyDefaultFilter
// above, scoped to one compound column's own detail sheet -- now also
// hides a fully-resolved STAGE (not just rows), the stage-side mirror of
// applyDefaultFilter's own visibleColumns. Confirmed missing (Oct 2026):
// the detail sheet kept showing every stage even when every row's cell
// for it was Done/N/A/Cancelled, unlike the master grid's own columns.
// Only status-type stages count -- text-type ones are informational and
// never "outstanding" in their own right, same exclusion the rollup
// itself uses (see computeRollupStatus() in rollout-tracker-db.js), and
// are never hidden here either, same as applyDefaultFilter's own
// text-column rule.
function applyDetailDefaultFilter(stages, rows) {
  const statusStages = stages.filter((s) => s.type === 'status');
  const visibleStages = stages.filter((s) => {
    if (s.type !== 'status') return true;
    return rows.some((r) => {
      const cell = r.cells[s.id];
      return cell && !RESOLVED_STATUSES.includes(cell.status);
    });
  });
  const visibleRows = rows.filter((r) =>
    statusStages.some((s) => {
      const cell = r.cells[s.id];
      return cell && !RESOLVED_STATUSES.includes(cell.status);
    })
  );
  return { stages: visibleStages, rows: visibleRows };
}

// The sub-row mirror of applyDetailDefaultFilter above, for a compound
// ROW's own detail sheet -- same fix, now also hides a fully-resolved
// COLUMN here, not just sub-rows. Every column here is already filtered
// to status-type-simple ones by getRowDetail() itself, so (unlike the
// stage-side version) there's no type to check, just the "outstanding
// somewhere" test, applied to columns as well as sub-rows.
function applyRowDetailDefaultFilter(columns, subRows) {
  const visibleColumns = columns.filter((col) =>
    subRows.some((sr) => {
      const cell = sr.cells[col.id];
      return cell && !RESOLVED_STATUSES.includes(cell.status);
    })
  );
  const visibleSubRows = subRows.filter((sr) =>
    columns.some((col) => {
      const cell = sr.cells[col.id];
      return cell && !RESOLVED_STATUSES.includes(cell.status);
    })
  );
  return { columns: visibleColumns, subRows: visibleSubRows };
}

// Validates the optional `rowIds` a stage's "Set Column" bulk request can
// send to restrict to a specific set of rows (in practice: whichever rows
// client.js currently has rendered on that detail sheet).
function isValidOptionalStageRowIds(body) {
  if (body.rowIds === undefined) return true;
  return Array.isArray(body.rowIds) && body.rowIds.every((id) => Number.isInteger(id));
}

// The sub-row mirror of isValidOptionalStageRowIds above -- validates the
// optional `subRowIds` a compound row's "Set [column]" bulk request can
// send to restrict to a specific set of sub-rows.
function isValidOptionalSubRowIds(body) {
  if (body.subRowIds === undefined) return true;
  return Array.isArray(body.subRowIds) && body.subRowIds.every((id) => Number.isInteger(id));
}

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

// The Notes field's rich text stays deliberately basic (bold/italic/
// underline/strikethrough/lists/links -- see rollout-tracker-client.js's
// own toolbar), so the allowlist can be just as small. Every tag not in
// this list -- and EVERY attribute on every tag, allowed or not -- is
// stripped entirely, which is what actually matters here: an attribute is
// the only place an onclick=/onerror=/javascript: href could live, so
// refusing to keep any attribute at all (rather than trying to allowlist
// individual safe ones) closes off that whole class of stored-XSS in one
// rule, without needing a full HTML-parser dependency for a field this
// narrow in scope. Written to notes.json only through this -- never trust
// the browser's own execCommand output to already be clean.
//
// `a` is the one tag that NEEDS an attribute (href) to mean anything, so
// it gets its own narrow carve-out below rather than joining the blanket
// "no attributes, ever" rule the rest of this list follows: its href is
// extracted, scheme-checked against SAFE_HREF_SCHEME (http(s)/mailto only
// -- a javascript:/data: URI in href is the exact stored-XSS vector this
// sanitizer exists to block), and target="_blank"/rel="noopener noreferrer"
// are always force-set server-side, regardless of what the client sent
// (defense in depth -- rollout-tracker-client.js's own insertNotesLink()
// already sets these too, but this is the actual trust boundary). A
// missing or unsafe href drops the link but keeps the text, rather than
// dropping the whole tag and losing content.
const NOTES_ALLOWED_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'strike', 'ul', 'ol', 'li', 'br', 'div', 'p', 'a']);
const SAFE_HREF_SCHEME = /^(https?:|mailto:)/i;
function sanitizeNotesHtml(html) {
  if (typeof html !== 'string') return '';
  return html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (match, tagName, attrs) => {
    const tag = tagName.toLowerCase();
    if (!NOTES_ALLOWED_TAGS.has(tag)) return '';
    if (match.startsWith('</')) return `</${tag}>`;
    if (tag === 'a') {
      const hrefMatch = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
      const rawHref = (hrefMatch ? hrefMatch[1] ?? hrefMatch[2] : '').replace(/&amp;/g, '&').trim();
      if (!SAFE_HREF_SCHEME.test(rawHref)) return '<a>';
      return `<a href="${rawHref.replace(/"/g, '&quot;')}" target="_blank" rel="noopener noreferrer">`;
    }
    return `<${tag}>`;
  });
}

function createRolloutTrackerRouter(storageDir, { rowNoun = 'Item' } = {}) {
  const {
    db,
    addRow,
    addColumn,
    addStage,
    addSubRow,
    addSubRowColumn,
    reorderColumns,
    reorderStages,
    setCell,
    setStage,
    setSubRowCell,
    setSubRowColumnValue,
    bulkSetRow,
    bulkSetColumn,
    bulkSetStages,
    bulkSetStageColumn,
    bulkSetSubRow,
    bulkSetColumnAcrossSubRows,
    renameRow,
    renameColumn,
    deleteRow,
    getGrid,
    getColumnDetail,
    getRowDetail,
    getCellHistory,
    getStageHistory,
    getSubRowHistory,
    getSubRowColumnHistory,
  } = createRolloutTrackerDb(path.join(storageDir, 'data.db'));
  // The generated package folder's own name IS this tracker's page id --
  // Rollout Tracker Builder names the folder exactly `<slug>-tracker` and
  // that same slug is this page's dashboardPage.id (see
  // rollout-tracker-builder/server.js), so no separate id needs passing
  // in just for Hide Complete/Un-Complete This to know which nav-layout
  // node is theirs.
  const pageId = path.basename(storageDir);

  // Plain JSON file, same read/write-and-swallow-errors pattern as
  // shell/registry.js's own readNavLayout()/writeNavLayout() and
  // tab-page-server.js's own help-text.json -- a tracker's Notes field is
  // shared, admin-authored, free-form content, not per-row application
  // data, so it doesn't belong in data.db alongside rows/columns/cells.
  const notesPath = path.join(storageDir, 'notes.json');
  function readNotesHtml() {
    try {
      const data = JSON.parse(fs.readFileSync(notesPath, 'utf8'));
      return typeof data.html === 'string' ? data.html : '';
    } catch {
      return ''; // no file yet, or unreadable -- no notes yet
    }
  }
  function writeNotesHtml(html) {
    const sanitized = sanitizeNotesHtml(html);
    fs.writeFileSync(notesPath, JSON.stringify({ html: sanitized }));
    return sanitized;
  }

  const router = express.Router();
  router.use(express.json());

  router.get('/', (req, res) => {
    try {
      const { columns, rows, totalRows } = getGrid();
      const shaped = req.query.all === 'true' ? { columns, rows } : applyDefaultFilter(columns, rows);
      // isManager rides along on every grid load -- rollout-tracker-
      // client.js uses it to show/hide Add Column and Tracking Complete/
      // Un-Complete This, rather than a separate /api/me round trip.
      res.json({ columns: shaped.columns, rows: shaped.rows, totalRows, rowNoun, isManager: isTrackerManager(req) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // `kind` is 'simple' (the pre-existing behaviour, default if omitted)
  // or 'compound' -- an initial sub-row label list, by request ("Need
  // Compound Rows as well as Compound Columns"), same "typed in right on
  // the Add form" shape POST /columns' own initial stage list already
  // uses. A compound row needs at least one real (non-blank) sub-row,
  // same validation a compound column's own stage list enforces.
  router.post('/rows', (req, res) => {
    try {
      const name = (req.body?.name || '').trim();
      if (!name) return res.status(400).json({ error: `${rowNoun} name is required.` });
      const kind = req.body?.kind === 'compound' ? 'compound' : 'simple';
      const subRows = Array.isArray(req.body?.subRows) ? req.body.subRows.map((s) => String(s).trim()).filter(Boolean) : [];
      if (kind === 'compound' && subRows.length === 0) {
        return res.status(400).json({ error: 'A compound row needs at least one sub-row.' });
      }
      const rowId = addRow(name, kind, subRows, actorFrom(req));
      if (rowId === null) return res.status(409).json({ error: `A ${rowNoun.toLowerCase()} named "${name}" already exists.` });
      res.status(201).json({ id: rowId, name, kind });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // Bulk-add -- one POST per line typed into a textarea client-side,
  // rather than clicking Add {rowNoun} repeatedly. Open to everyone, same
  // as the single-row POST /rows above -- a batch of the exact same
  // ungated action isn't a new permission. Duplicates (a name already in
  // the tracker) are skipped rather than failing the whole batch, same
  // "don't let one bad row block the rest" reasoning as bulkSetCells etc.
  // in rollout-tracker-db.js.
  router.post('/rows/bulk', (req, res) => {
    try {
      const names = Array.isArray(req.body?.names) ? req.body.names.map((s) => String(s).trim()).filter(Boolean) : [];
      if (names.length === 0) return res.status(400).json({ error: `At least one ${rowNoun.toLowerCase()} name is required.` });
      const actor = actorFrom(req);
      const added = [];
      const skipped = [];
      for (const name of names) {
        // Always 'simple' -- bulk-add is a plain list of names, same as
        // Rollout Tracker Builder's own creation-time row seeding; a
        // compound row (with its own sub-rows) is added afterward via
        // the single Add {rowNoun} form above.
        const rowId = addRow(name, 'simple', [], actor);
        if (rowId === null) skipped.push(name);
        else added.push({ id: rowId, name });
      }
      res.status(201).json({ added, skipped });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  router.patch('/rows/:rowId/name', (req, res) => {
    try {
      const rowId = Number(req.params.rowId);
      const name = (req.body?.name || '').trim();
      if (!name) return res.status(400).json({ error: `${rowNoun} name is required.` });
      const dupe = db.prepare('SELECT id FROM rows WHERE name = ? AND id != ?').get(name, rowId);
      if (dupe) return res.status(409).json({ error: `A ${rowNoun.toLowerCase()} named "${name}" already exists.` });
      const newName = renameRow(rowId, name, actorFrom(req));
      if (newName === null) return res.status(404).json({ error: `No such ${rowNoun.toLowerCase()}.` });
      res.json({ name: newName });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/rows/:rowId', (req, res) => {
    try {
      const rowId = Number(req.params.rowId);
      const row = db.prepare('SELECT id FROM rows WHERE id = ?').get(rowId);
      if (!row) return res.status(404).json({ error: `No such ${rowNoun.toLowerCase()}.` });
      deleteRow(rowId);
      res.status(204).end();
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // Tracker Manager-only -- changing what's tracked affects everyone
  // looking at this tracker (see rollout-tracker-permissions.js). `kind`
  // is 'simple' (the pre-existing behaviour, default if omitted for
  // backward compatibility with any caller still sending just `label`)
  // or 'compound' -- an initial stage list, each { label, type:
  // 'status'|'text' }, same shape tc-elite-rollout's own POST /columns
  // accepts. A compound column needs at least one real (non-blank-label)
  // stage, same validation tc-elite-rollout/client.js's own Add Column
  // form enforces client-side. `cellType` ('status' or 'text') only
  // matters for kind='simple' -- forced to 'status' for a compound
  // column, same as addColumn() itself already does -- a Text column is
  // the master-grid equivalent of a compound column's own text-type
  // stage, by request.
  router.post('/columns', (req, res) => {
    try {
      if (!isTrackerManager(req)) {
        return res.status(403).json({ error: 'Only a Tracker Manager can add a column.' });
      }
      const label = (req.body?.label || '').trim();
      if (!label) return res.status(400).json({ error: 'Column label is required.' });
      const kind = req.body?.kind === 'compound' ? 'compound' : 'simple';
      const cellType = kind === 'simple' && req.body?.cellType === 'text' ? 'text' : 'status';
      const stages = Array.isArray(req.body?.stages) ? req.body.stages : [];
      if (kind === 'compound' && stages.filter((s) => s && String(s.label || '').trim()).length === 0) {
        return res.status(400).json({ error: 'A compound column needs at least one stage.' });
      }
      const existingKeys = new Set(db.prepare('SELECT key FROM columns').all().map((c) => c.key));
      const key = uniqueKey(slugify(label), existingKeys);
      const columnId = addColumn(label, key, kind, cellType, stages, actorFrom(req));
      res.status(201).json({ id: columnId, key, label, kind, cellType });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // Renames a column -- Tracker Manager-only, same reasoning as Add
  // Column/reordering (a shared, structural change everyone viewing this
  // tracker sees). No duplicate check, unlike PATCH /rows/:rowId/name --
  // columns.label has never been required to be unique (only columns.key
  // is), so renaming to match another column's existing label is
  // allowed, same as Add Column already allows at creation time.
  router.patch('/columns/:columnId/label', (req, res) => {
    try {
      if (!isTrackerManager(req)) {
        return res.status(403).json({ error: 'Only a Tracker Manager can rename a column.' });
      }
      const columnId = Number(req.params.columnId);
      const label = (req.body?.label || '').trim();
      if (!label) return res.status(400).json({ error: 'Column label is required.' });
      const newLabel = renameColumn(columnId, label, actorFrom(req));
      if (newLabel === null) return res.status(404).json({ error: 'Column not found.' });
      res.json({ label: newLabel });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // One compound column's own detail grid -- every row x every stage of
  // that one column. Used when a "Show <X> Detail" button below the
  // master table is clicked. Viewable by anyone who can see the master
  // grid (same as an ordinary cell) -- only adding the column/a stage is
  // Tracker Manager-gated, not viewing/editing an already-added one.
  // ?all=true bypasses the default filter, same convention as GET /.
  router.get('/columns/:columnId/detail', (req, res) => {
    try {
      const columnId = Number(req.params.columnId);
      const column = db.prepare('SELECT * FROM columns WHERE id = ?').get(columnId);
      if (!column) return res.status(404).json({ error: 'Column not found.' });
      if (column.kind !== 'compound') return res.status(400).json({ error: 'Column has no detail sheet -- it is not compound.' });

      const detail = getColumnDetail(columnId);
      const totalRows = detail.rows.length; // captured before filtering, same reasoning as GET / above
      const { stages, rows } =
        req.query.all === 'true' ? { stages: detail.stages, rows: detail.rows } : applyDetailDefaultFilter(detail.stages, detail.rows);
      res.json({ column: detail.column, stages, rows, totalRows, rowNoun });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // Add a stage to an already-existing compound column -- Tracker
  // Manager-only, same reasoning as POST /columns above. Seeds every
  // existing row and recomputes rollups per addStage()/seedNewStage() in
  // rollout-tracker-db.js.
  router.post('/columns/:columnId/stages', (req, res) => {
    try {
      if (!isTrackerManager(req)) {
        return res.status(403).json({ error: 'Only a Tracker Manager can add a stage.' });
      }
      const columnId = Number(req.params.columnId);
      const column = db.prepare('SELECT * FROM columns WHERE id = ?').get(columnId);
      if (!column) return res.status(404).json({ error: 'Column not found.' });
      if (column.kind !== 'compound') return res.status(400).json({ error: 'Only compound columns can have stages.' });

      const label = (req.body?.label || '').trim();
      if (!label) return res.status(400).json({ error: 'Stage label is required.' });
      const type = req.body?.type === 'text' ? 'text' : 'status';
      const stage = addStage(columnId, label, type, actorFrom(req));
      res.status(201).json({ id: stage.id, key: stage.key, label, type });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // Drag-to-reorder columns, by request -- Tracker Manager-only, same
  // reasoning as POST /columns above ("changing what's tracked affects
  // everyone looking at this tracker"). The client sends the new order
  // for every column it can SEE, once each, rather than a single "move
  // this one to index N" -- simpler to validate (every id given has to be
  // a real current column id, with no duplicates) and immune to two
  // managers reordering at once racing each other into an inconsistent
  // half-applied state the way a relative move could.
  //
  // Real bug, confirmed: this used to require `order` to contain EVERY
  // column, full stop -- but applyDefaultFilter() (GET '/' above) hides a
  // fully-resolved column from the grid entirely whenever "Show All" is
  // off, so the browser never learns that hidden column's id and can't
  // include it. Dragging to reorder the columns actually on screen then
  // always failed with "order must contain every existing column id
  // exactly once" the moment any one column was fully done. `order` is
  // now allowed to be a SUBSET (still a real column id each, still no
  // duplicates) -- any column not mentioned (hidden by the filter) keeps
  // its current absolute position, and the mentioned ones are slotted
  // into the new order relative to each other without disturbing it.
  router.put('/columns/order', (req, res) => {
    try {
      if (!isTrackerManager(req)) {
        return res.status(403).json({ error: 'Only a Tracker Manager can reorder columns.' });
      }
      const order = req.body?.order;
      if (!Array.isArray(order) || order.length === 0 || !order.every((id) => Number.isInteger(id))) {
        return res.status(400).json({ error: 'order must be a non-empty array of column ids.' });
      }
      if (new Set(order).size !== order.length) {
        return res.status(400).json({ error: 'order must not contain the same column id more than once.' });
      }
      const existingIds = db.prepare('SELECT id FROM columns ORDER BY sort_order, id').all().map((c) => c.id);
      const existingSet = new Set(existingIds);
      if (!order.every((id) => existingSet.has(id))) {
        return res.status(400).json({ error: 'order must only contain existing column ids.' });
      }
      const mentioned = new Set(order);
      let i = 0;
      const fullOrder = existingIds.map((id) => (mentioned.has(id) ? order[i++] : id));
      reorderColumns(fullOrder);
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // Drag-to-reorder a compound column's own stages, within its detail
  // sheet -- the stage-level mirror of PUT /columns/order above ("move
  // the columns on a compound tab like they can on the main table"). Same
  // Tracker Manager gate. `order` is a SUBSET, same fix and same reason
  // as PUT /columns/order's own comment -- now that applyDetailDefaultFilter
  // above can hide a fully-resolved stage when Show All is off, requiring
  // the full set here would hit the exact same "order must contain every
  // existing [x]" failure the column-level route already had to fix once
  // a stage the client never saw got left out of a drag.
  router.put('/columns/:columnId/stages/order', (req, res) => {
    try {
      if (!isTrackerManager(req)) {
        return res.status(403).json({ error: 'Only a Tracker Manager can reorder stages.' });
      }
      const columnId = Number(req.params.columnId);
      const column = db.prepare('SELECT * FROM columns WHERE id = ?').get(columnId);
      if (!column) return res.status(404).json({ error: 'Column not found.' });
      if (column.kind !== 'compound') return res.status(400).json({ error: 'Only compound columns have stages to reorder.' });
      const order = req.body?.order;
      if (!Array.isArray(order) || order.length === 0 || !order.every((id) => Number.isInteger(id))) {
        return res.status(400).json({ error: 'order must be a non-empty array of stage ids.' });
      }
      if (new Set(order).size !== order.length) {
        return res.status(400).json({ error: 'order must not contain the same stage id more than once.' });
      }
      const existingIds = db.prepare('SELECT id FROM stages WHERE column_id = ? ORDER BY sort_order, id').all(columnId).map((s) => s.id);
      const existingSet = new Set(existingIds);
      if (!order.every((id) => existingSet.has(id))) {
        return res.status(400).json({ error: 'order must only contain existing stage ids of this column.' });
      }
      const mentioned = new Set(order);
      let i = 0;
      const fullOrder = existingIds.map((id) => (mentioned.has(id) ? order[i++] : id));
      reorderStages(fullOrder);
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Compound rows -- the row-level mirror of the compound-column
  // routes above, transposed (see rollout-tracker-db.js's own comments
  // for the full shape). By request ("Need Compound Rows as well as
  // Compound Columns").

  // One compound row's own detail grid -- every sub-row x every
  // status-type-simple column. Used when that row's own "Show Detail"
  // toggle is clicked. Viewable by anyone who can see the master grid,
  // same as a compound column's own detail sheet -- only adding the
  // row/a sub-row is Tracker Manager-gated. ?all=true bypasses the
  // default filter, same convention as GET / and GET /columns/:id/detail.
  router.get('/rows/:rowId/detail', (req, res) => {
    try {
      const rowId = Number(req.params.rowId);
      const row = db.prepare('SELECT * FROM rows WHERE id = ?').get(rowId);
      if (!row) return res.status(404).json({ error: `No such ${rowNoun.toLowerCase()}.` });
      if (row.kind !== 'compound') return res.status(400).json({ error: `This ${rowNoun.toLowerCase()} has no detail sheet -- it is not compound.` });

      const detail = getRowDetail(rowId);
      const totalSubRows = detail.subRows.length; // captured before filtering, same reasoning as GET / above
      const { columns, subRows } =
        req.query.all === 'true' ? { columns: detail.columns, subRows: detail.subRows } : applyRowDetailDefaultFilter(detail.columns, detail.subRows);
      // subRowColumns (this row's own text-only "sub-row columns") are
      // never filtered -- purely informational, same as every other text
      // field, so always sent in full regardless of Show All.
      res.json({ row: detail.row, columns, subRowColumns: detail.subRowColumns, subRows, totalSubRows, rowNoun });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // Add a sub-row to an already-existing compound row -- Tracker
  // Manager-only, same reasoning as POST /columns/:columnId/stages above.
  // Seeds every existing status-type-simple column and recomputes
  // rollups per addSubRow()/seedNewSubRow() in rollout-tracker-db.js.
  router.post('/rows/:rowId/sub-rows', (req, res) => {
    try {
      if (!isTrackerManager(req)) {
        return res.status(403).json({ error: 'Only a Tracker Manager can add a sub-row.' });
      }
      const rowId = Number(req.params.rowId);
      const row = db.prepare('SELECT * FROM rows WHERE id = ?').get(rowId);
      if (!row) return res.status(404).json({ error: `No such ${rowNoun.toLowerCase()}.` });
      if (row.kind !== 'compound') return res.status(400).json({ error: `Only a compound ${rowNoun.toLowerCase()} can have sub-rows.` });

      const label = (req.body?.label || '').trim();
      if (!label) return res.status(400).json({ error: 'Sub-row label is required.' });
      const subRow = addSubRow(rowId, label, actorFrom(req));
      res.status(201).json({ id: subRow.id, key: subRow.key, label });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // Add a text-only "sub-row column" to an already-existing compound
  // row's own detail sheet -- Tracker Manager-only, same reasoning as
  // POST /rows/:rowId/sub-rows above. By request ("allow independent
  // adding of text columns to the subsheet, not other columns") -- scoped
  // to just this one row, never the main grid or any other row's own
  // sub-table. Seeds a blank value across every existing sub-row per
  // addSubRowColumn() in rollout-tracker-db.js.
  router.post('/rows/:rowId/sub-columns', (req, res) => {
    try {
      if (!isTrackerManager(req)) {
        return res.status(403).json({ error: 'Only a Tracker Manager can add a column.' });
      }
      const rowId = Number(req.params.rowId);
      const row = db.prepare('SELECT * FROM rows WHERE id = ?').get(rowId);
      if (!row) return res.status(404).json({ error: `No such ${rowNoun.toLowerCase()}.` });
      if (row.kind !== 'compound') return res.status(400).json({ error: `Only a compound ${rowNoun.toLowerCase()} can have its own sub-row columns.` });

      const label = (req.body?.label || '').trim();
      if (!label) return res.status(400).json({ error: 'Column label is required.' });
      const subRowColumn = addSubRowColumn(rowId, label, actorFrom(req));
      res.status(201).json({ id: subRowColumn.id, key: subRowColumn.key, label });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // Update one sub-row's status for one status-type-simple column --
  // open to every signed-in user, same reasoning as PATCH
  // /stages/:rowId/:stageId above (editing an already-added sub-row's
  // value isn't a structural change). Triggers a rollup recompute for
  // the parent row afterward.
  router.patch('/sub-rows/:subRowId/:columnId', (req, res) => {
    try {
      const subRowId = Number(req.params.subRowId);
      const columnId = Number(req.params.columnId);
      const column = db.prepare('SELECT * FROM columns WHERE id = ?').get(columnId);
      if (!column) return res.status(404).json({ error: 'Column not found.' });
      if (column.kind !== 'simple' || column.cell_type !== 'status') {
        return res.status(400).json({ error: 'A sub-row only ever has a value for a simple status column.' });
      }

      const status = req.body?.status;
      if (!STATUSES.includes(status)) return res.status(400).json({ error: `Invalid status. Must be one of: ${STATUSES.join(', ')}.` });
      const rawReason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
      if (status === 'note' && !rawReason) {
        return res.status(400).json({ error: 'A Note requires a comment.' });
      }
      const reason = STATUSES_WITH_COMMENT.includes(status) ? rawReason || null : null;

      const result = setSubRowCell(subRowId, columnId, status, reason, actorFrom(req));
      if (result === undefined) return res.status(404).json({ error: 'Sub-row not found.' });
      if (result === null) return res.status(404).json({ error: 'No such sub-row/column.' });
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // Update one sub-row's value for one of its own row's sub_row_columns --
  // the sub_row_columns mirror of PATCH /sub-rows/:subRowId/:columnId
  // above, open to every signed-in user for the same reason (editing an
  // already-added column's value isn't a structural change). Just free
  // text -- no status, no rollup.
  router.patch('/sub-rows/:subRowId/sub-columns/:subRowColumnId', (req, res) => {
    try {
      const subRowId = Number(req.params.subRowId);
      const subRowColumnId = Number(req.params.subRowColumnId);
      const subRowColumn = db.prepare('SELECT id FROM sub_row_columns WHERE id = ?').get(subRowColumnId);
      if (!subRowColumn) return res.status(404).json({ error: 'Column not found.' });

      const value = typeof req.body?.value === 'string' ? req.body.value : null;
      const result = setSubRowColumnValue(subRowId, subRowColumnId, value, actorFrom(req));
      if (result === undefined) return res.status(404).json({ error: 'Sub-row not found.' });
      if (result === null) return res.status(404).json({ error: 'No such sub-row/column.' });
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // Set every status-type-simple column's value for one sub-row, within
  // one compound row's detail sheet, in one go -- the sub-row mirror of
  // PATCH /columns/:columnId/rows/:rowId/bulk-stages above ("Set
  // [sub-row]").
  router.patch('/rows/:rowId/sub-rows/:subRowId/bulk-cells', (req, res) => {
    try {
      const rowId = Number(req.params.rowId);
      const subRowId = Number(req.params.subRowId);
      const row = db.prepare('SELECT * FROM rows WHERE id = ?').get(rowId);
      if (!row) return res.status(404).json({ error: `No such ${rowNoun.toLowerCase()}.` });
      if (row.kind !== 'compound') return res.status(400).json({ error: `Only a compound ${rowNoun.toLowerCase()} has a detail sheet to bulk-set.` });
      const subRow = db.prepare('SELECT id FROM sub_rows WHERE id = ? AND parent_row_id = ?').get(subRowId, rowId);
      if (!subRow) return res.status(404).json({ error: 'Sub-row not found.' });

      const status = req.body?.status;
      if (!STATUSES.includes(status)) return res.status(400).json({ error: `Invalid status. Must be one of: ${STATUSES.join(', ')}.` });
      const rawReason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
      if (status === 'note' && !rawReason) {
        return res.status(400).json({ error: 'A Note requires a comment.' });
      }
      const reason = STATUSES_WITH_COMMENT.includes(status) ? rawReason || null : null;
      const columnIds = bulkSetSubRow(subRowId, status, reason, actorFrom(req));
      res.json({ status, reason, columnIds });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // Set one status-type-simple column's value for a set of sub-rows (or
  // every sub-row of one compound row, if `subRowIds` is omitted) in one
  // go -- the sub-row mirror of PATCH /stages/:stageId/bulk-status above
  // ("Set [column]").
  router.patch('/rows/:rowId/columns/:columnId/bulk-status', (req, res) => {
    try {
      const rowId = Number(req.params.rowId);
      const columnId = Number(req.params.columnId);
      const row = db.prepare('SELECT * FROM rows WHERE id = ?').get(rowId);
      if (!row) return res.status(404).json({ error: `No such ${rowNoun.toLowerCase()}.` });
      if (row.kind !== 'compound') return res.status(400).json({ error: `Only a compound ${rowNoun.toLowerCase()} has a detail sheet to bulk-set.` });
      const column = db.prepare('SELECT * FROM columns WHERE id = ?').get(columnId);
      if (!column) return res.status(404).json({ error: 'Column not found.' });
      if (column.kind !== 'simple' || column.cell_type !== 'status') {
        return res.status(400).json({ error: 'A sub-row only ever has a value for a simple status column.' });
      }

      const body = req.body || {};
      if (!isValidOptionalSubRowIds(body)) return res.status(400).json({ error: 'subRowIds must be an array of integers.' });
      const status = body.status;
      if (!STATUSES.includes(status)) return res.status(400).json({ error: `Invalid status. Must be one of: ${STATUSES.join(', ')}.` });
      const rawReason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (status === 'note' && !rawReason) {
        return res.status(400).json({ error: 'A Note requires a comment.' });
      }
      const reason = STATUSES_WITH_COMMENT.includes(status) ? rawReason || null : null;
      const subRowIds = bulkSetColumnAcrossSubRows(rowId, columnId, status, reason, actorFrom(req), body.subRowIds || null);
      res.json({ status, reason, subRowIds });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // A text-type simple column's cell has no real status -- the body is
  // just { reason }, and `status` is always written as the 'not_done'
  // placeholder (see cell_type's own comment in rollout-tracker-db.js),
  // same branch-by-type shape PATCH /stages/:rowId/:stageId already uses
  // for a text-type stage.
  router.patch('/cells/:rowId/:columnId', (req, res) => {
    try {
      const rowId = Number(req.params.rowId);
      const columnId = Number(req.params.columnId);
      const column = db.prepare('SELECT * FROM columns WHERE id = ?').get(columnId);
      if (!column) return res.status(404).json({ error: 'Column not found.' });
      if (column.kind !== 'simple') return res.status(400).json({ error: 'This column is compound -- edit its stages instead, not the cell directly.' });
      // A status-type column's cell for a COMPOUND row is a derived
      // rollup over that row's own sub-rows, same reasoning as the
      // compound-column check just above, transposed -- a text column's
      // cell stays directly editable regardless of the row's own kind
      // (see rollout-tracker-db.js's own seedNewRow comment).
      if (column.cell_type === 'status') {
        const row = db.prepare('SELECT kind FROM rows WHERE id = ?').get(rowId);
        if (row && row.kind === 'compound') {
          return res.status(400).json({ error: `This ${rowNoun.toLowerCase()} is compound -- edit its sub-rows instead, not the cell directly.` });
        }
      }

      let status;
      let reason;
      if (column.cell_type === 'text') {
        status = 'not_done';
        reason = typeof req.body?.reason === 'string' ? req.body.reason : null;
      } else {
        status = req.body?.status;
        if (!STATUSES.includes(status)) return res.status(400).json({ error: `Invalid status. Must be one of: ${STATUSES.join(', ')}.` });
        const rawReason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
        if (status === 'note' && !rawReason) {
          return res.status(400).json({ error: 'A Note requires a comment.' });
        }
        reason = STATUSES_WITH_COMMENT.includes(status) ? rawReason || null : null;
      }
      const result = setCell(rowId, columnId, status, reason, actorFrom(req));
      if (result === null) return res.status(404).json({ error: `No such ${rowNoun.toLowerCase()}/column.` });
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // Update one stage's value -- a status (+ optional/required comment)
  // for type='status' stages, or free text (stored in `reason`, status
  // left null) for type='text' stages. Triggers a rollup recompute for
  // the parent column afterward. Open to every signed-in user, same as
  // an ordinary simple-cell edit above -- editing an already-added
  // stage's value isn't a structural change (adding the stage itself is,
  // see POST /columns/:columnId/stages above).
  router.patch('/stages/:rowId/:stageId', (req, res) => {
    try {
      const rowId = Number(req.params.rowId);
      const stageId = Number(req.params.stageId);
      const stage = db.prepare('SELECT * FROM stages WHERE id = ?').get(stageId);
      if (!stage) return res.status(404).json({ error: 'Stage not found.' });

      let status;
      let reason;
      if (stage.type === 'text') {
        status = null;
        reason = (req.body && req.body.reason) || null;
      } else {
        status = req.body?.status;
        if (!STATUSES.includes(status)) return res.status(400).json({ error: `Invalid status. Must be one of: ${STATUSES.join(', ')}.` });
        const rawReason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
        if (status === 'note' && !rawReason) {
          return res.status(400).json({ error: 'A Note requires a comment.' });
        }
        reason = STATUSES_WITH_COMMENT.includes(status) ? rawReason || null : null;
      }

      const result = setStage(rowId, stageId, status, reason, actorFrom(req));
      if (result === undefined) return res.status(404).json({ error: 'Stage not found.' });
      if (result === null) return res.status(404).json({ error: `No such ${rowNoun.toLowerCase()}/stage.` });
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // Set every STATUS-type stage's status for one row, within one compound
  // column's detail sheet, in one go -- the detail-sheet equivalent of
  // PATCH /rows/:rowId/bulk-cells above. text-type stages are silently
  // skipped (see bulkSetStages() in rollout-tracker-db.js).
  router.patch('/columns/:columnId/rows/:rowId/bulk-stages', (req, res) => {
    try {
      const columnId = Number(req.params.columnId);
      const rowId = Number(req.params.rowId);
      const column = db.prepare('SELECT * FROM columns WHERE id = ?').get(columnId);
      if (!column) return res.status(404).json({ error: 'Column not found.' });
      if (column.kind !== 'compound') return res.status(400).json({ error: 'Only compound columns have a detail sheet to bulk-set.' });
      const row = db.prepare('SELECT id FROM rows WHERE id = ?').get(rowId);
      if (!row) return res.status(404).json({ error: `No such ${rowNoun.toLowerCase()}.` });
      const status = req.body?.status;
      if (!STATUSES.includes(status)) return res.status(400).json({ error: `Invalid status. Must be one of: ${STATUSES.join(', ')}.` });
      const rawReason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
      if (status === 'note' && !rawReason) {
        return res.status(400).json({ error: 'A Note requires a comment.' });
      }
      const reason = STATUSES_WITH_COMMENT.includes(status) ? rawReason || null : null;
      const stageIds = bulkSetStages(rowId, columnId, status, reason, actorFrom(req));
      res.json({ status, reason, stageIds });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // Set one stage's value for a set of rows in one go -- the column-based
  // mirror of PATCH .../rows/:rowId/bulk-stages above (which sets a whole
  // row within one detail sheet). Optional `rowIds` restricts to just
  // those (client.js sends whichever rows are currently rendered on that
  // sheet); omit it for every row. DOES accept text-type stages (setting
  // every row's free-text field to the same string), same status/text
  // shaping PATCH .../stages/:rowId/:stageId above uses per stage.type.
  router.patch('/stages/:stageId/bulk-status', (req, res) => {
    try {
      const stageId = Number(req.params.stageId);
      const stage = db.prepare('SELECT * FROM stages WHERE id = ?').get(stageId);
      if (!stage) return res.status(404).json({ error: 'Stage not found.' });

      const body = req.body || {};
      if (!isValidOptionalStageRowIds(body)) return res.status(400).json({ error: 'rowIds must be an array of integers.' });

      let status;
      let reason;
      if (stage.type === 'text') {
        status = null;
        reason = body.reason || null;
      } else {
        status = body.status;
        if (!STATUSES.includes(status)) return res.status(400).json({ error: `Invalid status. Must be one of: ${STATUSES.join(', ')}.` });
        const rawReason = typeof body.reason === 'string' ? body.reason.trim() : '';
        if (status === 'note' && !rawReason) {
          return res.status(400).json({ error: 'A Note requires a comment.' });
        }
        reason = STATUSES_WITH_COMMENT.includes(status) ? rawReason || null : null;
      }

      const rowIds = bulkSetStageColumn(stageId, status, reason, actorFrom(req), body.rowIds || null);
      res.json({ status, reason, rowIds });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  router.patch('/rows/:rowId/bulk-cells', (req, res) => {
    try {
      const rowId = Number(req.params.rowId);
      const row = db.prepare('SELECT kind FROM rows WHERE id = ?').get(rowId);
      if (!row) return res.status(404).json({ error: `No such ${rowNoun.toLowerCase()}.` });
      // Every status-type-simple column this action could touch is
      // derived for a compound row (see bulkSetRow's own comment in
      // rollout-tracker-db.js) -- nothing left to "Set Row" on.
      if (row.kind === 'compound') {
        return res.status(400).json({ error: `This ${rowNoun.toLowerCase()} is compound -- edit its sub-rows instead, not the whole row directly.` });
      }
      const status = req.body?.status;
      if (!STATUSES.includes(status)) return res.status(400).json({ error: `Invalid status. Must be one of: ${STATUSES.join(', ')}.` });
      const rawReason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
      if (status === 'note' && !rawReason) {
        return res.status(400).json({ error: 'A Note requires a comment.' });
      }
      const reason = STATUSES_WITH_COMMENT.includes(status) ? rawReason || null : null;
      const columnIds = bulkSetRow(rowId, status, reason, actorFrom(req));
      res.json({ columnIds });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // Same text-column branch as PATCH /cells/:rowId/:columnId above --
  // the "Set Column" bulk editor on a text column just sends { reason },
  // no status.
  router.patch('/columns/:columnId/bulk-cells', (req, res) => {
    try {
      const columnId = Number(req.params.columnId);
      const column = db.prepare('SELECT * FROM columns WHERE id = ?').get(columnId);
      if (!column) return res.status(404).json({ error: 'Column not found.' });
      if (column.kind !== 'simple') return res.status(400).json({ error: 'This column is compound -- edit its stages instead, not the whole column directly.' });
      if (!isValidOptionalRowIds(req.body)) return res.status(400).json({ error: 'rowIds must be an array of integers.' });

      let status;
      let reason;
      if (column.cell_type === 'text') {
        status = 'not_done';
        reason = typeof req.body?.reason === 'string' ? req.body.reason : null;
      } else {
        status = req.body?.status;
        if (!STATUSES.includes(status)) return res.status(400).json({ error: `Invalid status. Must be one of: ${STATUSES.join(', ')}.` });
        const rawReason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
        if (status === 'note' && !rawReason) {
          return res.status(400).json({ error: 'A Note requires a comment.' });
        }
        reason = STATUSES_WITH_COMMENT.includes(status) ? rawReason || null : null;
      }
      const rowIds = bulkSetColumn(columnId, status, reason, actorFrom(req), req.body.rowIds || null);
      res.json({ rowIds });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // Hide Complete / Un-Complete This -- moves this tracker's own sidebar
  // entry between the "Trackers" and "Trackers - Complete" categories
  // (creating either the first time it's needed). Admin-only, same
  // reasoning as every other shared-sidebar-structure change on this
  // dashboard (the nav editor's own drag/hide, Add Column above) -- one
  // person's click shouldn't reorganise what everyone else sees.
  router.post('/mark-complete', (req, res) => {
    try {
      if (!isTrackerManager(req)) {
        return res.status(403).json({ error: 'Only a Tracker Manager can mark this tracker complete.' });
      }
      const tree = readNavLayout() || [];
      movePageToCategory(tree, pageId, TRACKERS_COMPLETE_CATEGORY_ID, TRACKERS_COMPLETE_CATEGORY_LABEL);
      writeNavLayout(tree);
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/mark-incomplete', (req, res) => {
    try {
      if (!isTrackerManager(req)) {
        return res.status(403).json({ error: 'Only a Tracker Manager can move this tracker back to Trackers.' });
      }
      const tree = readNavLayout() || [];
      movePageToCategory(tree, pageId, TRACKERS_CATEGORY_ID, TRACKERS_CATEGORY_LABEL);
      writeNavLayout(tree);
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // Reports whether this tracker is CURRENTLY filed under "Trackers -
  // Complete" -- lets rollout-tracker-client.js show only the one button
  // (Hide Complete or Un-Complete This) that actually applies, without
  // duplicating nav-layout.json's own tree-walking logic client-side.
  router.get('/nav-status', (req, res) => {
    try {
      const tree = readNavLayout() || [];
      const completeCategory = tree.find((n) => n.type === 'category' && n.id === TRACKERS_COMPLETE_CATEGORY_ID);
      const complete = !!(completeCategory && completeCategory.children.some((c) => c.type === 'page' && c.id === pageId));
      res.json({ complete });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // Totally deletes this tracker -- by request, for cleaning up a
  // finished/throwaway one without asking Claude (or Amber, by hand) to
  // do it every time. Tracker Manager-only, and only ALLOWED while the
  // tracker is filed under "Trackers - Complete" -- enforced here too,
  // not just hidden client-side, same "never trust the client alone"
  // rule every admin-gated action on this dashboard follows. Removes the
  // sidebar entry outright (not moved -- there's nowhere left to move it
  // to), unregisters it from the live in-memory page registry (a real
  // bug otherwise -- confirmed the hard way: without this, re-creating a
  // tracker under the exact same name afterward hits Rollout Tracker
  // Builder's own "already exists" guard, which checks this same
  // in-memory list, not just the filesystem -- same unregisterPage()
  // call Tab Page Builder's own DELETE route already makes for the same
  // reason, see registry.js), and deletes the package folder from disk.
  //
  // Checkpointing the WAL and closing `db` FIRST matters on Windows: this
  // router's `db` has held data.db (and its WAL/SHM sidecars) open since
  // this tracker's server.js was first required, and a still-open SQLite
  // handle blocks deleting the folder that holds it (confirmed
  // repeatedly in this dashboard's own dev-loop smoke tests -- EPERM).
  // Confirmed the hard way that close() ALONE isn't always enough --
  // Windows can still be a beat behind releasing the underlying file
  // handle even after close() returns, so the checkpoint (folds the WAL
  // back into the main file, same step DEPLOYMENT.md's own manual data.db
  // copy instructions use) plus a short retry loop on the actual delete
  // covers that gap instead of failing on the very first attempt.
  router.post('/delete', async (req, res) => {
    try {
      if (!isTrackerManager(req)) {
        return res.status(403).json({ error: 'Only a Tracker Manager can delete a tracker.' });
      }
      const tree = readNavLayout() || [];
      const completeCategory = tree.find((n) => n.type === 'category' && n.id === TRACKERS_COMPLETE_CATEGORY_ID);
      const isComplete = !!(completeCategory && completeCategory.children.some((c) => c.type === 'page' && c.id === pageId));
      if (!isComplete) {
        return res.status(409).json({ error: 'Only a tracker marked Tracking Complete can be deleted.' });
      }

      removePageNode(tree, pageId);
      writeNavLayout(tree);
      unregisterPage(pageId);

      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.close();
      let filesRemoved = false;
      let lastErr = null;
      for (let attempt = 0; attempt < 5 && !filesRemoved; attempt++) {
        try {
          fs.rmSync(storageDir, { recursive: true, force: true });
          filesRemoved = true;
        } catch (err) {
          lastErr = err;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      if (!filesRemoved) {
        // Best-effort -- the tracker is already gone from the sidebar
        // either way (the part that actually matters to a viewer), so a
        // leftover folder isn't worth failing this request over. Rare
        // even with the checkpoint+retries above, but if it happens, a
        // dev-server restart clears it (see DEPLOYMENT.md's own
        // "Deploying Rollout Tracker Builder" section for the equivalent
        // production case).
        console.error(`Tracker "${pageId}" removed from the sidebar, but its files could not be fully deleted after 5 attempts:`, lastErr);
      }
      res.json({ ok: true, filesRemoved });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // Notes -- free-form instructions for the tracker, minimised by default
  // client-side. Viewable by anyone who can see the page (same as the
  // grid itself); editable by Tracker Managers only, same as every other
  // tracker-management action (create/add column/mark complete) -- by
  // request, all gated to the one TRACKER_MANAGER list rather than notes
  // staying a separate Amber-only carve-out. `editable` in the GET
  // response mirrors tab-page-server.js's own GET /help-text shape
  // exactly, so the client knows whether to show Edit Notes without a
  // second round trip.
  router.get('/notes', (req, res) => {
    res.json({ html: readNotesHtml(), editable: isTrackerManager(req) });
  });

  router.put('/notes', (req, res) => {
    if (!isTrackerManager(req)) {
      return res.status(403).json({ error: 'Only a Tracker Manager can edit this tracker\'s notes.' });
    }
    if (typeof req.body?.html !== 'string') {
      return res.status(400).json({ error: 'Body must be { html: string }.' });
    }
    const sanitized = writeNotesHtml(req.body.html);
    res.json({ html: sanitized });
  });

  router.get('/cells/:rowId/:columnId/history', (req, res) => {
    try {
      const rowId = Number(req.params.rowId);
      const columnId = Number(req.params.columnId);
      const history = getCellHistory(rowId, columnId);
      res.json({ history: history.map(shapeAuditRow) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/stages/:rowId/:stageId/history', (req, res) => {
    try {
      const rowId = Number(req.params.rowId);
      const stageId = Number(req.params.stageId);
      const history = getStageHistory(rowId, stageId);
      res.json({ history: history.map(shapeAuditRow) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/sub-rows/:subRowId/:columnId/history', (req, res) => {
    try {
      const subRowId = Number(req.params.subRowId);
      const columnId = Number(req.params.columnId);
      const history = getSubRowHistory(subRowId, columnId);
      res.json({ history: history.map(shapeAuditRow) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // The sub_row_columns mirror of the history route just above.
  router.get('/sub-rows/:subRowId/sub-columns/:subRowColumnId/history', (req, res) => {
    try {
      const subRowId = Number(req.params.subRowId);
      const subRowColumnId = Number(req.params.subRowColumnId);
      const history = getSubRowColumnHistory(subRowId, subRowColumnId);
      res.json({ history: history.map(shapeAuditRow) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createRolloutTrackerRouter };
