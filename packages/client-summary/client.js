export const id = "client-summary";
export const label = "Client Summary";

// Module-scope, not inside mount() -- the shell fully tears down and re-mounts a
// page's DOM on every navigation away and back, but the dynamically-imported
// module itself is cached by the browser and stays alive for the session, so a
// module-level variable survives across re-mounts and lets the last result
// restore instantly instead of coming back blank.
let lastQuery = null; // { client }
let lastData = null;

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>Client Summary</h1>
      <form id="filter-form" class="date-form">
        <label for="client-input">Client</label>
        <input type="text" id="client-input" name="client" placeholder="e.g. Cloud King Hosting" required />
        <button type="submit" id="search-button">Search</button>
      </form>
    </header>
    <p id="status" class="status">Type a client name (wildcards with *) and click Search. This is a single-client, at-a-glance summary, so a wildcard must match exactly one company.</p>
    <div id="results" class="results"></div>
  `;

  const form = container.querySelector('#filter-form');
  const clientInput = container.querySelector('#client-input');
  const searchButton = container.querySelector('#search-button');
  const statusEl = container.querySelector('#status');
  const resultsEl = container.querySelector('#results');

  if (lastQuery) clientInput.value = lastQuery.client;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    load(clientInput.value);
  });

  async function load(clientName, companyId) {
    searchButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    resultsEl.innerHTML = '';

    try {
      const params = new URLSearchParams({ client: clientName });
      if (companyId) params.set('companyId', companyId);
      const res = await fetch(`/api/client-summary?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastQuery = { client: clientName };
      lastData = data;
      if (data.status === 'ok') clientInput.value = data.companyName;
      render(data);
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      searchButton.disabled = false;
    }
  }

  function render(data) {
    if (data.status === 'not-found') {
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.textContent = `No client found matching "${data.client}".`;
      resultsEl.innerHTML = '';
      return;
    }
    if (data.status === 'ambiguous') {
      statusEl.hidden = false;
      statusEl.className = 'status';
      statusEl.textContent = `"${data.client}" matched ${data.matches.length} clients -- pick one:`;
      resultsEl.innerHTML = '';

      const list = document.createElement('div');
      list.className = 'resource-group';
      list.innerHTML = `
        <table>
          <tbody>
            ${data.matches
              .map((m) => `<tr><td><button type="button" class="link-button" data-company-id="${m.id}">${escapeHtml(m.companyName)}</button></td></tr>`)
              .join('')}
          </tbody>
        </table>
      `;
      list.querySelectorAll('button[data-company-id]').forEach((btn) => {
        btn.addEventListener('click', () => load(data.client, btn.dataset.companyId));
      });
      resultsEl.appendChild(list);
      return;
    }

    statusEl.hidden = true;
    resultsEl.innerHTML = '';

    resultsEl.appendChild(renderHeader(data));
    resultsEl.appendChild(renderFinancialSnapshot(data.financialSnapshot));
    resultsEl.appendChild(renderActiveContracts(data.activeContracts));
    resultsEl.appendChild(renderRecentTickets(data.recentTickets));
    resultsEl.appendChild(renderSecurityAlerts(data.securityAlerts));
  }

  // --- Company details header --------------------------------------------
  function renderHeader(data) {
    const wrap = document.createElement('div');
    wrap.className = 'resource-group';

    const addressParts = [data.address.line1, data.address.line2, [data.address.city, data.address.state, data.address.postalCode].filter(Boolean).join(' ')].filter(Boolean);
    const addressHtml = addressParts.length ? escapeHtml(addressParts.join(', ')) : '<span class="muted">--</span>';

    const activeBadge = data.isActive
      ? '<span class="cell-flag-green">Active</span>'
      : '<span class="cell-flag-red">Inactive</span>';

    const udfRows = data.contactUdfs
      .map((u) => `<div><span class="muted">${escapeHtml(u.name)}:</span> ${u.value ? escapeHtml(u.value) : '<span class="muted">--</span>'}</div>`)
      .join('');

    wrap.innerHTML = `
      <div class="resource-group-header">
        <span><strong>${companyLink(data)}</strong> ${activeBadge}${data.classification ? ` -- ${escapeHtml(data.classification)}` : ''}</span>
      </div>
      <div class="client-summary-header-grid">
        <div>
          <div><span class="muted">Address:</span> ${addressHtml}</div>
          <div><span class="muted">Phone:</span> ${data.phone ? escapeHtml(data.phone) : '<span class="muted">--</span>'}</div>
        </div>
        <div>
          <div><span class="muted">Primary Contact:</span> ${contactHtml(data.primaryContact)}</div>
          <div><span class="muted">Main Billing Contact:</span> ${contactHtml(data.billingContact)}</div>
        </div>
        <div>
          ${udfRows}
        </div>
      </div>
    `;
    return wrap;
  }

  function contactHtml(contact) {
    if (!contact || !contact.name) return '<span class="muted">--</span>';
    const parts = [escapeHtml(contact.name)];
    if (contact.email) parts.push(`(${escapeHtml(contact.email)})`);
    return parts.join(' ');
  }

  // --- Financial snapshot --------------------------------------------------
  function renderFinancialSnapshot(snap) {
    const section = document.createElement('div');
    section.innerHTML = `<h2 class="client-summary-section-heading">Financial Snapshot <span class="inline-subtext">-- last 12 months</span></h2>`;

    const wrap = document.createElement('div');
    wrap.className = 'resource-group';
    const t = snap.twelveMonthTotals;
    wrap.innerHTML = `
      <table>
        <thead>
          <tr class="shaded-row"><th>Category</th><th class="ticket-number">12-Month Total</th></tr>
        </thead>
        <tbody>
          <tr><td>Labour</td><td class="ticket-number">${formatPrice(t.labour)}</td></tr>
          <tr><td>Labour in Charges</td><td class="ticket-number">${formatPrice(t.chargesLabour)}</td></tr>
          <tr><td>Other Charges</td><td class="ticket-number">${formatPrice(t.chargesOther)}</td></tr>
          <tr><td>Recurring Services</td><td class="ticket-number">${formatPrice(t.recurringOther)}</td></tr>
          <tr><td>Tech Cover</td><td class="ticket-number">${formatPrice(t.recurringTechCover)}</td></tr>
          <tr class="shaded-row" style="font-weight: 600; border-top: 2px solid var(--border);"><td>Total</td><td class="ticket-number">${formatPrice(t.total)}</td></tr>
        </tbody>
      </table>
      <p class="inline-subtext" style="margin: 0.5rem 0 0;">
        ${snap.mostRecentInvoice
          ? `Most recent invoice: ${invoiceLink(snap.mostRecentInvoice)} on ${formatDate(snap.mostRecentInvoice.invoiceDate)} (${formatPrice(snap.mostRecentInvoice.total)})`
          : 'No invoices in the last 12 months.'}
      </p>
    `;
    section.appendChild(wrap);
    return section;
  }

  // --- Active contracts ------------------------------------------------
  function renderActiveContracts(contracts) {
    const section = document.createElement('div');
    section.innerHTML = `<h2 class="client-summary-section-heading">Active Contracts <span class="inline-subtext">(${contracts.length})</span></h2>`;

    if (contracts.length === 0) {
      section.insertAdjacentHTML('beforeend', '<p class="status">No active contracts.</p>');
      return section;
    }

    const wrap = document.createElement('div');
    wrap.className = 'resource-group';
    wrap.innerHTML = `
      <table>
        <thead><tr><th>Contract</th><th>Type</th><th>Start</th><th>End</th></tr></thead>
        <tbody>
          ${contracts
            .map(
              (c) => `
            <tr>
              <td>${contractLink(c)}</td>
              <td>${escapeHtml(c.contractType)}</td>
              <td class="ticket-number">${formatDate(c.startDate)}</td>
              <td class="ticket-number">${formatDate(c.endDate)}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    `;
    section.appendChild(wrap);
    return section;
  }

  // --- Recent ticket activity ------------------------------------------
  function renderRecentTickets(tickets) {
    const section = document.createElement('div');
    section.innerHTML = `<h2 class="client-summary-section-heading">Recent Ticket Activity <span class="inline-subtext">(${tickets.openCount} open)</span></h2>`;

    if (tickets.recent.length === 0) {
      section.insertAdjacentHTML('beforeend', '<p class="status">No open tickets.</p>');
      return section;
    }

    const wrap = document.createElement('div');
    wrap.className = 'resource-group';
    wrap.innerHTML = `
      <table>
        <thead><tr><th>Ticket #</th><th>Title</th><th>Status</th><th>Last Activity</th></tr></thead>
        <tbody>
          ${tickets.recent
            .map(
              (t) => `
            <tr>
              <td class="ticket-number">${ticketLink(t)}</td>
              <td>${escapeHtml(t.title)}</td>
              <td>${escapeHtml(t.status)}</td>
              <td class="ticket-number">${formatDateTime(t.lastActivityDate)}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
      ${tickets.openCount > tickets.recent.length ? `<p class="inline-subtext" style="margin: 0.5rem 0 0;">Showing the ${tickets.recent.length} most recently active of ${tickets.openCount} open tickets.</p>` : ''}
    `;
    section.appendChild(wrap);
    return section;
  }

  // --- Security Alerts (1 month) ------------------------------------------
  function renderSecurityAlerts(alerts) {
    const section = document.createElement('div');
    section.innerHTML = `<h2 class="client-summary-section-heading">Security Alerts <span class="inline-subtext">-- last 1 month</span></h2>`;

    if (!alerts.monitored) {
      section.insertAdjacentHTML('beforeend', '<p class="status">This client isn\'t mapped to a SaaS Alerts customer.</p>');
      return section;
    }

    const wrap = document.createElement('div');
    wrap.className = 'resource-group';
    if (alerts.totalCount === 0) {
      wrap.innerHTML = `<p class="status" style="margin: 0.75rem;">No medium/critical alerts from ${formatDate(alerts.periodStart)} to ${formatDate(alerts.periodEnd)}.</p>`;
      section.appendChild(wrap);
      return section;
    }

    wrap.innerHTML = `
      <div class="resource-group-header">
        <span><strong>${alerts.totalCount}</strong> alert${alerts.totalCount === 1 ? '' : 's'} (<span class="cell-flag-red">${alerts.criticalCount} critical</span>, <span class="cell-flag-blue">${alerts.mediumCount} medium</span>) from ${formatDate(alerts.periodStart)} to ${formatDate(alerts.periodEnd)}</span>
      </div>
      <table>
        <thead><tr><th>Alert</th><th class="ticket-number">Count</th></tr></thead>
        <tbody>
          ${alerts.topEvents.map((e) => `<tr><td>${escapeHtml(e.name)}</td><td class="ticket-number">${e.count}</td></tr>`).join('')}
        </tbody>
      </table>
    `;
    section.appendChild(wrap);
    return section;
  }

  if (lastData) render(lastData);

  function companyLink(data) {
    const label = escapeHtml(data.companyName);
    if (!data.companyUrl) return label;
    return `<a href="${escapeHtml(data.companyUrl)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  }

  function contractLink(c) {
    const label = escapeHtml(c.contractName);
    if (!c.contractUrl) return label;
    return `<a href="${escapeHtml(c.contractUrl)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  }

  function invoiceLink(inv) {
    const label = escapeHtml(inv.invoiceNumber || `#${inv.id}`);
    if (!inv.invoiceUrl) return label;
    // A real popup window, not just a new tab -- same pattern as Client
    // Financials' invoice links.
    return `<a href="${escapeHtml(inv.invoiceUrl)}" target="_blank" rel="noopener noreferrer" onclick="window.open(this.href, '_blank', 'noopener,noreferrer,width=1000,height=800'); return false;">${label}</a>`;
  }

  function ticketLink(t) {
    const label = escapeHtml(t.ticketNumber);
    if (!t.ticketUrl) return label;
    return `<a href="${escapeHtml(t.ticketUrl)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  }

  function formatDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString();
  }

  function formatDateTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString();
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
