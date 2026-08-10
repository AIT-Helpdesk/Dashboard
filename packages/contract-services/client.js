export const id = "contract-services";
export const label = "Contract Services";

// Module-scope, not inside mount() -- the shell fully tears down and re-mounts a
// page's DOM on every navigation away and back (no auto-load on this page means
// that would otherwise lose whatever was on screen), but the dynamically-imported
// module itself is cached by the browser and stays alive for the session, so a
// module-level variable survives across re-mounts and lets the last search
// restore instantly instead of coming back blank.
let lastQuery = null; // { month, search, client }
let lastData = null;

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>Contract Services</h1>
      <form id="filter-form" class="date-form">
        <label for="client-input">Client</label>
        <input type="text" id="client-input" name="client" placeholder="e.g. Cloud* or *IT*" />
        <label for="search-input">Service name</label>
        <input type="text" id="search-input" name="search" placeholder="e.g. Backup* or *Email*" />
        <label for="month-input">Month</label>
        <input type="month" id="month-input" name="month" required />
        <button type="submit">Search</button>
      </form>
    </header>
    <p id="status" class="status">Optionally filter by client and/or service name (wildcards with *), pick a month, then click Search.</p>
    <div id="summary" class="summary" hidden></div>
    <div id="results" class="results"></div>
  `;

  const form = container.querySelector('#filter-form');
  const clientInput = container.querySelector('#client-input');
  const searchInput = container.querySelector('#search-input');
  const monthInput = container.querySelector('#month-input');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const resultsEl = container.querySelector('#results');

  // AEST (UTC+10, no DST in Queensland) "this month", not the browser's own
  // local timezone -- computed explicitly so the month picker defaults to
  // the business's calendar month regardless of where the browser happens
  // to be.
  function currentMonthISO() {
    return new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString().slice(0, 7);
  }
  monthInput.value = currentMonthISO();

  if (lastQuery) {
    monthInput.value = lastQuery.month;
    searchInput.value = lastQuery.search;
    clientInput.value = lastQuery.client;
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    load(monthInput.value, searchInput.value, clientInput.value);
  });

  async function load(month, search, clientName) {
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
      if (clientName) params.set('client', clientName);
      const res = await fetch(`/api/contract-services?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastQuery = { month, search, client: clientName };
      lastData = data;
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
    const clientLabel = data.client ? ` for client "${escapeHtml(data.client)}"` : '';
    summaryEl.innerHTML = `<strong>${data.totalCount}</strong> service item${data.totalCount === 1 ? '' : 's'} active in ${formatMonth(data.month)}${searchLabel}${clientLabel} (active contracts only)`;

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
      table.className = 'contract-services-table';
      table.innerHTML = `
        <thead>
          <tr><th>Service</th><th>Contract</th><th title="Bracketed figure is the unit count for the 1st of next month, where already known">Units</th><th>Cost</th><th>Sell</th><th>Total</th><th>Period</th><th>Last Changed</th></tr>
        </thead>
        <tbody>
          ${group.rows
            .map(
              (r) => `
            <tr${rowClass(r)}>
              <td><div class="col-service">${formatServiceName(r.serviceName)}${r.internalDescription ? `<span class="cell-subtext">${escapeHtml(r.internalDescription)}</span>` : ''}</div></td>
              <td>${contractLink(r)}</td>
              <td class="ticket-number">${unitsCell(r)}</td>
              <td class="ticket-number">${formatPrice(perItem(r.cost, r.units))}</td>
              <td class="ticket-number">${formatPrice(perItem(r.price, r.units))}</td>
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

  if (lastData) render(lastData);

  // Telco service descriptions often end with an AVC (Access Virtual Circuit)
  // reference code glued on with no natural wrap point of its own -- force it
  // onto its own line rather than letting it stretch the column.
  function formatServiceName(name) {
    // The negative lookahead only lets the match succeed when no further AVC
    // code follows, so only the last occurrence gets the line break.
    return escapeHtml(name).replace(/\s+(AVC\d+)(?!.*AVC\d+)/i, '<br>$1');
  }

  function rowClass(r) {
    if (r.nextPeriodUnits === null) return ' class="row-no-next-period"';
    if (r.nextPeriodUnits !== r.units) return ' class="row-units-changed"';
    return '';
  }

  function unitsCell(r) {
    const current = escapeHtml(r.units);
    if (r.nextPeriodUnits === null) return current;
    const changeClass =
      r.nextPeriodUnits < r.units ? ' cell-flag-red' : r.nextPeriodUnits > r.units ? ' cell-flag-green' : '';
    return `${current} <span class="inline-subtext${changeClass}">(${escapeHtml(r.nextPeriodUnits)})</span>`;
  }

  function contractLink(r) {
    const label = escapeHtml(r.contractName);
    if (!r.contractUrl) return label;
    return `<a href="${escapeHtml(r.contractUrl)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  }

  function formatMonth(month) {
    if (!month) return '';
    const [y, m] = month.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'Australia/Brisbane' });
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

  // ContractServiceUnits' price/cost are totals for the full unit quantity in that
  // period, not a per-item rate -- divide by units to get the per-item figure.
  function perItem(total, units) {
    if (total === null || total === undefined || !units) return total;
    return total / units;
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