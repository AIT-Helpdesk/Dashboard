export const id = "invoice-intake";
export const label = "Invoice Intake Log";

// Module-scope cache, same "survive a re-mount instantly" reasoning
// classification-summary/client.js's own lastData/activeRender uses --
// the shell tears down and re-creates this page's DOM on every
// navigation away and back, but this module itself stays loaded.
let lastSummary = null;
let lastRecords = null;
let lastStatusFilter = '';

const STATUS_LABELS = { ok: 'Worked', fail: 'Failed', skipped: 'Skipped' };

export function mount(container) {
  container.innerHTML = `
    <style>
      .iil-tiles { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-bottom: 1.25rem; }
      .iil-tile { flex: 1 1 200px; border: 1px solid var(--border); border-radius: 10px; padding: 0.85rem 1rem; background: var(--card); }
      .iil-tile-label { color: var(--muted); font-size: 0.8rem; margin-bottom: 0.35rem; }
      .iil-tile-counts { display: flex; gap: 0.9rem; align-items: baseline; flex-wrap: wrap; }
      .iil-tile-count { font-size: 1.35rem; font-weight: 600; }
      .iil-tile-count-label { font-size: 0.75rem; color: var(--muted); margin-left: 0.2rem; font-weight: normal; }
      .iil-c-ok { color: #1a8a3d; }
      .iil-c-fail { color: #dc2626; }
      .iil-c-skipped { color: var(--muted); }
      .iil-lastrun { font-size: 0.85rem; color: var(--muted); margin-top: 0.3rem; }
      .iil-filters { display: flex; gap: 0.4rem; flex-wrap: wrap; }
      .iil-filter-btn { padding: 0.3rem 0.75rem; font-size: 0.8rem; border-radius: 999px; border: 1px solid var(--border); background: var(--card); color: var(--fg); cursor: pointer; }
      .iil-filter-btn:hover { border-color: var(--accent); }
      .iil-filter-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); }
      .iil-badge { display: inline-block; font-size: 0.72rem; padding: 0.12rem 0.55rem; border-radius: 999px; font-weight: 600; white-space: nowrap; }
      .iil-badge-ok { background: color-mix(in srgb, #1a8a3d 18%, transparent); color: #1a8a3d; }
      .iil-badge-fail { background: color-mix(in srgb, #dc2626 18%, transparent); color: #dc2626; }
      .iil-badge-skipped { background: color-mix(in srgb, var(--muted) 22%, transparent); color: var(--muted); }
      .iil-reason { color: #dc2626; }
      .iil-table-wrap { overflow-x: auto; }
    </style>
    <header class="page-header">
      <h1>Invoice Intake Log</h1>
      <div class="date-form">
        <div class="iil-filters" id="filters">
          <button type="button" class="iil-filter-btn" data-status="">All</button>
          <button type="button" class="iil-filter-btn" data-status="ok">Worked</button>
          <button type="button" class="iil-filter-btn" data-status="fail">Failed</button>
          <button type="button" class="iil-filter-btn" data-status="skipped">Skipped</button>
        </div>
        <button type="button" id="refresh-button">Refresh</button>
      </div>
    </header>
    <p id="status" class="status">Loading...</p>
    <div id="tiles" class="iil-tiles" hidden></div>
    <div id="table-section" hidden>
      <p id="table-note" class="inline-subtext"></p>
      <div class="iil-table-wrap">
        <table>
          <thead>
            <tr class="shaded-row">
              <th>When (AEST)</th>
              <th>Status</th>
              <th>Email Subject</th>
              <th>Attachment</th>
              <th>Result</th>
              <th>Supplier</th>
              <th>Customer</th>
              <th>Doc Date</th>
            </tr>
          </thead>
          <tbody id="table-body"></tbody>
        </table>
      </div>
    </div>
  `;

  const statusEl = container.querySelector('#status');
  const tilesEl = container.querySelector('#tiles');
  const tableSectionEl = container.querySelector('#table-section');
  const tableNoteEl = container.querySelector('#table-note');
  const tableBodyEl = container.querySelector('#table-body');
  const refreshButton = container.querySelector('#refresh-button');
  const filterButtons = [...container.querySelectorAll('.iil-filter-btn')];

  refreshButton.addEventListener('click', loadAll);
  filterButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      lastStatusFilter = btn.dataset.status;
      updateActiveFilterButton();
      loadRecords();
    });
  });

  function updateActiveFilterButton() {
    filterButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.status === lastStatusFilter));
  }

  async function fetchJson(url) {
    const res = await fetch(url);
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data;
  }

  async function loadAll() {
    refreshButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    try {
      const [summary] = await Promise.all([fetchJson('/api/invoice-intake/summary'), loadRecords()]);
      lastSummary = summary;
      renderSummary(summary);
      statusEl.hidden = true;
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error loading summary: ${err.message}`;
    } finally {
      refreshButton.disabled = false;
    }
  }

  async function loadRecords() {
    try {
      const qs = lastStatusFilter ? `?status=${encodeURIComponent(lastStatusFilter)}` : '';
      const data = await fetchJson(`/api/invoice-intake/records${qs}`);
      lastRecords = data.records;
      renderRecords(data.records);
    } catch (err) {
      tableSectionEl.hidden = false;
      tableBodyEl.innerHTML = `<tr><td colspan="8" class="status error">Error loading records: ${escapeHtml(err.message)}</td></tr>`;
    }
  }

  function renderSummary(summary) {
    tilesEl.hidden = false;
    const lastRun = summary.lastRun;
    const lastRunLine = !lastRun
      ? 'No run recorded yet.'
      : `Last run: ${formatAest(lastRun.started_at)} -- ${lastRun.ok ? '<span class="iil-c-ok">completed OK</span>' : '<span class="iil-c-fail">had failures</span>'}${lastRun.message ? ` -- ${escapeHtml(lastRun.message)}` : ''}`;

    tilesEl.innerHTML = `
      ${countsTile('Last 24 hours', summary.last24h)}
      ${countsTile('Last 7 days', summary.last7days)}
      ${countsTile('All time', summary.allTime)}
      <div class="iil-tile">
        <div class="iil-tile-label">Last run</div>
        <div class="iil-lastrun" style="margin-top:0">${lastRunLine}</div>
      </div>
    `;
  }

  function countsTile(label, counts) {
    return `
      <div class="iil-tile">
        <div class="iil-tile-label">${escapeHtml(label)}</div>
        <div class="iil-tile-counts">
          <span class="iil-tile-count iil-c-ok">${counts.ok}<span class="iil-tile-count-label">worked</span></span>
          <span class="iil-tile-count iil-c-fail">${counts.fail}<span class="iil-tile-count-label">failed</span></span>
          <span class="iil-tile-count iil-c-skipped">${counts.skipped}<span class="iil-tile-count-label">skipped</span></span>
        </div>
      </div>
    `;
  }

  function renderRecords(records) {
    tableSectionEl.hidden = false;
    tableNoteEl.textContent = `Showing ${records.length} most recent record${records.length === 1 ? '' : 's'}${lastStatusFilter ? ` (${STATUS_LABELS[lastStatusFilter]})` : ''}.`;
    if (records.length === 0) {
      tableBodyEl.innerHTML = `<tr><td colspan="8" class="status">No records yet.</td></tr>`;
      return;
    }
    tableBodyEl.innerHTML = records.map(recordRowHtml).join('');
  }

  function recordRowHtml(r) {
    const badge = `<span class="iil-badge iil-badge-${r.status}">${STATUS_LABELS[r.status] || r.status}</span>`;
    const result =
      r.status === 'ok'
        ? escapeHtml(r.final_filename || '')
        : r.status === 'fail'
          ? `<span class="iil-reason">${escapeHtml(r.reason || '')}</span>`
          : `<span class="inline-subtext">${escapeHtml(r.reason || '')}</span>`;
    return `
      <tr>
        <td>${formatAest(r.created_at)}</td>
        <td>${badge}</td>
        <td>${escapeHtml(r.email_subject || '')}</td>
        <td>${escapeHtml(r.attachment_name || '')}</td>
        <td>${result}</td>
        <td>${escapeHtml(r.supplier || '')}</td>
        <td>${escapeHtml(r.customer || '')}</td>
        <td>${escapeHtml(r.document_date || '')}</td>
      </tr>
    `;
  }

  // AEST regardless of the viewer's own machine time zone, by request --
  // this is operational data about one Australia-based mailbox/automation,
  // same convention every other operational timestamp on this dashboard
  // follows (see packages/autotask-client's own toAest()).
  function formatAest(iso) {
    if (!iso) return '';
    try {
      return new Intl.DateTimeFormat('en-AU', {
        timeZone: 'Australia/Sydney',
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date(iso));
    } catch {
      return iso;
    }
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  updateActiveFilterButton();

  if (lastSummary && lastRecords) {
    renderSummary(lastSummary);
    renderRecords(lastRecords);
    statusEl.hidden = true;
  } else {
    loadAll();
  }
}
