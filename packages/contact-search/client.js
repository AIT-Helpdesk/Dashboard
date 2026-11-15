export const id = "contact-search";
export const label = "Contact Search";

// Module-scope, not inside mount() -- same "survives a shell re-mount"
// convention every other page's client.js already uses.
let lastQuery = null; // { name, phone, address, email, fuzzy, activeOnly }
let lastData = null;

let activeRender = null;

// Click-to-sort column headers, same convention @dashboard/live-health-
// scores' own sortState/compareForSort()/sortableHeaderHtml() already use
// (that page's own comment notes this is deliberately a per-page class,
// not a dashboard-wide th convention, hence .cs-sort-btn below rather
// than reusing .lhs-sort-btn directly). Module-scope so it survives a
// remount, same as lastQuery/lastData above.
let sortState = { key: 'companyName', direction: 'asc' };

// One entry per visible table column -- `sort` reads the plain comparable
// value (not the rendered HTML, e.g. Company Name's own `cell` is a link);
// `filter` reads the same plain value for the per-column filter inputs
// below, which do a simple case-insensitive substring match (not the
// */wildcard syntax the search boxes above use -- this is a live, as-you-
// type narrowing of what's already on screen, not a new server request).
function addressLine(c) {
  return [c.addressLine, c.addressLine1, c.city].filter(Boolean).join(', ');
}
const COLUMNS = [
  { key: 'companyName', label: 'Company Name', sort: (c) => c.companyName || '', filter: (c) => c.companyName || '' },
  { key: 'firstName', label: 'First Name', sort: (c) => c.firstName || '', filter: (c) => c.firstName || '' },
  { key: 'lastName', label: 'Last Name', sort: (c) => c.lastName || '', filter: (c) => c.lastName || '' },
  { key: 'email', label: 'Email', sort: (c) => c.email || '', filter: (c) => c.email || '' },
  { key: 'phone', label: 'Phone', sort: (c) => c.phone || '', filter: (c) => c.phone || '', className: 'ticket-number' },
  { key: 'mobilePhone', label: 'Mobile', sort: (c) => c.mobilePhone || '', filter: (c) => c.mobilePhone || '', className: 'ticket-number' },
  { key: 'address', label: 'Address', sort: (c) => addressLine(c), filter: (c) => addressLine(c) },
];

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>Contact Search</h1>
      <form id="filter-form" class="date-form date-form--stacked">
        <div class="date-form-row">
          <label for="name-input">Name</label>
          <input type="text" id="name-input" name="name" placeholder="e.g. Smith* or *Smith* (First or Last Name)" />
          <label for="phone-input">Phone</label>
          <input type="text" id="phone-input" name="phone" placeholder="e.g. 0412* (any phone field)" />
        </div>
        <div class="date-form-row">
          <label for="address-input">Address</label>
          <input type="text" id="address-input" name="address" placeholder="e.g. *Smith Street* or a suburb" />
          <label for="email-input">Email</label>
          <input type="text" id="email-input" name="email" placeholder="e.g. *acme.com.au (domain works too)" />
        </div>
        <div class="date-form-row">
          <label class="inline-checkbox-label" title="Also include close-but-not-exact matches (typos, formatting differences) that a plain wildcard search would miss entirely -- in addition to, not instead of, the normal wildcard results above.">
            <input type="checkbox" id="fuzzy-input" /> Fuzzy Search
          </label>
          <label class="inline-checkbox-label" title="Leave out any contact that's marked Inactive, and any contact whose own company is marked Inactive.">
            <input type="checkbox" id="active-only-input" /> Ignore Inactive Contacts and Clients
          </label>
          <button type="submit" id="search-button" class="button-link button-link--small refresh-button--emphasis">Search</button>
          <button type="button" id="export-button" class="button-link button-link--small">Export CSV</button>
        </div>
      </form>
    </header>
    <p id="status" class="status">Enter at least one of Name / Phone / Address / Email (wildcards with *), then click Search.</p>
    <div id="summary" class="summary" hidden></div>
    <div id="results" class="results"></div>
  `;

  const form = container.querySelector('#filter-form');
  const nameInput = container.querySelector('#name-input');
  const phoneInput = container.querySelector('#phone-input');
  const addressInput = container.querySelector('#address-input');
  const emailInput = container.querySelector('#email-input');
  const fuzzyInput = container.querySelector('#fuzzy-input');
  const activeOnlyInput = container.querySelector('#active-only-input');
  const searchButton = container.querySelector('#search-button');
  const exportButton = container.querySelector('#export-button');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const resultsEl = container.querySelector('#results');

  if (lastQuery) {
    nameInput.value = lastQuery.name;
    phoneInput.value = lastQuery.phone;
    addressInput.value = lastQuery.address;
    emailInput.value = lastQuery.email;
    fuzzyInput.checked = lastQuery.fuzzy;
    activeOnlyInput.checked = lastQuery.activeOnly;
  }

  activeRender = render;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    load(nameInput.value, phoneInput.value, addressInput.value, emailInput.value, fuzzyInput.checked, activeOnlyInput.checked);
  });

  async function load(name, phone, address, email, fuzzy, activeOnly) {
    if (!name && !phone && !address && !email) {
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.textContent = 'Enter at least one of Name / Phone / Address / Email to search.';
      return;
    }
    searchButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    summaryEl.hidden = true;
    resultsEl.innerHTML = '';

    try {
      const params = new URLSearchParams();
      if (name) params.set('name', name);
      if (phone) params.set('phone', phone);
      if (address) params.set('address', address);
      if (email) params.set('email', email);
      if (fuzzy) params.set('fuzzy', 'true');
      if (activeOnly) params.set('activeOnly', 'true');
      const res = await fetch(`/api/contact-search?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastQuery = { name, phone, address, email, fuzzy, activeOnly };
      lastData = data;
      activeRender(data);
    } catch (err) {
      statusEl.hidden = false;
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
    downloadCsv(lastData.contacts);
  });

  const CSV_COLUMNS = [
    { header: 'Company Name', value: (c) => c.companyName },
    { header: 'First Name', value: (c) => c.firstName },
    { header: 'Last Name', value: (c) => c.lastName },
    { header: 'Email', value: (c) => c.email },
    { header: 'Phone', value: (c) => c.phone },
    { header: 'Mobile', value: (c) => c.mobilePhone },
    { header: 'Alternate Phone', value: (c) => c.alternatePhone },
    { header: 'Address', value: (c) => addressLine(c) },
    { header: 'Active', value: (c) => (c.isActive ? 'Yes' : 'No') },
  ];

  function csvField(value) {
    const str = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  }

  function downloadCsv(contacts) {
    const lines = [CSV_COLUMNS.map((col) => csvField(col.header)).join(',')];
    for (const c of contacts) {
      lines.push(CSV_COLUMNS.map((col) => csvField(col.value(c))).join(','));
    }
    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const today = new Date().toISOString().slice(0, 10);
    const a = document.createElement('a');
    a.href = url;
    a.download = `contact-search-${today}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function render(data) {
    statusEl.hidden = true;

    summaryEl.hidden = false;
    const filters = [];
    if (data.name) filters.push(`Name "${escapeHtml(data.name)}"`);
    if (data.phone) filters.push(`Phone "${escapeHtml(data.phone)}"`);
    if (data.address) filters.push(`Address "${escapeHtml(data.address)}"`);
    if (data.email) filters.push(`Email "${escapeHtml(data.email)}"`);
    const filterLabel = filters.length ? ` matching ${filters.join(' and ')}` : '';
    const fuzzyLabel = data.fuzzy ? ' (including fuzzy matches)' : '';
    const activeOnlyLabel = data.activeOnly ? ' (active contacts/clients only)' : '';
    summaryEl.innerHTML = `<strong>${data.totalCount}</strong> contact${data.totalCount === 1 ? '' : 's'}${filterLabel}${fuzzyLabel}${activeOnlyLabel}`;

    if (data.totalCount === 0) {
      resultsEl.innerHTML = '<p class="status">No matching contacts.</p>';
      return;
    }

    // Per-column filter text, by request ("sort and filter options on all
    // columns") -- reset on every new search, same lifetime as the
    // results themselves; a plain case-insensitive substring match
    // against that column's own `filter` value, ANDed across every
    // column with something typed into it.
    const columnFilters = {};

    const groupEl = document.createElement('div');
    groupEl.className = 'resource-group';
    const table = document.createElement('table');
    // Header built ONCE, not regenerated on every sort click/filter
    // keystroke -- only <tbody> below ever gets replaced. Rebuilding the
    // whole <thead> on every keystroke would destroy and recreate the
    // filter <input>s themselves, dropping focus after every single
    // character typed (confirmed the hard way the first version of this
    // tried exactly that).
    table.innerHTML = `
      <thead>
        <tr>${COLUMNS.map((col) => `<th><button type="button" class="cs-sort-btn" data-sort-key="${col.key}">${escapeHtml(col.label)}</button></th>`).join('')}</tr>
        <tr>${COLUMNS.map((col) => `<th><input type="text" class="cs-column-filter-input" data-filter-key="${col.key}" placeholder="Filter..." /></th>`).join('')}</tr>
      </thead>
      <tbody></tbody>
    `;
    groupEl.appendChild(table);
    resultsEl.innerHTML = '';
    resultsEl.appendChild(groupEl);

    const tbody = table.querySelector('tbody');
    const sortButtons = [...table.querySelectorAll('.cs-sort-btn')];

    function updateSortButtonStyles() {
      for (const btn of sortButtons) {
        const col = COLUMNS.find((c) => c.key === btn.dataset.sortKey);
        const isActive = sortState.key === col.key;
        const arrow = isActive ? (sortState.direction === 'asc' ? ' ▲' : ' ▼') : '';
        btn.textContent = `${col.label}${arrow}`;
        btn.classList.toggle('cs-sort-btn--active', isActive);
      }
    }

    function renderRows() {
      const sortCol = COLUMNS.find((c) => c.key === sortState.key);
      const visibleRows = data.contacts
        .filter((c) => COLUMNS.every((col) => !columnFilters[col.key] || col.filter(c).toLowerCase().includes(columnFilters[col.key])))
        .sort((a, b) => {
          const cmp = String(sortCol.sort(a)).localeCompare(String(sortCol.sort(b)), undefined, { numeric: true, sensitivity: 'base' });
          return sortState.direction === 'asc' ? cmp : -cmp;
        });

      if (visibleRows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="${COLUMNS.length}"><p class="status">No rows match the current column filters.</p></td></tr>`;
        return;
      }

      // Inactive contacts are included by design (see server.js's own
      // comment -- this is a lookup tool, not an "active clients"
      // report), flagged with the same light-red "needs a second look"
      // shading Client Details' own "Any Client" view already uses for
      // an inactive row mixed in among active ones.
      tbody.innerHTML = visibleRows
        .map(
          (c) => `
        <tr${c.isActive ? '' : ' class="row-no-next-period"'} title="${c.isActive ? '' : 'Inactive contact'}">
          <td>${companyLink(c)}</td>
          <td>${escapeHtml(c.firstName)}</td>
          <td>${escapeHtml(c.lastName)}</td>
          <td>${escapeHtml(c.email)}</td>
          <td class="ticket-number">${escapeHtml(c.phone)}</td>
          <td class="ticket-number">${escapeHtml(c.mobilePhone)}</td>
          <td>${escapeHtml(addressLine(c))}</td>
        </tr>`
        )
        .join('');
    }

    for (const btn of sortButtons) {
      btn.addEventListener('click', () => {
        const key = btn.dataset.sortKey;
        sortState = { key, direction: sortState.key === key && sortState.direction === 'asc' ? 'desc' : 'asc' };
        updateSortButtonStyles();
        renderRows();
      });
    }
    table.querySelectorAll('.cs-column-filter-input').forEach((input) => {
      input.addEventListener('input', () => {
        columnFilters[input.dataset.filterKey] = input.value.trim().toLowerCase();
        renderRows();
      });
    });

    updateSortButtonStyles();
    renderRows();
  }

  if (lastData) render(lastData);

  function companyLink(c) {
    const label = escapeHtml(c.companyName || '(no company)');
    if (!c.companyUrl) return label;
    // Real popup window, not just a new tab -- same convention every other
    // Autotask/IT Glue link on this dashboard uses.
    return `<a href="${escapeHtml(c.companyUrl)}" target="_blank" rel="noopener noreferrer" onclick="window.open(this.href, '_blank', 'noopener,noreferrer,width=1200,height=900'); return false;">${label}</a>`;
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
