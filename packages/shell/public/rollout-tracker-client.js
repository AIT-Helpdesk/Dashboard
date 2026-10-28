// Shared, generic rollout-tracker mount factory -- extracted from
// tc-elite-rollout's own client.js. Originally simple-column only; now
// also carries tc-elite-rollout's own compound-column/stages/detail-sheet
// feature (by request, Oct 2026), ported across rather than left as a
// TC-Elite-only capability. createRolloutTrackerMount({ id, label,
// apiBase, rowNoun }) is called once per generated tracker's own thin
// client.js, returning that page's real mount(container) function. Every
// generated tracker shares this one module (loaded once by the browser),
// so nothing here is module-scope state -- each call below gets its own
// closure over showAll and the filter/drag/detail-sheet state just below
// it, the same way multiple tabbed pages built from tab-page-client.js
// each get their own independent state despite sharing that one module
// too.
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
  // columnId -> lowercased search text, only meaningful (and only shown in
  // the filter popup) while that column's own Note status checkbox is
  // ticked -- by request ("when filtered by note, enable adding note
  // content to filter by"). Narrows WITHIN the note-status rows a column
  // filter already matches, by the cell's own `reason` (comment) text --
  // see applyLocalFilters() below. Scoped to 'note' specifically, not
  // na/cancelled/issue's own optional comments, matching exactly what was
  // asked.
  const columnNoteTextFilters = new Map();
  // columnId -> wildcard search text, for a simple TEXT column's own
  // filter-row input -- the column-level mirror of rowNameFilterText
  // above (same wildcard semantics, same "narrows what loadGrid()
  // already loaded, no extra round trip" convention), by request ("Text
  // columns need a wildcard search capability like the item column").
  const columnTextFilters = new Map();
  let currentVisibleRowIds = [];
  // Set while a header drag is in progress -- module-call-scope (not
  // per-render), so it survives the dragstart->drop round trip regardless
  // of how many times the grid/detail sheet re-renders in between. Shared
  // by both the master grid's own columns AND a compound column's own
  // stages within its detail sheet (see wireHeaderDragReorder below) --
  // a drag is inherently one-at-a-time, so one variable covers both.
  let draggedHeaderId = null;
  // Compound-column detail-sheet state -- which one (if any) is currently
  // open below the master grid, its own Show All (separate from the
  // master grid's), and the last detail payload loaded (so the column
  // bulk-set button knows which rows are CURRENTLY visible on that
  // sheet). Same shape tc-elite-rollout/client.js keeps module-scope;
  // here it's scoped to this one createRolloutTrackerMount() call instead
  // (the generic concern already explained for showAll etc. above).
  let openDetailColumnId = null;
  let showAllDetail = false;
  let lastDetailData = null;
  // The row-level mirror of the three above, for a compound ROW's own
  // detail sheet (by request -- "Need Compound Rows as well as Compound
  // Columns"). Only ever one detail sheet shown at a time, columns or
  // rows alike -- opening one clears the other's open-id (see loadGrid()
  // below, which is the one place that decides what detailContainer
  // actually shows).
  let openDetailRowId = null;
  let showAllRowDetail = false;
  let lastRowDetailData = null;
  // Set from loadGrid()'s own GET /'s `isManager` field on every load --
  // buildAddStageSection() below reads this to hide Add Stage from a
  // non-manager, same "server decides, client just reflects it" gate the
  // header's own Add Column button already uses (addColumnButton.hidden).
  let isManager = false;

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
              <button type="button" class="rt-notes-tool" data-cmd="createLink" title="Insert link">&#128279; Link</button>
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
          <label><input type="radio" name="new-row-kind" value="simple" checked /> Simple</label>
          <label><input type="radio" name="new-row-kind" value="compound" /> Compound (has its own sub-rows)</label>
          <div id="new-row-subrows-fields" hidden>
            <input type="text" id="new-row-subrows" placeholder="Sub-rows, comma-separated (e.g. Site A, Site B)" />
          </div>
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
          <label><input type="radio" name="new-column-kind" value="simple" checked /> Simple</label>
          <label><input type="radio" name="new-column-kind" value="text" /> Text (free-text field, no status)</label>
          <label><input type="radio" name="new-column-kind" value="compound" /> Compound (has its own stages)</label>
          <div id="new-column-stages-fields" hidden>
            <input type="text" id="new-column-status-stages" placeholder="Status stages, comma-separated (e.g. Installed, Verified)" />
            <input type="text" id="new-column-text-stages" placeholder="Text stages, comma-separated -- optional (e.g. Domain, WHO)" />
          </div>
          <p id="add-column-error" class="status error" hidden></p>
          <div class="rt-form-actions">
            <button type="button" id="save-column-button" class="button-link">Save</button>
            <button type="button" id="cancel-column-button">Cancel</button>
          </div>
        </div>
      </div>

      <div id="grid-container"></div>
      <div id="detail-buttons-container" class="rt-detail-buttons"></div>
      <div id="detail-container"></div>
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
    const detailButtonsContainer = container.querySelector('#detail-buttons-container');
    const detailContainer = container.querySelector('#detail-container');
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
      columnNoteTextFilters.clear();
      columnTextFilters.clear();
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
        if (btn.dataset.cmd === 'createLink') {
          insertNotesLink();
          return;
        }
        document.execCommand(btn.dataset.cmd, false, null);
      });
    });

    // Link insertion needs a URL (prompt(), same lightweight convention
    // Workshop/Updates/What's On already use for one-off text input) and a
    // bit more than the generic one-liner above -- execCommand('createLink')
    // only does anything when text is already selected, so with nothing
    // selected this inserts the URL itself as the link's visible text
    // instead of silently no-opping. target="_blank"/rel are set here too
    // (not just server-side -- see sanitizeNotesHtml()'s own comment in
    // rollout-tracker-server.js, which re-asserts them regardless of what
    // the client sent) so the still-open editor's own saved-and-reloaded
    // view is already correct without waiting on a round trip.
    function insertNotesLink() {
      const raw = prompt('Link URL (e.g. https://example.com):');
      if (raw === null) return; // cancelled
      const url = normalizeNotesLinkUrl(raw);
      if (!url) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        document.execCommand('insertHTML', false, `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`);
      } else {
        document.execCommand('createLink', false, url);
        notesEditable.querySelectorAll('a[href]').forEach((a) => {
          if (!a.target) a.target = '_blank';
          if (!a.rel) a.rel = 'noopener noreferrer';
        });
      }
    }

    // Bare "example.com" or "example.com/page" is treated as https --
    // friendlier than requiring the scheme to be typed every time. A bare
    // email address becomes a mailto: link. Anything already carrying a
    // recognised scheme is left as-is.
    function normalizeNotesLinkUrl(raw) {
      const trimmed = (raw || '').trim();
      if (!trimmed) return null;
      if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return `mailto:${trimmed}`;
      return `https://${trimmed}`;
    }
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
    container.querySelectorAll('input[name="new-row-kind"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        container.querySelector('#new-row-subrows-fields').hidden = !container.querySelector('input[name="new-row-kind"][value="compound"]').checked;
      });
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
      const kind = container.querySelector('input[name="new-row-kind"]:checked').value;
      const subRows = [];
      if (kind === 'compound') {
        subRows.push(...container.querySelector('#new-row-subrows').value.split(',').map((s) => s.trim()).filter(Boolean));
        if (subRows.length === 0) {
          errorEl.hidden = false;
          errorEl.textContent = 'A compound row needs at least one sub-row.';
          return;
        }
      }
      try {
        const res = await fetch(`${apiBase}/rows`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, kind, subRows }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        addRowForm.hidden = true;
        container.querySelector('#new-row-name').value = '';
        container.querySelector('#new-row-subrows').value = '';
        container.querySelector('input[name="new-row-kind"][value="simple"]').checked = true;
        container.querySelector('#new-row-subrows-fields').hidden = true;
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
    container.querySelectorAll('input[name="new-column-kind"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        container.querySelector('#new-column-stages-fields').hidden = !container.querySelector('input[name="new-column-kind"][value="compound"]').checked;
      });
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
      const uiKind = container.querySelector('input[name="new-column-kind"]:checked').value; // 'simple' | 'text' | 'compound'
      const kind = uiKind === 'compound' ? 'compound' : 'simple';
      const cellType = uiKind === 'text' ? 'text' : 'status';
      const stages = [];
      if (kind === 'compound') {
        const statusLabels = container.querySelector('#new-column-status-stages').value.split(',').map((s) => s.trim()).filter(Boolean);
        const textLabels = container.querySelector('#new-column-text-stages').value.split(',').map((s) => s.trim()).filter(Boolean);
        statusLabels.forEach((l) => stages.push({ label: l, type: 'status' }));
        textLabels.forEach((l) => stages.push({ label: l, type: 'text' }));
        if (stages.length === 0) {
          errorEl.hidden = false;
          errorEl.textContent = 'A compound column needs at least one stage.';
          return;
        }
      }
      try {
        const res = await fetch(`${apiBase}/columns`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: columnLabel, kind, cellType, stages }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        addColumnForm.hidden = true;
        container.querySelector('#new-column-label').value = '';
        container.querySelector('#new-column-status-stages').value = '';
        container.querySelector('#new-column-text-stages').value = '';
        container.querySelector('input[name="new-column-kind"][value="simple"]').checked = true;
        container.querySelector('#new-column-stages-fields').hidden = true;
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
        isManager = !!data.isManager;
        renderDetailButtons(data.columns, data.rows);
        addColumnButton.hidden = !isManager;
        if (openDetailColumnId && !data.columns.some((c) => c.id === openDetailColumnId)) {
          // The open detail column got filtered out of view (fully
          // resolved, Show All is off) -- close its detail sheet rather
          // than leaving a stale one open with nothing left to show.
          openDetailColumnId = null;
          detailContainer.innerHTML = '';
        } else if (openDetailColumnId) {
          await loadDetail(openDetailColumnId);
        } else if (openDetailRowId && !data.rows.some((r) => r.id === openDetailRowId && r.kind === 'compound')) {
          // Same reasoning, the row-level mirror -- the open detail row
          // got filtered out of view, or (shouldn't normally happen, but
          // cheap to guard) is no longer compound.
          openDetailRowId = null;
          detailContainer.innerHTML = '';
        } else if (openDetailRowId) {
          await loadRowDetail(openDetailRowId);
        }
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
      // server round trip per keystroke/checkbox. A compound column gets
      // no bulk-set gear button (its cell is never directly settable --
      // see masterCellHtml below), same as tc-elite-rollout's own master
      // grid.
      table.innerHTML = `
        <thead>
          <tr class="shaded-row">
            <th>${escapeHtml(rowNoun)} (<span class="rt-visible-count"></span>/${totalRows})</th>
            ${columns
              .map(
                (col) =>
                  `<th class="rt-col-header" draggable="${data.isManager ? 'true' : 'false'}" data-column-id="${col.id}">${col.kind === 'simple' ? `<button type="button" class="rt-bulk-col-btn" data-column-id="${col.id}" data-cell-type="${col.cellType}" title="Set every currently visible ${rowNoun.toLowerCase()} in this column to the same value">⚙</button> ` : ''}${escapeHtml(col.label)}${data.isManager ? ` <button type="button" class="rt-rename-btn rt-rename-col-btn" data-column-id="${col.id}" data-column-label="${escapeHtml(col.label)}" title="Rename column">${RENAME_ICON_SVG}</button>` : ''}</th>`
              )
              .join('')}
          </tr>
          <tr class="rt-filter-row">
            <th><input type="text" class="rt-row-filter-input" placeholder="e.g. Acme* (wildcards with *)" value="${escapeHtml(rowNameFilterText)}" /></th>
            ${columns
              .map(
                (col) =>
                  // A text column has no real status to filter by (its
                  // cell_status is always the placeholder, see
                  // cell_type's own comment in rollout-tracker-db.js) --
                  // a wildcard text search instead, same convention the
                  // row-name column's own input above already uses, by
                  // request ("Text columns need a wildcard search
                  // capability like the item column").
                  `<th class="rt-status-filter-cell" data-column-id="${col.id}">${
                    col.cellType === 'text'
                      ? `<input type="text" class="rt-column-text-filter-input" data-column-id="${col.id}" placeholder="e.g. Acme* (wildcards with *)" value="${escapeHtml(columnTextFilters.get(col.id) || '')}" />`
                      : `<button type="button" class="link-button rt-status-filter-btn" data-column-id="${col.id}">Filter${statusFilterCountLabel(col.id)}</button>`
                  }</th>`
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
      wireBulkColumnButtons(table, 'master');
      wireRenameColumnButtons(table);
      renderTbodyRows(columns, rows);
      wireRowNameFilterInput(table, columns, rows);
      wireColumnTextFilterInputs(table, columns, rows);
      wireStatusFilterButtons(table, columns, rows);
      wireHeaderDragReorder(table, columns.map((c) => c.id), 'columnId', `${apiBase}/columns/order`, loadGrid);
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
          if (col.cellType === 'text') {
            const textFilter = columnTextFilters.get(col.id);
            if (textFilter) {
              const cell = row.cells[col.id];
              if (!matchesWildcard((cell && cell.reason) || '', textFilter)) return false;
            }
            continue; // no status to check below for a text column
          }
          const selected = columnStatusFilters.get(col.id);
          if (!selected || selected.size === 0) continue;
          const cell = row.cells[col.id];
          const status = cell ? cell.status : 'not_done';
          if (!selected.has(status)) return false;
          // Further narrows the 'note' subset by the cell's own comment
          // text, by request -- a column filter also matching 'issue'/
          // 'cancelled' etc. in the same breath is untouched by this (it
          // only ever applies to a cell whose status is actually 'note').
          const noteText = columnNoteTextFilters.get(col.id);
          if (status === 'note' && noteText) {
            const reason = ((cell && cell.reason) || '').toLowerCase();
            if (!reason.includes(noteText)) return false;
          }
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
              <td>
                <button type="button" class="rt-rename-btn" data-row-id="${row.id}" data-row-name="${escapeHtml(row.name)}" title="Rename">${RENAME_ICON_SVG}</button>
                ${escapeHtml(row.name)}
                ${row.kind === 'simple' ? ` <button type="button" class="rt-bulk-row-btn" data-row-id="${row.id}" title="Set every column in this row to the same value">⚙</button>` : ''}
              </td>
              ${columns.map((col) => masterCellHtml(row, col)).join('')}
            </tr>`
              )
              .join('')
          : `<tr><td colspan="${columns.length + 1}" class="status">No ${rowNoun.toLowerCase()}s matching these filters.</td></tr>`;
      // Only the buttons that live INSIDE tbody rows (and so get
      // destroyed/recreated every time this runs) need re-wiring here --
      // see renderGrid()'s own comment for why wireCellInteractions/
      // wireBulkColumnButtons are wired exactly once, there, instead.
      wireBulkRowButtons(table, 'master');
      wireRenameButtons(table);
    }

    function wireRowNameFilterInput(table, columns, rows) {
      const input = table.querySelector('.rt-row-filter-input');
      input.addEventListener('input', () => {
        rowNameFilterText = input.value.trim();
        renderTbodyRows(columns, rows);
      });
    }

    // The column-level mirror of wireRowNameFilterInput above, one per
    // simple TEXT column's own filter-row input.
    function wireColumnTextFilterInputs(table, columns, rows) {
      table.querySelectorAll('.rt-column-text-filter-input').forEach((input) => {
        input.addEventListener('input', () => {
          const columnId = Number(input.dataset.columnId);
          const value = input.value.trim();
          if (value) columnTextFilters.set(columnId, value);
          else columnTextFilters.delete(columnId);
          renderTbodyRows(columns, rows);
        });
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
          const noteText = columnNoteTextFilters.get(columnId) || '';
          const popup = document.createElement('div');
          popup.className = 'rt-status-filter-popup';
          popup.innerHTML = `
            ${STATUS_ORDER.map(
              (s) =>
                `<label class="rt-status-filter-option"><input type="checkbox" value="${s}"${selected.has(s) ? ' checked' : ''} /> ${STATUS_SYMBOLS[s]} ${STATUS_LABELS[s]}</label>`
            ).join('')}
            <label class="rt-status-filter-note-text"${selected.has('note') ? '' : ' hidden'}>Note contains
              <input type="text" class="rt-status-filter-note-input" value="${escapeHtml(noteText)}" placeholder="Search note text..." />
            </label>
            <button type="button" class="link-button rt-status-filter-clear">Clear</button>
          `;
          const noteTextField = popup.querySelector('.rt-status-filter-note-text');
          const noteTextInput = popup.querySelector('.rt-status-filter-note-input');
          noteTextInput.addEventListener('input', () => {
            const val = noteTextInput.value.trim().toLowerCase();
            if (val) columnNoteTextFilters.set(columnId, val);
            else columnNoteTextFilters.delete(columnId);
            renderTbodyRows(columns, rows);
          });
          popup.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
            cb.addEventListener('change', () => {
              if (cb.checked) selected.add(cb.value);
              else selected.delete(cb.value);
              btn.textContent = `Filter${statusFilterCountLabel(columnId)}`;
              // The note-text field only makes sense (and is only shown)
              // once the Note status is actually part of this filter --
              // unticking it drops any leftover search text too, so a
              // later re-tick starts clean rather than silently reapplying
              // a stale filter the user can no longer see.
              if (cb.value === 'note') {
                noteTextField.hidden = !cb.checked;
                if (!cb.checked) {
                  columnNoteTextFilters.delete(columnId);
                  noteTextInput.value = '';
                }
              }
              renderTbodyRows(columns, rows);
            });
          });
          popup.querySelector('.rt-status-filter-clear').addEventListener('click', () => {
            selected.clear();
            columnNoteTextFilters.delete(columnId);
            popup.querySelectorAll('input[type="checkbox"]').forEach((cb) => (cb.checked = false));
            noteTextInput.value = '';
            noteTextField.hidden = true;
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
    // renderGrid() above). Works the same regardless of a column's kind
    // -- a compound column reorders exactly like a simple one, only its
    // cell's editability differs. Computes the new order from `columns`
    // (already in the real current sort order) rather than reading DOM
    // positions, so no live header-dragging/reflow code is needed at all
    // -- on drop, PUT the new full order, then loadGrid() picks it up
    // from the server's own now-updated sort_order, same "server is the
    // one source of truth, just reload" convention every other write on
    // this page already follows.
    // Shared by the master grid's own columns (idAttr 'columnId', PUT
    // .../columns/order) and a compound column's own stages within its
    // detail sheet (idAttr 'stageId', PUT .../columns/:columnId/stages/
    // order, by request -- "Need to be able to move the columns on a
    // compound tab like they can on the main table"). `ids` is the full
    // set of header ids in their current order; `onDone` re-loads
    // whichever view needs to reflect the server's own now-updated
    // sort_order afterward (loadGrid or loadDetail).
    function wireHeaderDragReorder(table, ids, idAttr, url, onDone) {
      table.querySelectorAll('th.rt-col-header[draggable="true"]').forEach((th) => {
        th.addEventListener('dragstart', () => {
          draggedHeaderId = Number(th.dataset[idAttr]);
          th.classList.add('rt-col-dragging');
        });
        th.addEventListener('dragend', () => th.classList.remove('rt-col-dragging'));
        th.addEventListener('dragover', (e) => {
          e.preventDefault();
          if (Number(th.dataset[idAttr]) !== draggedHeaderId) th.classList.add('rt-col-drag-over');
        });
        th.addEventListener('dragleave', () => th.classList.remove('rt-col-drag-over'));
        th.addEventListener('drop', async (e) => {
          e.preventDefault();
          th.classList.remove('rt-col-drag-over');
          const targetId = Number(th.dataset[idAttr]);
          if (draggedHeaderId === null || draggedHeaderId === targetId) return;
          const order = ids.slice();
          const fromIndex = order.indexOf(draggedHeaderId);
          const toIndex = order.indexOf(targetId);
          order.splice(fromIndex, 1);
          order.splice(toIndex, 0, draggedHeaderId);
          draggedHeaderId = null;
          try {
            const res = await fetch(url, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ order }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
            await onDone();
          } catch (err) {
            alert(`Error reordering: ${err.message}`);
          }
        });
      });
    }

    // A simple column's cell is directly editable; a compound column's
    // cell is its own auto-computed rollup -- never directly editable,
    // same tcr-cell--editable split tc-elite-rollout/client.js uses for
    // its own master grid. A simple TEXT column (by request -- "Add
    // column on the main page should have Text column capability like
    // the compound pages") is also directly editable, but as free text
    // rather than a status dropdown -- same tcr-cell--text split a
    // compound column's own text-type stage already uses, just at the
    // master-grid level. The note explains why a non-editable cell opens
    // history instead of an editor (see wireCellInteractions below).
    function masterCellHtml(row, col) {
      const cell = row.cells[col.id] || { status: 'not_done', reason: null };
      // A TEXT column's cell is untouched by a row's own kind -- always
      // directly editable regardless (see rollout-tracker-db.js's own
      // seedNewRow comment for why).
      if (col.kind === 'simple' && col.cellType === 'text') {
        return `<td class="rt-cell rt-cell--text rt-cell--editable" data-kind="cell-text" data-row-id="${row.id}" data-column-id="${col.id}" data-reason="${escapeHtml(cell.reason || '')}" data-label="${escapeHtml(col.label)}" data-row-name="${escapeHtml(row.name)}">${escapeHtml(cell.reason || '')}</td>`;
      }
      // A STATUS-type simple column's cell for a COMPOUND row is a
      // derived rollup over that row's own sub-rows, by request ("Need
      // Compound Rows as well as Compound Columns") -- the row-level
      // mirror of a compound column's own never-editable cell, just
      // transposed.
      const rowIsCompoundHere = col.cellType === 'status' && row.kind === 'compound';
      const editable = col.kind === 'simple' && !rowIsCompoundHere;
      const note = col.kind === 'compound'
        ? ' -- derived from its own detail sheet; click its Show Detail button below to edit.'
        : rowIsCompoundHere
          ? ' -- derived from its own sub-rows; click its own Show Detail button to edit.'
          : '';
      return `<td class="rt-cell rt-cell--${cell.status}${editable ? ' rt-cell--editable' : ''}" data-kind="cell" data-row-id="${row.id}" data-column-id="${col.id}" data-status="${cell.status}" data-reason="${escapeHtml(cell.reason || '')}" data-note="${escapeHtml(note)}" data-label="${escapeHtml(col.label)}" data-row-name="${escapeHtml(row.name)}">${STATUS_SYMBOLS[cell.status]}</td>`;
    }

    // One "Show/Hide <label> Detail" toggle per compound column AND per
    // compound row, below the master table -- mirrors tc-elite-rollout/
    // client.js's own renderDetailButtons() for columns; a compound
    // row's own toggle lives here too, by request ("make these buttons
    // below as well like the Show buttons for the compound columns" --
    // originally an inline per-row toggle). Only ever one sheet open at a
    // time (clicking a different toggle -- column or row -- closes
    // whichever was open).
    function renderDetailButtons(columns, rows) {
      const compoundColumns = columns.filter((c) => c.kind === 'compound');
      const compoundRows = rows.filter((r) => r.kind === 'compound');
      if (compoundColumns.length === 0 && compoundRows.length === 0) {
        detailButtonsContainer.innerHTML = '';
        return;
      }
      const columnButtonsHtml = compoundColumns.map(
        (c) =>
          `<button type="button" class="button-link button-link--small rt-detail-toggle${openDetailColumnId === c.id ? ' rt-detail-toggle--active' : ''}" data-kind="column" data-id="${c.id}">${openDetailColumnId === c.id ? 'Hide' : 'Show'} ${escapeHtml(c.label)} Detail</button>`
      );
      const rowButtonsHtml = compoundRows.map(
        (r) =>
          `<button type="button" class="button-link button-link--small rt-detail-toggle${openDetailRowId === r.id ? ' rt-detail-toggle--active' : ''}" data-kind="row" data-id="${r.id}">${openDetailRowId === r.id ? 'Hide' : 'Show'} ${escapeHtml(r.name)} Detail</button>`
      );
      detailButtonsContainer.innerHTML = [...columnButtonsHtml, ...rowButtonsHtml].join(' ');
      detailButtonsContainer.querySelectorAll('.rt-detail-toggle').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = Number(btn.dataset.id);
          if (btn.dataset.kind === 'column') {
            if (openDetailColumnId === id) {
              openDetailColumnId = null;
              detailContainer.innerHTML = '';
            } else {
              openDetailColumnId = id;
              openDetailRowId = null; // only one detail sheet at a time, columns or rows alike
              // Fresh sheet, fresh default -- start hidden-by-default same
              // as the master grid does on page load, not whatever this or
              // a previously-viewed sheet's toggle happened to be left at.
              showAllDetail = false;
            }
          } else {
            if (openDetailRowId === id) {
              openDetailRowId = null;
              detailContainer.innerHTML = '';
            } else {
              openDetailRowId = id;
              openDetailColumnId = null;
              showAllRowDetail = false;
            }
          }
          // Routed through loadGrid() rather than loading the detail +
          // re-rendering this button bank directly -- it already does
          // both of those (see its own openDetailColumnId/openDetailRowId
          // branches).
          await loadGrid();
        });
      });
    }

    async function loadDetail(columnId) {
      detailContainer.innerHTML = '<p class="status">Loading...</p>';
      try {
        const res = await fetch(`${apiBase}/columns/${columnId}/detail${showAllDetail ? '?all=true' : ''}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        lastDetailData = data;
        renderDetail(data);
      } catch (err) {
        detailContainer.innerHTML = `<p class="status error">Error: ${err.message}</p>`;
      }
    }

    function renderDetail(data) {
      const { column, stages, rows, totalRows } = data;
      const heading = document.createElement('div');
      heading.className = 'section-heading section-heading--scorecard';
      heading.textContent = `${column.label} -- Detail`;
      detailContainer.innerHTML = '';
      detailContainer.appendChild(heading);
      detailContainer.appendChild(buildAddStageSection(column));

      if (rows.length === 0) {
        const message = showAllDetail
          ? `No ${rowNoun.toLowerCase()}s yet.`
          : `Nothing outstanding on this sheet (0/${totalRows}) -- everything tracked is Done, N/A, or Cancelled. Try Show All to see everything.`;
        detailContainer.appendChild(Object.assign(document.createElement('p'), { className: 'status', textContent: message }));
        return;
      }

      const table = document.createElement('table');
      table.className = 'rt-table';
      table.innerHTML = `
        <thead>
          <tr class="shaded-row">
            <th>${escapeHtml(rowNoun)} (${rows.length}/${totalRows})</th>
            ${stages.map((s) => `<th class="rt-col-header" draggable="${isManager ? 'true' : 'false'}" data-stage-id="${s.id}"><button type="button" class="rt-bulk-col-btn" data-stage-id="${s.id}" data-cell-type="${s.type}" title="Set every currently visible ${rowNoun.toLowerCase()} in this column to the same value">⚙</button> ${escapeHtml(s.label)}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (row) => `
            <tr>
              <td><button type="button" class="rt-bulk-row-btn" data-row-id="${row.id}" title="Set every status stage in this row to the same value">⚙</button> ${escapeHtml(row.name)}</td>
              ${stages.map((stage) => stageCellHtml(row, stage)).join('')}
            </tr>`
            )
            .join('')}
        </tbody>
      `;
      detailContainer.appendChild(table);
      wireCellInteractions(table);
      wireBulkRowButtons(table, 'detail', column.id);
      wireBulkColumnButtons(table, 'detail');
      wireHeaderDragReorder(table, stages.map((s) => s.id), 'stageId', `${apiBase}/columns/${column.id}/stages/order`, () => loadDetail(column.id));
    }

    // Add Stage -- Tracker Manager-only, same reasoning as Add Column.
    // Built fresh on every renderDetail() call (rather than living in the
    // static header HTML like Add Row/Add Column) since it's scoped to
    // whichever compound column's detail sheet is currently open --
    // detailContainer.innerHTML is wiped on every render, so there's
    // never more than one of these live at once.
    function buildAddStageSection(column) {
      const wrapper = document.createElement('div');
      wrapper.className = 'rt-add-stage';

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button-link button-link--small';
      button.textContent = 'Add Stage';
      button.hidden = !isManager;
      wrapper.appendChild(button);

      // This detail sheet's own "what's waiting to be done" toggle -- by
      // request, separate from the master grid's own Show All. Persists
      // across re-renders of this same open sheet (a save reloads via
      // loadDetail(), which reads this each time), resets to hidden-by-
      // default the same as the master grid does on a fresh page load.
      const showAllLabel = document.createElement('label');
      showAllLabel.className = 'rt-detail-show-all';
      showAllLabel.innerHTML = `<input type="checkbox" class="rt-detail-show-all-toggle"${showAllDetail ? ' checked' : ''} /> Show All`;
      wrapper.appendChild(showAllLabel);
      showAllLabel.querySelector('.rt-detail-show-all-toggle').addEventListener('change', (e) => {
        showAllDetail = e.target.checked;
        loadDetail(column.id);
      });

      const form = document.createElement('div');
      form.className = 'resource-group';
      form.hidden = true;
      form.innerHTML = `
        <div class="section-heading">Add Stage to ${escapeHtml(column.label)}</div>
        <div class="rt-form-body">
          <input type="text" class="rt-new-stage-label" placeholder="Stage label" />
          <label><input type="radio" name="rt-new-stage-type" value="status" checked /> Status (one of the 7 states)</label>
          <label><input type="radio" name="rt-new-stage-type" value="text" /> Text (free-text field, not part of the rollup)</label>
          <p class="status error rt-add-stage-error" hidden></p>
          <div class="rt-form-actions">
            <button type="button" class="button-link rt-save-stage-button">Save</button>
            <button type="button" class="rt-cancel-stage-button">Cancel</button>
          </div>
        </div>
      `;
      wrapper.appendChild(form);

      button.addEventListener('click', () => {
        form.hidden = false;
        form.querySelector('.rt-new-stage-label').focus();
      });
      form.querySelector('.rt-cancel-stage-button').addEventListener('click', () => {
        form.hidden = true;
      });
      form.querySelector('.rt-save-stage-button').addEventListener('click', async () => {
        const errorEl = form.querySelector('.rt-add-stage-error');
        errorEl.hidden = true;
        const stageLabel = form.querySelector('.rt-new-stage-label').value.trim();
        if (!stageLabel) {
          errorEl.hidden = false;
          errorEl.textContent = 'Stage label is required.';
          return;
        }
        const type = form.querySelector('input[name="rt-new-stage-type"]:checked').value;
        try {
          const res = await fetch(`${apiBase}/columns/${column.id}/stages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ label: stageLabel, type }),
          });
          const resData = await res.json();
          if (!res.ok) throw new Error(resData.error || `Request failed (${res.status})`);
          form.hidden = true;
          // loadGrid() re-fetches the master grid AND, since
          // openDetailColumnId is still this column, reloads this detail
          // sheet too -- a freshly added stage can change the master
          // rollup for rows that were previously fully done.
          await loadGrid();
        } catch (err) {
          errorEl.hidden = false;
          errorEl.textContent = `Error: ${err.message}`;
        }
      });

      return wrapper;
    }

    function stageCellHtml(row, stage) {
      const cell = row.cells[stage.id] || {};
      if (stage.type === 'text') {
        return `<td class="rt-cell rt-cell--text rt-cell--editable" data-kind="stage-text" data-row-id="${row.id}" data-stage-id="${stage.id}" data-reason="${escapeHtml(cell.reason || '')}" data-label="${escapeHtml(stage.label)}" data-row-name="${escapeHtml(row.name)}">${escapeHtml(cell.reason || '')}</td>`;
      }
      const status = cell.status || 'not_done';
      return `<td class="rt-cell rt-cell--${status} rt-cell--editable" data-kind="stage-status" data-row-id="${row.id}" data-stage-id="${stage.id}" data-status="${status}" data-reason="${escapeHtml(cell.reason || '')}" data-label="${escapeHtml(stage.label)}" data-row-name="${escapeHtml(row.name)}">${STATUS_SYMBOLS[status]}</td>`;
    }

    // ---- Compound rows -- the row-level mirror of the compound-column
    // detail-sheet rendering above, transposed (by request -- "Need
    // Compound Rows as well as Compound Columns"). Shares the one
    // detailContainer below the master grid with the column-detail
    // rendering above -- only ever one sheet showing at a time (see
    // loadGrid()'s own openDetailColumnId/openDetailRowId branches).

    async function loadRowDetail(rowId) {
      detailContainer.innerHTML = '<p class="status">Loading...</p>';
      try {
        const res = await fetch(`${apiBase}/rows/${rowId}/detail${showAllRowDetail ? '?all=true' : ''}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        lastRowDetailData = data;
        renderRowDetail(data);
      } catch (err) {
        detailContainer.innerHTML = `<p class="status error">Error: ${err.message}</p>`;
      }
    }

    function renderRowDetail(data) {
      const { row, columns, subRows, totalSubRows } = data;
      const heading = document.createElement('div');
      heading.className = 'section-heading section-heading--scorecard';
      heading.textContent = `${row.name} -- Detail`;
      detailContainer.innerHTML = '';
      detailContainer.appendChild(heading);
      detailContainer.appendChild(buildAddSubRowSection(row));

      if (subRows.length === 0) {
        const message = showAllRowDetail
          ? 'No sub-rows yet.'
          : `Nothing outstanding on this sheet (0/${totalSubRows}) -- everything tracked is Done, N/A, or Cancelled. Try Show All to see everything.`;
        detailContainer.appendChild(Object.assign(document.createElement('p'), { className: 'status', textContent: message }));
        return;
      }

      // Columns here are already filtered by the server to just the
      // status-type-simple ones -- a sub-row never targets a text or
      // compound column (see rollout-tracker-db.js's own sub_rows
      // comment). Column headers are NOT draggable here -- column order
      // is a single global concept owned by the master grid's own
      // header drag, not something a row's own detail sheet reorders
      // independently.
      const table = document.createElement('table');
      table.className = 'rt-table';
      table.innerHTML = `
        <thead>
          <tr class="shaded-row">
            <th>Sub-rows (${subRows.length}/${totalSubRows})</th>
            ${columns
              .map(
                (c) =>
                  `<th class="rt-col-header" draggable="false" data-column-id="${c.id}"><button type="button" class="rt-bulk-col-btn" data-column-id="${c.id}" title="Set every currently visible sub-row in this column to the same value">⚙</button> ${escapeHtml(c.label)}</th>`
              )
              .join('')}
          </tr>
        </thead>
        <tbody>
          ${subRows
            .map(
              (subRow) => `
            <tr>
              <td><button type="button" class="rt-bulk-row-btn" data-sub-row-id="${subRow.id}" title="Set every column in this sub-row to the same value">⚙</button> ${escapeHtml(subRow.label)}</td>
              ${columns.map((col) => subRowCellHtml(subRow, col)).join('')}
            </tr>`
            )
            .join('')}
        </tbody>
      `;
      detailContainer.appendChild(table);
      wireCellInteractions(table);
      wireSubRowBulkButtons(table, row.id);
      wireColumnAcrossSubRowsBulkButtons(table, row.id);
    }

    // Add Sub-Row -- Tracker Manager-only, same reasoning as Add Stage.
    // Built fresh on every renderRowDetail() call, same "never more than
    // one of these live at once" reasoning as buildAddStageSection above.
    function buildAddSubRowSection(row) {
      const wrapper = document.createElement('div');
      wrapper.className = 'rt-add-stage'; // same visual treatment as Add Stage, reused rather than a near-duplicate class

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button-link button-link--small';
      button.textContent = 'Add Sub-Row';
      button.hidden = !isManager;
      wrapper.appendChild(button);

      const showAllLabel = document.createElement('label');
      showAllLabel.className = 'rt-detail-show-all';
      showAllLabel.innerHTML = `<input type="checkbox" class="rt-detail-show-all-toggle"${showAllRowDetail ? ' checked' : ''} /> Show All`;
      wrapper.appendChild(showAllLabel);
      showAllLabel.querySelector('.rt-detail-show-all-toggle').addEventListener('change', (e) => {
        showAllRowDetail = e.target.checked;
        loadRowDetail(row.id);
      });

      const form = document.createElement('div');
      form.className = 'resource-group';
      form.hidden = true;
      form.innerHTML = `
        <div class="section-heading">Add Sub-Row to ${escapeHtml(row.name)}</div>
        <div class="rt-form-body">
          <input type="text" class="rt-new-sub-row-label" placeholder="Sub-row name" />
          <p class="status error rt-add-sub-row-error" hidden></p>
          <div class="rt-form-actions">
            <button type="button" class="button-link rt-save-sub-row-button">Save</button>
            <button type="button" class="rt-cancel-sub-row-button">Cancel</button>
          </div>
        </div>
      `;
      wrapper.appendChild(form);

      button.addEventListener('click', () => {
        form.hidden = false;
        form.querySelector('.rt-new-sub-row-label').focus();
      });
      form.querySelector('.rt-cancel-sub-row-button').addEventListener('click', () => {
        form.hidden = true;
      });
      form.querySelector('.rt-save-sub-row-button').addEventListener('click', async () => {
        const errorEl = form.querySelector('.rt-add-sub-row-error');
        errorEl.hidden = true;
        const label = form.querySelector('.rt-new-sub-row-label').value.trim();
        if (!label) {
          errorEl.hidden = false;
          errorEl.textContent = 'Sub-row name is required.';
          return;
        }
        try {
          const res = await fetch(`${apiBase}/rows/${row.id}/sub-rows`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ label }),
          });
          const resData = await res.json();
          if (!res.ok) throw new Error(resData.error || `Request failed (${res.status})`);
          form.hidden = true;
          // loadGrid() re-fetches the master grid AND, since
          // openDetailRowId is still this row, reloads this detail sheet
          // too -- a freshly added sub-row can change the master rollup
          // for columns that were previously fully done on this row.
          await loadGrid();
        } catch (err) {
          errorEl.hidden = false;
          errorEl.textContent = `Error: ${err.message}`;
        }
      });

      return wrapper;
    }

    // Always a status cell -- a sub-row never targets a text or compound
    // column (see rollout-tracker-db.js's own sub_rows comment), so
    // unlike stageCellHtml there's no text branch to make here.
    function subRowCellHtml(subRow, col) {
      const cell = subRow.cells[col.id] || {};
      const status = cell.status || 'not_done';
      return `<td class="rt-cell rt-cell--${status} rt-cell--editable" data-kind="sub-row-cell" data-sub-row-id="${subRow.id}" data-column-id="${col.id}" data-status="${status}" data-reason="${escapeHtml(cell.reason || '')}" data-label="${escapeHtml(col.label)}" data-row-name="${escapeHtml(subRow.label)}">${STATUS_SYMBOLS[status]}</td>`;
    }

    function historyContextFor(td) {
      return {
        kind: td.dataset.kind,
        rowId: td.dataset.rowId,
        columnId: td.dataset.columnId,
        stageId: td.dataset.stageId,
        subRowId: td.dataset.subRowId,
        label: td.dataset.label,
        rowName: td.dataset.rowName,
      };
    }

    // 'stage-status'/'stage-text' both live on /stages/.../history;
    // 'sub-row-cell' lives on /sub-rows/.../history; a plain master-grid
    // cell (kind 'cell' or 'cell-text') lives on /cells/.../history.
    function historyUrlFor(ctx) {
      if (ctx.kind === 'stage-status' || ctx.kind === 'stage-text') return `${apiBase}/stages/${ctx.rowId}/${ctx.stageId}/history`;
      if (ctx.kind === 'sub-row-cell') return `${apiBase}/sub-rows/${ctx.subRowId}/${ctx.columnId}/history`;
      return `${apiBase}/cells/${ctx.rowId}/${ctx.columnId}/history`;
    }

    // Click-to-edit for an editable cell; a non-editable cell (only ever
    // a compound column's own auto-computed rollup on the master grid)
    // opens its change history directly instead, same split tc-elite-
    // rollout/client.js uses -- an editable cell's own history is reached
    // via the "View full history" link inside the hover tooltip.
    function wireCellInteractions(table) {
      table.addEventListener('click', (e) => {
        const editableTd = e.target.closest('.rt-cell--editable');
        if (editableTd && !editableTd.querySelector('select,input')) {
          openCellEditor(editableTd);
          return;
        }
        const readonlyTd = e.target.closest('.rt-cell:not(.rt-cell--editable)');
        if (readonlyTd) openHistoryModal(historyContextFor(readonlyTd));
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
      tooltipEl.innerHTML = buildTooltipHtml(ctx, td, null);
      tooltipEl.style.left = `${pageX + 12}px`;
      tooltipEl.style.top = `${pageY + 12}px`;
      tooltipEl.hidden = false;

      try {
        const res = await fetch(historyUrlFor(ctx));
        const data = await res.json();
        if (tooltipEl._historyCtx !== ctx) return;
        const entry = (data.history || [])[0];
        tooltipEl.innerHTML = buildTooltipHtml(ctx, td, entry);
      } catch {
        // Silent -- a failed history fetch just leaves the base content
        // showing, without the who/when line.
      }
    }

    function buildTooltipHtml(ctx, td, entry) {
      const status = td.dataset.status;
      const reason = td.dataset.reason;
      const note = td.dataset.note || '';
      let base;
      if (status) {
        base = STATUS_LABELS[status] || status;
        if (STATUSES_WITH_COMMENT.includes(status) && reason) base += `: ${escapeHtml(reason)}`;
        base += note;
      } else {
        // stage-text cell -- the cell's own content already IS the value,
        // nothing extra to say beyond who/when.
        base = ctx.label;
      }
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
        const isText = ctx.kind === 'stage-text' || ctx.kind === 'cell-text';
        body.innerHTML = `<ul class="history-modal-list">${data.history.map((entry) => historyEntryHtml(entry, isText)).join('')}</ul>`;
      } catch (err) {
        overlay.querySelector('.history-modal-body').innerHTML = `<p class="status error">Error: ${escapeHtml(err.message)}</p>`;
      }
    }

    function historyEntryHtml(entry, isText) {
      let changeText;
      if (isText) {
        const oldVal = entry.oldReason || '(blank)';
        const newVal = entry.newReason || '(blank)';
        changeText = oldVal === newVal ? escapeHtml(newVal) : `${escapeHtml(oldVal)} &rarr; ${escapeHtml(newVal)}`;
      } else {
        const oldLabel = entry.oldStatus ? STATUS_LABELS[entry.oldStatus] || entry.oldStatus : '(new)';
        const newLabel = entry.newStatus ? STATUS_LABELS[entry.newStatus] || entry.newStatus : '(none)';
        changeText = oldLabel === newLabel ? escapeHtml(newLabel) : `${escapeHtml(oldLabel)} &rarr; ${escapeHtml(newLabel)}`;
        if (entry.newReason) changeText += `: ${escapeHtml(entry.newReason)}`;
      }
      const when = `${escapeHtml(entry.changedByName)} -- ${escapeHtml(formatDateTime(entry.changedAt))}`;
      return `<li class="history-modal-entry"><div>${changeText}</div><div class="history-modal-when">${when}</div></li>`;
    }

    function openCellEditor(td) {
      const kind = td.dataset.kind;
      const originalHtml = td.innerHTML;

      if (kind === 'stage-text' || kind === 'cell-text') {
        td.innerHTML = `<input type="text" class="rt-inline-input" value="${escapeHtml(td.dataset.reason || '')}" />`;
        const input = td.querySelector('input');
        input.focus();
        input.select();
        const commit = () => (kind === 'stage-text' ? saveStageText(td, input.value.trim(), originalHtml) : saveCellText(td, input.value.trim(), originalHtml));
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') input.blur();
          if (e.key === 'Escape') {
            input.removeEventListener('blur', commit);
            td.innerHTML = originalHtml;
          }
        });
        return;
      }

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
        if (kind === 'cell') saveCell(td, status, reason, originalHtml);
        else if (kind === 'sub-row-cell') saveSubRowCell(td, status, reason, originalHtml);
        else saveStageStatus(td, status, reason, originalHtml);
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

    // Master-grid equivalent of saveStageText below, for a simple TEXT
    // column's own cell (kind 'cell-text') -- same "just send { reason },
    // update the cell in place, no full reload needed" shape.
    async function saveCellText(td, value, originalHtml) {
      try {
        const res = await fetch(`${apiBase}/cells/${td.dataset.rowId}/${td.dataset.columnId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: value }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        td.dataset.reason = value;
        td.textContent = value;
      } catch (err) {
        td.innerHTML = originalHtml;
        alert(`Error saving: ${err.message}`);
      }
    }

    // The sub-row mirror of saveStageStatus below -- a sub-row edit can
    // change the parent ROW's own master rollup, so (same reasoning) both
    // the grid and this same detail sheet need a fresh fetch, via
    // loadGrid() (which already reloads whichever detail sheet, column
    // or row, is currently open).
    async function saveSubRowCell(td, status, reason, originalHtml) {
      try {
        const res = await fetch(`${apiBase}/sub-rows/${td.dataset.subRowId}/${td.dataset.columnId}`, {
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

    async function saveStageStatus(td, status, reason, originalHtml) {
      try {
        const res = await fetch(`${apiBase}/stages/${td.dataset.rowId}/${td.dataset.stageId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status, reason }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        // A stage edit can change the parent column's master rollup, so
        // both the grid and this same detail sheet need a fresh fetch,
        // not just this one cell.
        await loadGrid();
      } catch (err) {
        td.innerHTML = originalHtml;
        alert(`Error saving: ${err.message}`);
      }
    }

    async function saveStageText(td, value, originalHtml) {
      try {
        const res = await fetch(`${apiBase}/stages/${td.dataset.rowId}/${td.dataset.stageId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: value }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        td.dataset.reason = value;
        td.textContent = value;
      } catch (err) {
        td.innerHTML = originalHtml;
        alert(`Error saving: ${err.message}`);
      }
    }

    // "Set this whole row to the same value" -- by request, for a row
    // where one value genuinely applies across the board rather than
    // clicking each cell one at a time. `kind` is 'master' (PATCH
    // .../bulk-cells, every simple column) or 'detail' (PATCH
    // .../bulk-stages, every status-type stage of the currently-open
    // compound column, `columnId`) -- the server skips compound columns/
    // text-type stages either way.
    function wireBulkRowButtons(table, kind, columnId) {
      table.querySelectorAll('.rt-bulk-row-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const existing = btn.parentElement.querySelector('.rt-bulk-row-editor');
          if (existing) {
            existing.remove();
            return;
          }
          const rowId = btn.dataset.rowId;
          const editor = buildBulkEditor('Set Row', async (status, reason) => {
            if (kind === 'master') {
              await fetchBulkRow(rowId, status, reason);
              // By request: on the master page specifically (a detail
              // sheet's own row-set is already scoped to just that one
              // sub-sheet, so there's nothing to ask there), offer to
              // extend the same status/reason to every compound column's
              // detail sheet too, not just this row's simple columns.
              if (confirm('Also apply this to all sub-sheets?')) {
                // Fetched fresh with ?all=true rather than reusing
                // whatever loadGrid() last rendered -- a compound column
                // currently hidden by the default "hide fully-resolved"
                // filter would otherwise be silently skipped, even though
                // "all sub-sheets" should really mean all of them.
                const allRes = await fetch(`${apiBase}/?all=true`);
                const allData = await allRes.json();
                for (const col of allData.columns.filter((c) => c.kind === 'compound')) {
                  await fetchBulkStages(col.id, rowId, status, reason);
                }
              }
            } else {
              await fetchBulkStages(columnId, rowId, status, reason);
            }
            await loadGrid();
          });
          btn.insertAdjacentElement('afterend', editor);
        });
      });
    }

    // "Set this whole column to the same value" -- the column-based
    // mirror of wireBulkRowButtons above. `kind` is 'master' (PATCH
    // /columns/:columnId/bulk-cells, one simple column -- the only kind
    // of gear button that ever appears on the master grid) or 'detail'
    // (PATCH /stages/:stageId/bulk-status, one stage of the currently-
    // open compound column, status or text type).
    //
    // Scoped to whichever rows are CURRENTLY RENDERED, by request -- see
    // currentVisibleRowIds's own comment up top for the master grid;
    // lastDetailData.rows plays the same role for a detail sheet.
    function wireBulkColumnButtons(table, kind) {
      table.querySelectorAll('.rt-bulk-col-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const existing = btn.parentElement.querySelector('.rt-bulk-row-editor');
          if (existing) {
            existing.remove();
            return;
          }
          const visibleRowIds = kind === 'master' ? currentVisibleRowIds : lastDetailData.rows.map((r) => r.id);
          const isText = btn.dataset.cellType === 'text';
          const saveLabel = `Set Column (${visibleRowIds.length} visible)`;
          let editor;
          if (isText) {
            editor = document.createElement('div');
            editor.className = 'rt-bulk-row-editor';
            editor.innerHTML = `
              <input type="text" class="rt-inline-input rt-bulk-col-text" placeholder="Value for every visible ${rowNoun.toLowerCase()}" />
              <div class="rt-form-actions">
                <button type="button" class="button-link button-link--small rt-save">${saveLabel}</button>
                <button type="button" class="rt-cancel">Cancel</button>
              </div>
            `;
            editor.querySelector('.rt-cancel').addEventListener('click', () => editor.remove());
            editor.querySelector('.rt-save').addEventListener('click', async () => {
              try {
                const text = editor.querySelector('.rt-bulk-col-text').value.trim();
                if (kind === 'master') {
                  await fetchBulkColumnText(btn.dataset.columnId, text || null, visibleRowIds);
                  editor.remove();
                  await loadGrid();
                } else {
                  await fetchBulkStageColumn(btn.dataset.stageId, null, text || null, visibleRowIds);
                  editor.remove();
                  await loadDetail(openDetailColumnId);
                }
              } catch (err) {
                alert(`Error: ${err.message}`);
              }
            });
          } else {
            editor = buildBulkEditor(saveLabel, async (status, reason) => {
              if (kind === 'master') {
                await fetchBulkColumn(btn.dataset.columnId, status, reason, visibleRowIds);
                await loadGrid();
              } else {
                await fetchBulkStageColumn(btn.dataset.stageId, status, reason, visibleRowIds);
                await loadDetail(openDetailColumnId);
              }
            });
          }
          // This editor lands inside the column header's own <th>, which
          // is draggable="true" on the master grid (column reordering) --
          // explicitly false here so clicking/dragging its select/input
          // can't be mistaken for a column-reorder drag start.
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

    // Master-grid equivalent of fetchBulkStageColumn's own text branch,
    // for a simple TEXT column's "Set Column" bulk editor -- same
    // endpoint as fetchBulkColumn above, just without a status.
    async function fetchBulkColumnText(columnId, text, rowIds) {
      const res = await fetch(`${apiBase}/columns/${columnId}/bulk-cells`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: text, rowIds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    }

    async function fetchBulkStages(columnId, rowId, status, reason) {
      const res = await fetch(`${apiBase}/columns/${columnId}/rows/${rowId}/bulk-stages`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, reason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    }

    async function fetchBulkStageColumn(stageId, status, reason, rowIds) {
      const res = await fetch(`${apiBase}/stages/${stageId}/bulk-status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, reason, rowIds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    }

    // ---- Compound rows -- bulk actions within a row's own detail sheet,
    // the sub-row mirror of wireBulkRowButtons/wireBulkColumnButtons'
    // own 'detail' branches above (transposed: sub-row <-> real row,
    // column <-> stage). Kept as their own dedicated functions rather
    // than folded into those two as a third `kind` -- the entities
    // differ enough (no stage type to branch on; sub-rows never target a
    // text column at all) that shoehorning them in would make those two
    // functions' own branching harder to follow, not easier.

    // "Set this sub-row" -- every status-type-simple column, for one
    // sub-row.
    function wireSubRowBulkButtons(table, parentRowId) {
      table.querySelectorAll('.rt-bulk-row-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const existing = btn.parentElement.querySelector('.rt-bulk-row-editor');
          if (existing) {
            existing.remove();
            return;
          }
          const subRowId = btn.dataset.subRowId;
          const editor = buildBulkEditor('Set Row', async (status, reason) => {
            await fetchBulkSubRow(parentRowId, subRowId, status, reason);
            await loadGrid();
          });
          btn.insertAdjacentElement('afterend', editor);
        });
      });
    }

    // "Set this column" -- one status-type-simple column, across every
    // (visible) sub-row of this one compound row.
    function wireColumnAcrossSubRowsBulkButtons(table, parentRowId) {
      table.querySelectorAll('.rt-bulk-col-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const existing = btn.parentElement.querySelector('.rt-bulk-row-editor');
          if (existing) {
            existing.remove();
            return;
          }
          const visibleSubRowIds = lastRowDetailData.subRows.map((sr) => sr.id);
          const saveLabel = `Set Column (${visibleSubRowIds.length} visible)`;
          const editor = buildBulkEditor(saveLabel, async (status, reason) => {
            await fetchBulkColumnAcrossSubRows(parentRowId, btn.dataset.columnId, status, reason, visibleSubRowIds);
            await loadGrid();
          });
          // Same reasoning as wireBulkColumnButtons' own editor -- not
          // actually inside a draggable header here (column headers in a
          // row's own detail sheet are draggable="false"), but harmless
          // and consistent either way.
          editor.setAttribute('draggable', 'false');
          btn.insertAdjacentElement('afterend', editor);
        });
      });
    }

    async function fetchBulkSubRow(rowId, subRowId, status, reason) {
      const res = await fetch(`${apiBase}/rows/${rowId}/sub-rows/${subRowId}/bulk-cells`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, reason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    }

    async function fetchBulkColumnAcrossSubRows(rowId, columnId, status, reason, subRowIds) {
      const res = await fetch(`${apiBase}/rows/${rowId}/columns/${columnId}/bulk-status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, reason, subRowIds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    }

    function wireRenameButtons(table) {
      // Scoped to tbody specifically, not the whole table -- a real bug
      // otherwise: the master grid's own column-header rename buttons
      // (wireRenameColumnButtons below) share the same .rt-rename-btn
      // CSS class for styling, and querying the whole `table` here would
      // also match those, double-wiring them. Since each click handler
      // toggles its own editor closed when one's already open, the
      // SECOND listener firing on the SAME click immediately removed the
      // editor the first one had just created -- the column rename
      // button appeared to do nothing at all.
      table.querySelector('tbody').querySelectorAll('.rt-rename-btn').forEach((btn) => {
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

    // The column-level mirror of wireRenameButtons above, for the master
    // grid's own column headers -- Tracker Manager-only (the button
    // itself is only ever rendered for a manager, same "server decides,
    // client just reflects it" gate every other structural action here
    // uses), by request ("need the capability to edit a column name").
    // Wired once, in renderGrid() -- this button lives in <thead>, which
    // survives a tbody-only refresh untouched, same reasoning
    // wireBulkColumnButtons/wireHeaderDragReorder are wired there instead
    // of inside renderTbodyRows().
    function wireRenameColumnButtons(table) {
      table.querySelectorAll('.rt-rename-col-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const existing = btn.parentElement.querySelector('.rt-rename-editor');
          if (existing) {
            existing.remove();
            return;
          }
          const columnId = btn.dataset.columnId;
          const editor = document.createElement('div');
          editor.className = 'rt-bulk-row-editor rt-rename-editor';
          // Not actually a drag start risk here (dragstart only fires on
          // mousedown+move, not a plain click), but explicit all the
          // same -- same reasoning wireBulkColumnButtons' own editor
          // already sets this for, landing inside this same draggable
          // <th>.
          editor.setAttribute('draggable', 'false');
          editor.innerHTML = `
            <input type="text" class="rt-inline-input rt-rename-input" value="${escapeHtml(btn.dataset.columnLabel)}" />
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
            const newLabel = input.value.trim();
            if (!newLabel) {
              alert('Column label cannot be blank.');
              return;
            }
            try {
              const res = await fetch(`${apiBase}/columns/${columnId}/label`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ label: newLabel }),
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
