export const id = "vicyber-reports";
export const label = "ViCyber Reports";

// Module-scope, not inside mount() -- same "survives a shell re-mount"
// convention every other page's client.js on this dashboard already uses.
let resolvedClient = null; // { id, companyName }
let lastReportsForClient = null;
let lastReportData = null; // GET /reports/:id response, currently displayed
let lastCompareData = null; // GET /compare response, currently displayed
let viewMode = 'report'; // 'report' | 'compare' -- which of the two above is on screen
let activeCategory = 'endpoint';
let activeGroupBy = 'device'; // 'device' | 'title'
const selectedForCompare = new Set(); // report ids ticked in the Past Reports list, max 2

const CATEGORIES = [
  { key: 'endpoint', label: 'Endpoint' },
  { key: 'webapp', label: 'Web App' },
  { key: 'network', label: 'Network' },
  { key: 'darkweb', label: 'Dark Web' },
];

const SEVERITY_FLAG_CLASS = {
  'VERY HIGH': 'cell-flag-red',
  HIGH: 'cell-flag-orange',
  MEDIUM: 'cell-flag-blue',
  LOW: 'cell-flag-green',
};
// Highest-first, for picking a group's own "worst severity" badge and for
// sorting rows worst-first within a group -- INFO is deliberately last (no
// real severity, e.g. a DarkWeb row with nothing notable).
const SEVERITY_ORDER = ['VERY HIGH', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

const DETAIL_FIELD_LABELS = {
  cveId: 'CVE ID',
  threat: 'Threat',
  ref: 'Ref',
  impact: 'Impact',
  host: 'Host',
  port: 'Port',
  description: 'Description',
  passwordExposed: 'Password Exposed',
  foundLocation: 'Found Location',
};

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function severityHtml(severity) {
  if (!severity) return '';
  const cls = SEVERITY_FLAG_CLASS[severity.toUpperCase()];
  return cls ? `<span class="${cls}">${escapeHtml(severity)}</span>` : `<span class="inline-subtext">${escapeHtml(severity)}</span>`;
}

function highestSeverity(severities) {
  let best = null;
  for (const s of severities) {
    const idx = SEVERITY_ORDER.indexOf((s || '').toUpperCase());
    if (idx === -1) continue;
    if (best === null || idx < best) best = idx;
  }
  return best === null ? null : SEVERITY_ORDER[best];
}

function formatDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString();
}

export function mount(container) {
  container.classList.add('vicyber-reports-page');
  container.innerHTML = `
    <header class="page-header">
      <h1>ViCyber Reports</h1>
    </header>
    <div class="date-form">
      <label for="client-input">Autotask Client</label>
      <input type="text" id="client-input" placeholder="e.g. Acme* (wildcards with *)" />
      <label class="inline-checkbox-label" title="Force an exact match on the Autotask Client name (instead of the usual wildcard/contains search)">
        <input type="checkbox" id="exact-client-input" /> Exact Match
      </label>
      <button type="button" id="client-search-button">Search</button>
    </div>
    <p id="client-status" class="status" hidden></p>
    <div id="client-picker"></div>
    <div id="client-area" hidden></div>
  `;

  const clientInput = container.querySelector('#client-input');
  const exactClientInput = container.querySelector('#exact-client-input');
  const clientSearchButton = container.querySelector('#client-search-button');
  const clientStatusEl = container.querySelector('#client-status');
  const clientPickerEl = container.querySelector('#client-picker');
  const clientAreaEl = container.querySelector('#client-area');

  clientSearchButton.addEventListener('click', () => searchClient());
  clientInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') searchClient();
  });

  async function searchClient() {
    const term = clientInput.value.trim();
    if (!term) return;
    clientSearchButton.disabled = true;
    clientStatusEl.hidden = false;
    clientStatusEl.className = 'status';
    clientStatusEl.textContent = 'Searching...';
    clientPickerEl.innerHTML = '';
    try {
      const params = new URLSearchParams({ client: term, exactClient: exactClientInput.checked ? 'true' : 'false' });
      const res = await fetch(`/api/vicyber-reports/resolve-client?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      const matches = data.matches || [];
      if (matches.length === 0) {
        clientStatusEl.className = 'status error';
        clientStatusEl.textContent = `No Autotask company matched "${term}".`;
        return;
      }
      clientStatusEl.hidden = true;
      if (matches.length === 1) {
        selectClient(matches[0]);
        return;
      }
      clientPickerEl.innerHTML = `
        <span class="inline-subtext">${matches.length} companies matched -- choose one:</span>
        <select id="client-picker-select">
          <option value="">Pick a client&hellip;</option>
          ${matches.map((m, i) => `<option value="${i}">${escapeHtml(m.companyName)}</option>`).join('')}
        </select>
      `;
      clientPickerEl.querySelector('#client-picker-select').addEventListener('change', (e) => {
        if (e.target.value === '') return;
        selectClient(matches[Number(e.target.value)]);
      });
    } catch (err) {
      clientStatusEl.className = 'status error';
      clientStatusEl.textContent = `Error: ${err.message}`;
    } finally {
      clientSearchButton.disabled = false;
    }
  }

  function selectClient(company) {
    resolvedClient = company;
    clientPickerEl.innerHTML = '';
    clientInput.value = company.companyName;
    clientAreaEl.hidden = false;
    selectedForCompare.clear();
    viewMode = 'report';
    lastReportData = null;
    lastCompareData = null;
    renderClientArea();
    loadReportsList();
  }

  function renderClientArea() {
    clientAreaEl.innerHTML = `
      <div class="resource-group">
        <div class="resource-group-header"><span>Upload New Scan -- ${escapeHtml(resolvedClient.companyName)}</span></div>
        <div class="date-form">
          <input type="file" id="file-input" accept=".xlsx" />
          <button type="button" id="upload-button" disabled>Upload</button>
        </div>
        <p id="upload-status" class="status" hidden></p>
      </div>
      <div class="resource-group">
        <div class="resource-group-header"><span>Past Reports</span><span class="count" id="reports-count"></span></div>
        <div id="reports-list"></div>
        <button type="button" id="selection-action-button" class="button-link button-link--small" hidden></button>
      </div>
      <div id="viewer"></div>
    `;

    const fileInput = clientAreaEl.querySelector('#file-input');
    const uploadButton = clientAreaEl.querySelector('#upload-button');
    const uploadStatusEl = clientAreaEl.querySelector('#upload-status');

    fileInput.addEventListener('change', () => {
      uploadButton.disabled = !fileInput.files.length;
    });

    uploadButton.addEventListener('click', async () => {
      if (!fileInput.files.length) return;
      uploadButton.disabled = true;
      uploadStatusEl.hidden = false;
      uploadStatusEl.className = 'status loading';
      uploadStatusEl.textContent = 'Uploading and parsing...';
      try {
        const formData = new FormData();
        formData.append('file', fileInput.files[0]);
        formData.append('clientId', resolvedClient.id);
        formData.append('clientName', resolvedClient.companyName);
        const res = await fetch('/api/vicyber-reports/upload', { method: 'POST', body: formData });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        uploadStatusEl.hidden = true;
        fileInput.value = '';
        uploadButton.disabled = true;
        await loadReportsList();
        await loadReport(data.reportId);
      } catch (err) {
        uploadStatusEl.className = 'status error';
        uploadStatusEl.textContent = `Error: ${err.message}`;
      } finally {
        uploadButton.disabled = !fileInput.files.length;
      }
    });

    // One button, by request -- "View Selected" with exactly one report
    // ticked, "Compare Selected" with exactly two, hidden otherwise (see
    // updateSelectionActionButton() below). Ticking is what drives both
    // actions now; the per-row "View" button is gone.
    clientAreaEl.querySelector('#selection-action-button').addEventListener('click', () => {
      const ids = [...selectedForCompare];
      if (ids.length === 1) loadReport(ids[0]);
      else if (ids.length === 2) loadCompare(ids[0], ids[1]);
    });
  }

  function updateSelectionActionButton() {
    const button = clientAreaEl.querySelector('#selection-action-button');
    const count = selectedForCompare.size;
    if (count === 1) {
      button.hidden = false;
      button.textContent = 'View Selected';
    } else if (count === 2) {
      button.hidden = false;
      button.textContent = 'Compare Selected';
    } else {
      button.hidden = true;
    }
  }

  async function loadReportsList() {
    const reportsListEl = clientAreaEl.querySelector('#reports-list');
    const reportsCountEl = clientAreaEl.querySelector('#reports-count');
    reportsListEl.innerHTML = '<p class="status">Loading...</p>';
    try {
      const params = new URLSearchParams({ clientId: resolvedClient.id });
      const res = await fetch(`/api/vicyber-reports/reports?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastReportsForClient = data.reports;
      reportsCountEl.textContent = data.reports.length;
      renderReportsList();
    } catch (err) {
      reportsListEl.innerHTML = `<p class="status error">Error: ${escapeHtml(err.message)}</p>`;
    }
  }

  function renderReportsList() {
    const reportsListEl = clientAreaEl.querySelector('#reports-list');
    if (lastReportsForClient.length === 0) {
      reportsListEl.innerHTML = '<p class="status">No reports uploaded yet for this Client.</p>';
      updateSelectionActionButton();
      return;
    }
    reportsListEl.innerHTML = `
      <table>
        <thead><tr><th></th><th>Filename</th><th>Uploaded</th><th>Endpoint</th><th>Web App</th><th>Network</th><th>Dark Web</th><th></th></tr></thead>
        <tbody>
          ${lastReportsForClient
            .map(
              (r) => `
            <tr data-report-id="${r.id}">
              <td><input type="checkbox" class="vcr-compare-check" data-report-id="${r.id}" ${selectedForCompare.has(r.id) ? 'checked' : ''} /></td>
              <td>${escapeHtml(r.filename)}</td>
              <td>${escapeHtml(formatDateTime(r.uploadedAt))}${r.uploadedByName ? ` <span class="inline-subtext">by ${escapeHtml(r.uploadedByName)}</span>` : ''}</td>
              <td>${r.counts.endpoint}</td>
              <td>${r.counts.webapp}</td>
              <td>${r.counts.network}</td>
              <td>${r.counts.darkweb}</td>
              <td><button type="button" class="link-button cell-flag-red vcr-delete-report-btn" data-report-id="${r.id}">Delete</button></td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    `;
    reportsListEl.querySelectorAll('.vcr-delete-report-btn').forEach((btn) => {
      btn.addEventListener('click', () => deleteReportRow(Number(btn.dataset.reportId)));
    });
    // Capped at 2, by request-adjacent convenience -- a 3rd tick silently
    // replaces the OLDEST of the two already ticked, rather than being
    // refused outright or letting the selection grow past what "Compare"
    // can use.
    reportsListEl.querySelectorAll('.vcr-compare-check').forEach((input) => {
      input.addEventListener('change', () => {
        const reportId = Number(input.dataset.reportId);
        if (input.checked) {
          if (selectedForCompare.size >= 2) {
            const oldest = [...selectedForCompare][0];
            selectedForCompare.delete(oldest);
          }
          selectedForCompare.add(reportId);
        } else {
          selectedForCompare.delete(reportId);
        }
        renderReportsList();
      });
    });
    updateSelectionActionButton();
  }

  // Permanent, by request -- no undo, hence the confirm() first, same
  // convention this dashboard already uses dashboard-wide for a real
  // DELETE (see e.g. @dashboard/announcements/client.js's own delete
  // button). Clears this report out of the compare selection and, if it
  // was the one currently on screen (either the single-report view, or
  // either side of a compare), clears the viewer too -- showing a now-
  // deleted report's data would be stale, not just unhelpful.
  async function deleteReportRow(reportId) {
    const report = lastReportsForClient.find((r) => r.id === reportId);
    if (!report) return;
    if (!confirm(`Permanently delete "${report.filename}"? This deletes all of its findings and can't be undone.`)) return;
    try {
      const res = await fetch(`/api/vicyber-reports/reports/${reportId}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      selectedForCompare.delete(reportId);
      const viewerEl = clientAreaEl.querySelector('#viewer');
      if (viewMode === 'report' && lastReportData?.report.id === reportId) {
        lastReportData = null;
        viewerEl.innerHTML = '';
      } else if (viewMode === 'compare' && (lastCompareData?.earlierReport.id === reportId || lastCompareData?.laterReport.id === reportId)) {
        lastCompareData = null;
        viewerEl.innerHTML = '';
      }
      await loadReportsList();
    } catch (err) {
      alert(`Error deleting report: ${err.message}`);
    }
  }

  async function loadReport(reportId) {
    const viewerEl = clientAreaEl.querySelector('#viewer');
    viewerEl.innerHTML = '<p class="status">Loading report...</p>';
    try {
      const res = await fetch(`/api/vicyber-reports/reports/${reportId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      viewMode = 'report';
      lastReportData = data;
      renderViewer();
    } catch (err) {
      viewerEl.innerHTML = `<p class="status error">Error: ${escapeHtml(err.message)}</p>`;
    }
  }

  async function loadCompare(fromId, toId) {
    const viewerEl = clientAreaEl.querySelector('#viewer');
    viewerEl.innerHTML = '<p class="status">Comparing...</p>';
    try {
      const params = new URLSearchParams({ from: fromId, to: toId });
      const res = await fetch(`/api/vicyber-reports/compare?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      viewMode = 'compare';
      lastCompareData = data;
      renderViewer();
    } catch (err) {
      viewerEl.innerHTML = `<p class="status error">Error: ${escapeHtml(err.message)}</p>`;
    }
  }

  function renderViewer() {
    if (viewMode === 'compare') renderCompareViewer();
    else renderReportViewer();
  }

  // ---- Single-report view -- tabs per non-empty category, then a Device/
  // Finding Type grouping toggle within whichever category is active. ----
  function renderReportViewer() {
    const viewerEl = clientAreaEl.querySelector('#viewer');
    const data = lastReportData;
    const available = CATEGORIES.filter((c) => (data.categories[c.key] || []).length > 0);
    if (!available.some((c) => c.key === activeCategory)) activeCategory = available[0]?.key || 'endpoint';

    viewerEl.innerHTML = `
      <p class="inline-subtext"><strong>${escapeHtml(data.report.filename)}</strong> -- uploaded ${escapeHtml(formatDateTime(data.report.uploadedAt))}${data.report.uploadedByName ? ` by ${escapeHtml(data.report.uploadedByName)}` : ''}</p>
      ${available.length === 0 ? '<p class="status">No findings in this report.</p>' : ''}
      <div id="vcr-category-tabs" class="rmmf-tabs rmmf-tabs--primary"></div>
      <div id="vcr-groupby-tabs" class="rmmf-tabs rmmf-subtabs"></div>
      <div id="vcr-results" class="results"></div>
    `;
    if (available.length === 0) return;

    const categoryTabsEl = viewerEl.querySelector('#vcr-category-tabs');
    categoryTabsEl.innerHTML = available
      .map((c) => `<button type="button" class="rmmf-tab${c.key === activeCategory ? ' rmmf-tab--active' : ''}" data-category="${c.key}">${escapeHtml(c.label)} (${data.categories[c.key].length})</button>`)
      .join('');
    categoryTabsEl.querySelectorAll('.rmmf-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeCategory = btn.dataset.category;
        renderReportViewer();
      });
    });

    const groupByTabsEl = viewerEl.querySelector('#vcr-groupby-tabs');
    groupByTabsEl.innerHTML = `
      <button type="button" class="rmmf-tab${activeGroupBy === 'device' ? ' rmmf-tab--active' : ''}" data-groupby="device">By Device</button>
      <button type="button" class="rmmf-tab${activeGroupBy === 'title' ? ' rmmf-tab--active' : ''}" data-groupby="title">By Finding Type</button>
    `;
    groupByTabsEl.querySelectorAll('.rmmf-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeGroupBy = btn.dataset.groupby;
        renderReportViewer();
      });
    });

    const resultsEl = viewerEl.querySelector('#vcr-results');
    const items = data.categories[activeCategory] || [];
    const groups = groupFindings(items, activeGroupBy);
    resultsEl.innerHTML = '';
    for (const g of groups) resultsEl.appendChild(groupEl(g));
  }

  function groupFindings(items, dimension) {
    const map = new Map();
    for (const f of items) {
      const key = dimension === 'device' ? f.device : f.title;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(f);
    }
    return [...map.entries()]
      .map(([key, findings]) => ({ key, findings }))
      .sort((a, b) => b.findings.length - a.findings.length || a.key.localeCompare(b.key));
  }

  // Collapsed by default, same real .resource-group-header--toggle/
  // .toggle-arrow convention Check Client/Classification Summary already
  // use, reused rather than invented fresh.
  function groupEl(group) {
    const wrap = document.createElement('div');
    wrap.className = 'resource-group';
    const worst = highestSeverity(group.findings.map((f) => f.severity));
    const header = document.createElement('div');
    header.className = 'resource-group-header resource-group-header--toggle';
    header.innerHTML = `<span><span class="toggle-arrow">&#9656;</span>${escapeHtml(group.key)}</span><span class="count">${group.findings.length}${worst ? ` &ndash; ${severityHtml(worst)}` : ''}</span>`;
    wrap.appendChild(header);

    const body = document.createElement('div');
    body.hidden = true;
    wrap.appendChild(body);

    const arrow = header.querySelector('.toggle-arrow');
    header.addEventListener('click', () => {
      const nowOpen = body.hidden;
      body.hidden = !nowOpen;
      arrow.innerHTML = nowOpen ? '&#9662;' : '&#9656;';
      if (nowOpen && !body.innerHTML) body.innerHTML = findingsTableHtml(group.findings);
    });
    return wrap;
  }

  function findingsTableHtml(findings) {
    const sorted = [...findings].sort((a, b) => {
      const ai = SEVERITY_ORDER.indexOf((a.severity || '').toUpperCase());
      const bi = SEVERITY_ORDER.indexOf((b.severity || '').toUpperCase());
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
    return `
      <table>
        <thead><tr><th>Device</th><th>Finding</th><th>Severity</th><th>Detected</th><th></th></tr></thead>
        <tbody>
          ${sorted
            .map(
              (f) => `
            <tr>
              <td>${escapeHtml(f.device)}</td>
              <td>${escapeHtml(f.title)}</td>
              <td>${severityHtml(f.severity)}</td>
              <td>${escapeHtml(f.detectedDate)}</td>
              <td><button type="button" class="link-button vcr-detail-toggle" data-finding-id="${f.id}">Details</button></td>
            </tr>
            <tr class="vcr-finding-detail" data-finding-id="${f.id}" hidden><td colspan="5">${findingDetailHtml(f)}</td></tr>`
            )
            .join('')}
        </tbody>
      </table>
    `;
  }

  function findingDetailHtml(f) {
    const fields = [];
    if (f.recommendation) fields.push(['Recommendation', f.recommendation]);
    for (const [key, value] of Object.entries(f.details || {})) {
      if (!value) continue;
      fields.push([DETAIL_FIELD_LABELS[key] || key, value]);
    }
    if (fields.length === 0) return '<p class="inline-subtext">No further detail.</p>';
    return fields.map(([label, value]) => `<p class="vcr-detail-field"><strong>${escapeHtml(label)}:</strong><br>${escapeHtml(value).replace(/\n/g, '<br>')}</p>`).join('');
  }

  // Delegated once on the whole page container -- both the single-report
  // view and the compare view's own tables get rebuilt wholesale on every
  // render, so a per-button listener would just be discarded each time.
  container.addEventListener('click', (e) => {
    const toggleBtn = e.target.closest('.vcr-detail-toggle');
    if (!toggleBtn) return;
    const tr = toggleBtn.closest('tr').nextElementSibling;
    if (tr && tr.classList.contains('vcr-finding-detail')) tr.hidden = !tr.hidden;
  });

  // ---- Compare view -- one category tab row, then Fixed/New/Still Open
  // as 3 stacked sections for whichever category is active. ----
  function renderCompareViewer() {
    const viewerEl = clientAreaEl.querySelector('#viewer');
    const data = lastCompareData;
    const available = CATEGORIES.filter((c) => {
      const d = data.categories[c.key];
      return d.fixed.length + d.added.length + d.stillOpen.length > 0;
    });
    if (!available.some((c) => c.key === activeCategory)) activeCategory = available[0]?.key || 'endpoint';

    viewerEl.innerHTML = `
      <p class="inline-subtext">Comparing <strong>${escapeHtml(data.earlierReport.filename)}</strong> (${escapeHtml(formatDateTime(data.earlierReport.uploadedAt))}) &rarr; <strong>${escapeHtml(data.laterReport.filename)}</strong> (${escapeHtml(formatDateTime(data.laterReport.uploadedAt))})</p>
      ${available.length === 0 ? '<p class="status">No findings in either report.</p>' : ''}
      <div id="vcr-category-tabs" class="rmmf-tabs rmmf-tabs--primary"></div>
      <div id="vcr-groupby-tabs" class="rmmf-tabs rmmf-subtabs"></div>
      <div id="vcr-results" class="results"></div>
    `;
    if (available.length === 0) return;

    const categoryTabsEl = viewerEl.querySelector('#vcr-category-tabs');
    categoryTabsEl.innerHTML = available
      .map((c) => {
        const d = data.categories[c.key];
        return `<button type="button" class="rmmf-tab${c.key === activeCategory ? ' rmmf-tab--active' : ''}" data-category="${c.key}">${escapeHtml(c.label)} (${d.fixed.length + d.added.length + d.stillOpen.length})</button>`;
      })
      .join('');
    categoryTabsEl.querySelectorAll('.rmmf-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeCategory = btn.dataset.category;
        renderCompareViewer();
      });
    });

    // Same shared By Device/By Finding Type toggle the single-report view
    // uses (`activeGroupBy`) -- one control for all 3 sections below, by
    // request ("For all sections allow group by device and group by
    // finding"), rather than 3 independent toggles.
    const groupByTabsEl = viewerEl.querySelector('#vcr-groupby-tabs');
    groupByTabsEl.innerHTML = `
      <button type="button" class="rmmf-tab${activeGroupBy === 'device' ? ' rmmf-tab--active' : ''}" data-groupby="device">By Device</button>
      <button type="button" class="rmmf-tab${activeGroupBy === 'title' ? ' rmmf-tab--active' : ''}" data-groupby="title">By Finding Type</button>
    `;
    groupByTabsEl.querySelectorAll('.rmmf-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeGroupBy = btn.dataset.groupby;
        renderCompareViewer();
      });
    });

    const resultsEl = viewerEl.querySelector('#vcr-results');
    const d = data.categories[activeCategory];
    resultsEl.innerHTML = '';
    resultsEl.appendChild(compareSectionEl('Fixed (no longer present)', d.fixed, 'cell-flag-green'));
    resultsEl.appendChild(compareSectionEl('New (since the earlier report)', d.added, 'cell-flag-red'));
    resultsEl.appendChild(compareSectionEl('Still Open (present in both)', d.stillOpen, null));
  }

  // Collapsed by default, by request -- same toggle convention as groupEl()
  // above, with the device/finding-type grouping (also reusing
  // groupFindings()/groupEl() directly) only built the first time a section
  // is actually opened.
  function compareSectionEl(label, findings, colorClass) {
    const wrap = document.createElement('div');
    wrap.className = 'resource-group';
    const header = document.createElement('div');
    header.className = 'resource-group-header resource-group-header--toggle';
    const labelHtml = colorClass ? `<span class="${colorClass}">${escapeHtml(label)}</span>` : escapeHtml(label);
    header.innerHTML = `<span><span class="toggle-arrow">&#9656;</span>${labelHtml}</span><span class="count">${findings.length}</span>`;
    wrap.appendChild(header);

    const body = document.createElement('div');
    body.hidden = true;
    wrap.appendChild(body);

    const arrow = header.querySelector('.toggle-arrow');
    header.addEventListener('click', () => {
      const nowOpen = body.hidden;
      body.hidden = !nowOpen;
      arrow.innerHTML = nowOpen ? '&#9662;' : '&#9656;';
      if (nowOpen && !body.dataset.rendered) {
        body.dataset.rendered = 'true';
        if (findings.length === 0) {
          body.innerHTML = '<p class="status">None.</p>';
        } else {
          for (const g of groupFindings(findings, activeGroupBy)) body.appendChild(groupEl(g));
        }
      }
    });
    return wrap;
  }
}
