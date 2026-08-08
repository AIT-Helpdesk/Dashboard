export const id = "csp-customers";
export const label = "CSP Customers";

// Module-scope, not inside mount() -- the shell fully tears down and re-mounts a
// page's DOM on every navigation away and back, but the dynamically-imported
// module itself is cached by the browser and stays alive for the session, so a
// module-level variable survives across re-mounts and lets the last result
// restore instantly instead of coming back blank.
let lastData = null;
let lastFilter = '';

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>CSP Customers</h1>
      <div class="date-form">
        <label for="filter-input">Filter</label>
        <input type="text" id="filter-input" placeholder="type to filter by name..." />
        <button type="button" id="refresh-button">Refresh</button>
      </div>
    </header>
    <p id="status" class="status">Loading...</p>
    <div id="summary" class="summary" hidden></div>
    <div id="results" class="results"></div>
  `;

  const filterInput = container.querySelector('#filter-input');
  const refreshButton = container.querySelector('#refresh-button');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const resultsEl = container.querySelector('#results');

  filterInput.value = lastFilter;

  // The whole list is already in memory client-side (it's cheap to fetch in
  // full -- unlike Ingram Subscriptions, there's no per-row expensive lookup
  // to avoid), so filtering as you type is instant and needs no round trip,
  // unlike the "type a filter, click a button" pattern used elsewhere on
  // this dashboard for genuinely expensive searches.
  filterInput.addEventListener('input', () => {
    lastFilter = filterInput.value;
    if (lastData) renderResults(lastData.customers);
  });

  refreshButton.addEventListener('click', () => load(true));

  async function load(force) {
    refreshButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    summaryEl.hidden = true;
    resultsEl.innerHTML = '';

    try {
      const res = await fetch(`/api/csp-customers${force ? '?force=true' : ''}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastData = data;
      render(data);
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      refreshButton.disabled = false;
    }
  }

  function render(data) {
    statusEl.hidden = true;
    summaryEl.hidden = false;
    summaryEl.innerHTML = `<strong>${data.totalCount}</strong> customers<span class="inline-subtext"> -- as of ${formatDateTime(data.asOf)}</span>`;
    renderResults(data.customers);
  }

  function renderResults(customers) {
    const term = lastFilter.trim().toLowerCase();
    const filtered = term ? customers.filter((c) => c.name.toLowerCase().includes(term)) : customers;

    resultsEl.innerHTML = '';
    if (filtered.length === 0) {
      resultsEl.innerHTML = '<p class="status">No matching customers.</p>';
      return;
    }

    const group = document.createElement('div');
    group.className = 'resource-group';
    group.innerHTML = `
      <table>
        <thead>
          <tr class="shaded-row"><th>Customer</th><th>Tenant ID</th><th>Domain</th></tr>
        </thead>
        <tbody>
          ${filtered
            .map(
              (c) => `
            <tr>
              <td>${escapeHtml(c.name)}</td>
              <td class="ticket-number">${escapeHtml(c.tenantId)}</td>
              <td>${escapeHtml(c.domain)}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    `;
    resultsEl.appendChild(group);
  }

  if (lastData) render(lastData);
  else load(false);

  function formatDateTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString();
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
