export const id = "tc-elite-rollout";
export const label = "TC Elite Rollout";

// Module-scope, not inside mount() -- the shell tears down and re-mounts a
// page's DOM on every navigation, but the imported module itself stays
// alive for the session, same convention every other page here uses for
// "restore instantly instead of a blank flash on revisit."
let lastGridData = null;
let showAll = false;
let openDetailColumnId = null;
let lastDetailData = null;
// Fetched fresh on every mount() from /api/me -- who's currently signed
// in, used only to give an immediate "see Amber" message on click rather
// than a wasted form-open + round trip. Not the real enforcement point --
// server.js checks this again on the actual POST /columns, since a
// client-side-only check is trivially bypassed by anyone hitting the API
// directly.
let currentUserEmail = null;
const COLUMN_ADMIN_EMAIL = 'amber@ambientit.com.au';

// STATUS_LABELS is what the edit dropdown shows (full text -- no
// ambiguity while actually picking a value); STATUS_SYMBOLS is what a
// cell shows at rest, by request -- compact enough that a whole grid of
// them scans quickly. na keeps its text label either way (no obvious
// single-glyph symbol for "not applicable" the way tick/cross/play/no-
// entry read unambiguously for done/not done/started/cancelled).
const STATUS_LABELS = { not_done: 'Not Done', started: 'Started', done: 'Done', na: 'N/A', cancelled: 'Cancelled', issue: 'Issue' };
const STATUS_SYMBOLS = { not_done: '✗', started: '▶', done: '✓', na: 'N/A', cancelled: '⛔', issue: '⚠️' };
const STATUS_ORDER = ['not_done', 'started', 'done', 'na', 'cancelled', 'issue'];
// Statuses that can carry an optional comment -- na's existing "why
// doesn't this apply" reason, cancelled's "why was this cancelled"
// comment, and issue's "what's the issue" comment. Same list server.js
// keeps (STATUSES_WITH_COMMENT).
const STATUSES_WITH_COMMENT = ['na', 'cancelled', 'issue'];

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>TC Elite Rollout</h1>
      <div class="date-form">
        <label style="display:inline-flex;align-items:center;gap:0.35rem;font-weight:normal;">
          <input type="checkbox" id="show-all-toggle" /> Show All
        </label>
        <button type="button" id="add-client-button">Add Client</button>
        <button type="button" id="add-column-button">Add Column</button>
        <button type="button" id="refresh-button">Refresh</button>
      </div>
    </header>
    <p id="status" class="status">Loading...</p>

    <div id="add-client-form" class="resource-group" hidden>
      <div class="section-heading">Add Client</div>
      <div class="tcr-form-body">
        <input type="text" id="new-client-name" placeholder="Client name" />
        <input type="text" id="new-client-active-contract" placeholder="Active Contract? (optional)" />
        <input type="text" id="new-client-comment" placeholder="Comment (optional)" />
        <input type="text" id="new-client-contract-signed" placeholder="Contract Signed (optional)" />
        <p id="add-client-error" class="status error" hidden></p>
        <div class="tcr-form-actions">
          <button type="button" id="save-client-button" class="button-link">Save</button>
          <button type="button" id="cancel-client-button">Cancel</button>
        </div>
      </div>
    </div>

    <div id="add-column-form" class="resource-group" hidden>
      <div class="section-heading">Add Column</div>
      <div class="tcr-form-body">
        <input type="text" id="new-column-label" placeholder="Column label" />
        <label><input type="radio" name="new-column-kind" value="simple" checked /> Simple</label>
        <label><input type="radio" name="new-column-kind" value="compound" /> Compound (has its own stages)</label>
        <div id="new-column-stages-fields" hidden>
          <input type="text" id="new-column-status-stages" placeholder="Status stages, comma-separated (e.g. Installed, Verified)" />
          <input type="text" id="new-column-text-stages" placeholder="Text stages, comma-separated -- optional (e.g. Domain, WHO)" />
        </div>
        <p id="add-column-error" class="status error" hidden></p>
        <div class="tcr-form-actions">
          <button type="button" id="save-column-button" class="button-link">Save</button>
          <button type="button" id="cancel-column-button">Cancel</button>
        </div>
      </div>
    </div>

    <div id="grid-container"></div>
    <div id="detail-buttons-container" class="tcr-detail-buttons"></div>
    <div id="detail-container"></div>
  `;

  const statusEl = container.querySelector('#status');
  const refreshButton = container.querySelector('#refresh-button');
  const showAllToggle = container.querySelector('#show-all-toggle');
  const addClientButton = container.querySelector('#add-client-button');
  const addColumnButton = container.querySelector('#add-column-button');
  const addClientForm = container.querySelector('#add-client-form');
  const addColumnForm = container.querySelector('#add-column-form');
  const gridContainer = container.querySelector('#grid-container');
  const detailButtonsContainer = container.querySelector('#detail-buttons-container');
  const detailContainer = container.querySelector('#detail-container');

  refreshButton.addEventListener('click', () => loadGrid());
  showAllToggle.addEventListener('change', () => {
    showAll = showAllToggle.checked;
    loadGrid();
  });

  fetch('/api/me')
    .then((res) => res.json())
    .then((data) => {
      currentUserEmail = data.user ? data.user.email : null;
    })
    .catch(() => {
      // Non-essential for anything except the Add Column gate below --
      // if this fails, that gate just falls back to "not Amber" (the
      // server-side check is the real enforcement anyway).
    });

  // One shared tooltip element for every cell's "last changed by <name> on
  // <date>" hover -- fetched on demand per cell (see showCellTooltip
  // below), not eagerly loaded for the whole grid up front, same lazy
  // pattern used for What's On's ticket-number hover tooltips. Reused
  // across mounts (the shell tears down and re-mounts this page's DOM on
  // every navigation, but this element lives on <body>, outside that
  // torn-down subtree) -- the `data-wired` guard below stops the
  // one-time listeners from being attached again on a revisit.
  let tooltipEl = document.querySelector('.tcr-tooltip');
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'tcr-tooltip';
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
  // A brief delay before a tooltip actually appears, by request -- without
  // this, sweeping the mouse across the grid (or just moving from one
  // cell toward its OWN tooltip, which sits a little offset from the
  // cursor) fires mouseover on whatever cells happen to be in the way,
  // each one instantly replacing the tooltip's content/position before
  // the cursor ever reaches the "View full history" link. Cancelled on
  // mouseout (see wireCellInteractions) if the cursor leaves before the
  // delay elapses, so a fast pass-through cell never gets a chance to
  // show anything at all.
  function scheduleShowTooltip(td, pageX, pageY) {
    clearTimeout(tooltipShowTimer);
    tooltipShowTimer = setTimeout(() => {
      showCellTooltip(td, pageX, pageY);
    }, 150);
  }
  if (!tooltipEl.dataset.wired) {
    tooltipEl.dataset.wired = '1';
    // The tooltip contains a "View full history" link, so it needs to be
    // hoverable/clickable (not the old pointer-events:none) -- these keep
    // it open while the cursor crosses from the cell into the tooltip
    // itself, rather than hiding the instant the cursor leaves the cell.
    tooltipEl.addEventListener('mouseover', cancelHideTooltip);
    tooltipEl.addEventListener('mouseout', scheduleHideTooltip);
    tooltipEl.addEventListener('click', (e) => {
      if (e.target.closest('.tcr-tooltip-history-link') && tooltipEl._historyCtx) {
        openHistoryModal(tooltipEl._historyCtx);
      }
    });
  }

  // ---- Add Client ----
  addClientButton.addEventListener('click', () => {
    addColumnForm.hidden = true;
    addClientForm.hidden = false;
    container.querySelector('#new-client-name').focus();
  });
  container.querySelector('#cancel-client-button').addEventListener('click', () => {
    addClientForm.hidden = true;
  });
  container.querySelector('#save-client-button').addEventListener('click', async () => {
    const errorEl = container.querySelector('#add-client-error');
    errorEl.hidden = true;
    const name = container.querySelector('#new-client-name').value.trim();
    if (!name) {
      errorEl.hidden = false;
      errorEl.textContent = 'Client name is required.';
      return;
    }
    try {
      const res = await fetch('/api/tc-elite-rollout/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          activeContract: container.querySelector('#new-client-active-contract').value.trim() || null,
          comment: container.querySelector('#new-client-comment').value.trim() || null,
          contractSigned: container.querySelector('#new-client-contract-signed').value.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      addClientForm.hidden = true;
      container.querySelectorAll('#add-client-form input[type="text"]').forEach((i) => (i.value = ''));
      await loadGrid();
    } catch (err) {
      errorEl.hidden = false;
      errorEl.textContent = `Error: ${err.message}`;
    }
  });

  // ---- Add Column ----
  // Restricted to Amber -- see COLUMN_ADMIN_EMAIL above and the matching
  // server-side check in server.js. Everyone else can still click the
  // button; they just get told who to see instead of the form opening.
  addColumnButton.addEventListener('click', () => {
    if (!currentUserEmail || currentUserEmail.toLowerCase() !== COLUMN_ADMIN_EMAIL) {
      alert('See Amber to authorise this function.');
      return;
    }
    addClientForm.hidden = true;
    addColumnForm.hidden = false;
    container.querySelector('#new-column-label').focus();
  });
  container.querySelector('#cancel-column-button').addEventListener('click', () => {
    addColumnForm.hidden = true;
  });
  container.querySelectorAll('input[name="new-column-kind"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      container.querySelector('#new-column-stages-fields').hidden = radio.value !== 'compound' && !container.querySelector('input[name="new-column-kind"][value="compound"]').checked;
    });
  });
  container.querySelector('#save-column-button').addEventListener('click', async () => {
    const errorEl = container.querySelector('#add-column-error');
    errorEl.hidden = true;
    const label = container.querySelector('#new-column-label').value.trim();
    if (!label) {
      errorEl.hidden = false;
      errorEl.textContent = 'Column label is required.';
      return;
    }
    const kind = container.querySelector('input[name="new-column-kind"]:checked').value;
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
      const res = await fetch('/api/tc-elite-rollout/columns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, kind, stages }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      addColumnForm.hidden = true;
      container.querySelector('#new-column-label').value = '';
      container.querySelector('#new-column-status-stages').value = '';
      container.querySelector('#new-column-text-stages').value = '';
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
      const res = await fetch(`/api/tc-elite-rollout/${showAll ? '?all=true' : ''}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastGridData = data;
      renderGrid(data);
      renderDetailButtons(data.columns);
      if (openDetailColumnId && !data.columns.some((c) => c.id === openDetailColumnId)) {
        // The open detail column got filtered out of view (fully resolved,
        // Show All is off) -- close its detail sheet rather than leaving a
        // stale one open with nothing left to show.
        openDetailColumnId = null;
        detailContainer.innerHTML = '';
      } else if (openDetailColumnId) {
        await loadDetail(openDetailColumnId);
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
    const { columns, clients } = data;
    if (columns.length === 0 && clients.length === 0) {
      gridContainer.innerHTML = `<p class="status">${showAll ? 'Nothing tracked yet -- add a client and a column to get started.' : 'Nothing outstanding -- everything tracked is Done or N/A. Try Show All to see everything.'}</p>`;
      return;
    }
    const table = document.createElement('table');
    table.className = 'tcr-table';
    table.innerHTML = `
      <thead>
        <tr class="shaded-row">
          <th>Client</th>
          ${columns.map((col) => `<th>${escapeHtml(col.label)}</th>`).join('')}
        </tr>
      </thead>
      <tbody>
        ${clients
          .map(
            (client) => `
          <tr>
            <td><button type="button" class="tcr-bulk-row-btn" data-client-id="${client.id}" title="Set every column in this row to the same value">⚙</button> ${escapeHtml(client.name)}</td>
            ${columns.map((col) => masterCellHtml(client, col)).join('')}
          </tr>`
          )
          .join('')}
      </tbody>
    `;
    gridContainer.innerHTML = '';
    gridContainer.appendChild(table);
    wireCellInteractions(table);
    wireBulkRowButtons(table, 'master');
  }

  function masterCellHtml(client, col) {
    const cell = client.cells[col.id] || { status: 'not_done', reason: null };
    const editable = col.kind === 'simple';
    // Cells at rest only show a symbol now, by request -- the status
    // label, na/cancelled's reason, a note for non-editable compound
    // cells, and who/when it was last changed all live in the hover
    // tooltip instead (see showCellTooltip) -- no native title="" here,
    // it'd just double up with the custom tooltip.
    let note = col.kind === 'compound' ? ' -- derived from its own detail sheet; click its Show Detail button below to edit.' : '';
    return `<td class="tcr-cell tcr-cell--${cell.status}${editable ? ' tcr-cell--editable' : ''}" data-kind="cell" data-client-id="${client.id}" data-column-id="${col.id}" data-status="${cell.status}" data-reason="${escapeHtml(cell.reason || '')}" data-note="${escapeHtml(note)}" data-label="${escapeHtml(col.label)}" data-client-name="${escapeHtml(client.name)}">${STATUS_SYMBOLS[cell.status]}</td>`;
  }

  function renderDetailButtons(columns) {
    const compoundColumns = columns.filter((c) => c.kind === 'compound');
    if (compoundColumns.length === 0) {
      detailButtonsContainer.innerHTML = '';
      return;
    }
    detailButtonsContainer.innerHTML = compoundColumns
      .map(
        (c) =>
          `<button type="button" class="button-link button-link--small tcr-detail-toggle${openDetailColumnId === c.id ? ' tcr-detail-toggle--active' : ''}" data-column-id="${c.id}">${openDetailColumnId === c.id ? 'Hide' : 'Show'} ${escapeHtml(c.label)} Detail</button>`
      )
      .join(' ');
    detailButtonsContainer.querySelectorAll('.tcr-detail-toggle').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const columnId = Number(btn.dataset.columnId);
        if (openDetailColumnId === columnId) {
          openDetailColumnId = null;
          detailContainer.innerHTML = '';
        } else {
          openDetailColumnId = columnId;
          await loadDetail(columnId);
        }
        renderDetailButtons(lastGridData.columns);
      });
    });
  }

  async function loadDetail(columnId) {
    detailContainer.innerHTML = '<p class="status">Loading...</p>';
    try {
      const res = await fetch(`/api/tc-elite-rollout/columns/${columnId}/detail`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastDetailData = data;
      renderDetail(data);
    } catch (err) {
      detailContainer.innerHTML = `<p class="status error">Error: ${err.message}</p>`;
    }
  }

  function renderDetail(data) {
    const { column, stages, clients } = data;
    const heading = document.createElement('div');
    heading.className = 'section-heading section-heading--scorecard';
    heading.textContent = `${column.label} -- Detail`;
    detailContainer.innerHTML = '';
    detailContainer.appendChild(heading);
    detailContainer.appendChild(buildAddStageSection(column));

    if (clients.length === 0) {
      detailContainer.appendChild(Object.assign(document.createElement('p'), { className: 'status', textContent: 'No clients yet.' }));
      return;
    }

    const table = document.createElement('table');
    table.className = 'tcr-table';
    table.innerHTML = `
      <thead>
        <tr class="shaded-row">
          <th>Client</th>
          ${stages.map((s) => `<th>${escapeHtml(s.label)}</th>`).join('')}
        </tr>
      </thead>
      <tbody>
        ${clients
          .map(
            (client) => `
          <tr>
            <td><button type="button" class="tcr-bulk-row-btn" data-client-id="${client.id}" title="Set every status stage in this row to the same value">⚙</button> ${escapeHtml(client.name)}</td>
            ${stages.map((stage) => stageCellHtml(client, stage)).join('')}
          </tr>`
          )
          .join('')}
      </tbody>
    `;
    detailContainer.appendChild(table);
    wireCellInteractions(table);
    wireBulkRowButtons(table, 'detail', column.id);
  }

  // Add Stage -- restricted to Amber, same as Add Column (see
  // COLUMN_ADMIN_EMAIL above and the matching server-side check in
  // server.js). Built fresh on every renderDetail() call (rather than
  // living in the static header HTML like Add Client/Add Column) since
  // it's scoped to whichever compound column's detail sheet is currently
  // open -- detailContainer.innerHTML is wiped on every render, so there's
  // never more than one of these live at once, and closures over the
  // actual elements avoid needing per-column-unique ids.
  function buildAddStageSection(column) {
    const wrapper = document.createElement('div');
    wrapper.className = 'tcr-add-stage';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button-link button-link--small';
    button.textContent = 'Add Stage';
    wrapper.appendChild(button);

    const form = document.createElement('div');
    form.className = 'resource-group';
    form.hidden = true;
    form.innerHTML = `
      <div class="section-heading">Add Stage to ${escapeHtml(column.label)}</div>
      <div class="tcr-form-body">
        <input type="text" class="tcr-new-stage-label" placeholder="Stage label" />
        <label><input type="radio" name="tcr-new-stage-type" value="status" checked /> Status (one of the 5 states)</label>
        <label><input type="radio" name="tcr-new-stage-type" value="text" /> Text (free-text field, not part of the rollup)</label>
        <p class="status error tcr-add-stage-error" hidden></p>
        <div class="tcr-form-actions">
          <button type="button" class="button-link tcr-save-stage-button">Save</button>
          <button type="button" class="tcr-cancel-stage-button">Cancel</button>
        </div>
      </div>
    `;
    wrapper.appendChild(form);

    button.addEventListener('click', () => {
      if (!currentUserEmail || currentUserEmail.toLowerCase() !== COLUMN_ADMIN_EMAIL) {
        alert('See Amber to authorise this function.');
        return;
      }
      form.hidden = false;
      form.querySelector('.tcr-new-stage-label').focus();
    });
    form.querySelector('.tcr-cancel-stage-button').addEventListener('click', () => {
      form.hidden = true;
    });
    form.querySelector('.tcr-save-stage-button').addEventListener('click', async () => {
      const errorEl = form.querySelector('.tcr-add-stage-error');
      errorEl.hidden = true;
      const label = form.querySelector('.tcr-new-stage-label').value.trim();
      if (!label) {
        errorEl.hidden = false;
        errorEl.textContent = 'Stage label is required.';
        return;
      }
      const type = form.querySelector('input[name="tcr-new-stage-type"]:checked').value;
      try {
        const res = await fetch(`/api/tc-elite-rollout/columns/${column.id}/stages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label, type }),
        });
        const resData = await res.json();
        if (!res.ok) throw new Error(resData.error || `Request failed (${res.status})`);
        form.hidden = true;
        // loadGrid() re-fetches the master grid AND, since
        // openDetailColumnId is still this column, reloads this detail
        // sheet too -- a freshly added stage can change the master
        // rollup for clients that were previously fully done.
        await loadGrid();
      } catch (err) {
        errorEl.hidden = false;
        errorEl.textContent = `Error: ${err.message}`;
      }
    });

    return wrapper;
  }

  function stageCellHtml(client, stage) {
    const cell = client.cells[stage.id] || {};
    if (stage.type === 'text') {
      return `<td class="tcr-cell tcr-cell--text tcr-cell--editable" data-kind="stage-text" data-client-id="${client.id}" data-stage-id="${stage.id}" data-reason="${escapeHtml(cell.reason || '')}" data-label="${escapeHtml(stage.label)}" data-client-name="${escapeHtml(client.name)}">${escapeHtml(cell.reason || '')}</td>`;
    }
    const status = cell.status || 'not_done';
    return `<td class="tcr-cell tcr-cell--${status} tcr-cell--editable" data-kind="stage-status" data-client-id="${client.id}" data-stage-id="${stage.id}" data-status="${status}" data-reason="${escapeHtml(cell.reason || '')}" data-label="${escapeHtml(stage.label)}" data-client-name="${escapeHtml(client.name)}">${STATUS_SYMBOLS[status]}</td>`;
  }

  // Click-to-edit + started-hover-tooltip, delegated once per table rather
  // than per cell -- both the master grid and a detail sheet's own table
  // use the exact same wiring.
  function wireCellInteractions(table) {
    table.addEventListener('click', (e) => {
      const editableTd = e.target.closest('.tcr-cell--editable');
      if (editableTd && !editableTd.querySelector('select,input')) {
        openCellEditor(editableTd);
        return;
      }
      // Non-editable cells -- only ever a compound column's own
      // auto-computed rollup on the master grid -- have no other click
      // action, so by request clicking one opens its change history
      // directly instead (editable cells keep click = edit; their history
      // is reached via the "View full history" link inside the hover
      // tooltip -- see showCellTooltip below).
      const readonlyTd = e.target.closest('.tcr-cell:not(.tcr-cell--editable)');
      if (readonlyTd) openHistoryModal(historyContextFor(readonlyTd));
    });
    table.addEventListener('mouseover', (e) => {
      const td = e.target.closest('.tcr-cell');
      if (td) {
        cancelHideTooltip();
        scheduleShowTooltip(td, e.pageX, e.pageY);
      }
    });
    table.addEventListener('mouseout', (e) => {
      const td = e.target.closest('.tcr-cell');
      if (td) {
        cancelShowTooltip();
        scheduleHideTooltip();
      }
    });
  }

  // { kind, clientId, columnId, stageId, label, clientName } for whichever
  // cell/stage a tooltip or history-modal action is about -- read straight
  // off the td's own data-* attributes rather than re-deriving from
  // lastGridData/lastDetailData, since those attributes are exactly what
  // was used to render the cell in the first place.
  function historyContextFor(td) {
    return {
      kind: td.dataset.kind,
      clientId: td.dataset.clientId,
      columnId: td.dataset.columnId,
      stageId: td.dataset.stageId,
      label: td.dataset.label,
      clientName: td.dataset.clientName,
    };
  }

  // "Set this whole row to the same value" -- by request, for a row where
  // one value genuinely applies across the board (e.g. a client that's
  // N/A "too small" for everything) rather than clicking each cell one at
  // a time. `kind` is 'master' (PATCH .../bulk-cells, every simple
  // column) or 'detail' (PATCH .../bulk-stages, every status-type stage
  // of the currently-open compound column, `columnId`) -- server.js skips
  // compound columns / text-type stages either way, so this never needs
  // to know which columns/stages are actually eligible itself.
  function wireBulkRowButtons(table, kind, columnId) {
    table.querySelectorAll('.tcr-bulk-row-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const existing = btn.parentElement.querySelector('.tcr-bulk-row-editor');
        if (existing) {
          existing.remove();
          return;
        }
        const clientId = btn.dataset.clientId;
        const editor = document.createElement('div');
        editor.className = 'tcr-bulk-row-editor';
        editor.innerHTML = `
          <select class="tcr-status-select">
            ${STATUS_ORDER.map((s) => `<option value="${s}">${STATUS_LABELS[s]}</option>`).join('')}
          </select>
          <input type="text" class="tcr-inline-input tcr-reason-input" placeholder="Reason (optional)" style="display:none" />
          <div class="tcr-form-actions">
            <button type="button" class="button-link button-link--small tcr-save">Set Row</button>
            <button type="button" class="tcr-cancel">Cancel</button>
          </div>
        `;
        btn.insertAdjacentElement('afterend', editor);
        const select = editor.querySelector('select');
        const reasonInput = editor.querySelector('.tcr-reason-input');
        select.addEventListener('change', () => {
          reasonInput.style.display = STATUSES_WITH_COMMENT.includes(select.value) ? '' : 'none';
        });
        editor.querySelector('.tcr-cancel').addEventListener('click', () => editor.remove());
        editor.querySelector('.tcr-save').addEventListener('click', async () => {
          const status = select.value;
          const reason = STATUSES_WITH_COMMENT.includes(status) ? reasonInput.value.trim() || null : null;
          try {
            if (kind === 'master') {
              await fetchBulkCells(clientId, status, reason);
              // By request: on the master page specifically (a detail
              // sheet's own row-set is already scoped to just that one
              // sub-sheet, so there's nothing to ask there), offer to
              // extend the same status/reason to every compound column's
              // detail sheet too, not just this client's simple columns.
              if (confirm('Also apply this to all sub-sheets (e.g. AutoElevate, EasyDMARC)?')) {
                // Fetched fresh with ?all=true rather than reusing
                // lastGridData -- a compound column currently hidden by
                // the default "hide fully-resolved" filter would
                // otherwise be silently skipped, even though "all
                // sub-sheets" should really mean all of them.
                const allRes = await fetch('/api/tc-elite-rollout/?all=true');
                const allData = await allRes.json();
                for (const col of allData.columns.filter((c) => c.kind === 'compound')) {
                  await fetchBulkStages(col.id, clientId, status, reason);
                }
              }
            } else {
              await fetchBulkStages(columnId, clientId, status, reason);
            }
            editor.remove();
            await loadGrid();
          } catch (err) {
            alert(`Error: ${err.message}`);
          }
        });
      });
    });
  }

  async function fetchBulkCells(clientId, status, reason) {
    const res = await fetch(`/api/tc-elite-rollout/clients/${clientId}/bulk-cells`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, reason }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  }

  async function fetchBulkStages(columnId, clientId, status, reason) {
    const res = await fetch(`/api/tc-elite-rollout/columns/${columnId}/clients/${clientId}/bulk-stages`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, reason }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  }

  // 'stage-status'/'stage-text' both live on /stages/.../history; a plain
  // master-grid cell (kind 'cell') lives on /cells/.../history.
  function historyUrlFor(ctx) {
    return ctx.kind === 'stage-status' || ctx.kind === 'stage-text'
      ? `/api/tc-elite-rollout/stages/${ctx.clientId}/${ctx.stageId}/history`
      : `/api/tc-elite-rollout/cells/${ctx.clientId}/${ctx.columnId}/history`;
  }

  // Every cell's hover tooltip now, not just 'started' ones -- by request,
  // "who and when" for the most recent change on anything, plus a link to
  // the full history (openHistoryModal). Shows the synchronous status/
  // reason/note content immediately (no flash of empty content), then
  // fills in who/when once the on-hover history fetch resolves. Takes
  // pageX/pageY (captured at mouseover time) rather than the MouseEvent
  // itself -- this only actually runs after scheduleShowTooltip's delay,
  // by which point the original event has served its purpose.
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
      // The mouse may have moved to a different cell (or away entirely)
      // by the time this resolves -- only apply it if this tooltip is
      // still showing the same cell's context.
      if (tooltipEl._historyCtx !== ctx) return;
      const entry = (data.history || [])[0];
      tooltipEl.innerHTML = buildTooltipHtml(ctx, td, entry);
    } catch {
      // Silent -- a failed history fetch just leaves the base content
      // showing, without the who/when line. Not worth surfacing an error
      // for a hover-only convenience feature.
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
      ? `<div class="tcr-tooltip-when">Last changed by ${escapeHtml(entry.changedByName)} on ${escapeHtml(formatDateTime(entry.changedAt))}</div>`
      : `<div class="tcr-tooltip-when">Loading history...</div>`;
    return `<div>${escapeHtml(base)}</div>${whenHtml}<button type="button" class="tcr-tooltip-history-link">View full history</button>`;
  }

  // "open a window with the change history for that object" -- a simple
  // overlay + panel (no existing modal convention elsewhere on this
  // dashboard to reuse), listing every audit_log entry for this one
  // cell/stage, most recent first (same data the tooltip's "most recent"
  // line already draws from, just the whole list instead of entry[0]).
  async function openHistoryModal(ctx) {
    const overlay = document.createElement('div');
    overlay.className = 'tcr-history-overlay';
    overlay.innerHTML = `
      <div class="tcr-history-panel">
        <div class="tcr-history-panel-header">
          <span>${escapeHtml(ctx.clientName || '')} -- ${escapeHtml(ctx.label || '')}</span>
          <button type="button" class="tcr-history-close" aria-label="Close">✕</button>
        </div>
        <div class="tcr-history-body"><p class="status">Loading...</p></div>
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
    overlay.querySelector('.tcr-history-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    try {
      const res = await fetch(historyUrlFor(ctx));
      const data = await res.json();
      const body = overlay.querySelector('.tcr-history-body');
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      if (!data.history || data.history.length === 0) {
        body.innerHTML = '<p class="status">No history found.</p>';
        return;
      }
      const isText = ctx.kind === 'stage-text';
      body.innerHTML = `<ul class="tcr-history-list">${data.history.map((entry) => historyEntryHtml(entry, isText)).join('')}</ul>`;
    } catch (err) {
      overlay.querySelector('.tcr-history-body').innerHTML = `<p class="status error">Error: ${escapeHtml(err.message)}</p>`;
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
    return `<li class="tcr-history-entry"><div>${changeText}</div><div class="tcr-history-when">${when}</div></li>`;
  }

  function openCellEditor(td) {
    const kind = td.dataset.kind;
    const originalHtml = td.innerHTML;

    if (kind === 'stage-text') {
      td.innerHTML = `<input type="text" class="tcr-inline-input" value="${escapeHtml(td.dataset.reason || '')}" />`;
      const input = td.querySelector('input');
      input.focus();
      input.select();
      const commit = () => saveStageText(td, input.value.trim(), originalHtml);
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
      <select class="tcr-status-select">
        ${STATUS_ORDER.map((s) => `<option value="${s}"${s === currentStatus ? ' selected' : ''}>${STATUS_LABELS[s]}</option>`).join('')}
      </select>
      <input type="text" class="tcr-inline-input tcr-reason-input" placeholder="Reason (optional)" value="${escapeHtml(currentReason)}" style="${STATUSES_WITH_COMMENT.includes(currentStatus) ? '' : 'display:none;'}" />
      <div class="tcr-form-actions">
        <button type="button" class="button-link button-link--small tcr-save">Save</button>
        <button type="button" class="tcr-cancel">Cancel</button>
      </div>
    `;
    const select = td.querySelector('select');
    const reasonInput = td.querySelector('.tcr-reason-input');
    select.addEventListener('change', () => {
      reasonInput.style.display = STATUSES_WITH_COMMENT.includes(select.value) ? '' : 'none';
    });
    td.querySelector('.tcr-cancel').addEventListener('click', () => {
      td.innerHTML = originalHtml;
    });
    td.querySelector('.tcr-save').addEventListener('click', () => {
      const status = select.value;
      const reason = STATUSES_WITH_COMMENT.includes(status) ? reasonInput.value.trim() || null : null;
      if (kind === 'cell') saveCell(td, status, reason, originalHtml);
      else saveStageStatus(td, status, reason, originalHtml);
    });
  }

  async function saveCell(td, status, reason, originalHtml) {
    try {
      const res = await fetch(`/api/tc-elite-rollout/cells/${td.dataset.clientId}/${td.dataset.columnId}`, {
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
      const res = await fetch(`/api/tc-elite-rollout/stages/${td.dataset.clientId}/${td.dataset.stageId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, reason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      // A stage edit can change the parent column's master rollup, so both
      // the grid and this same detail sheet need a fresh fetch, not just
      // this one cell.
      await loadGrid();
    } catch (err) {
      td.innerHTML = originalHtml;
      alert(`Error saving: ${err.message}`);
    }
  }

  async function saveStageText(td, value, originalHtml) {
    try {
      const res = await fetch(`/api/tc-elite-rollout/stages/${td.dataset.clientId}/${td.dataset.stageId}`, {
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
}

function formatDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString();
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
