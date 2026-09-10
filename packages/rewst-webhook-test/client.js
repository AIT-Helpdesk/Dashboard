export const id = "rewst-webhook-test";
export const label = "Rewst Webhook Test";

// Module-scope, not inside mount() -- same "survives across remounts,
// re-fetching a remote workflow's own data on every navigation would be
// wasteful" reasoning every other page on this dashboard already uses.
let lastData = null;

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>Rewst Webhook Test</h1>
    </header>
    <p class="status">Calls a real Rewst workflow (via its webhook trigger) and shows the CSP customer data it returns.</p>
    <div class="date-form-row">
      <button type="button" id="load-button">Load</button>
      <input type="text" id="search-input" placeholder="Filter by company name..." />
    </div>
    <p id="status" class="status" hidden></p>
    <div id="results"></div>
  `;

  const loadButton = container.querySelector('#load-button');
  const searchInput = container.querySelector('#search-input');
  const statusEl = container.querySelector('#status');
  const resultsEl = container.querySelector('#results');

  loadButton.addEventListener('click', load);
  searchInput.addEventListener('input', () => {
    if (lastData) render(lastData);
  });

  if (lastData) render(lastData);
  else load();

  async function load() {
    loadButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Calling Rewst...';
    resultsEl.innerHTML = '';

    try {
      const res = await fetch('/api/rewst-webhook-test');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastData = data;
      render(data);
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      loadButton.disabled = false;
    }
  }

  function render(data) {
    const customers = Array.isArray(data.Customers) ? data.Customers : [];
    if (customers.length === 0) {
      statusEl.hidden = false;
      statusEl.className = 'status';
      statusEl.textContent = 'No customers returned.';
      resultsEl.innerHTML = '';
      return;
    }

    const search = searchInput.value.trim().toLowerCase();
    const filtered = search ? customers.filter((c) => (c.company_name || '').toLowerCase().includes(search)) : customers;

    const withConsent = customers.filter((c) => c.has_consent).length;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = `${customers.length} real customers (${withConsent} with consent, ${customers.length - withConsent} without)${search ? ` -- ${filtered.length} matching "${search}"` : ''}`;

    resultsEl.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Company Name</th>
            <th class="col-center">Consent</th>
            <th>Tenant ID</th>
            <th>CSP Tenant ID</th>
            <th>Linked Organizations</th>
            <th>Rewst Customer ID</th>
          </tr>
        </thead>
        <tbody>
          ${filtered.map(rowHtml).join('')}
        </tbody>
      </table>
    `;
  }

  function rowHtml(c) {
    const linkedOrgs = Array.isArray(c.linked_organizations) ? c.linked_organizations.map((o) => o.name).join(', ') : '';
    return `
      <tr>
        <td>${escapeHtml(c.company_name)}</td>
        <td class="col-center">${c.has_consent ? 'Yes' : 'No'}</td>
        <td>${escapeHtml(c.tenant_id)}</td>
        <td>${escapeHtml(c.csp_tenant_id)}</td>
        <td>${escapeHtml(linkedOrgs)}</td>
        <td>${escapeHtml(c.id)}</td>
      </tr>
    `;
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
