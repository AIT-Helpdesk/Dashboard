export const id = "saas-protection";
export const label = "SaaS Protection";

// Module-scope, not inside mount() -- same "survives a re-mount, instant
// restore" reasoning every other Ingram/Datto-style page on this dashboard
// already follows (see Ingram Subscriptions' own client.js for the fuller
// writeup).
let lastData = null;
let lastFilter = '';
let activeRender = null;

// The two widgets' own data, cached module-scope same as `lastData` --
// by request, re-fetched from Datto ONLY when the Refresh button is
// actually pressed, never just because the page re-rendered (e.g.
// navigating away and back). `null` means "never fetched yet, show the
// loading placeholder"; once set, every render reuses it until a Refresh
// click (or a successful Accept, which patches it directly -- see
// acceptFailure() below) replaces it.
let lastServiceTotals = null;
let lastAcceptedFailures = null;
// Keyed by bucket name ('all'/'allFailed'/'someFailed'/'succeeded') --
// same caching rule as the two above: a widget's popup is fetched once,
// then reused for every later open until a real Refresh (load() below
// clears this map) or, for 'all' specifically, a successful Accept (which
// patches the cached entry in place -- see acceptFailure()).
let widgetDetailCache = new Map();

// Direct references to the widgets that need an in-place update right
// after a successful Accept click, or when a cached value fills them in
// without a fetch -- set fresh every renderWidgets() call, so these never
// point at a detached element left over from a previous render. The first
// four all come from the one combined /service-totals fetch (see
// loadServiceTotals()) -- they're classified together server-side, so they
// load/cache/patch together too.
let allBackupsCardEl = null;
let allFailedCardEl = null;
let someFailedCardEl = null;
let succeededCardEl = null;
let acceptedFailuresCardEl = null;

// Same status-color palette Datto RMM's own client.js uses (STATUS_COLORS),
// by request ("Datto RMM style widgets") -- for visual continuity with that
// page's own donut cards, not this dashboard's more general red/orange/
// green (.cell-flag-*) shades.
const STATUS_COLORS = {
  healthy: '#28a745',
  warning: '#f39c12',
  danger: '#dc3545',
  neutral: '#5dade2',
};

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>SaaS Protection</h1>
      <form id="filter-form" class="date-form">
        <label for="client-input">Client</label>
        <input type="text" id="client-input" name="client" placeholder="optional, e.g. Acme* (wildcards with *)" />
        <button type="submit" id="refresh-button">Refresh</button>
      </form>
    </header>
    <p id="status" class="status">Microsoft 365 backup health, via Datto SaaS Protection. Clients with the lowest backup % are listed first -- that's where something is most likely not being backed up. Click a client's name for a breakdown by mailbox/site and by application (Exchange/SharePoint/OneDrive).</p>
    <div id="summary" class="summary" hidden></div>
    <div id="widgets" class="datto-card-grid" hidden></div>
    <div id="results" class="results"></div>
  `;

  const form = container.querySelector('#filter-form');
  const clientInput = container.querySelector('#client-input');
  const refreshButton = container.querySelector('#refresh-button');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const widgetsEl = container.querySelector('#widgets');
  const resultsEl = container.querySelector('#results');

  clientInput.value = lastFilter;

  activeRender = render;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    load(clientInput.value);
  });

  // Cached server-side for ~20 min; Refresh always sends `force=true`,
  // bypassing that cache -- same convention every other Ingram/Datto-style
  // page here uses. This is the ONLY path that counts as "the refresh
  // button was pressed" (it's also how a client-name filter is applied,
  // since there's no separate button for that) -- `activeRender(data,
  // true)` tells renderWidgets() below to force the two widget fetches
  // too, rather than reusing whatever's cached.
  async function load(clientFilter) {
    refreshButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    summaryEl.hidden = true;
    widgetsEl.hidden = true;
    resultsEl.innerHTML = '';

    try {
      const params = new URLSearchParams({ force: 'true' });
      if (clientFilter) params.set('client', clientFilter);
      const res = await fetch(`/api/saas-protection?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastData = data;
      lastFilter = clientFilter;
      // A real Refresh -- every cached widget/popup result is stale as of
      // now, so clear all of them before rendering; renderWidgets() (and
      // any widget popup opened afterwards) will fetch fresh rather than
      // reuse what's here.
      lastServiceTotals = null;
      lastAcceptedFailures = null;
      widgetDetailCache = new Map();
      activeRender(data, true);
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      refreshButton.disabled = false;
    }
  }

  // `forceWidgets` is true ONLY when called from load() above (a real
  // Refresh-button press) -- the restore-on-remount call at the bottom of
  // mount() (`if (lastData) render(lastData)`) omits it, so navigating
  // away and back just redraws whatever's already cached, by request,
  // rather than re-pulling from Datto every time the page happens to
  // re-render.
  function render(data, forceWidgets = false) {
    statusEl.hidden = true;

    const filterSuffix = data.filterTerm ? ` matching client "${escapeHtml(data.filterTerm)}"` : '';
    summaryEl.hidden = false;
    summaryEl.innerHTML = `<strong>${data.totalClients}</strong> client${data.totalClients === 1 ? '' : 's'} (${data.totalSeats} seats total)${filterSuffix}<span class="inline-subtext"> -- as of ${formatDateTime(data.asOf)}</span>`;

    renderWidgets(data, forceWidgets);

    resultsEl.innerHTML = '';
    if (data.byClient.length === 0) {
      resultsEl.innerHTML = `<p class="status">No clients${filterSuffix}.</p>`;
      return;
    }

    const table = document.createElement('table');
    table.className = 'saas-protection-table';
    table.innerHTML = `
      <thead>
        <tr>
          <th>Client</th><th>Domain</th><th>Product</th>
          <th class="saas-seats-header"></th>
          <th class="saas-services-header"></th>
          <th>Backup %</th>
        </tr>
        <tr class="saas-client-filter-row">
          <th><input type="text" class="saas-client-filter-input" placeholder="Filter clients..." /></th>
          <th></th><th></th><th></th><th></th><th></th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    resultsEl.appendChild(table);

    // Live, purely in-memory filter on the Client column, by request --
    // narrows the already-loaded `data.byClient` as you type, with no
    // server round trip at all (unlike the top-of-page Client search box,
    // which re-fetches from Datto on submit). The Seats/Services Backed Up
    // header totals re-derive from whatever's currently visible, same
    // "reflects the filtered set" rule those two already followed before
    // this filter existed -- only the filter `<input>` element itself is
    // never recreated (so typing doesn't lose focus/cursor position);
    // everything else below it is rebuilt on every keystroke.
    const seatsHeaderEl = table.querySelector('.saas-seats-header');
    const servicesHeaderEl = table.querySelector('.saas-services-header');
    const tbody = table.querySelector('tbody');
    const filterInput = table.querySelector('.saas-client-filter-input');

    function renderTableRows() {
      const term = filterInput.value.trim().toLowerCase();
      const visible = term ? data.byClient.filter((c) => c.clientName.toLowerCase().includes(term)) : data.byClient;
      seatsHeaderEl.textContent = seatsHeaderHtml(visible);
      servicesHeaderEl.textContent = servicesHeaderHtml(visible);
      tbody.innerHTML = visible.length > 0 ? clientRowsHtml(visible) : `<tr><td colspan="6" class="status">No clients matching this filter.</td></tr>`;
      tbody.querySelectorAll('.client-name-button').forEach((btn) => {
        const client = visible.find((c) => String(c.customerId) === btn.dataset.customerId);
        if (client) btn.addEventListener('click', () => openClientModal(client));
      });
    }

    filterInput.addEventListener('input', renderTableRows);
    renderTableRows();
  }

  // "All Backups" is a two-colour ring (green = services with a recent
  // backup, red = the rest) rather than a single flat colour, by request --
  // the centre number is the total SERVICE count, not a client count like
  // the other three. Those three stay single-colour, with a fixed colour
  // tied to their own identity (danger/warning/healthy) regardless of
  // count -- same "fixed colour per widget identity" convention About Me's
  // own Overdue/Due Today donut cards already use (ticketCountDonutHtml()).
  // All four are classified together, by request ("don't show the
  // accepted failures in circles 2 & 3 either") -- see getServiceAggregate()
  // in server.js: a client's bucket (All/Some Failed/Succeeded) now comes
  // from the SAME accepted-failure-aware per-application pass behind the
  // ring, not the older, cheaper /domains-level backupPercentage, so they
  // all load/cache/patch as one unit via loadServiceTotals() below.
  function renderWidgets(data, force) {
    widgetsEl.hidden = false;
    widgetsEl.innerHTML = '';
    allBackupsCardEl = placeholderCard('All Backups', () => openWidgetModal('all', 'All Backups'));
    widgetsEl.appendChild(allBackupsCardEl);
    allFailedCardEl = placeholderCard('All Backups Failed', () => openWidgetModal('allFailed', 'All Backups Failed'));
    widgetsEl.appendChild(allFailedCardEl);
    someFailedCardEl = placeholderCard('Some Backups Failed', () => openWidgetModal('someFailed', 'Some Backups Failed'));
    widgetsEl.appendChild(someFailedCardEl);
    succeededCardEl = placeholderCard('Clients Succeeded', () => openWidgetModal('succeeded', 'Clients Succeeded'));
    widgetsEl.appendChild(succeededCardEl);

    if (!force && lastServiceTotals) {
      fillServiceTotalsWidgets(lastServiceTotals);
    } else {
      setServiceTotalsWidgetsLoading();
      loadServiceTotals();
    }

    acceptedFailuresCardEl = acceptedFailuresWidgetCard(force);
    widgetsEl.appendChild(acceptedFailuresCardEl);
  }

  // Bare shell -- donut/label/sub all filled in afterwards, either
  // instantly from cache or once the fetch resolves. `onClick` is wired
  // immediately either way, since which bucket it opens never depends on
  // whether the numbers have loaded yet.
  function placeholderCard(label, onClick) {
    const div = document.createElement('div');
    div.className = 'datto-card datto-card--clickable';
    div.title = 'Click to see the clients behind this number';
    div.innerHTML = `<div class="datto-donut-wrap"></div><div class="datto-card-label">${escapeHtml(label)}</div><div class="datto-card-sub"></div>`;
    div.addEventListener('click', onClick);
    return div;
  }

  function setServiceTotalsWidgetsLoading() {
    for (const el of [allBackupsCardEl, allFailedCardEl, someFailedCardEl, succeededCardEl]) {
      el.querySelector('.datto-donut-wrap').innerHTML = `${donutSvg(0, 0, STATUS_COLORS.neutral)}<div class="datto-donut-center"><span class="datto-donut-count">…</span></div>`;
      el.querySelector('.datto-card-sub').textContent = 'Loading...';
    }
  }

  function fillServiceTotalsWidgets(data) {
    fillAllBackupsCard(allBackupsCardEl, data);
    fillSimpleWidget(allFailedCardEl, data.allFailedCount, data.classifiedTotal, STATUS_COLORS.danger, `${data.allFailedCount} of ${data.classifiedTotal} clients`);
    fillSimpleWidget(someFailedCardEl, data.someFailedCount, data.classifiedTotal, STATUS_COLORS.warning, `${data.someFailedCount} of ${data.classifiedTotal} clients`);
    fillSimpleWidget(succeededCardEl, data.succeededCount, data.classifiedTotal, STATUS_COLORS.healthy, `${data.succeededCount} of ${data.classifiedTotal} clients`);
  }

  function fillAllBackupsCard(card, data) {
    card.querySelector('.datto-donut-wrap').innerHTML = `
      ${twoColorDonutSvg(data.success, data.failure)}
      <div class="datto-donut-center"><span class="datto-donut-count">${data.total}</span></div>
    `;
    card.querySelector('.datto-card-sub').textContent = `${data.success} succeeded, ${data.failure} failed`;
  }

  function fillSimpleWidget(card, count, total, color, subtext) {
    card.querySelector('.datto-donut-wrap').innerHTML = `
      ${donutSvg(count, total, color)}
      <div class="datto-donut-center"><span class="datto-donut-count">${count}</span></div>
    `;
    card.querySelector('.datto-card-sub').textContent = subtext;
  }

  // Counts APPLICATION TYPES (Exchange/SharePoint/OneDrive/Teams, one per
  // client), not clients or seats -- by request ("for a client there might
  // be exchange, onedrive, sharepoint, teams"). The /domains list this
  // page's main table is built from doesn't carry that breakdown at all
  // (its own activeServicesCount/activeServicesWithRecentBackupCount turned
  // out to be a seat-equivalent count instead), so this fetches every
  // client's own /applications detail server-side -- a genuinely heavy
  // ~230+-call fetch on a cold cache, same magnitude as Ingram
  // Subscriptions' own "a cold load can take a couple of minutes" cost, so
  // it's loaded AFTER the page's own already-fast initial render, not
  // blocking it. Fills all four widgets at once from one response -- checks
  // `isConnected` first in case a later Refresh click has already replaced
  // these exact elements (a fresh renderWidgets() call rebuilds the whole
  // grid from scratch), so a slow, stale fetch can never overwrite a newer
  // render. `force`-free, by request ("only pull up the data... again if
  // the refresh button is specifically pressed") -- renderWidgets() above
  // only calls this when there's no cache to use yet.
  async function loadServiceTotals() {
    try {
      const res = await fetch('/api/saas-protection/service-totals');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastServiceTotals = data;
      if (allBackupsCardEl.isConnected) fillServiceTotalsWidgets(data);
    } catch (err) {
      for (const el of [allBackupsCardEl, allFailedCardEl, someFailedCardEl, succeededCardEl]) {
        if (el.isConnected) el.querySelector('.datto-card-sub').textContent = `Error: ${err.message}`;
      }
    }
  }

  // 5th widget, by request -- a count of currently-ACTIVE accepted
  // failures (end date not yet reached), coloured red/danger (by request)
  // same as it's still a live, unresolved failure underneath, just a
  // deliberately deferred one. Cheap (DB-only, no live Datto call), but
  // still cached/loaded the same way as the others for consistency --
  // `force` is only true right after a Refresh click (see render()'s own
  // comment); otherwise an already-cached `lastAcceptedFailures` fills the
  // ring immediately, no fetch at all. Clicking it opens the flat list of
  // what's currently accepted (client/backup type/accepted-until/by).
  function acceptedFailuresWidgetCard(force) {
    const div = document.createElement('div');
    div.className = 'datto-card datto-card--clickable';
    div.title = 'Click to see the currently accepted failures';
    div.innerHTML = `<div class="datto-donut-wrap"></div><div class="datto-card-label">Accepted Failures</div><div class="datto-card-sub"></div>`;
    div.addEventListener('click', openAcceptedFailuresModal);
    if (!force && lastAcceptedFailures) {
      fillAcceptedFailuresCard(div, lastAcceptedFailures);
    } else {
      div.querySelector('.datto-donut-wrap').innerHTML = `${donutSvg(0, 0, STATUS_COLORS.neutral)}<div class="datto-donut-center"><span class="datto-donut-count">…</span></div>`;
      div.querySelector('.datto-card-sub').textContent = 'Loading...';
      loadAcceptedFailuresCount(div);
    }
    return div;
  }

  function fillAcceptedFailuresCard(card, items) {
    const count = items.length;
    card.querySelector('.datto-donut-wrap').innerHTML = `
      ${donutSvg(count, Math.max(count, 1), STATUS_COLORS.danger)}
      <div class="datto-donut-center"><span class="datto-donut-count">${count}</span></div>
    `;
    card.querySelector('.datto-card-sub').textContent = `${count} currently accepted`;
  }

  async function loadAcceptedFailuresCount(card) {
    try {
      const data = await fetchAcceptedFailures();
      lastAcceptedFailures = data.items;
      if (!card.isConnected) return;
      fillAcceptedFailuresCard(card, data.items);
    } catch (err) {
      if (!card.isConnected) return;
      card.querySelector('.datto-card-sub').textContent = `Error: ${err.message}`;
    }
  }

  async function fetchAcceptedFailures() {
    const res = await fetch('/api/saas-protection/accepted-failures');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // Reuses `lastAcceptedFailures` if it's already populated -- same "don't
  // re-pull unless Refresh was pressed" rule as the widget itself; it's
  // always kept current anyway, since both loadAcceptedFailuresCount() and
  // a successful Accept (see acceptFailure()) write straight into it.
  async function openAcceptedFailuresModal() {
    const overlay = openModal('Accepted Failures', true);
    try {
      const items = lastAcceptedFailures || (await fetchAcceptedFailures()).items;
      lastAcceptedFailures = items;
      overlay.querySelector('.history-modal-body').innerHTML = acceptedFailuresBodyHtml(items);
    } catch (err) {
      overlay.querySelector('.history-modal-body').innerHTML = `<p class="status error">Error: ${escapeHtml(err.message)}</p>`;
    }
  }

  function acceptedFailuresBodyHtml(items) {
    if (items.length === 0) return '<p class="status">No accepted failures right now.</p>';
    return `<table class="saas-protection-detail-table">
      <thead><tr><th>Client</th><th>Domain</th><th>Application</th><th>Accepted From</th><th>Accepted Until</th><th>By</th></tr></thead>
      <tbody>${items
        .map(
          (i) => `<tr>
        <td>${escapeHtml(i.clientName || '')}</td>
        <td>${escapeHtml(i.domain || '')}</td>
        <td>${escapeHtml(appTypeLabel(i.appType))}</td>
        <td class="ticket-number">${formatDate(i.startDate)}</td>
        <td class="ticket-number">${formatDate(i.endDate)}</td>
        <td>${escapeHtml(i.acceptedByName || '')}</td>
      </tr>`
        )
        .join('')}</tbody>
    </table>`;
  }

  function clientRowsHtml(clients) {
    return clients
      .map(
        (c) => `
      <tr>
        <td><button type="button" class="link-button client-name-button" data-customer-id="${escapeHtml(c.customerId)}">${escapeHtml(c.clientName)}</button></td>
        <td>${escapeHtml(c.domain)}</td>
        <td>${escapeHtml(c.productType || '')}</td>
        <td class="ticket-number">${c.seatsUsed ?? ''}</td>
        <td class="ticket-number">${servicesCellHtml(c)}</td>
        <td class="ticket-number ${backupPctClass(c.backupPercentage)}">${backupPctText(c.backupPercentage)}</td>
      </tr>`
      )
      .join('');
  }

  function servicesCellHtml(c) {
    if (c.activeServicesCount == null) return '';
    return `${c.activeServicesWithRecentBackupCount ?? 0} / ${c.activeServicesCount}`;
  }

  // Column-header totals, by request -- sums over whatever's currently on
  // screen (the filtered/sorted `byClient` list as rendered), not the
  // unfiltered full report, so a client-name search narrows these too.
  function seatsHeaderHtml(clients) {
    const total = clients.reduce((sum, c) => sum + (c.seatsUsed || 0), 0);
    return `Seats (${total})`;
  }

  function servicesHeaderHtml(clients) {
    const backedUp = clients.reduce((sum, c) => sum + (c.activeServicesWithRecentBackupCount || 0), 0);
    const active = clients.reduce((sum, c) => sum + (c.activeServicesCount || 0), 0);
    return `Services Backed Up (${backedUp} / ${active})`;
  }

  // 100% is green, anything 90-99% is a yellowy-orange "worth a look but
  // not an emergency" band (by request), and everything else (<=90%, or
  // unknown) is red -- a narrower band than Check-Up's own graduated
  // pctColorClass() (40/75), since a backup product's whole point is 100%
  // or there's a real gap.
  function backupPctClass(pct) {
    if (pct == null) return 'cell-flag-red';
    if (pct === 100) return 'cell-flag-green';
    if (pct > 90) return 'cell-flag-orange';
    return 'cell-flag-red';
  }

  function backupPctText(pct) {
    return pct == null ? 'Unknown' : `${pct}%`;
  }

  // One client's application-backup-stats + seat-level breakdown, fetched
  // on demand -- same shared modal shell (.history-modal-overlay/-panel)
  // Check Client/Contract Checks already use for their own Info/History
  // popups, reused here rather than building a new one.
  async function openClientModal(client) {
    const overlay = openModal(`${client.clientName} -- SaaS Protection`, true);
    try {
      const res = await fetch(`/api/saas-protection/detail?customerId=${encodeURIComponent(client.customerId)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      overlay.querySelector('.history-modal-body').innerHTML = clientDetailBodyHtml(data);
    } catch (err) {
      overlay.querySelector('.history-modal-body').innerHTML = `<p class="status error">Error: ${escapeHtml(err.message)}</p>`;
    }
  }

  // Shared modal shell (overlay/panel/close-on-Escape-or-click-outside),
  // factored out since both the per-client popup above and the five widget
  // popups below need the exact same open/close wiring, just different
  // body content. `wide` (the five widget popups, not the per-client one)
  // adds .saas-widget-modal-panel -- ~30% wider than the shared default, by
  // request, since these can carry a per-app Accept control/column the
  // default 30rem width crowds.
  function openModal(title, wide) {
    const overlay = document.createElement('div');
    overlay.className = 'history-modal-overlay';
    overlay.innerHTML = `
      <div class="history-modal-panel${wide ? ' saas-widget-modal-panel' : ''}">
        <div class="history-modal-panel-header">
          <span>${escapeHtml(title)}</span>
          <button type="button" class="history-modal-close" aria-label="Close">✕</button>
        </div>
        <div class="history-modal-body"><p class="status loading">Loading...</p></div>
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
    return overlay;
  }

  function clientDetailBodyHtml(data) {
    const appsHtml = data.applications.length
      ? `<table class="saas-protection-detail-table">
          <thead><tr><th>Application</th><th>Status</th><th>Last Successful Backup</th><th>Storage Used</th></tr></thead>
          <tbody>${data.applications.map(appRowHtml).join('')}</tbody>
        </table>`
      : '<p class="status">No application backup stats available.</p>';

    const seatsHtml = data.seats.length
      ? `<table class="saas-protection-detail-table">
          <thead><tr><th>Mailbox / Site</th><th>Type</th><th>Status</th><th>Added</th></tr></thead>
          <tbody>${data.seats
            .map(
              (s) => `<tr>
            <td>${escapeHtml(s.name || s.mainId)}</td>
            <td>${escapeHtml(s.seatType || '')}</td>
            <td${s.seatState !== 'Active' ? ' class="cell-flag-blue"' : ''}>${escapeHtml(s.seatState || '')}</td>
            <td class="ticket-number">${formatDate(s.dateAdded)}</td>
          </tr>`
            )
            .join('')}</tbody>
        </table>`
      : '<p class="status">No seats found.</p>';

    return `
      ${backupStatusChartHtml(data.applications)}
      <h3>Applications</h3>
      ${appsHtml}
      <h3>Seats (${data.seats.length})</h3>
      ${seatsHtml}
    `;
  }

  // Mirrors Datto's own Partner Portal "Backup Status" widget, by request
  // ("I can see this [screenshot of that widget] ... can you get me
  // something similar?") -- a 30-day green/red/grey bar row per
  // application type. `a.history` (only present on the per-client detail
  // this modal fetches, not the bulk aggregate -- see
  // getApplicationsHistory() in server.js) is a SPARSE array (an app type
  // with little or no history, e.g. a freshly-added OneDrive, simply has
  // fewer entries, not 30 blanks), so this fills in every day 0-29 from a
  // lookup map rather than assuming index === day.
  function backupStatusChartHtml(applications) {
    if (!applications.length) return '';
    return `
      <h3>Backup Status <span class="inline-subtext">Last 30 days</span></h3>
      <div class="saas-history-chart">
        ${applications
          .map(
            (a) => `
          <div class="saas-history-row">
            <span class="saas-history-label">${escapeHtml(appTypeLabel(a.appType))}</span>
            <span class="saas-history-bars">${backupHistoryBarsHtml(a.history)}</span>
          </div>
        `
          )
          .join('')}
      </div>
    `;
  }

  // Datto's own 4 confirmed statuses (sampled across every currently
  // non-100% client in the account, ~280+ real backupHistory entries) --
  // "Backup With Issues" (minor, amber) is a genuinely different status
  // from "Backup With Lots Of Issues" (severe, red), not a duplicate.
  // Tooltip wording matches what's shown in Datto's own Partner Portal, by
  // request. A status Datto returns that ISN'T one of these four (none
  // seen in that sample, but the API is never guaranteed exhaustive) falls
  // back to red with Datto's own raw text rather than silently mislabeling
  // it as something it isn't.
  const HISTORY_STATUS_INFO = {
    Perfect: { cls: 'ok', label: 'Backup Successful' },
    'Backup With Issues': { cls: 'minor', label: 'Backup Successful with Some Issues' },
    'Backup With Lots Of Issues': { cls: 'issue', label: 'Backup Successful with Lots of Issues' },
    'Insufficient History': { cls: 'none', label: 'No data' },
  };

  function backupHistoryBarsHtml(history) {
    const byDaysAgo = new Map((history || []).map((h) => [h.daysAgo, h.status]));
    const bars = [];
    for (let daysAgo = 29; daysAgo >= 0; daysAgo--) {
      const status = byDaysAgo.get(daysAgo);
      const info = status ? HISTORY_STATUS_INFO[status] || { cls: 'issue', label: status } : { cls: 'none', label: 'No data' };
      const dateText = formatDate(dateForDaysAgo(daysAgo));
      bars.push(`<span class="saas-history-bar saas-history-bar--${info.cls}" title="${escapeHtml(`${info.label} ${dateText}`)}"></span>`);
    }
    return bars.join('');
  }

  // AEST-anchored, same "today" convention every date-scoped page on this
  // dashboard uses -- `daysAgo` comes straight from Datto's own
  // "BetweenNdAndN+1d" time window (see getApplicationsHistory() in
  // server.js), day-granularity only (Datto's API carries no hour/minute
  // for these), so the tooltip shows a date, not a fabricated time.
  function dateForDaysAgo(daysAgo) {
    const d = new Date(Date.now() + 10 * 60 * 60 * 1000);
    d.setUTCDate(d.getUTCDate() - daysAgo);
    return d.toISOString().slice(0, 10);
  }

  function appRowHtml(a) {
    return `<tr>
      <td>${escapeHtml(appTypeLabel(a.appType))}</td>
      <td class="${a.healthy ? 'cell-flag-green' : 'cell-flag-red'}">${escapeHtml(a.status)}</td>
      <td class="ticket-number">${a.lastFullyProtectedTime ? formatDateTime(new Date(a.lastFullyProtectedTime).toISOString()) : ''}</td>
      <td class="ticket-number">${formatBytes(a.usedBytes)}</td>
    </tr>`;
  }

  // One widget's popup -- 'succeeded' is cheap (the plain client list
  // already in `lastData`, server-side just re-shapes it, no live Datto
  // call); 'allFailed'/'someFailed'/'all' all trigger a live per-client
  // applications fetch server-side (bounded concurrency, 'all' uncapped --
  // see getServiceAggregate() in server.js), so this can take a few seconds
  // (or, for 'all' on a cold cache, as long as the widget's own ring itself
  // took) -- same "Loading..." placeholder convention as the per-client
  // popup above. Cached per bucket in `widgetDetailCache`, by request --
  // reopening the same popup within a session reuses it rather than
  // re-fetching, until a real Refresh (or, for 'all', a successful Accept,
  // which patches this cache directly -- see onFailureAccepted()).
  async function openWidgetModal(bucket, title) {
    const overlay = openModal(title, true);
    try {
      const data = widgetDetailCache.get(bucket) || (await fetchWidgetDetail(bucket));
      widgetDetailCache.set(bucket, data);
      const body = overlay.querySelector('.history-modal-body');
      body.innerHTML = widgetDetailBodyHtml(data);
      if (data.clients.length > 0 && data.clients[0].apps !== null) wireAcceptButtons(body);
    } catch (err) {
      overlay.querySelector('.history-modal-body').innerHTML = `<p class="status error">Error: ${escapeHtml(err.message)}</p>`;
    }
  }

  async function fetchWidgetDetail(bucket) {
    const res = await fetch(`/api/saas-protection/widget-detail?bucket=${encodeURIComponent(bucket)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function widgetDetailBodyHtml(data) {
    if (data.clients.length === 0) {
      return data.bucket === 'all'
        ? '<p class="status">No backup failures right now -- every application type on every client backed up successfully.</p>'
        : '<p class="status">No clients in this bucket.</p>';
    }

    const truncatedNote = data.truncated
      ? `<p class="status">Showing the first ${data.clients.length} of ${data.totalMatching} matching clients.</p>`
      : '';

    // 'allFailed'/'someFailed'/'all': each client gets its own small
    // application-status table (the per-app-type error detail) -- for
    // 'all' specifically, only the FAILING application types (see
    // getServiceAggregate()'s own `failingClients` in server.js), not
    // every application type the way the per-client popup above shows.
    // 'succeeded': `apps` is null (server never fetched it, by design --
    // see getWidgetBucket()'s own comment), so this is just the same flat
    // client/domain/backup% list the main table already shows, for a quick
    // overview without leaving the popup.
    if (data.clients[0].apps === null) {
      return `${truncatedNote}<table class="saas-protection-detail-table">
        <thead><tr><th>Client</th><th>Domain</th><th>Backup %</th></tr></thead>
        <tbody>${data.clients
          .map(
            (c) => `<tr>
          <td>${escapeHtml(c.clientName)}</td>
          <td>${escapeHtml(c.domain)}</td>
          <td class="ticket-number ${backupPctClass(c.backupPercentage)}">${backupPctText(c.backupPercentage)}</td>
        </tr>`
          )
          .join('')}</tbody>
      </table>`;
    }

    // Accept is offered everywhere except 'succeeded' (already handled
    // above via its own `apps === null` branch) -- 'all'/'allFailed'/
    // 'someFailed' all now come from the exact same per-application-type
    // aggregate (see getServiceAggregate() in server.js), so there's no
    // reason to single out 'all' as the only place able to act on a
    // failure.
    const allowAccept = true;
    return (
      truncatedNote +
      data.clients
        .map((c) => {
          const appsHtml = c.apps
            ? `<table class="saas-protection-detail-table">
                <thead><tr><th>Application</th><th>Status</th><th>Last Successful Backup</th>${allowAccept ? '<th>Accept Until</th>' : ''}</tr></thead>
                <tbody>${c.apps.map((a) => appFailureRowHtml(c, a, allowAccept)).join('')}</tbody>
              </table>`
            : '<p class="status error">Couldn\'t load application detail for this client.</p>';
          return `
            <div class="resource-group">
              <div class="resource-group-header"><span>${escapeHtml(c.clientName)}</span><span class="count">${escapeHtml(c.domain)}</span></div>
              ${appsHtml}
            </div>
          `;
        })
        .join('')
    );
  }

  // The yellowy-orange "Failure accepted for X to Y" note, by request --
  // shown as a second line inside the Status cell (not a separate row)
  // specifically so removing a row on a fresh Accept (see acceptFailure())
  // only ever has to remove ONE <tr>, not hunt for a sibling note row.
  // `a.acceptedFailure` only carries a LAPSED record (end date already
  // passed) -- an ACTIVE one is excluded from this list entirely server-
  // side (see computeServiceAggregate() in server.js), so its presence
  // here always means "this was accepted before, and that acceptance has
  // since run out", never a currently-active one.
  function appFailureRowHtml(c, a, allowAccept) {
    const acceptedNote = a.acceptedFailure
      ? `<br><span class="cell-flag-orange saas-accepted-note">Failure accepted for ${formatDate(a.acceptedFailure.startDate)} to ${formatDate(a.acceptedFailure.endDate)}</span>`
      : '';
    return `<tr>
      <td>${escapeHtml(appTypeLabel(a.appType))}</td>
      <td class="${a.healthy ? 'cell-flag-green' : 'cell-flag-red'}">${escapeHtml(a.status)}${acceptedNote}</td>
      <td class="ticket-number">${a.lastFullyProtectedTime ? formatDateTime(new Date(a.lastFullyProtectedTime).toISOString()) : ''}</td>
      ${allowAccept ? `<td>${acceptControlHtml(c, a)}</td>` : ''}
    </tr>`;
  }

  // A date input (defaulting to a week out, picked purely for convenience
  // -- any future date is accepted) + its own Accept button, per
  // (client, application type) row. customerId/appType/clientName/domain
  // travel on the wrapper's own dataset so acceptFailure() below has
  // everything it needs without re-deriving it from the row's text.
  function acceptControlHtml(c, a) {
    return `<span class="saas-accept-control" data-customer-id="${escapeHtml(c.customerId)}" data-app-type="${escapeHtml(a.appType)}" data-client-name="${escapeHtml(c.clientName)}" data-domain="${escapeHtml(c.domain)}">
      <input type="date" class="saas-accept-date" value="${defaultAcceptUntilDate()}" min="${todayDateString()}" />
      <button type="button" class="button-link button-link--small saas-accept-btn">Accept</button>
    </span>`;
  }

  function defaultAcceptUntilDate() {
    return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  function todayDateString() {
    return new Date().toISOString().slice(0, 10);
  }

  function wireAcceptButtons(bodyEl) {
    bodyEl.querySelectorAll('.saas-accept-control').forEach((control) => {
      control.querySelector('.saas-accept-btn').addEventListener('click', () => acceptFailure(control, bodyEl));
    });
  }

  // POST is a cheap, instant DB write (no live Datto call), so this never
  // waits on anything slow -- the row disappears (and, once its client has
  // no failures left, the whole client block) as soon as the server
  // confirms it, and the two widgets' own cached numbers/lists are patched
  // in place via onFailureAccepted() rather than re-fetched.
  async function acceptFailure(controlEl, bodyEl) {
    const { customerId, appType, clientName, domain } = controlEl.dataset;
    const dateInput = controlEl.querySelector('.saas-accept-date');
    const endDate = dateInput.value;
    if (!endDate) {
      alert('Pick an "accept until" date first.');
      return;
    }
    const btn = controlEl.querySelector('.saas-accept-btn');
    const originalLabel = btn.textContent;
    btn.disabled = true;
    dateInput.disabled = true;
    btn.textContent = 'Accepting...';

    try {
      const res = await fetch('/api/saas-protection/accept-failure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId, appType, clientName, domain, endDate }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

      onFailureAccepted(data.record);

      const row = controlEl.closest('tr');
      const group = row.closest('.resource-group');
      row.remove();
      if (group && group.querySelectorAll('tbody tr').length === 0) group.remove();
      if (bodyEl.querySelectorAll('.resource-group').length === 0) {
        bodyEl.innerHTML = '<p class="status">No clients left in this list.</p>';
      }
    } catch (err) {
      btn.disabled = false;
      dateInput.disabled = false;
      btn.textContent = originalLabel;
      alert(`Couldn't accept: ${err.message}`);
    }
  }

  // The row the user just acted on is already removed from the currently-
  // open modal directly (see acceptFailure() above) -- what's left here is
  // keeping everything ELSE honest:
  //   - The ring's own success/failure/total patches directly (removing
  //     exactly one failure is unambiguous, whichever bucket it came from).
  //   - The three classification counts (All/Some Failed, Succeeded)
  //     DON'T patch client-side -- whether this client now belongs in a
  //     different bucket (e.g. its last real failure just got accepted, or
  //     it had several and this was only one of them) depends on how many
  //     application types it has in total, which isn't reliably available
  //     here. So `lastServiceTotals` is dropped entirely and re-fetched --
  //     cheap and correct either way, since the SERVER's own cache was
  //     already patched by patchServiceAggregateCache() in server.js, so
  //     this re-fetch is a local JSON response, not a live Datto round trip.
  //   - Every cached widget POPUP (`widgetDetailCache`) is cleared for the
  //     same reason -- a bucket other than the one just acted on might also
  //     need to drop or move this client, so the simplest correct fix is
  //     "re-fetch next time it's opened", not try to replicate server-side
  //     reclassification twice.
  //   - Accepted Failures patches directly -- no classification ambiguity
  //     there, it's just "add or update this one row".
  function onFailureAccepted(record) {
    lastServiceTotals = null;
    if (allBackupsCardEl && allBackupsCardEl.isConnected) {
      setServiceTotalsWidgetsLoading();
      loadServiceTotals();
    }
    widgetDetailCache.clear();

    if (!record) return;
    const entry = {
      customerId: record.customer_id,
      appType: record.app_type,
      clientName: record.client_name,
      domain: record.domain,
      startDate: record.start_date,
      endDate: record.end_date,
      acceptedByName: record.accepted_by_name,
      acceptedAt: record.accepted_at,
    };
    const list = lastAcceptedFailures ? [...lastAcceptedFailures] : [];
    const idx = list.findIndex((i) => String(i.customerId) === String(entry.customerId) && i.appType === entry.appType);
    if (idx !== -1) list[idx] = entry;
    else list.push(entry);
    list.sort((a, b) => a.endDate.localeCompare(b.endDate));
    lastAcceptedFailures = list;
    if (acceptedFailuresCardEl && acceptedFailuresCardEl.isConnected) fillAcceptedFailuresCard(acceptedFailuresCardEl, lastAcceptedFailures);
  }

  // Datto's own appType values are camelCase/compound ("Office365Exchange",
  // "Office365SharePoint", "Office365OneDrive", confirmed against real
  // data) -- "Office365" stripped off the front, by request (every app
  // type on this page is already Office365, so it's redundant noise on
  // every row), then split into a readable label rather than shown
  // verbatim.
  function appTypeLabel(appType) {
    if (!appType) return '';
    return appType
      .replace(/^Office365/, '')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/(\d)([A-Z])/g, '$1 $2');
  }

  function formatBytes(bytes) {
    if (bytes == null) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex++;
    }
    return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
  }

  // No auto-load on mount, by request-following convention (same as Ingram
  // Subscriptions/Ingram Orders) -- this page only fetches when Refresh is
  // explicitly clicked. `lastData` still restores instantly on a
  // same-session re-mount.
  if (lastData) render(lastData);

  // Same donutSvg()/polarToCartesian()/describeArc() arc-drawing helpers
  // Datto RMM's own client.js uses, duplicated here rather than imported --
  // same "separate page package" convention every small page-local helper
  // on this dashboard follows (see About Me's own ticketCountDonutHtml()
  // comment for the fuller reasoning).
  function donutSvg(count, total, color, size = 120) {
    const cx = size / 2;
    const cy = size / 2;
    const r = size * 0.4;
    const stroke = size * 0.14;
    const pct = total > 0 ? Math.min(1, count / total) : 0;
    const sweep = pct * 360;
    const bg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--border)" stroke-width="${stroke}" />`;
    const arc = sweep > 0 ? `<path d="${describeArc(cx, cy, r, 0, sweep)}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="butt" />` : '';
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${bg}${arc}</svg>`;
  }

  // Two-colour variant for "All Backups" -- green arc (services with a
  // recent backup) then a red arc for the rest, each carrying its own
  // native SVG <title> so hovering just that arc shows its own count,
  // by request ("mouse over on the green and red to show success and
  // failure counts"). All-success/all-failure draws as a single stroked
  // <circle> instead of a 360-degree <path> arc -- a path whose start and
  // end angle are identical degenerates to nothing in SVG.
  function twoColorDonutSvg(successCount, failureCount, size = 120) {
    const cx = size / 2;
    const cy = size / 2;
    const r = size * 0.4;
    const stroke = size * 0.14;
    const total = successCount + failureCount;
    const bg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--border)" stroke-width="${stroke}" />`;

    if (total === 0) return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${bg}</svg>`;
    if (failureCount === 0) {
      const ring = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${STATUS_COLORS.healthy}" stroke-width="${stroke}"><title>${successCount} succeeded</title></circle>`;
      return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${bg}${ring}</svg>`;
    }
    if (successCount === 0) {
      const ring = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${STATUS_COLORS.danger}" stroke-width="${stroke}"><title>${failureCount} failed</title></circle>`;
      return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${bg}${ring}</svg>`;
    }

    const successSweep = (successCount / total) * 360;
    const successArc = `<path d="${describeArc(cx, cy, r, 0, successSweep)}" fill="none" stroke="${STATUS_COLORS.healthy}" stroke-width="${stroke}" stroke-linecap="butt"><title>${successCount} succeeded</title></path>`;
    const failureArc = `<path d="${describeArc(cx, cy, r, successSweep, 360)}" fill="none" stroke="${STATUS_COLORS.danger}" stroke-width="${stroke}" stroke-linecap="butt"><title>${failureCount} failed</title></path>`;
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${bg}${successArc}${failureArc}</svg>`;
  }

  function polarToCartesian(cx, cy, r, angleDeg) {
    const rad = ((angleDeg - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  function describeArc(cx, cy, r, startAngle, endAngle) {
    const start = polarToCartesian(cx, cy, r, endAngle);
    const end = polarToCartesian(cx, cy, r, startAngle);
    const largeArc = endAngle - startAngle <= 180 ? '0' : '1';
    return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y}`;
  }

  function formatDate(isoDateOnly) {
    if (!isoDateOnly) return '';
    return new Date(isoDateOnly).toLocaleDateString();
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
