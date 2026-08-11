export const id = "subscriptions-expiring";
export const label = "Subscriptions Expiring";

// Module-scope, not inside mount() -- the shell fully tears down and re-mounts a
// page's DOM on every navigation away and back, but the dynamically-imported
// module itself is cached by the browser and stays alive for the session, so a
// module-level variable survives across re-mounts and lets the last result
// restore instantly instead of coming back blank.
let lastWindow = "7";
let lastFilter = "";
let lastData = null;

// Keys and labels mirror WINDOWS in server.js exactly -- kept in sync
// manually (same pattern as CRITERIA/CRITERIA_OPTIONS on Client Details),
// since the dropdown needs to render before any request to the server.
const WINDOW_OPTIONS = [
  { value: "2", label: "2 days" },
  { value: "7", label: "7 days" },
  { value: "14", label: "14 days" },
  { value: "30", label: "30 days" },
  { value: "60", label: "60 days" },
  { value: "90", label: "90 days" },
  { value: "expired-recently", label: "Expired Recently" },
];

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>Subscriptions Expiring</h1>
      <form id="filter-form" class="date-form">
        <label for="window-input">Window</label>
        <select id="window-input" name="window">
          ${WINDOW_OPTIONS.map((o) => `<option value="${o.value}">${o.label}</option>`).join('')}
        </select>
        <label for="client-input">Client</label>
        <input type="text" id="client-input" name="client" placeholder="optional, e.g. Acme* (wildcards with *)" />
        <button type="submit" id="load-button">Load</button>
      </form>
    </header>
    <p id="status" class="status">Pick a window (default: 7 days) and click Load.</p>
    <div id="summary" class="summary" hidden></div>
    <div id="results" class="results"></div>
  `;

  const form = container.querySelector('#filter-form');
  const windowInput = container.querySelector('#window-input');
  const clientInput = container.querySelector('#client-input');
  const loadButton = container.querySelector('#load-button');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const resultsEl = container.querySelector('#results');

  windowInput.value = lastWindow;
  clientInput.value = lastFilter;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    load(windowInput.value, clientInput.value);
  });

  async function load(windowKey, clientFilter) {
    loadButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    summaryEl.hidden = true;
    resultsEl.innerHTML = '';

    try {
      // Not forced -- the server caches per window+filter combination for 20
      // min, so a repeat Load with the same selection is instant, while
      // changing the window or filter always lands on a different cache key
      // and fetches fresh regardless.
      const params = new URLSearchParams({ window: windowKey });
      if (clientFilter) params.set('client', clientFilter);
      const res = await fetch(`/api/subscriptions-expiring?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastWindow = windowKey;
      lastFilter = clientFilter;
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
    statusEl.hidden = true;

    const filterSuffix = data.filterTerm ? ` matching "${escapeHtml(data.filterTerm)}"` : '';
    summaryEl.hidden = false;
    summaryEl.innerHTML = `<strong>${data.totalCount}</strong> subscription${data.totalCount === 1 ? '' : 's'} -- ${escapeHtml(data.windowLabel)}${filterSuffix}<span class="inline-subtext"> -- as of ${formatDateTime(data.asOf)}</span>`;

    resultsEl.innerHTML = '';
    if (data.totalCount === 0) {
      resultsEl.innerHTML = `<p class="status">No subscriptions${filterSuffix} in this window.</p>`;
      return;
    }

    // Split into four sections, by request -- Auto-Renews first (Terminating
    // needs follow-up, so it leads), then Term within each: Annual before
    // Monthly. A term type other than month/year (none seen in real data as
    // of writing, but not assumed impossible) falls into its own "Other"
    // section rather than being silently dropped or miscategorized. Each
    // section is sorted by client name, not the server's
    // chronological-by-expiration ordering. Sections with zero rows are
    // omitted entirely.
    const terminating = data.rows.filter((r) => !r.autoRenews);
    const renewing = data.rows.filter((r) => r.autoRenews);

    renderTermSections('TERMINATING', 'section-heading--red', terminating);
    renderTermSections('RENEWING', 'section-heading--green', renewing);

    function renderTermSections(label, headingClass, rows) {
      for (const termLabel of ['Annual', 'Monthly', 'Other']) {
        const matching = rows.filter((r) => termType(r.term) === termLabel).sort(byClientName);
        if (matching.length === 0) continue;
        resultsEl.appendChild(section(`${label} ${termLabel.toUpperCase()}`, headingClass, matching));
      }
    }
  }

  function termType(term) {
    if (term?.type === 'year') return 'Annual';
    if (term?.type === 'month') return 'Monthly';
    return 'Other';
  }

  function byClientName(a, b) {
    return a.clientName.localeCompare(b.clientName) || a.name.localeCompare(b.name);
  }

  function section(heading, headingClass, rows) {
    const groupEl = document.createElement('div');
    groupEl.className = 'resource-group';

    const headingEl = document.createElement('div');
    headingEl.className = `section-heading ${headingClass}`;
    headingEl.textContent = `${heading} (${rows.length})`;
    groupEl.appendChild(headingEl);

    const table = document.createElement('table');
    table.innerHTML = `
      <thead>
        <tr><th>Client</th><th>Subscription</th><th>Status</th><th>Auto-Renews</th><th>Term</th><th>Expires</th><th>Days</th></tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (r) => `
          <tr>
            <td>${escapeHtml(r.clientName)}</td>
            <td>${escapeHtml(r.name)}</td>
            <td${r.status === 'pending' ? ' class="cell-flag-blue"' : ''}>${escapeHtml(r.status === 'hold' ? 'On Hold' : capitalize(r.status))}</td>
            <td class="${r.autoRenews ? 'cell-flag-green' : 'cell-flag-red'}">${r.autoRenews ? 'Yes' : 'No'}</td>
            <td class="ticket-number">${formatPeriod(r.term)}</td>
            <td class="ticket-number">${formatDate(r.expirationDate)}</td>
            <td class="ticket-number">${formatDays(r.daysUntilExpiry)}</td>
          </tr>`
          )
          .join('')}
      </tbody>
    `;
    groupEl.appendChild(table);
    return groupEl;
  }

  if (lastData) render(lastData);

  function capitalize(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  function formatDate(isoDateOnly) {
    if (!isoDateOnly) return '';
    return new Date(`${isoDateOnly}T00:00:00.000Z`).toLocaleDateString(undefined, { timeZone: 'Australia/Brisbane' });
  }

  function formatDateTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString();
  }

  // "in 3 days" / "Today" / "3 days ago" -- much easier to scan at a glance
  // than a bare signed integer, especially since this page mixes both
  // directions (forward-looking windows vs. Expired Recently).
  function formatDays(days) {
    if (days === 0) return 'Today';
    if (days > 0) return `in ${days} day${days === 1 ? '' : 's'}`;
    return `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`;
  }

  // Ingram's term/billing-period shape is {type: 'month'|'year'|..., duration: N}
  // -- same formatting convention as Ingram Subscriptions.
  function formatPeriod(period) {
    if (!period) return '';
    const { type, duration } = period;
    if (duration === 1) {
      if (type === 'month') return 'Monthly';
      if (type === 'year') return 'Annual';
      if (type === 'day') return 'Daily';
    }
    return `${duration} ${type}${duration === 1 ? '' : 's'}`;
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
