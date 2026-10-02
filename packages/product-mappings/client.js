export const id = "product-mappings";
export const label = "Product Mappings";

// Module-scope, not inside mount() -- same "survive a remount instantly,
// still refresh in the background" convention most pages here use, so
// switching tabs away and back (this page lives as a Contract Mgmt tab)
// doesn't flash blank.
let lastMappings = null;
let lastIsManager = false;
let hasLoadedOnce = false;

// Whichever mount() is CURRENTLY on screen registers its own render
// function here -- same fix for the "in-flight fetch from a torn-down
// mount" bug this dashboard's other pages already document (see check-
// client/client.js's own activeRenderers for the fuller writeup).
let activeRender = null;

// The real columns on product_mappings (see @dashboard/contract-checks'
// own db.js CREATE TABLE) -- id/created_at/updated_at deliberately not
// shown as their own columns (id is an internal key, created_at/
// updated_at aren't something anyone's asked to see here), everything
// else this table actually carries is.
const PM_COLUMNS = [
  { key: 'ingram_product_name', label: 'Ingram Product Name' },
  { key: 'ms_sku_part_number', label: 'MS SKU Part Number' },
  { key: 'ms_sku_id', label: 'MS SKU ID' },
  { key: 'friendly_ms_product_name', label: 'Friendly MS Product Name' },
  { key: 'autotask_contract_server_name', label: 'Autotask Contract Server Name' },
  { key: 'autotask_contract_invoice_name', label: 'Autotask Contract Invoice Name' },
  { key: 'free', label: 'Free' },
];

function pmCellText(m, key) {
  if (key === 'free') return m.free === 1 ? 'Yes' : m.free === 0 ? 'No' : '';
  return m[key] || '';
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
      lastIsManager = !!data.isManager;
      hasLoadedOnce = true;
      statusEl.hidden = true;
      activeRender(lastMappings, lastIsManager);
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
  function render(mappings, isManager) {
    addButton.hidden = !isManager;
    if (!mappings || mappings.length === 0) {
      tableWrapEl.innerHTML = '<p class="status">No product mappings yet.</p>';
      return;
    }
    const columns = isManager ? [...PM_COLUMNS, { key: 'actions', label: '' }] : PM_COLUMNS;
    const filters = {};
    const table = document.createElement('table');
    table.className = 'pm-table';
    table.innerHTML = `
      <thead>
        <tr class="shaded-row">${columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('')}</tr>
        <tr class="pm-filter-row">${columns
          .map((c) => (c.key === 'actions' ? '<th></th>' : `<th><input type="text" data-filter-key="${c.key}" placeholder="Filter..." /></th>`))
          .join('')}</tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector('tbody');
    function renderRows() {
      const filtered = mappings.filter((m) =>
        PM_COLUMNS.every((c) => {
          const f = filters[c.key];
          return !f || pmCellText(m, c.key).toLowerCase().includes(f);
        })
      );
      tbody.innerHTML =
        filtered.length > 0
          ? filtered
              .map((m) => {
                const cells = PM_COLUMNS.map((c) => `<td>${escapeHtml(pmCellText(m, c.key))}</td>`).join('');
                const actionsCell = isManager
                  ? `<td class="pm-actions-cell">
                       <button type="button" class="link-button pm-edit-button" data-id="${m.id}">Edit</button>
                       <button type="button" class="link-button pm-delete-button" data-id="${m.id}">Delete</button>
                     </td>`
                  : '';
                return `<tr>${cells}${actionsCell}</tr>`;
              })
              .join('')
          : `<tr><td colspan="${columns.length}" class="status">No rows matching these filters.</td></tr>`;
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
    if (!confirm(`Delete the mapping for "${m.ingram_product_name}"? This can't be undone.`)) return;
    try {
      await fetchJson(`/api/product-mappings/${id}`, 'DELETE');
      await load();
    } catch (err) {
      alert(`Error deleting: ${err.message}`);
    }
  }

  // Add (mapping === null) or Edit (mapping === the real row) -- same
  // form either way, same shared .history-modal-* overlay/panel shell
  // every other popup on this dashboard uses.
  function openMappingModal(mapping) {
    const overlay = document.createElement('div');
    overlay.className = 'history-modal-overlay';
    const title = mapping ? `Edit -- ${mapping.ingram_product_name}` : 'Add Product Mapping';
    const freeValue = mapping ? (mapping.free === 1 ? '1' : mapping.free === 0 ? '0' : '') : '';
    overlay.innerHTML = `
      <div class="history-modal-panel pm-modal-panel">
        <div class="history-modal-panel-header">
          <span>${escapeHtml(title)}</span>
          <button type="button" class="history-modal-close" aria-label="Close">✕</button>
        </div>
        <div class="history-modal-body">
          <div class="pm-form-field">
            <label for="pm-f-ingram">Ingram Product Name *</label>
            <input type="text" id="pm-f-ingram" class="wsp-field" value="${escapeHtml(mapping ? mapping.ingram_product_name : '')}" />
          </div>
          <div class="pm-form-field">
            <label for="pm-f-sku-part">MS SKU Part Number</label>
            <input type="text" id="pm-f-sku-part" class="wsp-field" value="${escapeHtml(mapping ? mapping.ms_sku_part_number || '' : '')}" />
          </div>
          <div class="pm-form-field">
            <label for="pm-f-sku-id">MS SKU ID</label>
            <input type="text" id="pm-f-sku-id" class="wsp-field" value="${escapeHtml(mapping ? mapping.ms_sku_id || '' : '')}" />
          </div>
          <div class="pm-form-field">
            <label for="pm-f-friendly">Friendly MS Product Name</label>
            <input type="text" id="pm-f-friendly" class="wsp-field" value="${escapeHtml(mapping ? mapping.friendly_ms_product_name || '' : '')}" />
          </div>
          <div class="pm-form-field">
            <label for="pm-f-at-server">Autotask Contract Server Name</label>
            <input type="text" id="pm-f-at-server" class="wsp-field" value="${escapeHtml(mapping ? mapping.autotask_contract_server_name || '' : '')}" />
          </div>
          <div class="pm-form-field">
            <label for="pm-f-at-invoice">Autotask Contract Invoice Name</label>
            <input type="text" id="pm-f-at-invoice" class="wsp-field" value="${escapeHtml(mapping ? mapping.autotask_contract_invoice_name || '' : '')}" />
          </div>
          <div class="pm-form-field">
            <label for="pm-f-free">Free</label>
            <select id="pm-f-free" class="wsp-field">
              <option value=""${freeValue === '' ? ' selected' : ''}>(not specified)</option>
              <option value="1"${freeValue === '1' ? ' selected' : ''}>Yes</option>
              <option value="0"${freeValue === '0' ? ' selected' : ''}>No</option>
            </select>
          </div>
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

    const ingramInput = overlay.querySelector('#pm-f-ingram');
    async function save() {
      const errorEl = overlay.querySelector('.pm-modal-error');
      errorEl.hidden = true;
      const freeRaw = overlay.querySelector('#pm-f-free').value;
      const body = {
        ingramProductName: ingramInput.value.trim(),
        msSkuPartNumber: overlay.querySelector('#pm-f-sku-part').value.trim(),
        msSkuId: overlay.querySelector('#pm-f-sku-id').value.trim(),
        friendlyMsProductName: overlay.querySelector('#pm-f-friendly').value.trim(),
        autotaskContractServerName: overlay.querySelector('#pm-f-at-server').value.trim(),
        autotaskContractInvoiceName: overlay.querySelector('#pm-f-at-invoice').value.trim(),
        free: freeRaw === '' ? null : freeRaw === '1',
      };
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
    ingramInput.focus();
  }

  activeRender = render;
  if (hasLoadedOnce) {
    statusEl.hidden = true;
    render(lastMappings, lastIsManager);
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
