export const id = "cost-of-azure";
export const label = "Cost of Azure";

// Module-scope, not inside mount() -- same "survives a navigate-away-and-
// back" convention every other page on this dashboard uses (see e.g.
// @dashboard/client-activity's own identical comment).
let lastData = null;
let lastFilterMode = 'all';
let lastPostedState = 'unposted';
let activeRender = null;

// Mirrors server.js's own three posted states. Entirely read-only, by
// request ("I don't need to update ContractServiceUnits") -- Billable
// Amount is only ever shown here, never edited from this page.
const POSTED_STATE_OPTIONS = [
  { value: 'unposted', label: 'Unposted' },
  { value: 'posted-not-invoiced', label: 'Posted - Not Invoiced' },
  { value: 'invoiced', label: 'Invoiced' },
];

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>Cost of Azure</h1>
      <div class="date-form coa-toolbar">
        <label for="posted-state-select">Show</label>
        <select id="posted-state-select">
          ${POSTED_STATE_OPTIONS.map((o) => `<option value="${o.value}">${o.label}</option>`).join('')}
        </select>
        <div class="coa-filter-group" role="group" aria-label="Filter by billable amount">
          <button type="button" class="coa-filter-btn" data-mode="all">All</button>
          <button type="button" class="coa-filter-btn" data-mode="zero">$0 only</button>
          <button type="button" class="coa-filter-btn" data-mode="nonzero">&gt; $0 only</button>
        </div>
        <button type="button" id="client-totals-btn" class="button-link button-link--small">Client Totals</button>
        <button type="button" id="refresh-btn" class="button-link button-link--small">Refresh</button>
      </div>
    </header>
    <p id="status" class="status">Loading...</p>
    <div id="results" class="results"></div>
  `;

  const statusEl = container.querySelector('#status');
  const resultsEl = container.querySelector('#results');
  const postedStateSelect = container.querySelector('#posted-state-select');
  const refreshBtn = container.querySelector('#refresh-btn');
  const clientTotalsBtn = container.querySelector('#client-totals-btn');
  const filterBtns = [...container.querySelectorAll('.coa-filter-btn')];

  let filterMode = lastFilterMode;
  postedStateSelect.value = lastPostedState;

  activeRender = render;

  postedStateSelect.addEventListener('change', () => {
    lastPostedState = postedStateSelect.value;
    load();
  });

  filterBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      filterMode = btn.dataset.mode;
      lastFilterMode = filterMode;
      render(lastData);
    });
  });

  refreshBtn.addEventListener('click', () => load());

  clientTotalsBtn.addEventListener('click', () => openClientTotalsModal());

  async function load() {
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    resultsEl.innerHTML = '';
    try {
      const res = await fetch(`/api/cost-of-azure?postedState=${encodeURIComponent(lastPostedState)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastData = data;
      activeRender(data);
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    }
  }

  function visibleItems() {
    if (!lastData) return [];
    if (filterMode === 'zero') return lastData.items.filter((it) => !it.billableAmount);
    if (filterMode === 'nonzero') return lastData.items.filter((it) => it.billableAmount);
    return lastData.items;
  }

  function render(data) {
    if (!data) return;
    lastData = data;

    filterBtns.forEach((btn) => btn.classList.toggle('active', btn.dataset.mode === filterMode));

    const items = visibleItems();
    const stateLabel = (POSTED_STATE_OPTIONS.find((o) => o.value === data.postedState) || {}).label || data.postedState;

    if (data.contractCount === 0) {
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.textContent = `No contract found matching "Sync - Cost of Azure*".`;
      resultsEl.innerHTML = '';
      return;
    }

    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = `${data.items.length} ${stateLabel.toLowerCase()} recurring billing item${data.items.length === 1 ? '' : 's'} from 1/7/2026 to the end of this month across ${data.contractCount} contract${data.contractCount === 1 ? '' : 's'} matching "Sync - Cost of Azure*" -- showing ${items.length}.`;

    resultsEl.innerHTML = '';
    resultsEl.appendChild(itemsTable(items));
  }

  function itemsTable(items) {
    const wrap = document.createElement('div');
    wrap.className = 'resource-group coa-items-table';
    wrap.style.overflowX = 'auto';
    if (items.length === 0) {
      wrap.innerHTML = '<p class="status" style="padding: 0.75rem 1rem;">None.</p>';
      return wrap;
    }
    wrap.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Client</th>
            <th>Invoice Description</th>
            <th class="ticket-number">Quantity</th>
            <th class="ticket-number">Unit Price</th>
            <th class="ticket-number">Original Amount</th>
            <th class="ticket-number">Billable Amount</th>
            <th>Item Date</th>
          </tr>
        </thead>
        <tbody>
          ${items
            .map(
              (it) => `
            <tr>
              <td>${contractLink(it)}</td>
              <td>${escapeHtml(it.description)}</td>
              <td class="ticket-number">${it.quantity ?? ''}</td>
              <td class="ticket-number">${formatCurrency(it.unitPrice)}</td>
              <td class="ticket-number">${it.originalBillableAmount === null ? '' : formatCurrency(it.originalBillableAmount)}</td>
              <td class="ticket-number">${billableAmountCellHtml(it)}</td>
              <td class="ticket-number">${formatDate(it.itemDate)}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    `;
    return wrap;
  }

  // Flags a Billable Amount that no longer matches the contract's own
  // standard rate for this service (it.originalBillableAmount) -- by
  // request ("differentiate original value in billable amount and
  // billable amount (edited)").
  function billableAmountCellHtml(it) {
    const amount = formatCurrency(it.billableAmount);
    if (!it.isEdited) return amount;
    return `${amount} <span class="coa-edited-tag" title="Differs from the contract's standard rate (${formatCurrency(it.originalBillableAmount)})">(edited)</span>`;
  }

  // Billable Amount summed per client, across ALL currently-loaded items
  // for whichever posted-state is currently selected -- deliberately NOT
  // scoped to the current $0/>$0 filter, so switching tabs doesn't change
  // what this shows (a client viewed while "$0 only" is active would
  // otherwise always show $0 here, even if they have real outstanding
  // amounts elsewhere in the list).
  function openClientTotalsModal() {
    if (!lastData) return;
    const stateLabel = (POSTED_STATE_OPTIONS.find((o) => o.value === lastData.postedState) || {}).label || lastData.postedState;
    const totalsByCompany = new Map(); // companyName -> { sum, companyUrl }
    for (const it of lastData.items) {
      const entry = totalsByCompany.get(it.companyName) || { sum: 0, companyUrl: it.companyUrl };
      entry.sum += it.billableAmount || 0;
      totalsByCompany.set(it.companyName, entry);
    }
    const rows = [...totalsByCompany.entries()]
      .map(([companyName, { sum, companyUrl }]) => ({ companyName, companyUrl, sum }))
      .sort((a, b) => b.sum - a.sum);
    const grandTotal = rows.reduce((s, r) => s + r.sum, 0);

    const overlay = document.createElement('div');
    overlay.className = 'history-modal-overlay';
    overlay.innerHTML = `
      <div class="history-modal-panel">
        <div class="history-modal-panel-header">
          <span>Billable Amount by Client (${escapeHtml(stateLabel.toLowerCase())} items)</span>
          <button type="button" class="history-modal-close" aria-label="Close">&#10005;</button>
        </div>
        <div class="history-modal-body">
          <table>
            <thead>
              <tr><th>Client</th><th class="ticket-number">Billable Amount Sum</th></tr>
            </thead>
            <tbody>
              ${rows
                .map(
                  (r) => `
                <tr>
                  <td>${companyLink(r)}</td>
                  <td class="ticket-number">${formatCurrency(r.sum)}</td>
                </tr>`
                )
                .join('')}
            </tbody>
            <tfoot>
              <tr style="font-weight: 600; border-top: 2px solid var(--border);">
                <td>Total</td>
                <td class="ticket-number">${formatCurrency(grandTotal)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKeydown);
    };
    function onKeydown(e) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKeydown);
    overlay.querySelector('.history-modal-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
  }

  // Used by the Client Totals popup (one row per client -- a single
  // contract link wouldn't make sense there).
  function companyLink(it) {
    const label = escapeHtml(it.companyName);
    if (!it.companyUrl) return label;
    return `<a href="${escapeHtml(it.companyUrl)}" target="_blank" rel="noopener noreferrer" onclick="window.open(this.href, '_blank', 'noopener,noreferrer,width=1200,height=900'); return false;">${label}</a>`;
  }

  // Used by the main results table -- by request, the Client cell links
  // to that row's own CONTRACT (not the company page), while still
  // showing the company name as the link text.
  function contractLink(it) {
    const label = escapeHtml(it.companyName);
    if (!it.contractUrl) return label;
    return `<a href="${escapeHtml(it.contractUrl)}" target="_blank" rel="noopener noreferrer" onclick="window.open(this.href, '_blank', 'noopener,noreferrer,width=1200,height=900'); return false;">${label}</a>`;
  }

  function formatDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString();
  }

  // Same $#,##0.00 (en-AU) convention @dashboard/completed-tickets' own
  // Billable $ figure uses -- not invented fresh.
  function formatCurrency(n) {
    return `$${(n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  if (lastData) render(lastData);
  else load();
}
