const express = require('express');
const fs = require('fs');
const path = require('path');
const { createRolloutTrackerDb } = require('./rollout-tracker-db.js');
const { readNavLayout, writeNavLayout } = require('./registry.js');
const {
  TRACKERS_CATEGORY_ID,
  TRACKERS_CATEGORY_LABEL,
  TRACKERS_COMPLETE_CATEGORY_ID,
  TRACKERS_COMPLETE_CATEGORY_LABEL,
  movePageToCategory,
  removePageNode,
} = require('./rollout-tracker-nav.js');
const { isTrackerManager } = require('./rollout-tracker-permissions.js');

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
  const visibleColumns = columns.filter((col) =>
    rows.some((r) => {
      const cell = r.cells[col.id];
      return cell && !RESOLVED_STATUSES.includes(cell.status);
    })
  );
  const visibleColumnIds = new Set(visibleColumns.map((c) => c.id));
  const visibleRows = rows.filter((r) =>
    Object.entries(r.cells).some(([colId, cell]) => visibleColumnIds.has(Number(colId)) && !RESOLVED_STATUSES.includes(cell.status))
  );
  return { columns: visibleColumns, rows: visibleRows };
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
// underline/strikethrough/lists -- see rollout-tracker-client.js's own
// toolbar), so the allowlist can be just as small. Every tag not in this
// list -- and EVERY attribute on every tag, allowed or not -- is stripped
// entirely, which is what actually matters here: an attribute is the only
// place an onclick=/onerror=/javascript: href could live, so refusing to
// keep any attribute at all (rather than trying to allowlist individual
// safe ones) closes off that whole class of stored-XSS in one rule,
// without needing a full HTML-parser dependency for a field this narrow
// in scope. Written to notes.json only through this -- never trust the
// browser's own execCommand output to already be clean.
const NOTES_ALLOWED_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'strike', 'ul', 'ol', 'li', 'br', 'div', 'p']);
function sanitizeNotesHtml(html) {
  if (typeof html !== 'string') return '';
  return html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (match, tagName) => {
    const tag = tagName.toLowerCase();
    if (!NOTES_ALLOWED_TAGS.has(tag)) return '';
    return match.startsWith('</') ? `</${tag}>` : `<${tag}>`;
  });
}

function createRolloutTrackerRouter(storageDir, { rowNoun = 'Item' } = {}) {
  const { db, addRow, addColumn, setCell, bulkSetRow, bulkSetColumn, renameRow, deleteRow, getGrid, getCellHistory } = createRolloutTrackerDb(
    path.join(storageDir, 'data.db')
  );
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

  router.post('/rows', (req, res) => {
    try {
      const name = (req.body?.name || '').trim();
      if (!name) return res.status(400).json({ error: `${rowNoun} name is required.` });
      const rowId = addRow(name, actorFrom(req));
      if (rowId === null) return res.status(409).json({ error: `A ${rowNoun.toLowerCase()} named "${name}" already exists.` });
      res.status(201).json({ id: rowId, name });
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
        const rowId = addRow(name, actor);
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
  // looking at this tracker (see rollout-tracker-permissions.js).
  router.post('/columns', (req, res) => {
    try {
      if (!isTrackerManager(req)) {
        return res.status(403).json({ error: 'Only a Tracker Manager can add a column.' });
      }
      const label = (req.body?.label || '').trim();
      if (!label) return res.status(400).json({ error: 'Column label is required.' });
      const existingKeys = new Set(db.prepare('SELECT key FROM columns').all().map((c) => c.key));
      const key = uniqueKey(slugify(label), existingKeys);
      const columnId = addColumn(label, key, actorFrom(req));
      res.status(201).json({ id: columnId, key, label });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  router.patch('/cells/:rowId/:columnId', (req, res) => {
    try {
      const rowId = Number(req.params.rowId);
      const columnId = Number(req.params.columnId);
      const status = req.body?.status;
      if (!STATUSES.includes(status)) return res.status(400).json({ error: `Invalid status. Must be one of: ${STATUSES.join(', ')}.` });
      const rawReason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
      if (status === 'note' && !rawReason) {
        return res.status(400).json({ error: 'A Note requires a comment.' });
      }
      const reason = STATUSES_WITH_COMMENT.includes(status) ? rawReason || null : null;
      const result = setCell(rowId, columnId, status, reason, actorFrom(req));
      if (result === null) return res.status(404).json({ error: `No such ${rowNoun.toLowerCase()}/column.` });
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  router.patch('/rows/:rowId/bulk-cells', (req, res) => {
    try {
      const rowId = Number(req.params.rowId);
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

  router.patch('/columns/:columnId/bulk-cells', (req, res) => {
    try {
      const columnId = Number(req.params.columnId);
      const status = req.body?.status;
      if (!STATUSES.includes(status)) return res.status(400).json({ error: `Invalid status. Must be one of: ${STATUSES.join(', ')}.` });
      if (!isValidOptionalRowIds(req.body)) return res.status(400).json({ error: 'rowIds must be an array of integers.' });
      const rawReason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
      if (status === 'note' && !rawReason) {
        return res.status(400).json({ error: 'A Note requires a comment.' });
      }
      const reason = STATUSES_WITH_COMMENT.includes(status) ? rawReason || null : null;
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
  // to) and deletes the package folder from disk.
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

  return router;
}

module.exports = { createRolloutTrackerRouter };
