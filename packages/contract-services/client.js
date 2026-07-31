export const id = "contract-services";
export const label = "Contract Services";

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>Contract Services</h1>
      <form id="filter-form" class="date-form">
        <label for="search-input">Service name</label>
        <input type="text" id="search-input" name="search" placeholder="e.g. Backup* or *Email*" />
        <label for="month-input">Month</label>
        <input type="month" id="month-input" name="month" required />
        <button type="submit">Search</button>
      </form>
    </header>
    <p id="status" class="status">Enter a service name (wildcards with *) and pick a month, then click Search.</p>
    <div id="summary" class="summary" hidden></div>
    <div id="results" class="results"></div>
  `;

  const form = container.querySelector('#filter-form');
  const searchInput = container.querySelector('#search-input');
  const monthInput = container.querySelector('#month-input');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const resultsEl = container.querySelector('#results');

  function currentMonthISO() {
    const now = new Date();
    const offset = now.getTimezoneOffset();
    const local = new Date(now.getTime() - offset * 60000);
    return local.toISOString().slice(0, 7);
  }
  monthInput.value = currentMonthISO();

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    load(monthInput.value, searchInput.value);
  });

  async function load(month, search) {
    const button = form.querySelector('button');
    button.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = `Loading services active in ${formatMonth(month)}...`;
    summaryEl.hidden = true;
    resultsEl.innerHTML = '';

    try {
      const params = new URLSearchParams({ month });
      if (search) params.set('search', search);
      const res = await fetch(`/api/contract-services?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      render(data);
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      button.disabled = false;
    }
  }

  function render(data) {
    statusEl.hidden = true;

    summaryEl.hidden = false;
    const searchLabel = data.search ? ` matching "${escapeHtml(data.search)}"` : '';
    summaryEl.innerHTML = `<strong>${data.totalCount}</strong> service item${data.totalCount === 1 ? '' : 's'} active in ${formatMonth(data.month)}${searchLabel} (active contracts only)`;

    if (data.totalCount === 0) {
      resultsEl.innerHTML = '<p class="status">No matching service items.</p>';
      return;
    }

    resultsEl.innerHTML = '';
    for (const group of data.byCompany) {
      const groupEl = document.createElement('div');
      groupEl.className = 'resource-group';

      const header = document.createElement('div');
      header.className = 'resource-group-header';
      header.innerHTML = `<span>${escapeHtml(group.companyName)}</span><span class="count">${group.count} item${group.count === 1 ? '' : 's'}</span>`;
      groupEl.appendChild(header);

      const table = document.createElement('table');
      table.innerHTML = `
        <thead>
          <tr><th>Service</th><th>Contract</th><th>Units</th><th>Price</th><th>Period</th><th>Last Changed</th></tr>
        </thead>
        <tbody>
          ${group.rows
            .map(
              (r) => `
            <tr>
              <td>${escapeHtml(r.serviceName)}</td>
              <td>${escapeHtml(r.contractName)}</td>
              <td class="ticket-number">${escapeHtml(r.units)}</td>
              <td class="ticket-number">${formatPrice(r.price)}</td>
              <td class="ticket-number">${formatDate(r.startDate)} - ${formatDate(r.endDate)}</td>
              <td class="ticket-number${isRecentChange(r.contractLastModified) ? ' cell-flag-red' : ''}" title="Contract's last-modified date -- the service unit itself has no modification timestamp">${formatDate(r.contractLastModified)}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      `;
      groupEl.appendChild(table);
      resultsEl.appendChild(groupEl);
    }
  }

  function formatMonth(month) {
    if (!month) return '';
    const [y, m] = month.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }

  function formatDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString();
  }

  function isRecentChange(iso) {
    if (!iso) return false;
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    return new Date(iso) >= thirtyDaysAgo;
  }

  function formatPrice(value) {
    if (value === null || value === undefined) return '';
    return '$' + Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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