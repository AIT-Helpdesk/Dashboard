export const id = "coming-soon";
export const label = "Coming Soon";

// Module-scope, not inside mount() -- same "survives a shell re-mount"
// convention every other page's client.js already uses (see
// @dashboard/subscriptions-expiring/client.js's own comment for the full
// reasoning).
let lastSection = 'domains';
let lastWindow = '30';
let lastDataBySection = { domains: null, licensing: null, all: null };
let activeRender = null;

const WINDOW_OPTIONS = [
  { value: '7', label: '7 days' },
  { value: '14', label: '14 days' },
  { value: '30', label: '30 days' },
  { value: '60', label: '60 days' },
  { value: 'expired-recently', label: 'Expired Recently' },
];

// "Show All" sits first so it reads as the obvious default rather than a
// bolted-on extra option -- picking it just runs every other choice in this
// same dropdown (Domains + Microsoft Licensing) and renders both sections
// stacked on one page, instead of making the reader flip the dropdown back
// and forth between them.
const SECTION_OPTIONS = [
  { value: 'all', label: 'Show All' },
  { value: 'domains', label: 'Domains' },
  { value: 'licensing', label: 'Microsoft Licensing' },
];

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>Coming Soon</h1>
      <form id="filter-form" class="date-form">
        <label for="section-input">Section</label>
        <select id="section-input" name="section">
          ${SECTION_OPTIONS.map((o) => `<option value="${o.value}">${o.label}</option>`).join('')}
        </select>
        <label for="window-input">Window</label>
        <select id="window-input" name="window">
          ${WINDOW_OPTIONS.map((o) => `<option value="${o.value}">${o.label}</option>`).join('')}
        </select>
        <button type="submit" id="load-button">Load</button>
      </form>
    </header>
    <p id="status" class="status">Pick a section and window (default: 30 days), then click Load.</p>
    <div id="summary" class="summary" hidden></div>
    <div id="results" class="results"></div>
  `;

  const form = container.querySelector('#filter-form');
  const sectionInput = container.querySelector('#section-input');
  const windowInput = container.querySelector('#window-input');
  const loadButton = container.querySelector('#load-button');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const resultsEl = container.querySelector('#results');

  sectionInput.value = lastSection;
  windowInput.value = lastWindow;

  activeRender = render;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    load(sectionInput.value, windowInput.value);
  });

  async function load(section, windowKey, includeRenewingMonthly = false) {
    loadButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    summaryEl.hidden = true;
    resultsEl.innerHTML = '';

    try {
      // Not forced -- the server caches each section per window (and, for
      // Licensing, per includeRenewingMonthly too) for 20 min, same
      // convention as Subscriptions Expiring, so a repeat Load with the
      // same selection is instant.
      const params = new URLSearchParams({ window: windowKey });
      if (includeRenewingMonthly) params.set('includeRenewingMonthly', 'true');

      let data;
      if (section === 'all') {
        // Both real sub-routes hit in parallel -- each is independently
        // cached server-side, so this costs nothing extra once either has
        // been loaded on its own. Domains ignores the unused
        // includeRenewingMonthly param harmlessly.
        const [domainsRes, licensingRes] = await Promise.all([
          fetch(`/api/coming-soon/domains?${params.toString()}`),
          fetch(`/api/coming-soon/licensing?${params.toString()}`),
        ]);
        const [domainsData, licensingData] = await Promise.all([domainsRes.json(), licensingRes.json()]);
        if (!domainsRes.ok) throw new Error(domainsData.error || `Domains request failed (${domainsRes.status})`);
        if (!licensingRes.ok) throw new Error(licensingData.error || `Microsoft Licensing request failed (${licensingRes.status})`);
        data = {
          asOf: new Date().toISOString(),
          section: 'all',
          window: windowKey,
          windowLabel: domainsData.windowLabel,
          domains: domainsData,
          licensing: licensingData,
          totalCount: domainsData.totalCount + licensingData.totalCount,
        };
      } else {
        const res = await fetch(`/api/coming-soon/${section}?${params.toString()}`);
        data = await res.json();
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      }

      lastSection = section;
      lastWindow = windowKey;
      lastDataBySection[section] = data;
      activeRender(data);
    } catch (err) {
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      loadButton.disabled = false;
    }
  }

  function render(data) {
    statusEl.hidden = true;
    summaryEl.hidden = false;

    if (data.section === 'all') {
      renderAll(data);
      return;
    }

    summaryEl.innerHTML = `<strong>${data.totalCount}</strong> ${data.section === 'domains' ? 'domain' : 'license'}${data.totalCount === 1 ? '' : 's'} -- ${escapeHtml(data.windowLabel)}<span class="inline-subtext"> -- as of ${formatDateTime(data.asOf)}</span>`;

    resultsEl.innerHTML = '';
    if (data.totalCount === 0) {
      resultsEl.innerHTML = `<p class="status">Nothing in this window.</p>`;
      return;
    }

    resultsEl.appendChild(data.section === 'domains' ? domainsTable(data.rows) : licensingTable(data.rows));

    // "Show Monthly Renewing" -- by request, monthly-and-auto-renewing
    // licenses are left out of the default view (see server.js's own
    // showsByDefault()), but still one click away rather than genuinely
    // unavailable. Omitted once they're already showing.
    if (data.section === 'licensing' && !data.includeRenewingMonthly) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button-link button-link--small';
      button.textContent = 'Show Monthly Renewing Licenses';
      button.addEventListener('click', () => load('licensing', data.window, true));
      resultsEl.appendChild(button);
    }
  }

  // "Show All" -- runs every other choice in the Section dropdown at once
  // (Domains + Microsoft Licensing) rather than making the reader flip the
  // dropdown back and forth. Only one number is bolded in the summary line
  // (the combined total), per this dashboard's own "one emphasis per
  // summary line" convention -- the per-section counts sit alongside it,
  // unbolded.
  function renderAll(data) {
    summaryEl.innerHTML = `<strong>${data.totalCount}</strong> item${data.totalCount === 1 ? '' : 's'} (${data.domains.totalCount} domain${data.domains.totalCount === 1 ? '' : 's'}, ${data.licensing.totalCount} license${data.licensing.totalCount === 1 ? '' : 's'}) -- ${escapeHtml(data.windowLabel)}<span class="inline-subtext"> -- as of ${formatDateTime(data.asOf)}</span>`;

    resultsEl.innerHTML = '';
    if (data.totalCount === 0) {
      resultsEl.innerHTML = `<p class="status">Nothing in this window.</p>`;
      return;
    }

    resultsEl.appendChild(sectionHeading('Domains', data.domains.totalCount));
    if (data.domains.totalCount > 0) {
      resultsEl.appendChild(domainsTable(data.domains.rows));
    } else {
      resultsEl.appendChild(statusParagraph('No domains in this window.'));
    }

    resultsEl.appendChild(sectionHeading('Microsoft Licensing', data.licensing.totalCount));
    if (data.licensing.totalCount > 0) {
      resultsEl.appendChild(licensingTable(data.licensing.rows));
    } else {
      resultsEl.appendChild(statusParagraph('No licenses in this window.'));
    }

    if (!data.licensing.includeRenewingMonthly) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button-link button-link--small';
      button.textContent = 'Show Monthly Renewing Licenses';
      button.addEventListener('click', () => load('all', data.window, true));
      resultsEl.appendChild(button);
    }
  }

  // Plain top-level sub-heading, same `.section-heading--split` convention
  // Ticket Times already uses for a label + right-aligned count -- lighter
  // weight than `.resource-group-header` (which lives INSIDE a
  // `.resource-group` card, not standalone above one), appropriate here
  // since this is just splitting one page into its two existing sections,
  // not introducing a new card-level grouping.
  function sectionHeading(title, count) {
    const el = document.createElement('div');
    el.className = 'section-heading section-heading--split';
    el.innerHTML = `<span>${escapeHtml(title)}</span><span class="count">${count}</span>`;
    return el;
  }

  function statusParagraph(text) {
    const p = document.createElement('p');
    p.className = 'status';
    p.textContent = text;
    return p;
  }

  function domainsTable(rows) {
    const groupEl = document.createElement('div');
    groupEl.className = 'resource-group';
    // Shaded header bar, by request -- same `.resource-group-header` blue
    // the Microsoft Licensing tables' own Annual/Monthly bars already use,
    // so this table's card reads the same way rather than starting flush
    // with a plain, unshaded column-name row.
    const headerEl = document.createElement('div');
    headerEl.className = 'resource-group-header';
    headerEl.innerHTML = `<span>Domains</span><span class="count">${rows.length}</span>`;
    groupEl.appendChild(headerEl);
    const table = document.createElement('table');
    table.className = 'coming-soon-table';
    table.innerHTML = `
      <thead>
        <tr><th>Autotask Client</th><th>TPP Client</th><th>Domain</th><th>Category</th><th>Expiry Date</th><th>Days</th><th>Auto-Renews</th></tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (r) => `
          <tr>
            <td>${r.autotaskClientName ? escapeHtml(r.autotaskClientName) : '<span class="inline-subtext">Not matched</span>'}</td>
            <td>${escapeHtml(r.accountReference || 'Unknown')}</td>
            <td>${escapeHtml(r.domainName)}</td>
            <td>${r.category ? escapeHtml(r.category) : ''}</td>
            <td class="ticket-number">${formatDate(r.expiryDate)}</td>
            <td class="ticket-number">${formatDays(r.daysUntilExpiry)}</td>
            <td class="${r.autoRenew ? 'cell-flag-green' : 'cell-flag-red'}">${r.autoRenew ? 'Yes' : 'No'}</td>
          </tr>`
          )
          .join('')}
      </tbody>
    `;
    groupEl.appendChild(table);
    return groupEl;
  }

  // Autotask Contracted Qty is a best-effort join (see server.js's own
  // comment on findMatchingContractedLine/buildLicensingReport) -- "None
  // contracted" is an honest, distinct-from-zero answer: it means the join
  // itself found nothing (no matching company, or no matching contract
  // line), not that the real contracted quantity is zero.
  //
  // Two separate tables, by request -- Annual (renewing or expiring, since
  // there's a real yearly decision point either way) listed first, then
  // Monthly (expiring only by default -- see server.js's own
  // showsByDefault() -- or expiring+renewing once the "Show Monthly
  // Renewing" button below has been used) in its own table underneath, same
  // "split by what a reader is actually scanning for" convention
  // @dashboard/subscriptions-expiring already uses for its own
  // Annual/Monthly sections.
  function licensingTable(rows) {
    const wrap = document.createElement('div');
    const annualRows = rows.filter((r) => r.term === 'annual');
    const monthlyRows = rows.filter((r) => r.term === 'monthly');
    if (annualRows.length > 0) wrap.appendChild(licensingSubTable('Annual', annualRows, true));
    if (monthlyRows.length > 0) wrap.appendChild(licensingSubTable('Monthly', monthlyRows, false));
    return wrap;
  }

  // Invoice column is Annual-only, by request -- a monthly subscription
  // auto-bills every month with no single "has THIS renewal been invoiced"
  // question to ask, so the column would always be empty there. Shown as
  // invoice EXISTENCE near the renewal date (server.js's own
  // findMatchingInvoice()), not genuine send/delivery confirmation --
  // Autotask has no field for that (see server.js's own comment) -- so
  // "No invoice found" means the proxy found nothing nearby, not that one
  // definitely wasn't sent some other way.
  function licensingSubTable(heading, rows, isAnnual) {
    const groupEl = document.createElement('div');
    groupEl.className = 'resource-group';
    const headerEl = document.createElement('div');
    headerEl.className = 'resource-group-header';
    headerEl.innerHTML = `<span>${escapeHtml(heading)}</span><span class="count">${rows.length}</span>`;
    groupEl.appendChild(headerEl);

    const invoiceHeader = isAnnual ? '<th>Invoice</th>' : '';
    const table = document.createElement('table');
    table.className = 'coming-soon-table';
    table.innerHTML = `
      <thead>
        <tr>
          <th>Client</th><th>Subscription</th><th>Expiry Date</th><th>Days</th><th>Auto-Renews</th>
          <th style="text-align: right; padding-right: 0.2rem;">#</th><th style="width: 1%; padding-left: 0; padding-right: 0;"></th><th style="padding-left: 0.2rem;">Autotask Contracted</th>${invoiceHeader}
        </tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (r) => `
          <tr>
            <td>${escapeHtml(r.companyName || r.clientName)}</td>
            <td>${escapeHtml(r.name)}</td>
            <td class="ticket-number">${formatDate(r.expirationDate)}</td>
            <td class="ticket-number">${formatDays(r.daysUntilExpiry)}</td>
            <td class="${r.autoRenews ? 'cell-flag-green' : 'cell-flag-red'}">${r.autoRenews ? 'Yes' : 'No'}</td>
            <td style="text-align: right; padding-right: 0.2rem;">${r.contractedUnits ?? ''}</td>
            <td style="padding-left: 0; padding-right: 0;">${r.contractedUnits != null ? 'x' : ''}</td>
            <td style="padding-left: 0.2rem;">${r.contractedServiceName ? escapeHtml(r.contractedServiceName) : '<span class="inline-subtext">None contracted</span>'}</td>
            ${isAnnual ? `<td class="cs-invoice-cell">${invoiceCellHtml(r)}</td>` : ''}
          </tr>`
          )
          .join('')}
      </tbody>
    `;
    groupEl.appendChild(table);
    return groupEl;
  }

  function invoiceCellHtml(r) {
    if (!r.invoiceNumber) return '<span class="inline-subtext">No invoice found</span>';
    // Not paid -- by request, the invoice number itself goes red rather
    // than just dropping the green "[PAID]" tag, so an unpaid renewal
    // invoice actually stands out at a glance instead of looking identical
    // to a paid one minus one word.
    if (!r.invoicePaid) return `<span class="cell-flag-red">${escapeHtml(r.invoiceNumber)}</span>`;
    return `${escapeHtml(r.invoiceNumber)} <span class="cell-flag-green">[PAID]</span>`;
  }

  if (lastDataBySection[lastSection]) render(lastDataBySection[lastSection]);

  function formatDate(isoDateOnly) {
    if (!isoDateOnly) return '';
    return new Date(`${isoDateOnly}T00:00:00.000Z`).toLocaleDateString(undefined, { timeZone: 'Australia/Brisbane' });
  }

  function formatDateTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString();
  }

  // "in 3 days" / "Today" / "3 days ago" -- same formatting Subscriptions
  // Expiring already uses, for the same reason: this page mixes both
  // forward-looking windows and Expired Recently.
  function formatDays(days) {
    if (days === 0) return 'Today';
    if (days > 0) return `in ${days} day${days === 1 ? '' : 's'}`;
    return `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`;
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
