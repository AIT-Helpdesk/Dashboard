// Shared, generic rollout-tracker mount factory -- extracted from
// tc-elite-rollout's own client.js, simple-column subset only (no
// stages/detail-sheets/compound rollups -- see rollout-tracker-db.js's own
// comment for why). createRolloutTrackerMount({ id, label, apiBase,
// rowNoun }) is called once per generated tracker's own thin client.js,
// returning that page's real mount(container) function. Every generated
// tracker shares this one module (loaded once by the browser), so nothing
// here is module-scope state -- each call below gets its own closure over
// showAll and the filter/drag state just below it, the same way multiple
// tabbed pages built from tab-page-client.js each get their own
// independent state despite sharing that one module too.
const STATUS_LABELS = { not_done: 'Not Done', started: 'Started', done: 'Done', na: 'N/A', cancelled: 'Cancelled', issue: 'Issue', note: 'Note' };
const STATUS_SYMBOLS = { not_done: '✗', started: '▶', done: '✓', na: 'N/A', cancelled: '⛔', issue: '⚠️', note: '📝' };
const STATUS_ORDER = ['not_done', 'started', 'done', 'na', 'cancelled', 'issue', 'note'];
// na/cancelled/issue keep an optional comment, same as tc-elite-rollout;
// note's is REQUIRED (enforced both here and server-side).
const STATUSES_WITH_COMMENT = ['na', 'cancelled', 'issue', 'note'];
const STATUSES_REQUIRING_COMMENT = ['note'];

const RENAME_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.9959.9959 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';

export function createRolloutTrackerMount({ id, label, apiBase, rowNoun = 'Item' }) {
  let showAll = false;
  // Client-side filtering, by request -- narrows which rows are DISPLAYED
  // out of whatever loadGrid() already fetched (Show All or not), with no
  // extra round trip, same "filter what's already loaded" convention
  // Check Client's own M365 Users table uses. rowNameFilterText is plain
  // wildcard text against the first column; columnStatusFilters is
  // columnId -> Set of allowed statuses (absent or empty = no filter for
  // that column). currentVisibleRowIds is kept in sync on every re-render
  // so the column bulk-update button ("set every visible row in this
  // column") respects these filters too, not just Show All -- by
  // request, row bulk-update does NOT need this (it already always
  // applies to every column of its own row, filters or not).
  let rowNameFilterText = '';
  const columnStatusFilters = new Map();
  let currentVisibleRowIds = [];
  // Set while a column header drag is in progress -- module-call-scope
  // (not per-render), so it survives the dragstart->drop round trip
  // regardless of how many times the grid re-renders in between.
  let draggedColumnId = null;

  return function mount(container) {
    container.innerHTML = `
      <header class="page-header">
        <h1>${escapeHtml(label)}</h1>
        <div class="date-form">
          <label style="display:inline-flex;align-items:center;gap:0.35rem;font-weight:normal;">
            <input type="checkbox" id="show-all-toggle" /> Show All
          </label>
          <button type="button" id="clear-filters-button" class="button-link button-link--small rt-clear-filters-button">Clear All Filters</button>
          <button type="button" id="add-row-button" class="button-link button-link--small">Add ${escapeHtml(rowNoun)}</button>
          <button type="button" id="bulk-add-rows-button" class="button-link button-link--small">Bulk Add ${escapeHtml(rowNoun)}s</button>
          <button type="button" id="add-column-button" class="button-link button-link--small" hidden>Add Column</button>
          <button type="button" id="hide-complete-button" class="button-link button-link--small" hidden>Tracking Complete</button>
          <button type="button" id="uncomplete-button" class="button-link button-link--small" hidden>Un-Complete This</button>
          <button type="button" id="delete-tracker-button" class="button-link button-link--small rt-delete-button" hidden>Delete Tracker</button>
          <button type="button" id="refresh-button" class="button-link button-link--small refresh-button--emphasis">Refresh</button>
        </div>
      </header>

      <div id="notes-section" class="rt-notes">
        <button type="button" id="notes-toggle" class="rt-notes-toggle">&#9656; Notes</button>
        <div id="notes-body" class="rt-notes-body" hidden>
          <div id="notes-view" class="rt-notes-view"></div>
          <button type="button" id="notes-edit-button" class="button-link button-link--small" hidden>Edit Notes</button>
          <div id="notes-editor" class="rt-notes-editor" hidden>
            <div class="rt-notes-toolbar">
              <button type="button" class="rt-notes-tool" data-cmd="bold" title="Bold"><b>B</b></button>
              <button type="button" class="rt-notes-tool" data-cmd="italic" title="Italic"><i>I</i></button>
              <button type="button" class="rt-notes-tool" data-cmd="underline" title="Underline"><u>U</u></button>
              <button type="button" class="rt-notes-tool" data-cmd="strikeThrough" title="Strikethrough"><s>S</s></button>
              <button type="button" class="rt-notes-tool" data-cmd="insertUnorderedList" title="Bullet list">&#8226; List</button>
              <button type="button" class="rt-notes-tool" data-cmd="insertOrderedList" title="Numbered list">1. List</button>
              <button type="button" class="rt-notes-tool" data-cmd="removeFormat" title="Clear formatting">Clear</button>
            </div>
            <div id="notes-editable" class="rt-notes-editable" contenteditable="true"></div>
            <div class="rt-form-actions">
              <button type="button" id="notes-save-button" class="button-link button-link--small">Save Notes</button>
              <button type="button" id="notes-cancel-button">Cancel</button>
            </div>
          </div>
        </div>
      </div>

      <p id="status" class="status">Loading...</p>

      <div id="add-row-form" class="resource-group" hidden>
        <div class="section-heading">Add ${escapeHtml(rowNoun)}</div>
        <div class="rt-form-body">
          <input type="text" id="new-row-name" placeholder="${escapeHtml(rowNoun)} name" />
          <p id="add-row-error" class="status error" hidden></p>
          <div class="rt-form-actions">
            <button type="button" id="save-row-button" class="button-link">Save</button>
            <button type="button" id="cancel-row-button">Cancel</button>
          </div>
        </div>
      </div>

      <div id="bulk-add-rows-form" class="resource-group" hidden>
        <div class="section-heading">Bulk Add ${escapeHtml(rowNoun)}s</div>
        <div class="rt-form-body">
          <textarea id="bulk-row-names" rows="8" placeholder="One ${rowNoun.toLowerCase()} per line" style="display:block; width:100%; font: inherit; padding:0.4rem 0.6rem; border:1px solid var(--border); border-radius:6px; background:var(--bg); color:var(--fg);"></textarea>
          <p id="bulk-add-rows-error" class="status error" hidden></p>
          <div class="rt-form-actions">
            <button type="button" id="save-bulk-rows-button" class="button-link">Save</button>
            <button type="button" id="cancel-bulk-rows-button">Cancel</button>
          </div>
        </div>
      </div>

      <div id="add-column-form" class="resource-group" hidden>
        <div class="section-heading">Add Column</div>
        <div class="rt-form-body">
          <input type="text" id="new-column-label" placeholder="Column label" />
          <p id="add-column-error" class="status error" hidden></p>
          <div class="rt-form-actions">
            <button type="button" id="save-column-button" class="button-link">Save</button>
            <button type="button" id="cancel-column-button">Cancel</button>
          </div>
        </div>
      </div>

      <div id="grid-container"></div>
    `;

    const statusEl = container.querySelector('#status');
    const refreshButton = container.querySelector('#refresh-button');
    const showAllToggle = container.querySelector('#show-all-toggle');
    const clearFiltersButton = container.querySelector('#clear-filters-button');
    const addRowButton = container.querySelector('#add-row-button');
    const bulkAddRowsButton = container.querySelector('#bulk-add-rows-button');
    const addColumnButton = container.querySelector('#add-column-button');
    const hideCompleteButton = container.querySelector('#hide-complete-button');
    const uncompleteButton = container.querySelector('#uncomplete-button');
    const deleteTrackerButton = container.querySelector('#delete-tracker-button');
    const addRowForm = container.querySelector('#add-row-form');
    const bulkAddRowsForm = container.querySelector('#bulk-add-rows-form');
    const addColumnForm = container.querySelector('#add-column-form');
    const gridContainer = container.querySelector('#grid-container');
    const notesToggle = container.querySelector('#notes-toggle');
    const notesBody = container.querySelector('#notes-body');
    const notesView = container.querySelector('#notes-view');
    const notesEditButton = container.querySelector('#notes-edit-button');
    const notesEditor = container.querySelector('#notes-editor');
    const notesEditable = container.querySelector('#notes-editable');

    refreshButton.addEventListener('click', () => loadGrid());
    showAllToggle.addEventListener('change', () => {
      showAll = showAllToggle.checked;
      loadGrid();
    });

    // By request -- a full loadGrid() (not just a tbody refresh) so the
    // filter row itself (the wildcard input's value, each column's
    // "Filter (N)" button label, any open status-filter popup) rebuilds
    // from this now-cleared state too, not just the rows it narrows.
    clearFiltersButton.addEventListener('click', () => {
      rowNameFilterText = '';
      columnStatusFilters.clear();
      loadGrid();
    });

    // Only one of Hide Complete / Un-Complete This is ever shown at once
    // -- whichever actually applies, per this tracker's CURRENT category
    // (see GET .../nav-status in rollout-tracker-server.js). Both stay
    // hidden entirely for a non-manager, same as Add Column -- all three
    // are driven off `isManager` in the grid response (loadGrid below),
    // not a separate /api/me lookup, since Tracker Manager is a name-list
    // permission (TRACKER_MANAGER in .env, see
    // rollout-tracker-permissions.js) the server already has to resolve
    // for itself on every request.
    async function loadCompletionState() {
      try {
        const res = await fetch(`${apiBase}/nav-status`);
        const data = await res.json();
        hideCompleteButton.hidden = !!data.complete;
        uncompleteButton.hidden = !data.complete;
        // Delete Tracker only ever shows alongside Un-Complete This -- by
        // request, only a tracker already filed under Trackers - Complete
        // can be deleted at all (enforced again server-side in POST
        // /delete, not just this visibility check).
        deleteTrackerButton.hidden = !data.complete;
      } catch {
        // Leave all three hidden -- not worth surfacing an error for this.
      }
    }
    hideCompleteButton.addEventListener('click', async () => {
      if (!confirm(`Mark "${label}" as complete? It'll move from Trackers into Trackers - Complete.`)) return;
      try {
        const res = await fetch(`${apiBase}/mark-complete`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        await loadCompletionState();
      } catch (err) {
        alert(`Error: ${err.message}`);
      }
    });
    uncompleteButton.addEventListener('click', async () => {
      if (!confirm(`Move "${label}" back into Trackers?`)) return;
      try {
        const res = await fetch(`${apiBase}/mark-incomplete`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        await loadCompletionState();
      } catch (err) {
        alert(`Error: ${err.message}`);
      }
    });

    // Totally deletes this tracker -- rows, columns, every status, the
    // full audit trail, its Notes, all of it, permanently. Only ever
    // reachable while it's already filed under Trackers - Complete (see
    // loadCompletionState above), and enforced again server-side, same as
    // every other tracker-management action. A second, more explicit
    // confirm than Hide Complete/Un-Complete This get -- this one can't
    // be undone by clicking another button.
    deleteTrackerButton.addEventListener('click', async () => {
      if (!confirm(`Permanently delete "${label}"? This deletes every row, column, status, and note -- it cannot be undone.`)) return;
      try {
        const res = await fetch(`${apiBase}/delete`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        alert(data.filesRemoved ? `"${label}" has been deleted.` : `"${label}" was removed from the sidebar, but its files couldn't be fully deleted -- ask Claude to finish cleaning it up.`);
        window.location.href = '/';
      } catch (err) {
        alert(`Error: ${err.message}`);
      }
    });

    // ---- Notes ----
    // Minimised by default (per request) -- fetched once on mount (cheap,
    // small payload) so it's ready the instant someone expands it, but the
    // body itself starts hidden regardless of whether there's content.
    // Editable by Tracker Managers only (GET /notes's own `editable`
    // flag, same "server decides, client just reflects it" convention as
    // Add Column/Hide Complete above) -- same TRACKER_MANAGER gate as
    // every other tracker-management action.
    let notesCanEdit = false; // this viewer's own edit permission -- from GET /notes's `editable` flag
    let currentNotesHtml = ''; // the last-saved raw HTML -- what Edit Notes actually loads into the editor, never re-derived from notesView's rendered innerHTML (which may be showing the "No notes yet." placeholder instead)
    notesToggle.addEventListener('click', () => {
      const expanded = !notesBody.hidden;
      notesBody.hidden = expanded;
      notesToggle.innerHTML = expanded ? '&#9656; Notes' : '&#9662; Notes';
    });
    loadNotes();

    async function loadNotes() {
      try {
        const res = await fetch(`${apiBase}/notes`);
        const data = await res.json();
        notesCanEdit = !!data.editable;
        renderNotesView(data.html || '');
      } catch {
        // Leave the section showing whatever it last had (nothing, on a
        // fresh mount) -- not worth surfacing an error for this.
      }
    }

    function renderNotesView(html) {
      currentNotesHtml = html || '';
      notesView.innerHTML = isBlankHtml(currentNotesHtml) ? '<p class="status">No notes yet.</p>' : currentNotesHtml;
      notesEditButton.hidden = !notesCanEdit;
    }

    notesEditButton.addEventListener('click', () => {
      notesEditable.innerHTML = currentNotesHtml;
      notesView.hidden = true;
      notesEditButton.hidden = true;
      notesEditor.hidden = false;
      notesEditable.focus();
    });
    notesEditor.querySelectorAll('.rt-notes-tool').forEach((btn) => {
      btn.addEventListener('click', () => {
        notesEditable.focus();
        document.execCommand(btn.dataset.cmd, false, null);
      });
    });
    container.querySelector('#notes-cancel-button').addEventListener('click', () => {
      notesEditor.hidden = true;
      notesView.hidden = false;
      notesEditButton.hidden = !notesCanEdit;
    });
    container.querySelector('#notes-save-button').addEventListener('click', async () => {
      try {
        const res = await fetch(`${apiBase}/notes`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ html: notesEditable.innerHTML }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        renderNotesView(data.html || '');
        notesEditor.hidden = true;
        notesView.hidden = false;
      } catch (err) {
        alert(`Error: ${err.message}`);
      }
    });

    // One shared tooltip element for every cell's "last changed by <name>
    // on <date>" hover -- reused across every generated tracker page (it
    // lives on <body>, outside the torn-down mount subtree), same pattern
    // tc-elite-rollout's own client.js uses.
    let tooltipEl = document.querySelector('.rt-tooltip');
    if (!tooltipEl) {
      tooltipEl = document.createElement('div');
      tooltipEl.className = 'rt-tooltip';
      tooltipEl.hidden = true;
      document.body.appendChild(tooltipEl);
    }
    let tooltipHideTimer = null;
    let tooltipShowTimer = null;
    function cancelHideTooltip() {
      clearTimeout(tooltipHideTimer);
    }
    function scheduleHideTooltip() {
      clearTimeout(tooltipHideTimer);
      tooltipHideTimer = setTimeout(() => {
        tooltipEl.hidden = true;
      }, 300);
    }
    function cancelShowTooltip() {
      clearTimeout(tooltipShowTimer);
    }
    function scheduleShowTooltip(td, pageX, pageY) {
      clearTimeout(tooltipShowTimer);
      tooltipShowTimer = setTimeout(() => {
        showCellTooltip(td, pageX, pageY);
      }, 150);
    }
    if (!tooltipEl.dataset.wired) {
      tooltipEl.dataset.wired = '1';
      tooltipEl.addEventListener('mouseover', cancelHideTooltip);
      tooltipEl.addEventListener('mouseout', scheduleHideTooltip);
      tooltipEl.addEventListener('click', (e) => {
        if (e.target.closest('.rt-tooltip-history-link') && tooltipEl._historyCtx) {
          openHistoryModal(tooltipEl._historyCtx);
        }
      });
    }

    // ---- Add Row ----
    addRowButton.addEventListener('click', () => {
      addColumnForm.hidden = true;
      bulkAddRowsForm.hidden = true;
      addRowForm.hidden = false;
      container.querySelector('#new-row-name').focus();
    });
    container.querySelector('#cancel-row-button').addEventListener('click', () => {
      addRowForm.hidden = true;
    });
    container.querySelector('#save-row-button').addEventListener('click', async () => {
      const errorEl = container.querySelector('#add-row-error');
      errorEl.hidden = true;
      const name = container.querySelector('#new-row-name').value.trim();
      if (!name) {
        errorEl.hidden = false;
        errorEl.textContent = `${rowNoun} name is required.`;
        return;
      }
      try {
        const res = await fetch(`${apiBase}/rows`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        addRowForm.hidden = true;
        container.querySelector('#new-row-name').value = '';
        await loadGrid();
      } catch (err) {
        errorEl.hidden = false;
        errorEl.textContent = `Error: ${err.message}`;
      }
    });

    // ---- Bulk Add Rows ----
    // Same textarea-of-names idea Rollout Tracker Builder's own form uses
    // for its Rows field -- open to everyone, same as the single-row Add
    // {rowNoun} above (a batch of the exact same ungated action isn't a
    // new permission). Duplicate names are reported back rather than
    // failing the whole batch (see POST /rows/bulk in
    // rollout-tracker-server.js).
    bulkAddRowsButton.addEventListener('click', () => {
      addRowForm.hidden = true;
      addColumnForm.hidden = true;
      bulkAddRowsForm.hidden = false;
      container.querySelector('#bulk-row-names').focus();
    });
    container.querySelector('#cancel-bulk-rows-button').addEventListener('click', () => {
      bulkAddRowsForm.hidden = true;
    });
    container.querySelector('#save-bulk-rows-button').addEventListener('click', async () => {
      const errorEl = container.querySelector('#bulk-add-rows-error');
      errorEl.hidden = true;
      const namesInput = container.querySelector('#bulk-row-names');
      const names = namesInput.value
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      if (names.length === 0) {
        errorEl.hidden = false;
        errorEl.textContent = `Enter at least one ${rowNoun.toLowerCase()}.`;
        return;
      }
      try {
        const res = await fetch(`${apiBase}/rows/bulk`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ names }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        bulkAddRowsForm.hidden = true;
        namesInput.value = '';
        await loadGrid();
        if (data.skipped && data.skipped.length > 0) {
          alert(`${data.added.length} added. Skipped (already existed): ${data.skipped.join(', ')}`);
        }
      } catch (err) {
        errorEl.hidden = false;
        errorEl.textContent = `Error: ${err.message}`;
      }
    });

    // ---- Add Column ----
    addColumnButton.addEventListener('click', () => {
      addRowForm.hidden = true;
      bulkAddRowsForm.hidden = true;
      addColumnForm.hidden = false;
      container.querySelector('#new-column-label').focus();
    });
    container.querySelector('#cancel-column-button').addEventListener('click', () => {
      addColumnForm.hidden = true;
    });
    container.querySelector('#save-column-button').addEventListener('click', async () => {
      const errorEl = container.querySelector('#add-column-error');
      errorEl.hidden = true;
      const columnLabel = container.querySelector('#new-column-label').value.trim();
      if (!columnLabel) {
        errorEl.hidden = false;
        errorEl.textContent = 'Column label is required.';
        return;
      }
      try {
        const res = await fetch(`${apiBase}/columns`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: columnLabel }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        addColumnForm.hidden = true;
        container.querySelector('#new-column-label').value = '';
        await loadGrid();
      } catch (err) {
        errorEl.hidden = false;
        errorEl.textContent = `Error: ${err.message}`;
      }
    });

    loadGrid();

    async function loadGrid() {
      refreshButton.disabled = true;
      statusEl.hidden = false;
      statusEl.className = 'status';
      statusEl.textContent = 'Loading...';
      try {
        const res = await fetch(`${apiBase}/${showAll ? '?all=true' : ''}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        renderGrid(data);
        addColumnButton.hidden = !data.isManager;
        if (data.isManager) {
          loadCompletionState();
        } else {
          hideCompleteButton.hidden = true;
          uncompleteButton.hidden = true;
          deleteTrackerButton.hidden = true;
        }
        statusEl.hidden = true;
      } catch (err) {
        statusEl.className = 'status error';
        statusEl.textContent = `Error: ${err.message}`;
      } finally {
        refreshButton.disabled = false;
      }
    }

    function renderGrid(data) {
      const { columns, rows, totalRows } = data;
      if (columns.length === 0 && rows.length === 0) {
        const message = showAll
          ? `Nothing tracked yet -- add a ${rowNoun.toLowerCase()} and a column to get started.`
          : `Nothing outstanding (0/${totalRows}) -- everything tracked is Done, N/A, or Cancelled. Try Show All to see everything.`;
        gridContainer.innerHTML = `<p class="status">${message}</p>`;
        return;
      }
      const table = document.createElement('table');
      table.className = 'rt-table';
      // Filter row, by request -- a wildcard text filter under the row-
      // name column (same "e.g. Acme* (wildcards with *)" convention this
      // dashboard already uses for client-name search elsewhere), and a
      // status multi-select filter under every real column. Both are
      // purely client-side, narrowing whatever loadGrid() already loaded
      // -- see renderTbodyRows()/applyLocalFilters() below, not a new
      // server round trip per keystroke/checkbox.
      table.innerHTML = `
        <thead>
          <tr class="shaded-row">
            <th>${escapeHtml(rowNoun)} (<span class="rt-visible-count"></span>/${totalRows})</th>
            ${columns
              .map(
                (col) =>
                  `<th class="rt-col-header" draggable="${data.isManager ? 'true' : 'false'}" data-column-id="${col.id}"><button type="button" class="rt-bulk-col-btn" data-column-id="${col.id}" title="Set every currently visible ${rowNoun.toLowerCase()} in this column to the same value">⚙</button> ${escapeHtml(col.label)}</th>`
              )
              .join('')}
          </tr>
          <tr class="rt-filter-row">
            <th><input type="text" class="rt-row-filter-input" placeholder="e.g. Acme* (wildcards with *)" value="${escapeHtml(rowNameFilterText)}" /></th>
            ${columns
              .map(
                (col) =>
                  `<th class="rt-status-filter-cell" data-column-id="${col.id}"><button type="button" class="link-button rt-status-filter-btn" data-column-id="${col.id}">Filter${statusFilterCountLabel(col.id)}</button></th>`
              )
              .join('')}
          </tr>
        </thead>
        <tbody></tbody>
      `;
      gridContainer.innerHTML = '';
      gridContainer.appendChild(table);
      // wireCellInteractions is delegated on `table` itself, and
      // wireBulkColumnButtons' own buttons live in the header -- both
      // survive a tbody-only refresh untouched, so both are wired ONCE
      // here, not inside renderTbodyRows() (which runs again on every
      // filter change and would otherwise stack duplicate listeners on
      // the same persistent elements). wireBulkRowButtons/
      // wireRenameButtons are the opposite -- their buttons live INSIDE
      // tbody and get destroyed/recreated on every refresh, so those two
      // DO need re-wiring every time, inside renderTbodyRows() itself.
      wireCellInteractions(table);
      wireBulkColumnButtons(table);
      renderTbodyRows(columns, rows);
      wireRowNameFilterInput(table, columns, rows);
      wireStatusFilterButtons(table, columns, rows);
      wireColumnDragReorder(table, columns);
    }

    function statusFilterCountLabel(columnId) {
      const selected = columnStatusFilters.get(columnId);
      return selected && selected.size > 0 ? ` (${selected.size})` : '';
    }

    // A row passes if its name matches the wildcard filter (when set) AND
    // every column with an active status filter has that row's cell in
    // one of the selected statuses -- same "every active filter ANDed"
    // convention Check Client's own M365 Users table uses. An EMPTY
    // selected-status set for a column means "no filter" (show
    // everything), not "hide everything" -- same "nothing checked = no
    // filter" convention a plain Excel-style column filter uses.
    function applyLocalFilters(rows, columns) {
      return rows.filter((row) => {
        if (rowNameFilterText && !matchesWildcard(row.name, rowNameFilterText)) return false;
        for (const col of columns) {
          const selected = columnStatusFilters.get(col.id);
          if (!selected || selected.size === 0) continue;
          const cell = row.cells[col.id];
          const status = cell ? cell.status : 'not_done';
          if (!selected.has(status)) return false;
        }
        return true;
      });
    }

    // Rebuilds just <tbody> -- called on every full loadGrid() AND on
    // every filter change, without re-fetching or rebuilding the header/
    // filter row (whose own input/checkbox state would otherwise be lost
    // mid-edit). currentVisibleRowIds is updated here so the column bulk-
    // update button (wireBulkColumnButtons below) always reflects
    // whatever's actually on screen right now.
    function renderTbodyRows(columns, allRows) {
      const table = gridContainer.querySelector('table');
      if (!table) return;
      const visibleRows = applyLocalFilters(allRows, columns);
      currentVisibleRowIds = visibleRows.map((r) => r.id);
      const visibleCountEl = table.querySelector('.rt-visible-count');
      if (visibleCountEl) visibleCountEl.textContent = String(visibleRows.length);
      const tbody = table.querySelector('tbody');
      tbody.innerHTML =
        visibleRows.length > 0
          ? visibleRows
              .map(
                (row) => `
            <tr>
              <td><button type="button" class="rt-bulk-row-btn" data-row-id="${row.id}" title="Set every column in this row to the same value">⚙</button> <button type="button" class="rt-rename-btn" data-row-id="${row.id}" data-row-name="${escapeHtml(row.name)}" title="Rename">${RENAME_ICON_SVG}</button> ${escapeHtml(row.name)}</td>
              ${columns.map((col) => cellHtml(row, col)).join('')}
            </tr>`
              )
              .join('')
          : `<tr><td colspan="${columns.length + 1}" class="status">No ${rowNoun.toLowerCase()}s matching these filters.</td></tr>`;
      // Only the two buttons that live INSIDE tbody rows (and so get
      // destroyed/recreated every time this runs) need re-wiring here --
      // see renderGrid()'s own comment for why wireCellInteractions/
      // wireBulkColumnButtons are wired exactly once, there, instead.
      wireBulkRowButtons(table);
      wireRenameButtons(table);
    }

    function wireRowNameFilterInput(table, columns, rows) {
      const input = table.querySelector('.rt-row-filter-input');
      input.addEventListener('input', () => {
        rowNameFilterText = input.value.trim();
        renderTbodyRows(columns, rows);
      });
    }

    // Toggleable checkbox popup per column -- clicking the same Filter
    // button again closes it (same convention wireBulkColumnButtons' own
    // editor already uses below), and by request ("the filter popups
    // won't close") so does clicking anywhere outside it, same standard
    // dropdown-dismissal behaviour as the rest of the web.
    function wireStatusFilterButtons(table, columns, rows) {
      table.querySelectorAll('.rt-status-filter-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation(); // otherwise this same click immediately re-triggers the outside-click handler being registered below, on the very popup it just opened
          const filterCell = btn.closest('th');
          const existing = filterCell.querySelector('.rt-status-filter-popup');
          if (existing) {
            existing.remove();
            return;
          }
          const columnId = Number(btn.dataset.columnId);
          if (!columnStatusFilters.has(columnId)) columnStatusFilters.set(columnId, new Set());
          const selected = columnStatusFilters.get(columnId);
          const popup = document.createElement('div');
          popup.className = 'rt-status-filter-popup';
          popup.innerHTML = `
            ${STATUS_ORDER.map(
              (s) =>
                `<label class="rt-status-filter-option"><input type="checkbox" value="${s}"${selected.has(s) ? ' checked' : ''} /> ${STATUS_SYMBOLS[s]} ${STATUS_LABELS[s]}</label>`
            ).join('')}
            <button type="button" class="link-button rt-status-filter-clear">Clear</button>
          `;
          popup.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
            cb.addEventListener('change', () => {
              if (cb.checked) selected.add(cb.value);
              else selected.delete(cb.value);
              btn.textContent = `Filter${statusFilterCountLabel(columnId)}`;
              renderTbodyRows(columns, rows);
            });
          });
          popup.querySelector('.rt-status-filter-clear').addEventListener('click', () => {
            selected.clear();
            popup.querySelectorAll('input[type="checkbox"]').forEach((cb) => (cb.checked = false));
            btn.textContent = 'Filter';
            renderTbodyRows(columns, rows);
          });
          filterCell.appendChild(popup);
          // Close on an outside click. Safe to register right here (not
          // deferred) -- e.stopPropagation() above already keeps THIS
          // same click from ever reaching document, so there's no risk
          // of it immediately closing the popup it just opened. Cleans
          // itself up either way this popup closes: fires and removes
          // itself on a genuine outside click, or self-removes (no-op by
          // then) the next time anything is clicked after the Filter
          // button's own re-click already closed it.
          function onOutsideClick(ev) {
            if (popup.isConnected && popup.contains(ev.target)) return;
            popup.remove();
            document.removeEventListener('click', onOutsideClick);
          }
          document.addEventListener('click', onOutsideClick);
        });
      });
    }

    // Drag-to-reorder columns, by request ("Dragging a column left or
    // right to place it in a different position will be a permanent kept
    // change") -- Tracker Manager-only (same `draggable` gate set in
    // renderGrid() above). Computes the new order from `columns` (already
    // in the real current sort order) rather than reading DOM positions,
    // so no live header-dragging/reflow code is needed at all -- on drop,
    // PUT the new full order, then loadGrid() picks it up from the
    // server's own now-updated sort_order, same "server is the one
    // source of truth, just reload" convention every other write on this
    // page already follows.
    function wireColumnDragReorder(table, columns) {
      table.querySelectorAll('th.rt-col-header[draggable="true"]').forEach((th) => {
        th.addEventListener('dragstart', () => {
          draggedColumnId = Number(th.dataset.columnId);
          th.classList.add('rt-col-dragging');
        });
        th.addEventListener('dragend', () => th.classList.remove('rt-col-dragging'));
        th.addEventListener('dragover', (e) => {
          e.preventDefault();
          if (Number(th.dataset.columnId) !== draggedColumnId) th.classList.add('rt-col-drag-over');
        });
        th.addEventListener('dragleave', () => th.classList.remove('rt-col-drag-over'));
        th.addEventListener('drop', async (e) => {
          e.preventDefault();
          th.classList.remove('rt-col-drag-over');
          const targetColumnId = Number(th.dataset.columnId);
          if (draggedColumnId === null || draggedColumnId === targetColumnId) return;
          const order = columns.map((c) => c.id);
          const fromIndex = order.indexOf(draggedColumnId);
          const toIndex = order.indexOf(targetColumnId);
          order.splice(fromIndex, 1);
          order.splice(toIndex, 0, draggedColumnId);
          draggedColumnId = null;
          try {
            const res = await fetch(`${apiBase}/columns/order`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ order }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
            await loadGrid();
          } catch (err) {
            alert(`Error reordering columns: ${err.message}`);
          }
        });
      });
    }

    function cellHtml(row, col) {
      const cell = row.cells[col.id] || { status: 'not_done', reason: null };
      return `<td class="rt-cell rt-cell--${cell.status} rt-cell--editable" data-row-id="${row.id}" data-column-id="${col.id}" data-status="${cell.status}" data-reason="${escapeHtml(cell.reason || '')}" data-label="${escapeHtml(col.label)}" data-row-name="${escapeHtml(row.name)}">${STATUS_SYMBOLS[cell.status]}</td>`;
    }

    function historyContextFor(td) {
      return {
        rowId: td.dataset.rowId,
        columnId: td.dataset.columnId,
        label: td.dataset.label,
        rowName: td.dataset.rowName,
      };
    }

    function historyUrlFor(ctx) {
      return `${apiBase}/cells/${ctx.rowId}/${ctx.columnId}/history`;
    }

    function wireCellInteractions(table) {
      table.addEventListener('click', (e) => {
        const td = e.target.closest('.rt-cell--editable');
        if (td && !td.querySelector('select,input')) {
          openCellEditor(td);
        }
      });
      table.addEventListener('mouseover', (e) => {
        const td = e.target.closest('.rt-cell');
        if (td) {
          cancelHideTooltip();
          scheduleShowTooltip(td, e.pageX, e.pageY);
        }
      });
      table.addEventListener('mouseout', (e) => {
        const td = e.target.closest('.rt-cell');
        if (td) {
          cancelShowTooltip();
          scheduleHideTooltip();
        }
      });
    }

    async function showCellTooltip(td, pageX, pageY) {
      const ctx = historyContextFor(td);
      tooltipEl._historyCtx = ctx;
      tooltipEl.innerHTML = buildTooltipHtml(td);
      tooltipEl.style.left = `${pageX + 12}px`;
      tooltipEl.style.top = `${pageY + 12}px`;
      tooltipEl.hidden = false;

      try {
        const res = await fetch(historyUrlFor(ctx));
        const data = await res.json();
        if (tooltipEl._historyCtx !== ctx) return;
        const entry = (data.history || [])[0];
        tooltipEl.innerHTML = buildTooltipHtml(td, entry);
      } catch {
        // Silent -- a failed history fetch just leaves the base content
        // showing, without the who/when line.
      }
    }

    function buildTooltipHtml(td, entry) {
      const status = td.dataset.status;
      const reason = td.dataset.reason;
      let base = STATUS_LABELS[status] || status;
      if (STATUSES_WITH_COMMENT.includes(status) && reason) base += `: ${escapeHtml(reason)}`;
      const whenHtml = entry
        ? `<div class="rt-tooltip-when">Last changed by ${escapeHtml(entry.changedByName)} on ${escapeHtml(formatDateTime(entry.changedAt))}</div>`
        : `<div class="rt-tooltip-when">Loading history...</div>`;
      return `<div>${escapeHtml(base)}</div>${whenHtml}<button type="button" class="rt-tooltip-history-link">View full history</button>`;
    }

    // Shared .history-modal-overlay/.history-modal-panel classes (already
    // dashboard-wide, see styles.css) -- same markup shape tc-elite-rollout
    // and Workshop both already use for their own per-record history.
    async function openHistoryModal(ctx) {
      const overlay = document.createElement('div');
      overlay.className = 'history-modal-overlay';
      overlay.innerHTML = `
        <div class="history-modal-panel">
          <div class="history-modal-panel-header">
            <span>${escapeHtml(ctx.rowName || '')} -- ${escapeHtml(ctx.label || '')}</span>
            <button type="button" class="history-modal-close" aria-label="Close">✕</button>
          </div>
          <div class="history-modal-body"><p class="status">Loading...</p></div>
        </div>
      `;
      document.body.appendChild(overlay);
      const close = () => {
        overlay.remove();
        document.removeEventListener('keydown', onKeydown);
      };
      function onKeydown(e) {
        if (e.key === 'Escape') close();
      }
      document.addEventListener('keydown', onKeydown);
      overlay.querySelector('.history-modal-close').addEventListener('click', close);
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
      });

      try {
        const res = await fetch(historyUrlFor(ctx));
        const data = await res.json();
        const body = overlay.querySelector('.history-modal-body');
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        if (!data.history || data.history.length === 0) {
          body.innerHTML = '<p class="status">No history found.</p>';
          return;
        }
        body.innerHTML = `<ul class="history-modal-list">${data.history.map(historyEntryHtml).join('')}</ul>`;
      } catch (err) {
        overlay.querySelector('.history-modal-body').innerHTML = `<p class="status error">Error: ${escapeHtml(err.message)}</p>`;
      }
    }

    function historyEntryHtml(entry) {
      const oldLabel = entry.oldStatus ? STATUS_LABELS[entry.oldStatus] || entry.oldStatus : '(new)';
      const newLabel = entry.newStatus ? STATUS_LABELS[entry.newStatus] || entry.newStatus : '(none)';
      let changeText = oldLabel === newLabel ? escapeHtml(newLabel) : `${escapeHtml(oldLabel)} &rarr; ${escapeHtml(newLabel)}`;
      if (entry.newReason) changeText += `: ${escapeHtml(entry.newReason)}`;
      const when = `${escapeHtml(entry.changedByName)} -- ${escapeHtml(formatDateTime(entry.changedAt))}`;
      return `<li class="history-modal-entry"><div>${changeText}</div><div class="history-modal-when">${when}</div></li>`;
    }

    function openCellEditor(td) {
      const originalHtml = td.innerHTML;
      const currentStatus = td.dataset.status;
      const currentReason = td.dataset.reason || '';
      td.innerHTML = `
        <select class="rt-status-select">
          ${STATUS_ORDER.map((s) => `<option value="${s}"${s === currentStatus ? ' selected' : ''}>${STATUS_LABELS[s]}</option>`).join('')}
        </select>
        <input type="text" class="rt-inline-input rt-reason-input" placeholder="${STATUSES_REQUIRING_COMMENT.includes(currentStatus) ? 'Comment (required)' : 'Comment (optional)'}" value="${escapeHtml(currentReason)}" style="${STATUSES_WITH_COMMENT.includes(currentStatus) ? '' : 'display:none;'}" />
        <div class="rt-form-actions">
          <button type="button" class="button-link button-link--small rt-save">Save</button>
          <button type="button" class="rt-cancel">Cancel</button>
        </div>
      `;
      const select = td.querySelector('select');
      const reasonInput = td.querySelector('.rt-reason-input');
      select.addEventListener('change', () => {
        reasonInput.style.display = STATUSES_WITH_COMMENT.includes(select.value) ? '' : 'none';
        reasonInput.placeholder = STATUSES_REQUIRING_COMMENT.includes(select.value) ? 'Comment (required)' : 'Comment (optional)';
      });
      td.querySelector('.rt-cancel').addEventListener('click', () => {
        td.innerHTML = originalHtml;
      });
      td.querySelector('.rt-save').addEventListener('click', () => {
        const status = select.value;
        const reasonValue = reasonInput.value.trim();
        if (STATUSES_REQUIRING_COMMENT.includes(status) && !reasonValue) {
          alert('A Note requires a comment.');
          return;
        }
        const reason = STATUSES_WITH_COMMENT.includes(status) ? reasonValue || null : null;
        saveCell(td, status, reason, originalHtml);
      });
    }

    async function saveCell(td, status, reason, originalHtml) {
      try {
        const res = await fetch(`${apiBase}/cells/${td.dataset.rowId}/${td.dataset.columnId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status, reason }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        await loadGrid();
      } catch (err) {
        td.innerHTML = originalHtml;
        alert(`Error saving: ${err.message}`);
      }
    }

    function wireBulkRowButtons(table) {
      table.querySelectorAll('.rt-bulk-row-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const existing = btn.parentElement.querySelector('.rt-bulk-row-editor');
          if (existing) {
            existing.remove();
            return;
          }
          const rowId = btn.dataset.rowId;
          const editor = buildBulkEditor('Set Row', async (status, reason) => {
            await fetchBulkRow(rowId, status, reason);
            await loadGrid();
          });
          btn.insertAdjacentElement('afterend', editor);
        });
      });
    }

    function wireBulkColumnButtons(table) {
      table.querySelectorAll('.rt-bulk-col-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const existing = btn.parentElement.querySelector('.rt-bulk-row-editor');
          if (existing) {
            existing.remove();
            return;
          }
          const columnId = btn.dataset.columnId;
          // Scoped to whichever rows are CURRENTLY VISIBLE -- by request,
          // this has to respect the new per-column/row-name filters too,
          // not just Show All (currentVisibleRowIds is kept in sync by
          // renderTbodyRows() on every filter change, same convention
          // tc-elite-rollout's own wireBulkColumnButtons already followed
          // for Show All alone, just generalised).
          const visibleRowIds = currentVisibleRowIds;
          const editor = buildBulkEditor(`Set Column (${visibleRowIds.length} visible)`, async (status, reason) => {
            await fetchBulkColumn(columnId, status, reason, visibleRowIds);
            await loadGrid();
          });
          // This editor lands inside the column header's own <th>, which
          // is draggable="true" now (column reordering) -- explicitly
          // false here so clicking/dragging its select/input can't be
          // mistaken for a column-reorder drag start.
          editor.setAttribute('draggable', 'false');
          btn.insertAdjacentElement('afterend', editor);
        });
      });
    }

    function buildBulkEditor(saveLabel, onSave) {
      const editor = document.createElement('div');
      editor.className = 'rt-bulk-row-editor';
      editor.innerHTML = `
        <select class="rt-status-select">
          ${STATUS_ORDER.map((s) => `<option value="${s}">${STATUS_LABELS[s]}</option>`).join('')}
        </select>
        <input type="text" class="rt-inline-input rt-reason-input" placeholder="Comment (optional)" style="display:none" />
        <div class="rt-form-actions">
          <button type="button" class="button-link button-link--small rt-save">${saveLabel}</button>
          <button type="button" class="rt-cancel">Cancel</button>
        </div>
      `;
      const select = editor.querySelector('select');
      const reasonInput = editor.querySelector('.rt-reason-input');
      select.addEventListener('change', () => {
        reasonInput.style.display = STATUSES_WITH_COMMENT.includes(select.value) ? '' : 'none';
        reasonInput.placeholder = STATUSES_REQUIRING_COMMENT.includes(select.value) ? 'Comment (required)' : 'Comment (optional)';
      });
      editor.querySelector('.rt-cancel').addEventListener('click', () => editor.remove());
      editor.querySelector('.rt-save').addEventListener('click', async () => {
        const status = select.value;
        const reasonValue = reasonInput.value.trim();
        if (STATUSES_REQUIRING_COMMENT.includes(status) && !reasonValue) {
          alert('A Note requires a comment.');
          return;
        }
        const reason = STATUSES_WITH_COMMENT.includes(status) ? reasonValue || null : null;
        try {
          await onSave(status, reason);
          editor.remove();
        } catch (err) {
          alert(`Error: ${err.message}`);
        }
      });
      return editor;
    }

    async function fetchBulkRow(rowId, status, reason) {
      const res = await fetch(`${apiBase}/rows/${rowId}/bulk-cells`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, reason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    }

    async function fetchBulkColumn(columnId, status, reason, rowIds) {
      const res = await fetch(`${apiBase}/columns/${columnId}/bulk-cells`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, reason, rowIds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    }

    function wireRenameButtons(table) {
      table.querySelectorAll('.rt-rename-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const existing = btn.parentElement.querySelector('.rt-rename-editor');
          if (existing) {
            existing.remove();
            return;
          }
          const rowId = btn.dataset.rowId;
          const editor = document.createElement('div');
          editor.className = 'rt-bulk-row-editor rt-rename-editor';
          editor.innerHTML = `
            <input type="text" class="rt-inline-input rt-rename-input" value="${escapeHtml(btn.dataset.rowName)}" />
            <div class="rt-form-actions">
              <button type="button" class="button-link button-link--small rt-save">Save</button>
              <button type="button" class="rt-cancel">Cancel</button>
            </div>
          `;
          btn.insertAdjacentElement('afterend', editor);
          const input = editor.querySelector('.rt-rename-input');
          input.focus();
          input.select();

          async function save() {
            const newName = input.value.trim();
            if (!newName) {
              alert('Name cannot be blank.');
              return;
            }
            try {
              const res = await fetch(`${apiBase}/rows/${rowId}/name`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newName }),
              });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
              editor.remove();
              await loadGrid();
            } catch (err) {
              alert(`Error: ${err.message}`);
            }
          }

          editor.querySelector('.rt-cancel').addEventListener('click', () => editor.remove());
          editor.querySelector('.rt-save').addEventListener('click', save);
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') editor.remove();
          });
        });
      });
    }
  };
}

// True for '', null/undefined, or HTML that renders to nothing visible
// (execCommand leaves an empty contenteditable as e.g. '<div><br></div>')
// -- lets the notes view show a "No notes yet." placeholder instead of a
// blank box, and lets Edit Notes start from a genuinely empty editor
// rather than a stray <div><br></div>.
function isBlankHtml(html) {
  return !html || !html.replace(/<[^>]*>/g, '').trim();
}

function formatDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString();
}

// Same wildcard semantics as @dashboard/autotask-client's own
// parseWildcard()/matchesWildcard() (e.g. Client Details' own "Acme*"
// search) -- duplicated here rather than imported since that package is
// Node-only (used from server.js files), and this module runs in the
// browser. No `*` at all defaults to "contains" (same as `*text*`), a
// trailing `*` means "begins with", a leading `*` means "ends with".
function parseWildcard(term) {
  if (!term) return null;
  const startsWithStar = term.startsWith('*');
  const endsWithStar = term.endsWith('*');
  let value = term;
  if (startsWithStar) value = value.slice(1);
  if (endsWithStar) value = value.slice(0, -1);
  value = value.trim();
  if (!value) return null;
  if (startsWithStar && endsWithStar) return { op: 'contains', value };
  if (endsWithStar) return { op: 'beginsWith', value };
  if (startsWithStar) return { op: 'endsWith', value };
  return { op: 'contains', value };
}

function matchesWildcard(value, term) {
  const parsed = parseWildcard(term);
  if (!parsed) return true;
  const v = (value || '').toLowerCase();
  const needle = parsed.value.toLowerCase();
  if (parsed.op === 'beginsWith') return v.startsWith(needle);
  if (parsed.op === 'endsWith') return v.endsWith(needle);
  return v.includes(needle);
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
