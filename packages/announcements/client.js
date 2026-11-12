export const id = 'announcements';
export const label = 'Announcements';

// Same "survive a remount instantly, still refresh in the background"
// module-scope caching convention most pages here use (see check-
// client/client.js's own activeRenderers for the fuller writeup) --
// whichever mount() is CURRENTLY on screen registers its own render
// function in activeRender.
let lastAnnouncements = null;
let hasLoadedOnce = false;
let activeRender = null;
let includeRetired = false;

const TEAM_OPTIONS = [
  { value: 'serviceDesk', label: 'Service Desk' },
  { value: 'professionalServices', label: 'Professional Services' },
  { value: 'leadership', label: 'Leadership Team' },
];
const SEVERITY_LABELS = { info: 'Info', warning: 'Warning', critical: 'Critical' };

function targetsLabel(targets) {
  if (!targets || targets.length === 0) return 'Everyone';
  return targets
    .map((t) => (TEAM_OPTIONS.find((o) => o.value === t.value) || { label: t.value }).label)
    .join(', ');
}

function windowLabel(a) {
  if (!a.startAt && !a.endAt) return 'Always';
  const from = a.startAt ? new Date(a.startAt).toLocaleString('en-AU') : 'now';
  const to = a.endAt ? new Date(a.endAt).toLocaleString('en-AU') : 'no end';
  return `${from} → ${to}`;
}

// <input type="datetime-local"> wants/returns local-time "YYYY-MM-DDTHH:mm"
// with no timezone suffix -- new Date() correctly treats that as local time
// both ways, so this is a plain round-trip through the browser's own
// timezone (AEST for this team), no manual offset math needed.
function toDatetimeLocalValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromDatetimeLocalValue(value) {
  if (!value) return null;
  return new Date(value).toISOString();
}

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>Announcements</h1>
      <div class="date-form">
        <button type="button" id="ann-add-button" class="button-link button-link--small">Add Announcement</button>
        <button type="button" id="ann-refresh-button" class="button-link button-link--small refresh-button--emphasis">Refresh</button>
      </div>
    </header>
    <p class="status">Shown as a pop-up to everyone on dashboard open/refresh, filtered to whatever currently applies to them -- anyone can add one; editing, archiving, or deleting is limited to its creator or the dashboard admin.</p>
    <label class="inline-checkbox-label"><input type="checkbox" id="ann-show-retired-input" /> Show archived</label>
    <p id="ann-status" class="status">Loading...</p>
    <div id="ann-table-wrap"></div>
  `;

  const addButton = container.querySelector('#ann-add-button');
  const refreshButton = container.querySelector('#ann-refresh-button');
  const showRetiredInput = container.querySelector('#ann-show-retired-input');
  const statusEl = container.querySelector('#ann-status');
  const tableWrapEl = container.querySelector('#ann-table-wrap');

  showRetiredInput.checked = includeRetired;
  refreshButton.addEventListener('click', () => load());
  addButton.addEventListener('click', () => openAnnouncementModal(null));
  showRetiredInput.addEventListener('change', () => {
    includeRetired = showRetiredInput.checked;
    load();
  });

  async function load() {
    refreshButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    try {
      const data = await fetchJson(`/api/announcements?includeRetired=${includeRetired ? '1' : '0'}`, 'GET');
      lastAnnouncements = data.announcements;
      hasLoadedOnce = true;
      statusEl.hidden = true;
      activeRender(lastAnnouncements);
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      refreshButton.disabled = false;
    }
  }

  // `canManage` (creator or dashboard admin) now comes per-row from the
  // server, not a single page-wide `editable` flag -- anyone can add an
  // announcement, but only its creator or the admin sees that row's own
  // Edit/Archive/Ack's controls. `canDelete` is separate and narrower (admin
  // only, by request: "the creator can Archive but not delete") -- a row's
  // creator can see Edit/Archive without Delete. The actions column itself
  // only appears when at least one visible row has EITHER permission; a row
  // with neither still gets a blank filler cell so every row keeps the same
  // column count as its header.
  function render(announcements) {
    if (!announcements || announcements.length === 0) {
      tableWrapEl.innerHTML = `<p class="status">No${includeRetired ? '' : ' active'} announcements yet.</p>`;
      return;
    }
    const anyActionable = announcements.some((a) => a.canManage || a.canDelete);
    const table = document.createElement('table');
    table.className = 'ann-table';
    table.innerHTML = `
      <thead>
        <tr class="shaded-row">
          <th>Title</th>
          <th>Severity</th>
          <th>Window</th>
          <th>Targets</th>
          <th>Status</th>
          ${anyActionable ? '<th></th>' : ''}
        </tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector('tbody');
    tbody.innerHTML = announcements
      .map((a) => {
        const retired = !!a.retiredAt;
        const actionsCell = a.canManage || a.canDelete
          ? `<td class="ann-actions-cell">
               ${a.canManage ? `<button type="button" class="button-link button-link--small ann-edit-button" data-id="${a.id}">Edit</button>` : ''}
               ${a.canManage ? `<button type="button" class="button-link button-link--small ann-retire-button" data-id="${a.id}">${retired ? 'Restore' : 'Archive'}</button>` : ''}
               ${a.canDelete ? `<button type="button" class="button-link button-link--small ann-delete-button" data-id="${a.id}">Delete</button>` : ''}
               ${a.canManage && a.ackRequired ? `<button type="button" class="button-link button-link--small ann-ack-view-button" data-id="${a.id}">Ack's</button>` : ''}
             </td>`
          : anyActionable
          ? '<td></td>'
          : '';
        return `
          <tr>
            <td>${escapeHtml(a.title)}</td>
            <td><span class="ann-badge ann-severity-${a.severity}">${SEVERITY_LABELS[a.severity] || a.severity}</span></td>
            <td>${escapeHtml(windowLabel(a))}</td>
            <td>${escapeHtml(targetsLabel(a.targets))}</td>
            <td>${retired ? 'Archived' : 'Active'}</td>
            ${actionsCell}
          </tr>
        `;
      })
      .join('');
    // Buttons only ever exist inside an actionable row's own .ann-actions-cell
    // (never the blank filler <td> above), so wiring these up unconditionally
    // is safe -- querySelectorAll on an empty set is just a no-op.
    tbody.querySelectorAll('.ann-edit-button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const a = lastAnnouncements.find((x) => x.id === Number(btn.dataset.id));
        if (a) openAnnouncementModal(a);
      });
    });
    tbody.querySelectorAll('.ann-ack-view-button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const a = lastAnnouncements.find((x) => x.id === Number(btn.dataset.id));
        if (a) openAcknowledgementsModal(a);
      });
    });
    tbody.querySelectorAll('.ann-retire-button').forEach((btn) => {
      btn.addEventListener('click', () => toggleRetire(Number(btn.dataset.id)));
    });
    tbody.querySelectorAll('.ann-delete-button').forEach((btn) => {
      btn.addEventListener('click', () => deleteAnnouncement(Number(btn.dataset.id)));
    });
    tableWrapEl.innerHTML = '';
    tableWrapEl.appendChild(table);
  }

  async function toggleRetire(annId) {
    const a = lastAnnouncements.find((x) => x.id === annId);
    if (!a) return;
    try {
      await fetchJson(`/api/announcements/${annId}/${a.retiredAt ? 'unretire' : 'retire'}`, 'POST');
      await load();
    } catch (err) {
      alert(`Error: ${err.message}`);
    }
  }

  async function deleteAnnouncement(annId) {
    const a = lastAnnouncements.find((x) => x.id === annId);
    if (!a) return;
    if (!confirm(`Delete "${a.title}"? This can't be undone.`)) return;
    try {
      await fetchJson(`/api/announcements/${annId}`, 'DELETE');
      await load();
    } catch (err) {
      alert(`Error deleting: ${err.message}`);
    }
  }

  // Who's acknowledged a given announcement -- same shared .history-modal-*
  // overlay/panel shell as openAnnouncementModal below, just a read-only list.
  async function openAcknowledgementsModal(announcement) {
    const overlay = document.createElement('div');
    overlay.className = 'history-modal-overlay';
    overlay.innerHTML = `
      <div class="history-modal-panel ann-modal-panel">
        <div class="history-modal-panel-header">
          <span>Acknowledgements -- ${escapeHtml(announcement.title)}</span>
          <button type="button" class="history-modal-close" aria-label="Close">✕</button>
        </div>
        <div class="history-modal-body">
          <p class="status ann-ack-status">Loading...</p>
          <div class="ann-ack-list-wrap"></div>
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
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    const statusEl = overlay.querySelector('.ann-ack-status');
    const listWrapEl = overlay.querySelector('.ann-ack-list-wrap');
    try {
      const data = await fetchJson(`/api/announcements/${announcement.id}/acknowledgements`, 'GET');
      const acks = data.acknowledgements || [];
      if (acks.length === 0) {
        statusEl.textContent = 'No one has acknowledged this yet.';
        return;
      }
      statusEl.hidden = true;
      listWrapEl.innerHTML = `
        <table class="ann-table">
          <thead>
            <tr class="shaded-row">
              <th>Name</th>
              <th>Email</th>
              <th>Acknowledged</th>
            </tr>
          </thead>
          <tbody>
            ${acks
              .map(
                (ack) => `
              <tr>
                <td>${escapeHtml(ack.name || '')}</td>
                <td>${escapeHtml(ack.email)}</td>
                <td>${escapeHtml(new Date(ack.acknowledgedAt).toLocaleString('en-AU'))}</td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>
      `;
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    }
  }

  // Add (announcement === null) or Edit (the real row) -- same shared
  // .history-modal-* overlay/panel shell every other popup on this
  // dashboard uses (product-mappings/client.js's own openMappingModal()
  // is the direct model).
  function openAnnouncementModal(announcement) {
    const overlay = document.createElement('div');
    overlay.className = 'history-modal-overlay';
    const title = announcement ? `Edit -- ${announcement.title}` : 'Add Announcement';
    const existingTargets = announcement ? announcement.targets.map((t) => t.value) : [];
    overlay.innerHTML = `
      <div class="history-modal-panel ann-modal-panel">
        <div class="history-modal-panel-header">
          <span>${escapeHtml(title)}</span>
          <button type="button" class="history-modal-close" aria-label="Close">✕</button>
        </div>
        <div class="history-modal-body">
          <div class="pm-form-field">
            <label for="ann-f-title">Title *</label>
            <input type="text" id="ann-f-title" class="wsp-field" maxlength="150" value="${escapeHtml(announcement ? announcement.title : '')}" />
          </div>
          <div class="pm-form-field">
            <label for="ann-f-body">Body</label>
            <textarea id="ann-f-body" class="wsp-field" rows="5">${escapeHtml(announcement ? announcement.body : '')}</textarea>
          </div>
          <div class="pm-form-field">
            <label for="ann-f-severity">Severity</label>
            <select id="ann-f-severity" class="wsp-field">
              ${['info', 'warning', 'critical']
                .map((s) => `<option value="${s}"${announcement && announcement.severity === s ? ' selected' : ''}>${SEVERITY_LABELS[s]}</option>`)
                .join('')}
            </select>
          </div>
          <div class="pm-form-field">
            <label for="ann-f-start">Starts (optional)</label>
            <input type="datetime-local" id="ann-f-start" class="wsp-field" value="${toDatetimeLocalValue(announcement && announcement.startAt)}" />
          </div>
          <div class="pm-form-field">
            <label for="ann-f-end">Ends (optional)</label>
            <input type="datetime-local" id="ann-f-end" class="wsp-field" value="${toDatetimeLocalValue(announcement && announcement.endAt)}" />
          </div>
          <div class="pm-form-field">
            <label>Targeted teams (none = everyone)</label>
            ${TEAM_OPTIONS.map(
              (o) => `
              <label class="inline-checkbox-label ann-team-label">
                <input type="checkbox" class="ann-f-team" value="${o.value}" ${existingTargets.includes(o.value) ? 'checked' : ''} /> ${escapeHtml(o.label)}
              </label>`
            ).join('')}
          </div>
          <label class="inline-checkbox-label">
            <input type="checkbox" id="ann-f-ack" ${(announcement ? announcement.ackRequired : true) ? 'checked' : ''} /> Requires Acknowledge to dismiss
          </label>
          <p class="status error ann-modal-error" hidden></p>
          <div class="wsp-form-actions ann-form-actions">
            <button type="button" class="ann-cancel-button">Cancel</button>
            <button type="button" class="button-link ann-save-button">Save</button>
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
    overlay.querySelector('.ann-cancel-button').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    async function save() {
      const errorEl = overlay.querySelector('.ann-modal-error');
      errorEl.hidden = true;
      const targets = Array.from(overlay.querySelectorAll('.ann-f-team:checked')).map((el) => ({ type: 'team', value: el.value }));
      const body = {
        title: overlay.querySelector('#ann-f-title').value.trim(),
        body: overlay.querySelector('#ann-f-body').value,
        severity: overlay.querySelector('#ann-f-severity').value,
        ackRequired: overlay.querySelector('#ann-f-ack').checked,
        startAt: fromDatetimeLocalValue(overlay.querySelector('#ann-f-start').value),
        endAt: fromDatetimeLocalValue(overlay.querySelector('#ann-f-end').value),
        targets,
      };
      try {
        if (announcement) {
          await fetchJson(`/api/announcements/${announcement.id}`, 'PUT', body);
        } else {
          await fetchJson('/api/announcements', 'POST', body);
        }
        close();
        await load();
      } catch (err) {
        errorEl.hidden = false;
        errorEl.textContent = `Error: ${err.message}`;
      }
    }
    overlay.querySelector('.ann-save-button').addEventListener('click', save);
    overlay.querySelector('#ann-f-title').focus();
  }

  activeRender = render;
  if (hasLoadedOnce) {
    statusEl.hidden = true;
    render(lastAnnouncements);
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
