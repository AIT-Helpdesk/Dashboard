export const id = "saasalerts-customers";
export const label = "SaaS Alerts Customers";

// Module-scope, not inside mount() -- the shell fully tears down and re-mounts a
// page's DOM on every navigation away and back, but the dynamically-imported
// module itself is cached by the browser and stays alive for the session, so a
// module-level variable survives across re-mounts and lets the last result
// restore instantly instead of coming back blank.
let lastData = null;
let lastFilter = '';
// Persists across re-mounts, same reasoning as lastData/lastFilter above.
// null key means "no explicit sort chosen yet" -- falls back to the
// server's own default order (name, ascending -- see server.js).
let sortState = { key: null, direction: 'asc' };

const SORTABLE_COLUMNS = [
  { key: 'name', label: 'Customer' },
  { key: 'domain', label: 'Domain' },
  { key: 'status', label: 'Status' },
  { key: 'products', label: 'Products' },
  { key: 'monitoredUsers', label: 'Monitored Users' },
];

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>SaaS Alerts Customers</h1>
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

  // The whole list is already in memory client-side (one cheap API call, no
  // per-row expensive lookup to avoid, same as CSP Customers) -- filtering
  // as you type is instant and needs no round trip.
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
      const res = await fetch(`/api/saasalerts-customers${force ? '?force=true' : ''}`);
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
    let filtered = term ? customers.filter((c) => c.name.toLowerCase().includes(term)) : customers;
    // No explicit sort chosen -- leave the server's own default order
    // (name, ascending) alone rather than re-sorting to the same thing.
    if (sortState.key) {
      filtered = [...filtered].sort((a, b) => compareForSort(a, b, sortState.key, sortState.direction));
    }

    resultsEl.innerHTML = '';
    if (filtered.length === 0) {
      resultsEl.innerHTML = '<p class="status">No matching customers.</p>';
      return;
    }

    const group = document.createElement('div');
    group.className = 'resource-group';
    group.innerHTML = `
      <table class="sac-table">
        <thead>
          <tr class="shaded-row">${SORTABLE_COLUMNS.map((col) => sortableHeaderHtml(col)).join('')}</tr>
        </thead>
        <tbody>
          ${filtered
            .map(
              (c) => `
            <tr>
              <td>${customerLink(c)}</td>
              <td>${escapeHtml(c.domain)}</td>
              <td${c.status !== 'active' ? ' class="cell-flag-red"' : ''}>${escapeHtml(capitalize(c.status))}</td>
              <td>${escapeHtml(c.products.join(', '))}</td>
              <td class="ticket-number">${c.monitoredUsers ?? ''}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    `;
    resultsEl.appendChild(group);

    group.querySelectorAll('.sac-sort-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.sortKey;
        if (sortState.key === key) {
          sortState.direction = sortState.direction === 'asc' ? 'desc' : 'asc';
        } else {
          sortState = { key, direction: 'asc' };
        }
        // Re-render from the full (unfiltered) customer list, same as the
        // filter input's own re-render -- filtering/sorting are both
        // re-derived from lastData.customers, not accumulated on top of
        // whatever's currently on screen.
        renderResults(lastData.customers);
      });
    });
  }

  // Click-to-sort, click-again-to-reverse column headers -- the whole
  // list is already in memory client-side (see the filter-input comment
  // above), so re-sorting on click is instant, no round trip needed.
  function sortableHeaderHtml(col) {
    const isActive = sortState.key === col.key;
    const arrow = isActive ? (sortState.direction === 'asc' ? ' ▲' : ' ▼') : '';
    return `<th><button type="button" class="sac-sort-btn${isActive ? ' sac-sort-btn--active' : ''}" data-sort-key="${col.key}">${escapeHtml(col.label)}${arrow}</button></th>`;
  }

  // 'products' isn't a plain field on the customer object -- it's an
  // array, sorted the same way it's displayed (joined, alphabetically).
  function sortValueFor(c, key) {
    return key === 'products' ? c.products.join(', ') : c[key];
  }

  // Nulls (domain/monitoredUsers can both be genuinely absent) always
  // sort to the end, regardless of direction -- so reversing the sort
  // doesn't make "missing data" jump to the top, which would read as
  // more surprising than useful.
  function compareForSort(a, b, key, direction) {
    const av = sortValueFor(a, key);
    const bv = sortValueFor(b, key);
    const aMissing = av === null || av === undefined;
    const bMissing = bv === null || bv === undefined;
    if (aMissing || bMissing) return aMissing && bMissing ? 0 : aMissing ? 1 : -1;
    const cmp =
      typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
    return direction === 'asc' ? cmp : -cmp;
  }

  if (lastData) render(lastData);
  else load(false);

  function customerLink(c) {
    const label = escapeHtml(c.name);
    if (!c.autotaskUrl) return label;
    // Real popup window, not just a new tab -- same convention every other
    // Autotask/IT Glue link on this dashboard uses (explicit window.open
    // size features are what make browsers treat it as a window).
    return `<a href="${escapeHtml(c.autotaskUrl)}" target="_blank" rel="noopener noreferrer" onclick="window.open(this.href, '_blank', 'noopener,noreferrer,width=1200,height=900'); return false;">${label}</a>`;
  }

  function capitalize(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

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
