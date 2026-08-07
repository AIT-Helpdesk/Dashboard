export const id = "ingram-subscriptions";
export const label = "Ingram Subscriptions";

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
      <h1>Ingram Subscriptions</h1>
      <form id="filter-form" class="date-form">
        <label for="client-input">Client</label>
        <input type="text" id="client-input" name="client" placeholder="optional, e.g. Acme* (wildcards with *)" />
        <button type="submit" id="refresh-button">Refresh</button>
      </form>
    </header>
    <p id="status" class="status">Optionally type a client name (wildcards with *) to narrow the list, then click Refresh. License counts aren't loaded up front -- click a client's name to fetch theirs.</p>
    <div id="summary" class="summary" hidden></div>
    <div id="results" class="results"></div>
  `;

  const form = container.querySelector('#filter-form');
  const clientInput = container.querySelector('#client-input');
  const refreshButton = container.querySelector('#refresh-button');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const resultsEl = container.querySelector('#results');

  clientInput.value = lastFilter;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    load(clientInput.value);
  });

  // The server caches each search (keyed by the filter term, an empty filter
  // included) for ~20 min. This is the fast base list -- client/subscription
  // names, status, term, etc. -- NOT license counts, which are fetched
  // separately per client on demand (see loadLicensesForClient() below).
  // Refresh always sends `force=true`, which bypasses that cache for the
  // current search and rebuilds -- a button literally labeled "Refresh"
  // should always get current data, not a cached one.
  async function load(clientFilter) {
    refreshButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = clientFilter ? `Loading subscriptions for "${clientFilter}"...` : 'Loading...';
    summaryEl.hidden = true;
    resultsEl.innerHTML = '';

    try {
      const params = new URLSearchParams({ force: 'true' });
      if (clientFilter) params.set('client', clientFilter);
      const res = await fetch(`/api/ingram-subscriptions?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastData = data;
      lastFilter = clientFilter;
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

    const filterSuffix = data.filterTerm ? ` matching "${escapeHtml(data.filterTerm)}"` : '';
    summaryEl.hidden = false;
    summaryEl.innerHTML = `<strong>${data.totalCount}</strong> subscriptions (${data.activeCount} active, ${data.pendingCount} pending) across ${data.byClient.length} clients${filterSuffix}<span class="inline-subtext"> -- as of ${formatDateTime(data.asOf)}</span>`;

    resultsEl.innerHTML = '';
    if (data.byClient.length === 0) {
      resultsEl.innerHTML = `<p class="status">No active or pending subscriptions${filterSuffix}.</p>`;
      return;
    }

    for (const client of data.byClient) {
      const groupEl = document.createElement('div');
      groupEl.className = 'resource-group';

      const header = document.createElement('div');
      header.className = 'resource-group-header';
      header.innerHTML = `
        <span><button type="button" class="link-button client-name-button">${escapeHtml(client.clientName)}</button></span>
        <span class="count">${client.count} subscription${client.count === 1 ? '' : 's'}</span>
      `;
      const nameButton = header.querySelector('.client-name-button');
      nameButton.addEventListener('click', () => loadLicensesForClient(client, groupEl, nameButton));
      groupEl.appendChild(header);

      const table = document.createElement('table');
      table.innerHTML = `
        <thead>
          <tr><th>Subscription</th><th>Status</th><th>Licenses</th><th>Term</th><th>Billing Period</th><th>Created</th><th>Renews</th><th>Expires</th></tr>
        </thead>
        <tbody>${subscriptionRowsHtml(client.subscriptions)}</tbody>
      `;
      groupEl.appendChild(table);
      resultsEl.appendChild(groupEl);
    }
  }

  function subscriptionRowsHtml(subscriptions) {
    return subscriptions
      .map(
        (s) => `
      <tr>
        <td>${escapeHtml(s.name)}</td>
        <td${s.status === 'pending' ? ' class="cell-flag-blue"' : ''}>${escapeHtml(capitalize(s.status))}</td>
        <td class="ticket-number">${s.licenseCount ?? ''}</td>
        <td class="ticket-number">${formatPeriod(s.term)}</td>
        <td class="ticket-number">${formatPeriod(s.billingPeriod)}</td>
        <td class="ticket-number">${formatDate(s.creationDate)}</td>
        <td class="ticket-number">${formatDate(s.renewalDate)}</td>
        <td class="ticket-number">${formatDate(s.expirationDate)}</td>
      </tr>`
      )
      .join('');
  }

  // Fetches license counts for ONE client's subscriptions and updates only
  // that client's rows in place -- every other client group on screen is
  // left exactly as it was, by request, rather than the whole page
  // reloading. Skips re-fetching if this client's counts are already loaded
  // (clicking again is a no-op, not a redundant round trip).
  async function loadLicensesForClient(client, groupEl, nameButton) {
    if (client.licensesLoaded || nameButton.disabled) return;
    nameButton.disabled = true;
    nameButton.textContent = `${client.clientName} (loading licenses...)`;

    try {
      const ids = client.subscriptions.map((s) => s.id).join(',');
      const res = await fetch(`/api/ingram-subscriptions/licenses?ids=${encodeURIComponent(ids)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

      // Mutate the subscription objects in place -- they're the same objects
      // referenced from `lastData`, so this persists across a same-session
      // re-mount without needing a separate cache structure.
      for (const s of client.subscriptions) {
        s.licenseCount = data.licenseCounts[s.id] ?? null;
      }
      client.licensesLoaded = true;

      groupEl.querySelector('tbody').innerHTML = subscriptionRowsHtml(client.subscriptions);
      nameButton.textContent = client.clientName;
    } catch (err) {
      nameButton.textContent = `${client.clientName} (failed to load licenses -- click to retry)`;
    } finally {
      nameButton.disabled = false;
    }
  }

  // No auto-load on mount, by request -- this page only fetches when Refresh
  // is explicitly clicked (a cold load can take a couple of minutes with no
  // filter). `lastData` still restores instantly on a same-session re-mount
  // (e.g. navigating to another page and back), same as every other page.
  if (lastData) render(lastData);

  function capitalize(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  function formatDate(isoDateOnly) {
    if (!isoDateOnly) return '';
    return new Date(`${isoDateOnly}T00:00:00.000Z`).toLocaleDateString(undefined, { timeZone: 'UTC' });
  }

  function formatDateTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString();
  }

  // Ingram's term/billing-period shape is {type: 'month'|'year'|..., duration: N}
  // -- "Monthly"/"Annual" for the common duration-1 cases (natural business
  // language), "N months"/"N years" otherwise.
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
