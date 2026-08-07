export const id = "client-contacts";
export const label = "Client Contacts";

// Module-scope, not inside mount() -- the shell fully tears down and re-mounts a
// page's DOM on every navigation away and back, but the dynamically-imported
// module itself is cached by the browser and stays alive for the session, so a
// module-level variable survives across re-mounts and lets the last result
// restore instantly instead of coming back blank.
let lastQuery = null; // { contactType, client, companyType, classification }
let lastData = null;

const CONTACT_TYPE_OPTIONS = [
  { value: "primary", label: "Primary contacts" },
  { value: "billing", label: "Main billing contacts" },
  { value: "both", label: "Both" },
  { value: "all", label: "All active contacts" },
];

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>Client Contacts</h1>
      <form id="filter-form" class="date-form">
        <label for="client-input">Client</label>
        <input type="text" id="client-input" name="client" placeholder="e.g. Cloud* or *IT*" />
        <label for="contact-type-input">Show</label>
        <select id="contact-type-input" name="contactType">
          ${CONTACT_TYPE_OPTIONS.map((o) => `<option value="${o.value}">${o.label}</option>`).join('')}
        </select>
        <label for="company-type-input">Company Type</label>
        <input type="text" id="company-type-input" name="companyType" placeholder="e.g. Cust* or *Prospect*" />
        <label for="classification-input">Classification</label>
        <input type="text" id="classification-input" name="classification" placeholder="e.g. Tech* or *Elite*" />
        <button type="submit" id="search-button">Search</button>
        <button type="button" id="export-button">Export CSV</button>
      </form>
    </header>
    <p id="status" class="status">Pick which contacts to show, optionally filter by Client / Company Type / Classification (wildcards with *), then click Search.</p>
    <div id="summary" class="summary" hidden></div>
    <div id="results" class="results"></div>
  `;

  const form = container.querySelector('#filter-form');
  const clientInput = container.querySelector('#client-input');
  const contactTypeInput = container.querySelector('#contact-type-input');
  const companyTypeInput = container.querySelector('#company-type-input');
  const classificationInput = container.querySelector('#classification-input');
  const searchButton = container.querySelector('#search-button');
  const exportButton = container.querySelector('#export-button');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const resultsEl = container.querySelector('#results');

  if (lastQuery) {
    contactTypeInput.value = lastQuery.contactType;
    clientInput.value = lastQuery.client;
    companyTypeInput.value = lastQuery.companyType;
    classificationInput.value = lastQuery.classification;
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    load(contactTypeInput.value, clientInput.value, companyTypeInput.value, classificationInput.value);
  });

  async function load(contactType, clientName, companyType, classification) {
    searchButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    summaryEl.hidden = true;
    resultsEl.innerHTML = '';

    try {
      const params = new URLSearchParams({ contactType });
      if (clientName) params.set('client', clientName);
      if (companyType) params.set('companyType', companyType);
      if (classification) params.set('classification', classification);
      const res = await fetch(`/api/client-contacts?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastQuery = { contactType, client: clientName, companyType, classification };
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
    { header: 'Company Name', value: (c) => c.companyName },
    { header: 'First Name', value: (c) => c.firstName },
    { header: 'Last Name', value: (c) => c.lastName },
    { header: 'Email', value: (c) => c.email },
  ];

  function csvField(value) {
    const str = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  }

  function downloadCsv(data) {
    const lines = [CSV_COLUMNS.map((col) => csvField(col.header)).join(',')];
    for (const c of data.contacts) {
      lines.push(CSV_COLUMNS.map((col) => csvField(col.value(c))).join(','));
    }
    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const today = new Date().toISOString().slice(0, 10);
    const a = document.createElement('a');
    a.href = url;
    a.download = `client-contacts-${data.contactType}-${today}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function render(data) {
    statusEl.hidden = true;

    summaryEl.hidden = false;
    const contactTypeLabel = CONTACT_TYPE_OPTIONS.find((o) => o.value === data.contactType)?.label || data.contactType;
    const filters = [];
    if (data.client) filters.push(`Client "${escapeHtml(data.client)}"`);
    if (data.companyType) filters.push(`Company Type "${escapeHtml(data.companyType)}"`);
    if (data.classification) filters.push(`Classification "${escapeHtml(data.classification)}"`);
    const filterLabel = filters.length ? ` matching ${filters.join(' and ')}` : '';
    summaryEl.innerHTML = `<strong>${data.totalCount}</strong> contact${data.totalCount === 1 ? '' : 's'} -- ${escapeHtml(contactTypeLabel)}${filterLabel}`;

    if (data.totalCount === 0) {
      resultsEl.innerHTML = '<p class="status">No matching contacts.</p>';
      return;
    }

    const groupEl = document.createElement('div');
    groupEl.className = 'resource-group';

    const table = document.createElement('table');
    table.innerHTML = `
      <thead>
        <tr><th>Company Name</th><th>First Name</th><th>Last Name</th><th>Email</th></tr>
      </thead>
      <tbody>
        ${data.contacts
          .map(
            (c) => `
          <tr>
            <td>${companyLink(c)}</td>
            <td>${escapeHtml(c.firstName)}</td>
            <td>${escapeHtml(c.lastName)}</td>
            <td>${escapeHtml(c.email)}</td>
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
    return `<a href="${escapeHtml(c.companyUrl)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
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
