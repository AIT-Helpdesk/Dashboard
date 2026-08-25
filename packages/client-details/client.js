export const id = "client-details";
export const label = "Client Details";

// Module-scope, not inside mount() -- the shell fully tears down and re-mounts a
// page's DOM on every navigation away and back, but the dynamically-imported
// module itself is cached by the browser and stays alive for the session, so a
// module-level variable survives across re-mounts and lets the last result
// restore instantly instead of coming back blank.
let lastQuery = null; // { criteria, client }
let lastData = null;

// "Beginning of the year before last" is a moving two-year window, not a fixed
// year -- computed the same way (and independently) as the server's own cutoff,
// so the dropdown label always matches what the query actually does. AEST
// (UTC+10, no DST in Queensland), not the browser's own local timezone --
// only actually matters for the ~10 AEST hours spanning New Year's Day, but
// consistent with the server side now being AEST-anchored too.
const noRecentInvoiceCutoffYear = new Date(Date.now() + 10 * 60 * 60 * 1000).getUTCFullYear() - 2;

const CRITERIA_OPTIONS = [
  { value: "active", label: "Active Clients" },
  { value: "inactive", label: "Inactive clients" },
  { value: "any", label: "Any Client" },
  { value: "no-primary-contact", label: "No primary contact" },
  { value: "no-billing-contact", label: "No main billing contact set" },
  { value: "no-recent-invoice", label: `No invoice since 1 Jan ${noRecentInvoiceCutoffYear}` },
];

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>Client Details</h1>
      <form id="filter-form" class="date-form">
        <label for="client-input">Client</label>
        <input type="text" id="client-input" name="client" placeholder="e.g. Cloud* or *IT*" />
        <label for="criteria-input">Show</label>
        <select id="criteria-input" name="criteria">
          ${CRITERIA_OPTIONS.map((o) => `<option value="${o.value}">${o.label}</option>`).join('')}
        </select>
        <button type="submit" id="search-button">Search</button>
        <button type="button" id="export-button">Export CSV</button>
      </form>
    </header>
    <p id="status" class="status">Optionally filter by client (wildcards with *), pick a criteria, then click Search.</p>
    <div id="summary" class="summary" hidden></div>
    <div id="results" class="results"></div>
  `;

  const form = container.querySelector('#filter-form');
  const clientInput = container.querySelector('#client-input');
  const criteriaInput = container.querySelector('#criteria-input');
  const searchButton = container.querySelector('#search-button');
  const exportButton = container.querySelector('#export-button');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const resultsEl = container.querySelector('#results');

  if (lastQuery) {
    criteriaInput.value = lastQuery.criteria;
    clientInput.value = lastQuery.client;
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    load(criteriaInput.value, clientInput.value);
  });

  async function load(criteria, clientName) {
    searchButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = `Loading...`;
    summaryEl.hidden = true;
    resultsEl.innerHTML = '';

    try {
      const params = new URLSearchParams({ criteria });
      if (clientName) params.set('client', clientName);
      const res = await fetch(`/api/client-details?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastQuery = { criteria, client: clientName };
      lastData = data;
      render(data);
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      searchButton.disabled = false;
    }
  }

  exportButton.addEventListener('click', () => {
    if (!lastData || lastData.totalCount === 0) {
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.textContent = 'Nothing to export -- run a search with results first.';
      return;
    }
    downloadCsv(lastData);
  });

  const CSV_COLUMNS = [
    { header: 'Client ID', value: (c) => c.id },
    { header: 'Client', value: (c) => c.companyName },
    { header: 'Classification', value: (c) => c.classification },
    { header: 'Last Invoice', value: (c) => formatDate(c.lastInvoiceDate) },
    { header: 'State', value: (c) => c.state },
    { header: 'Phone', value: (c) => c.phone },
    { header: 'Primary Contact', value: (c) => c.primaryContactName },
    { header: 'Main Billing Contact', value: (c) => c.billingContactName },
  ];

  function csvField(value) {
    const str = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  }

  function downloadCsv(data) {
    const lines = [CSV_COLUMNS.map((col) => csvField(col.header)).join(',')];
    for (const c of data.companies) {
      lines.push(CSV_COLUMNS.map((col) => csvField(col.value(c))).join(','));
    }
    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const today = new Date().toISOString().slice(0, 10);
    const a = document.createElement('a');
    a.href = url;
    a.download = `client-details-${data.criteria}-${today}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function render(data) {
    statusEl.hidden = true;

    summaryEl.hidden = false;
    const criteriaLabel = CRITERIA_OPTIONS.find((o) => o.value === data.criteria)?.label || data.criteria;
    const clientLabel = data.client ? ` matching client "${escapeHtml(data.client)}"` : '';
    summaryEl.innerHTML = `<strong>${data.totalCount}</strong> client${data.totalCount === 1 ? '' : 's'} -- ${escapeHtml(criteriaLabel)}${clientLabel}`;

    if (data.totalCount === 0) {
      resultsEl.innerHTML = '<p class="status">No matching clients.</p>';
      return;
    }

    const groupEl = document.createElement('div');
    groupEl.className = 'resource-group';

    const table = document.createElement('table');
    table.innerHTML = `
      <thead>
        <tr><th>Client</th><th>Classification</th><th>Last Invoice</th><th>State</th><th>Phone</th><th>Primary Contact</th><th>Main Billing Contact</th></tr>
      </thead>
      <tbody>
        ${data.companies
          .map(
            // "Any Client" mixes active and inactive rows together -- flag inactive
            // ones with the same light-red shading used on Contract Services for
            // "no next period" (shared CSS class, not a Contract Services concept
            // leaking in -- just reusing the same visual "needs attention" color).
            (c) => `
          <tr${data.criteria === 'any' && c.isActive === false ? ' class="row-no-next-period"' : ''}>
            <td>${companyLink(c)}</td>
            <td>${escapeHtml(c.classification)}</td>
            <td class="ticket-number">${lastInvoiceCell(c)}</td>
            <td>${escapeHtml(c.state)}</td>
            <td class="ticket-number">${escapeHtml(c.phone)}</td>
            <td>${escapeHtml(c.primaryContactName)}</td>
            <td>${escapeHtml(c.billingContactName)}</td>
          </tr>`
          )
          .join('')}
      </tbody>
    `;
    groupEl.appendChild(table);

    resultsEl.innerHTML = '';
    resultsEl.appendChild(groupEl);
  }

  if (lastData) render(lastData);

  function companyLink(c) {
    const label = escapeHtml(c.companyName);
    if (!c.companyUrl) return label;
    // Real popup window, not just a new tab -- same convention this page's
    // own invoice link (and every other Autotask/IT Glue link on this
    // dashboard) uses.
    return `<a href="${escapeHtml(c.companyUrl)}" target="_blank" rel="noopener noreferrer" onclick="window.open(this.href, '_blank', 'noopener,noreferrer,width=1200,height=900'); return false;">${label}</a>`;
  }

  function formatDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString();
  }

  function lastInvoiceCell(c) {
    if (!c.lastInvoiceDate) return '';
    const label = escapeHtml(formatDate(c.lastInvoiceDate));
    if (!c.lastInvoiceUrl) return label;
    // A real popup window, not just a new tab -- specifying window features
    // (width/height/etc.) is what signals that to the browser. Reads `this.href`
    // rather than re-embedding the URL in the onclick string, so there's only one
    // place the URL needs escaping (the href attribute) instead of two.
    return `<a href="${escapeHtml(c.lastInvoiceUrl)}" target="_blank" rel="noopener noreferrer" onclick="window.open(this.href, '_blank', 'noopener,noreferrer,width=1000,height=800'); return false;">${label}</a>`;
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
