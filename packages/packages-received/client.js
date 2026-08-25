export const id = "packages-received";
export const label = "Goods Received";

// Module-scope, not inside mount() -- the shell tears down and re-mounts a
// page's DOM on every navigation, but the imported module itself stays
// alive for the session, same "restore instantly instead of a blank flash
// on revisit" convention every other page here uses.
let lastDeliveries = null;

// audit_log's `field` values -> a human label for the history modal.
// 'created' is a whole-delivery event (see db.js's recordAudit call in
// createDelivery()); the rest are real column names.
const FIELD_LABELS = {
  created: 'Logged',
  received_at: 'Date & Time',
  receiver_name: 'Receiver Name',
  sender: 'Sender/Supplier',
  freight_company: 'Freight Company',
  customer: 'Client',
  ticket_number: 'Ticket',
  contents: 'Contents',
  carton_count: 'How Many Cartons',
  slip_checked: 'Contents/Packing Slip Checked',
  matched_with_order: 'Matched with Order',
  notes: 'Notes/Action/Given To',
};
// The two checkbox columns store/log '0'/'1' (see recordAudit's own
// String(newValue) coercion in db.js) -- shown as Yes/No in the history
// modal rather than a raw 0/1.
const BOOLEAN_FIELD_LABELS = { 0: 'No', 1: 'Yes' };

export function mount(container) {
  container.innerHTML = `
    <div class="pgr-page">
      <header class="page-header">
        <div class="date-form date-form--stacked pgr-controls">
          <div class="date-form-row">
            <button type="button" id="refresh-button">Refresh</button>
            <button type="button" id="add-delivery-button" class="button-link">+ Log delivery</button>
          </div>
        </div>
      </header>

      <div id="delivery-form-container"></div>

      <p id="status" class="status">Loading...</p>
      <div id="results"></div>
    </div>
  `;

  const statusEl = container.querySelector('#status');
  const resultsEl = container.querySelector('#results');
  const formContainer = container.querySelector('#delivery-form-container');
  const addDeliveryButton = container.querySelector('#add-delivery-button');
  const refreshButton = container.querySelector('#refresh-button');

  addDeliveryButton.addEventListener('click', () => openForm(null));
  refreshButton.addEventListener('click', () => loadDeliveries());

  async function loadDeliveries() {
    formContainer.innerHTML = '';
    refreshButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    resultsEl.innerHTML = '';
    try {
      const res = await fetch('/api/packages-received/');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastDeliveries = data.deliveries;
      statusEl.hidden = true;
      renderResults(data.deliveries);
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      refreshButton.disabled = false;
    }
  }

  function renderResults(deliveries) {
    resultsEl.innerHTML = '';
    if (deliveries.length === 0) {
      resultsEl.innerHTML = '<p class="status">No deliveries logged yet -- add one to get started.</p>';
      return;
    }
    resultsEl.appendChild(buildTableGroup(deliveries));
  }

  function buildTableGroup(deliveries) {
    const group = document.createElement('div');
    group.className = 'resource-group pgr-table-wrap';
    group.innerHTML = `
      <table class="pgr-table">
        <thead>
          <tr class="shaded-row">
            <th>Date &amp; Time</th>
            <th>Receiver Name</th>
            <th>Sender/Supplier</th>
            <th>Freight Company</th>
            <th class="pgr-col-client">Client</th>
            <th>Ticket</th>
            <th>Contents</th>
            <th class="pgr-col-center">Cartons</th>
            <th class="pgr-col-center">Slip Checked</th>
            <th class="pgr-col-center">Matched</th>
            <th>Notes/Action/Given To</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${deliveries.map(deliveryRowHtml).join('')}
        </tbody>
      </table>
    `;
    wireRowActions(group);
    return group;
  }

  function ticketCellHtml(d) {
    if (!d.ticketNumber) return '—';
    if (d.ticketUrl) {
      // Real popup window, not just a new tab -- same convention every
      // other ticket link on this dashboard uses.
      return `<a href="${escapeHtml(d.ticketUrl)}" target="_blank" rel="noopener noreferrer" onclick="window.open(this.href, '_blank', 'noopener,noreferrer,width=1200,height=900'); return false;">${escapeHtml(d.ticketNumber)}</a>`;
    }
    return `<span title="Ticket not found in Autotask">${escapeHtml(d.ticketNumber)}</span>`;
  }

  function deliveryRowHtml(d) {
    const cartons = d.cartonCount === null || d.cartonCount === undefined ? '—' : d.cartonCount;
    return `
      <tr>
        <td class="pgr-nowrap">${escapeHtml(formatDateTime(d.receivedAt))}</td>
        <td>${escapeHtml(d.receiverName) || '—'}</td>
        <td>${escapeHtml(d.sender) || '—'}</td>
        <td>${escapeHtml(d.freightCompany) || '—'}</td>
        <td class="pgr-col-client">${escapeHtml(d.customer) || '—'}</td>
        <td>${ticketCellHtml(d)}</td>
        <td>${escapeHtml(d.contents) || '—'}</td>
        <td class="pgr-col-center">${cartons}</td>
        <td class="pgr-col-center"><input type="checkbox" class="pgr-checkbox" data-id="${d.id}" data-field="slipChecked"${d.slipChecked ? ' checked' : ''} /></td>
        <td class="pgr-col-center"><input type="checkbox" class="pgr-checkbox" data-id="${d.id}" data-field="matchedWithOrder"${d.matchedWithOrder ? ' checked' : ''} /></td>
        <td>${escapeHtml(d.notes) || '—'}</td>
        <td class="pgr-actions">
          <button type="button" class="pgr-icon-btn pgr-edit-btn" data-id="${d.id}" title="Edit">✏️</button>
          <button type="button" class="pgr-icon-btn pgr-history-btn" data-id="${d.id}" title="View history">\u{1F553}</button>
        </td>
      </tr>`;
  }

  // Both checkboxes save immediately on click, same "no separate form trip
  // needed for the field staff touch most often" reasoning Workshop
  // Board's own inline priority/status editors use -- by request, ticking
  // off "Slip Checked"/"Matched with Order" as goods are processed is the
  // whole point of having them as real checkboxes in the list, not just in
  // the Edit form.
  function wireRowActions(group) {
    group.querySelectorAll('.pgr-checkbox').forEach((cb) => {
      cb.addEventListener('change', async () => {
        cb.disabled = true;
        try {
          await fetchJson(`/api/packages-received/${cb.dataset.id}`, 'PATCH', { [cb.dataset.field]: cb.checked });
          const d = lastDeliveries?.find((x) => x.id === Number(cb.dataset.id));
          if (d) d[cb.dataset.field] = cb.checked;
        } catch (err) {
          cb.checked = !cb.checked;
          alert(`Error: ${err.message}`);
        } finally {
          cb.disabled = false;
        }
      });
    });
    group.querySelectorAll('.pgr-edit-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const d = lastDeliveries?.find((x) => x.id === Number(btn.dataset.id));
        openForm(d || null);
      });
    });
    group.querySelectorAll('.pgr-history-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const d = lastDeliveries?.find((x) => x.id === Number(btn.dataset.id));
        openHistoryModal(Number(btn.dataset.id), d);
      });
    });
  }

  function openForm(existingDelivery) {
    formContainer.innerHTML = '';
    formContainer.appendChild(buildDeliveryForm(existingDelivery));
    formContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Two explicit columns, same layout convention Workshop Board's own
  // Add/Edit form uses -- left: when/who/where it came from and who it's
  // for; right: what it is and the two processing checkboxes plus notes.
  function buildDeliveryForm(existingDelivery) {
    const isEdit = !!existingDelivery;
    const wrapper = document.createElement('div');
    wrapper.className = 'resource-group pgr-delivery-form';
    const receivedAtValue = toDatetimeLocalValue(existingDelivery?.receivedAt || new Date().toISOString());
    wrapper.innerHTML = `
      <div class="section-heading section-heading--nav">${isEdit ? 'Edit delivery' : 'Log delivery'}</div>
      <div class="pgr-form-body">
        <div class="pgr-form-columns">
          <div class="pgr-form-column">
            <label>Date &amp; Time
              <input type="datetime-local" class="pgr-field" data-field="receivedAt" value="${escapeHtml(receivedAtValue)}" />
            </label>
            <label>Receiver Name
              <input type="text" class="pgr-field" data-field="receiverName" value="${escapeHtml(existingDelivery?.receiverName || '')}" />
            </label>
            <label>Sender/Supplier
              <input type="text" class="pgr-field" data-field="sender" value="${escapeHtml(existingDelivery?.sender || '')}" />
            </label>
            <label>Freight Company
              <input type="text" class="pgr-field" data-field="freightCompany" value="${escapeHtml(existingDelivery?.freightCompany || '')}" />
            </label>
            <label>Client
              <input type="text" class="pgr-field" data-field="customer" value="${escapeHtml(existingDelivery?.customer || '')}" />
            </label>
            <label>Ticket
              <input type="text" class="pgr-field" data-field="ticketNumber" value="${escapeHtml(existingDelivery?.ticketNumber || '')}" />
            </label>
          </div>
          <div class="pgr-form-column">
            <label>Contents (if known)
              <input type="text" class="pgr-field" data-field="contents" value="${escapeHtml(existingDelivery?.contents || '')}" />
            </label>
            <label>How Many Cartons
              <input type="number" min="0" step="1" class="pgr-field" data-field="cartonCount" value="${existingDelivery?.cartonCount ?? ''}" />
            </label>
            <label class="pgr-checkbox-field">
              <input type="checkbox" data-field="slipChecked"${existingDelivery?.slipChecked ? ' checked' : ''} /> Contents/Packing Slip Checked
            </label>
            <label class="pgr-checkbox-field">
              <input type="checkbox" data-field="matchedWithOrder"${existingDelivery?.matchedWithOrder ? ' checked' : ''} /> Matched with Order
            </label>
            <label>Notes/Action/Given To
              <textarea class="pgr-field" data-field="notes" rows="3">${escapeHtml(existingDelivery?.notes || '')}</textarea>
            </label>
          </div>
        </div>
        <p class="status error pgr-form-error" hidden></p>
        <div class="pgr-form-actions">
          <button type="button" class="button-link pgr-save-button">Save</button>
          <button type="button" class="pgr-cancel-button">Cancel</button>
        </div>
      </div>
    `;

    wrapper.querySelector('.pgr-cancel-button').addEventListener('click', () => {
      formContainer.innerHTML = '';
    });
    wrapper.querySelector('.pgr-save-button').addEventListener('click', async () => {
      const errorEl = wrapper.querySelector('.pgr-form-error');
      errorEl.hidden = true;
      let fields;
      try {
        fields = collectFormFields(wrapper);
      } catch (err) {
        errorEl.hidden = false;
        errorEl.textContent = `Error: ${err.message}`;
        return;
      }
      try {
        if (isEdit) {
          await fetchJson(`/api/packages-received/${existingDelivery.id}`, 'PATCH', fields);
        } else {
          await fetchJson('/api/packages-received', 'POST', fields);
        }
        formContainer.innerHTML = '';
        await loadDeliveries();
      } catch (err) {
        errorEl.hidden = false;
        errorEl.textContent = `Error: ${err.message}`;
      }
    });

    return wrapper;
  }

  // Reads every [data-field] control in the form into the camelCase body
  // parseDeliveryBody() (server.js) expects -- checkboxes read .checked,
  // How Many Cartons reads as a real number (or null when blank), Date &
  // Time converts from the <input type="datetime-local">'s local-time
  // string back to a real ISO string, everything else is plain trimmed
  // text.
  function collectFormFields(wrapper) {
    const fields = {};
    wrapper.querySelectorAll('[data-field]').forEach((el) => {
      const field = el.dataset.field;
      if (el.type === 'checkbox') {
        fields[field] = el.checked;
      } else if (field === 'receivedAt') {
        fields[field] = fromDatetimeLocalValue(el.value);
      } else if (field === 'cartonCount') {
        fields[field] = el.value.trim() === '' ? null : Number(el.value);
      } else {
        fields[field] = el.value.trim();
      }
    });
    if (!fields.receivedAt) throw new Error('Date & Time is required.');
    return fields;
  }

  // ---- History modal -- reuses the shared .history-modal-* classes
  // TC Elite Rollout's own per-cell history window uses (see
  // packages/shell/public/styles.css), same overlay+panel shape, just a
  // per-delivery audit trail instead of a per-cell one. ----
  async function openHistoryModal(deliveryId, delivery) {
    const overlay = document.createElement('div');
    overlay.className = 'history-modal-overlay';
    const title = delivery ? delivery.customer || delivery.sender || `Delivery #${deliveryId}` : `Delivery #${deliveryId}`;
    overlay.innerHTML = `
      <div class="history-modal-panel">
        <div class="history-modal-panel-header">
          <span>${escapeHtml(title)} -- History</span>
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
      const res = await fetch(`/api/packages-received/${deliveryId}/history`);
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
    const label = FIELD_LABELS[entry.field] || entry.field;
    let changeText;
    if (entry.field === 'created') {
      changeText = escapeHtml(label);
    } else if (entry.field === 'slip_checked' || entry.field === 'matched_with_order') {
      changeText = `${escapeHtml(label)}: ${valueChangeHtml(entry, BOOLEAN_FIELD_LABELS)}`;
    } else if (entry.field === 'received_at') {
      changeText = `${escapeHtml(label)}: ${escapeHtml(formatDateTime(entry.oldValue))} &rarr; ${escapeHtml(formatDateTime(entry.newValue))}`;
    } else {
      changeText = `${escapeHtml(label)}: ${valueChangeHtml(entry, null)}`;
    }
    const when = `${escapeHtml(entry.changedByName)} -- ${escapeHtml(formatDateTime(entry.changedAt))}`;
    return `<li class="history-modal-entry"><div>${changeText}</div><div class="history-modal-when">${when}</div></li>`;
  }

  function valueChangeHtml(entry, labelMap) {
    const label = (v) => (v === null || v === undefined || v === '' ? '(blank)' : labelMap ? labelMap[v] ?? v : v);
    const oldLabel = label(entry.oldValue);
    const newLabel = label(entry.newValue);
    return `${escapeHtml(oldLabel)} &rarr; ${escapeHtml(newLabel)}`;
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

  if (lastDeliveries) {
    statusEl.hidden = true;
    renderResults(lastDeliveries);
  } else {
    loadDeliveries();
  }
}

function formatDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString();
}

// <input type="datetime-local"> needs "YYYY-MM-DDTHH:mm" in LOCAL time (no
// timezone suffix) -- built from the Date object's own local getters, not
// a slice of its ISO string (which is always UTC and would silently shift
// the displayed time).
function toDatetimeLocalValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// The reverse -- new Date() parses a timezone-less "YYYY-MM-DDTHH:mm"
// string as local time, so this correctly round-trips back to a real UTC
// ISO string for storage.
function fromDatetimeLocalValue(value) {
  if (!value) return null;
  return new Date(value).toISOString();
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
