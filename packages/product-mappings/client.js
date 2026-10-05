export const id = "product-mappings";
export const label = "Product Mappings";

// Module-scope, not inside mount() -- same "survive a remount instantly,
// still refresh in the background" convention most pages here use, so
// switching tabs away and back (this page lives as a Contract Mgmt tab)
// doesn't flash blank.
let lastMappings = null;
let lastColumns = null;
let lastIsManager = false;
let hasLoadedOnce = false;

// Whichever mount() is CURRENTLY on screen registers its own render
// function here -- same fix for the "in-flight fetch from a torn-down
// mount" bug this dashboard's other pages already document (see check-
// client/client.js's own activeRenderers for the fuller writeup).
let activeRender = null;

// The table's own columns (name/label/required/unique/inputType) come
// straight off the server's GET / response now, by request ("generate
// the columns and edit page based on the table structure on the fly
// instead of hard coded") -- @dashboard/contract-checks' own
// getProductMappingColumns() is the real source of truth; this page has
// no second, separately-maintained column list any more. A column added
// to product_mappings later just shows up here automatically.
function pmCellText(m, col) {
  const v = m[col.name];
  if (col.inputType === 'boolean') return v === 1 ? 'Yes' : v === 0 ? 'No' : '';
  return v === null || v === undefined ? '' : String(v);
}

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>Product Mappings</h1>
      <div class="date-form">
        <button type="button" id="pm-add-button" class="button-link button-link--small" hidden>Add Mapping</button>
        <button type="button" id="pm-refresh-button" class="button-link button-link--small refresh-button--emphasis">Refresh</button>
      </div>
    </header>
    <p class="status">Every Ingram Micro product this dashboard knows how to match to a real Microsoft SKU and/or an Autotask contract service/invoice name -- feeds Contract Checks/Check Client's own matching elsewhere on this dashboard.</p>
    <p id="pm-status" class="status">Loading...</p>
    <div id="pm-table-wrap"></div>
  `;

  const addButton = container.querySelector('#pm-add-button');
  const refreshButton = container.querySelector('#pm-refresh-button');
  const statusEl = container.querySelector('#pm-status');
  const tableWrapEl = container.querySelector('#pm-table-wrap');

  refreshButton.addEventListener('click', () => load());
  addButton.addEventListener('click', () => openMappingModal(null));

  async function load() {
    refreshButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    try {
      const data = await fetchJson('/api/product-mappings', 'GET');
      lastMappings = data.mappings;
      lastColumns = data.columns;
      lastIsManager = !!data.isManager;
      hasLoadedOnce = true;
      statusEl.hidden = true;
      activeRender(lastMappings, lastColumns, lastIsManager);
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      refreshButton.disabled = false;
    }
  }

  // Per-column filters, same convention Check Client's own M365 Users
  // table uses (buildM365UsersTable() in check-client/client.js) -- a
  // second header row, one plain text input per column, every active
  // filter ANDed together.
  function render(mappings, columns, isManager) {
    addButton.hidden = !isManager;
    if (!mappings || mappings.length === 0) {
      tableWrapEl.innerHTML = '<p class="status">No product mappings yet.</p>';
      return;
    }
    const displayColumns = isManager ? [...columns, { name: 'actions', label: '' }] : columns;
    const filters = {};
    const table = document.createElement('table');
    table.className = 'pm-table';
    table.innerHTML = `
      <thead>
        <tr class="shaded-row">${displayColumns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('')}</tr>
        <tr class="pm-filter-row">${displayColumns
          .map((c) => (c.name === 'actions' ? '<th></th>' : `<th><input type="text" data-filter-key="${c.name}" placeholder="Filter..." /></th>`))
          .join('')}</tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector('tbody');
    function renderRows() {
      const filtered = mappings.filter((m) =>
        columns.every((c) => {
          const f = filters[c.name];
          return !f || pmCellText(m, c).toLowerCase().includes(f);
        })
      );
      tbody.innerHTML =
        filtered.length > 0
          ? filtered
              .map((m) => {
                const cells = columns.map((c) => `<td>${escapeHtml(pmCellText(m, c))}</td>`).join('');
                const actionsCell = isManager
                  ? `<td class="pm-actions-cell">
                       <button type="button" class="link-button pm-edit-button" data-id="${m.id}">Edit</button>
                       <button type="button" class="link-button pm-delete-button" data-id="${m.id}">Delete</button>
                     </td>`
                  : '';
                return `<tr>${cells}${actionsCell}</tr>`;
              })
              .join('')
          : `<tr><td colspan="${displayColumns.length}" class="status">No rows matching these filters.</td></tr>`;
      if (isManager) {
        tbody.querySelectorAll('.pm-edit-button').forEach((btn) => {
          btn.addEventListener('click', () => {
            const m = lastMappings.find((x) => x.id === Number(btn.dataset.id));
            if (m) openMappingModal(m);
          });
        });
        tbody.querySelectorAll('.pm-delete-button').forEach((btn) => {
          btn.addEventListener('click', () => deleteMapping(Number(btn.dataset.id)));
        });
      }
    }
    table.querySelectorAll('[data-filter-key]').forEach((input) => {
      input.addEventListener('input', () => {
        filters[input.dataset.filterKey] = input.value.trim().toLowerCase();
        renderRows();
      });
    });
    renderRows();
    tableWrapEl.innerHTML = '';
    tableWrapEl.appendChild(table);
  }

  async function deleteMapping(id) {
    const m = lastMappings.find((x) => x.id === id);
    if (!m) return;
    const nameColumn = lastColumns.find((c) => c.unique) || lastColumns[0];
    if (!confirm(`Delete the mapping for "${m[nameColumn.name]}"? This can't be undone.`)) return;
    try {
      await fetchJson(`/api/product-mappings/${id}`, 'DELETE');
      await load();
    } catch (err) {
      alert(`Error deleting: ${err.message}`);
    }
  }

  // One form field per real column -- text/number/boolean (Yes/No
  // dropdown) decided by that column's own inputType, exactly as
  // getProductMappingColumns() classified it. A required boolean column
  // (ignore_consumed_count) gets no "(not specified)" option at all --
  // it can never actually be NULL in the database, so the dropdown
  // defaults to No on a brand new row instead of offering a blank state
  // that would just fail validation on save.
  function fieldHtml(col, mapping) {
    const existing = mapping ? mapping[col.name] : null;
    const requiredMark = col.required ? ' *' : '';
    if (col.inputType === 'boolean') {
      const value = existing === 1 ? '1' : existing === 0 ? '0' : '';
      const blankOption = col.required ? '' : `<option value=""${value === '' ? ' selected' : ''}>(not specified)</option>`;
      const noSelected = value === '0' || (col.required && value === '') ? ' selected' : '';
      return `
        <div class="pm-form-field">
          <label for="pm-f-${col.name}">${escapeHtml(col.label)}${requiredMark}</label>
          <select id="pm-f-${col.name}" class="wsp-field" data-input-type="boolean">
            ${blankOption}
            <option value="1"${value === '1' ? ' selected' : ''}>Yes</option>
            <option value="0"${noSelected}>No</option>
          </select>
        </div>
      `;
    }
    const inputType = col.inputType === 'number' ? 'number' : 'text';
    const value = existing === null || existing === undefined ? '' : existing;
    return `
      <div class="pm-form-field">
        <label for="pm-f-${col.name}">${escapeHtml(col.label)}${requiredMark}</label>
        <input type="${inputType}" id="pm-f-${col.name}" class="wsp-field" data-input-type="${inputType}" value="${escapeHtml(String(value))}" />
      </div>
    `;
  }

  // Add (mapping === null) or Edit (mapping === the real row) -- same
  // form either way, same shared .history-modal-* overlay/panel shell
  // every other popup on this dashboard uses. Field order/labels/types
  // all come from lastColumns -- see fieldHtml() above.
  function openMappingModal(mapping) {
    const nameColumn = lastColumns.find((c) => c.unique) || lastColumns[0];
    const overlay = document.createElement('div');
    overlay.className = 'history-modal-overlay';
    const title = mapping ? `Edit -- ${mapping[nameColumn.name]}` : 'Add Product Mapping';
    overlay.innerHTML = `
      <div class="history-modal-panel pm-modal-panel">
        <div class="history-modal-panel-header">
          <span>${escapeHtml(title)}</span>
          <button type="button" class="history-modal-close" aria-label="Close">✕</button>
        </div>
        <div class="history-modal-body">
          ${lastColumns.map((c) => fieldHtml(c, mapping)).join('')}
          <p class="status error pm-modal-error" hidden></p>
          <div class="wsp-form-actions">
            <button type="button" class="button-link pm-save-button">Save</button>
            <button type="button" class="pm-cancel-button">Cancel</button>
          </div>
        </div>
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
    overlay.querySelector('.pm-cancel-button').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    const firstInput = overlay.querySelector(`#pm-f-${nameColumn.name}`);
    async function save() {
      const errorEl = overlay.querySelector('.pm-modal-error');
      errorEl.hidden = true;
      // Keyed by the REAL column name directly -- the server's own
      // normalizeValueForColumn() does the actual type coercion
      // (blank -> NULL, string '0'/'1' -> a real 0/1, etc.), so this
      // just reads each control's raw value as-is.
      const body = {};
      for (const col of lastColumns) {
        const el = overlay.querySelector(`#pm-f-${col.name}`);
        body[col.name] = el.value.trim ? el.value.trim() : el.value;
      }
      try {
        if (mapping) {
          await fetchJson(`/api/product-mappings/${mapping.id}`, 'PUT', body);
        } else {
          await fetchJson('/api/product-mappings', 'POST', body);
        }
        close();
        await load();
      } catch (err) {
        errorEl.hidden = false;
        errorEl.textContent = `Error: ${err.message}`;
      }
    }
    overlay.querySelector('.pm-save-button').addEventListener('click', save);
    if (firstInput) firstInput.focus();
  }

  activeRender = render;
  if (hasLoadedOnce) {
    statusEl.hidden = true;
    render(lastMappings, lastColumns, lastIsManager);
    load();
  } else {
    load();
  }

  async function fetchJson(url, method, body) {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    if (res.status !== 204) data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data;
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
