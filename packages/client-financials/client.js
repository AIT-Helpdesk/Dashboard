export const id = "client-financials";
export const label = "Client Financials";

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
      <h1>Client Financials</h1>
      <form id="filter-form" class="date-form">
        <label for="client-input">Client</label>
        <input type="text" id="client-input" name="client" placeholder="e.g. Cloud King Hosting" required />
        <button type="submit" id="search-button">Search</button>
      </form>
    </header>
    <p id="status" class="status">Type a client name (wildcards with *) and click Search. This report is single-client, so a wildcard must match exactly one company.</p>
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
      const res = await fetch(`/api/client-financials?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastQuery = { client: clientName };
      lastData = data;
      // A pick from the ambiguous-match list resolves to one company; reflect
      // that in the input so the field matches what's actually displayed.
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

    const heading = document.createElement('div');
    heading.className = 'summary';
    heading.innerHTML = `<strong>${companyLink(data)}</strong> -- last 12 months`;
    resultsEl.appendChild(heading);

    // Wide table (12 months + total column) -- scrolls within its own
    // container rather than widening the page on small screens.
    const summaryWrap = document.createElement('div');
    summaryWrap.className = 'resource-group';
    summaryWrap.style.overflowX = 'auto';
    summaryWrap.innerHTML = `
      <table>
        <thead>
          <tr class="shaded-row">
            <th>Category</th>
            ${data.months.map((m) => `<th class="ticket-number">${escapeHtml(m.label)}</th>`).join('')}
            <th class="ticket-number">12-Month Total</th>
          </tr>
        </thead>
        <tbody>
          ${summaryRow('Labour', data.months.map((m) => m.labour), data.grandTotal.labour)}
          ${summaryRow('Labour in Charges', data.months.map((m) => m.chargesLabour), data.grandTotal.chargesLabour)}
          ${summaryRow('Other Charges', data.months.map((m) => m.chargesOther), data.grandTotal.chargesOther)}
          ${summaryRow('Recurring Services', data.months.map((m) => m.recurringOther), data.grandTotal.recurringOther)}
          ${summaryRow('Tech Cover', data.months.map((m) => m.recurringTechCover), data.grandTotal.recurringTechCover)}
          ${summaryRow('Total', data.months.map((m) => m.total), data.grandTotal.total, true)}
        </tbody>
      </table>
    `;
    resultsEl.appendChild(summaryWrap);

    const invoiceHeading = document.createElement('h2');
    invoiceHeading.textContent = `Invoices (${data.invoices.length})`;
    invoiceHeading.style.fontSize = '1.1rem';
    invoiceHeading.style.margin = '1.5rem 0 0.75rem';
    resultsEl.appendChild(invoiceHeading);

    if (data.invoices.length === 0) {
      resultsEl.insertAdjacentHTML('beforeend', '<p class="status">No invoices in the last 12 months.</p>');
      return;
    }

    const invoiceGroup = document.createElement('div');
    invoiceGroup.className = 'resource-group';
    invoiceGroup.innerHTML = `
      <table>
        <thead>
          <tr><th>Invoice #</th><th>Date</th><th>Total</th></tr>
        </thead>
        <tbody>
          ${data.invoices
            .map(
              (inv) => `
            <tr>
              <td>${invoiceLink(inv)}${unpaidIconHtml(inv)}</td>
              <td class="ticket-number">${formatDate(inv.invoiceDate)}</td>
              <td class="ticket-number">${formatPrice(inv.total)}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    `;
    resultsEl.appendChild(invoiceGroup);
  }

  if (lastData) render(lastData);

  function summaryRow(label, values, total, isTotalRow) {
    const rowClass = isTotalRow ? ' class="shaded-row"' : '';
    const rowStyle = isTotalRow ? ' style="font-weight: 600; border-top: 2px solid var(--border);"' : '';
    return `
      <tr${rowClass}${rowStyle}>
        <td>${escapeHtml(label)}</td>
        ${values.map((v) => `<td class="ticket-number">${formatPrice(v)}</td>`).join('')}
        <td class="ticket-number">${formatPrice(total)}</td>
      </tr>`;
  }

  function companyLink(data) {
    const label = escapeHtml(data.companyName);
    if (!data.companyUrl) return label;
    // Real popup window, not just a new tab -- same convention this page's
    // own invoice link (and every other Autotask/IT Glue link on this
    // dashboard) uses.
    return `<a href="${escapeHtml(data.companyUrl)}" target="_blank" rel="noopener noreferrer" onclick="window.open(this.href, '_blank', 'noopener,noreferrer,width=1200,height=900'); return false;">${label}</a>`;
  }

  function invoiceLink(inv) {
    const label = escapeHtml(inv.invoiceNumber || `#${inv.id}`);
    if (!inv.invoiceUrl) return label;
    // A real popup window, not just a new tab -- specifying window features
    // (width/height/etc.) is what signals that to the browser. Reads `this.href`
    // rather than re-embedding the URL in the onclick string, so there's only one
    // place the URL needs escaping (the href attribute) instead of two. Same
    // pattern as Client Details' Last Invoice link.
    return `<a href="${escapeHtml(inv.invoiceUrl)}" target="_blank" rel="noopener noreferrer" onclick="window.open(this.href, '_blank', 'noopener,noreferrer,width=1000,height=800'); return false;">${label}</a>`;
  }

  // `isUnpaid` (server.js) -- Autotask's own `paidDate` field is blank, scoped
  // to invoice numbers starting "INV-" only (other prefixes, e.g. credit
  // memos, aren't real client invoices and can legitimately have no
  // paidDate). A plain warning glyph, by request, not a full row highlight --
  // this is meant to catch the eye on an otherwise plain invoice list without
  // implying every OTHER row was specifically checked and confirmed paid.
  function unpaidIconHtml(inv) {
    if (!inv.isUnpaid) return '';
    return `<span class="cf-unpaid-icon" title="Unpaid -- no Date Paid recorded in Autotask">&#9888;</span>`;
  }

  function formatDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString();
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
