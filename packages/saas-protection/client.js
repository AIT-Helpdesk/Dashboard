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
    // Card itself stays "All Backups" (the two-colour ring really is every
    // application-type check, success + failure) -- only the popup's own
    // heading changes, by request, since its content is actually narrower
    // than that: every FAILING app across every client with at least one
    // real failure (aggregate.failingClients -- allFailed + someFailed
    // combined), not literally every backup the card's own donut counts.
    allBackupsCardEl = placeholderCard('All Backups', () => openWidgetModal('all', 'All Failed Backups'));
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
    const overlay = openModal('Accepted Failures', true, copyButtonHtml());
    try {
      const items = lastAcceptedFailures || (await fetchAcceptedFailures()).items;
      lastAcceptedFailures = items;
      const body = overlay.querySelector('.history-modal-body');
      body.innerHTML = acceptedFailuresBodyHtml(items);
      if (items.length > 0) wireCopyButton(overlay, () => acceptedFailuresToText(items), () => acceptedFailuresToHtml(items));
      else hideCopyButton(overlay);
    } catch (err) {
      overlay.querySelector('.history-modal-body').innerHTML = `<p class="status error">Error: ${escapeHtml(err.message)}</p>`;
    }
  }

  function acceptedFailuresBodyHtml(items) {
    if (items.length === 0) return '<p class="status">No accepted failures right now.</p>';
    return `<table class="saas-protection-detail-table">
      <thead><tr><th>Client</th><th>Application</th><th>Accepted From</th><th>Accepted Until</th><th>By</th></tr></thead>
      <tbody>${items
        .map(
          (i) => `<tr>
        <td>${escapeHtml(i.clientName || '')}</td>
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

  // Shared by the grouped resource-group-header's own "count" span and
  // the Copy builders below, so the two stay in sync -- same wording and
  // field reads, not two separately-maintained copies.
  function seatsServicesText(c) {
    return `Seats: ${c.seatsUsed ?? ''} | Services Backed Up: ${servicesCellHtml(c)}`;
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
  // default 30rem width crowds. `headerExtraHtml` (the Copy button, on the
  // three popups that have one) lives INSIDE .history-modal-panel-header,
  // not the scrollable body -- that header is already sticky (top: 0,
  // see styles.css), so the button rides along with it for free, with no
  // separate sticky-offset math needed to keep it visible while scrolling
  // (by request). Table headers staying visible too (also by request) is
  // handled the same way, just one level down -- see .saas-protection-
  // detail-table thead th in styles.css, which also keys off this header's
  // real rendered height via --modal-header-h, set right below.
  function openModal(title, wide, headerExtraHtml) {
    const overlay = document.createElement('div');
    overlay.className = 'history-modal-overlay';
    overlay.innerHTML = `
      <div class="history-modal-panel${wide ? ' saas-widget-modal-panel' : ''}">
        <div class="history-modal-panel-header">
          <span>${escapeHtml(title)}</span>
          <div class="history-modal-header-actions">
            ${headerExtraHtml || ''}
            <button type="button" class="history-modal-close" aria-label="Close">✕</button>
          </div>
        </div>
        <div class="history-modal-body"><p class="status loading">Loading...</p></div>
      </div>
    `;
    document.body.appendChild(overlay);
    const panelEl = overlay.querySelector('.history-modal-panel');
    const headerEl = overlay.querySelector('.history-modal-panel-header');
    panelEl.style.setProperty('--modal-header-h', `${headerEl.offsetHeight}px`);
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

  // Datto's /seats endpoint carries no backup date of its own (confirmed --
  // checked that endpoint directly, its own detailedBackupStats endpoint
  // -- currently 502ing on Datto's own side -- and their activity-log
  // endpoint, none expose one), so there's no TRUE per-seat last-backup
  // time available from this API at all -- only per-APPLICATION TYPE (the
  // Applications table/Backup Status chart above). By request, this maps
  // each seat's own seatType to the application type that actually backs
  // it up and shows THAT application's last successful backup instead --
  // not seat-specific, but the closest real, non-fabricated date available
  // for that row. Confirmed against real seatType values across ~40
  // clients: SharedMailbox and User are both mailbox-identified (a
  // "User" seat's own mainId is an email address) and map to Exchange;
  // Site/TeamSite map to SharePoint; Team maps to Teams. No OneDrive-typed
  // seat was observed in that sample, so there's nothing to map it from
  // yet -- an unmapped/unrecognised seatType just shows blank rather than
  // guessing.
  const SEAT_TYPE_TO_APP_TYPE = {
    SharedMailbox: 'Office365Exchange',
    User: 'Office365Exchange',
    Site: 'Office365SharePoint',
    TeamSite: 'Office365SharePoint',
    Team: 'Office365Teams',
  };

  function clientDetailBodyHtml(data) {
    const appsHtml = data.applications.length
      ? `<table class="saas-protection-detail-table">
          <thead><tr><th>Application</th><th>Status</th><th>Last Successful Backup</th><th>Storage Used</th></tr></thead>
          <tbody>${data.applications.map(appRowHtml).join('')}</tbody>
        </table>`
      : '<p class="status">No application backup stats available.</p>';

    const lastBackupByAppType = new Map(data.applications.map((a) => [a.appType, a.lastFullyProtectedTime]));

    const seatsHtml = data.seats.length
      ? `<table class="saas-protection-detail-table">
          <thead><tr><th>Mailbox / Site</th><th>Type</th><th>Status</th><th>Added</th><th>Last Successful Backup</th></tr></thead>
          <tbody>${data.seats
            .map((s) => {
              const appType = SEAT_TYPE_TO_APP_TYPE[s.seatType];
              const lastBackup = appType ? lastBackupByAppType.get(appType) : null;
              const lastBackupCellTitle = appType
                ? `title="From this seat's own ${escapeHtml(appTypeLabel(appType))} application backup -- Datto doesn't track a per-seat backup time"`
                : '';
              return `<tr>
            <td>${escapeHtml(s.name || s.mainId)}</td>
            <td>${escapeHtml(s.seatType || '')}</td>
            <td${s.seatState !== 'Active' ? ' class="cell-flag-blue"' : ''}>${escapeHtml(s.seatState || '')}</td>
            <td class="ticket-number">${formatDate(s.dateAdded)}</td>
            <td class="ticket-number" ${lastBackupCellTitle}>${lastBackup ? formatDateTime(new Date(lastBackup).toISOString()) : ''}</td>
          </tr>`;
            })
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
    // Every widget popup gets a Copy button now, by request ("make the
    // other popup windows copy buttons the same") -- 'succeeded' uses its
    // own flat builders (succeededToText/Html, below) since it has no
    // per-app `apps` data to group by client (see getWidgetBucket()'s own
    // comment on why -- 'all'/'allFailed'/'someFailed' share failuresToText/
    // Html instead.
    const hasCopyButton = true;
    const overlay = openModal(title, true, hasCopyButton ? copyButtonHtml() : '');
    try {
      const data = widgetDetailCache.get(bucket) || (await fetchWidgetDetail(bucket));
      widgetDetailCache.set(bucket, data);
      const body = overlay.querySelector('.history-modal-body');
      body.innerHTML = widgetDetailBodyHtml(data);
      if (data.clients.length > 0 && data.clients[0].apps !== null) wireAcceptButtons(body);
      if (data.clients.length > 0) {
        const getText = bucket === 'succeeded' ? () => succeededToText(data.clients) : () => failuresToText(data.clients, bucket);
        const getHtml = bucket === 'succeeded' ? () => succeededToHtml(data.clients) : () => failuresToHtml(data.clients, bucket);
        wireCopyButton(overlay, getText, getHtml);
      } else {
        hideCopyButton(overlay);
      }
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
    // see getWidgetBucket()'s own comment), so this is just a flat
    // client/backup% list, for a quick overview without leaving the popup.
    // Domain left out of every popup table here, by request -- the main
    // table (clientRowsHtml() above) still shows it, these just don't.
    // Seats/Services Backed Up ARE shown here, by request -- both already
    // ride along on every client object (seatsUsed/activeServicesCount/
    // activeServicesWithRecentBackupCount come straight from buildReport()
    // in server.js, same fields the main table's own clientRowsHtml()
    // reads), so this is a client.js-only change, no new data to fetch.
    if (data.clients[0].apps === null) {
      return `${truncatedNote}<table class="saas-protection-detail-table">
        <thead><tr><th>Client</th><th>Seats</th><th>Services Backed Up</th><th>Backup %</th></tr></thead>
        <tbody>${data.clients
          .map(
            (c) => `<tr>
          <td>${escapeHtml(c.clientName)}</td>
          <td class="ticket-number">${c.seatsUsed ?? ''}</td>
          <td class="ticket-number">${servicesCellHtml(c)}</td>
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

    // "Some Backups Failed" specifically, by request -- one flat table
    // (Client as the first column) instead of a separate .resource-group
    // block per client ('all'/'allFailed' below keep that grouping, since
    // only this bucket's layout was asked to change). The shade flips only
    // when the CLIENT changes between rows, not every row -- a client with
    // 2-3 failing app types here reads as one visual band instead of
    // alternating mid-client (see .saas-flat-client-table in styles.css,
    // which overrides the dashboard-wide per-row zebra rule for this one).
    if (data.bucket === 'someFailed') {
      let shade = false;
      let prevCustomerId = null;
      const rows = data.clients
        .map((c) => {
          if (c.customerId !== prevCustomerId) {
            shade = !shade;
            prevCustomerId = c.customerId;
          }
          const rowClass = shade ? 'saas-client-shade' : '';
          return (c.apps || []).map((a) => appFailureRowHtml(c, a, allowAccept, clientLeadingCellsHtml(c), rowClass)).join('');
        })
        .join('');
      return `${truncatedNote}<table class="saas-protection-detail-table saas-flat-client-table">
        <thead><tr class="shaded-row"><th>Client</th><th>Seats</th><th>Services Backed Up</th><th>Application</th><th>Status</th><th>Last Successful Backup</th>${allowAccept ? '<th>Accept Until</th>' : ''}</tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    }

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
              <div class="resource-group-header"><span>${escapeHtml(c.clientName)}</span><span class="count">${escapeHtml(seatsServicesText(c))}</span></div>
              ${appsHtml}
            </div>
          `;
        })
        .join('')
    );
  }

  function clientLeadingCellsHtml(c) {
    return `<td>${escapeHtml(c.clientName)}</td><td class="ticket-number">${c.seatsUsed ?? ''}</td><td class="ticket-number">${servicesCellHtml(c)}</td>`;
  }

  // Lives in .history-modal-header-actions (see openModal()'s own comment)
  // rather than in the scrollable body, so it stays visible on scroll for
  // free via the header's existing sticky positioning.
  function copyButtonHtml() {
    return '<button type="button" class="button-link button-link--small saas-copy-btn">Copy</button>';
  }

  // "Clients Succeeded" -- same flat Client/Seats/Services Backed Up/
  // Backup % table as the visible popup (the apps === null branch above),
  // not the failingClients shape every other bucket's copy builder deals
  // with.
  function succeededToText(clients) {
    const header = ['Client', 'Seats', 'Services Backed Up', 'Backup %'];
    const lines = [header.join('\t')];
    for (const c of clients) {
      lines.push([c.clientName, c.seatsUsed ?? '', servicesCellHtml(c), backupPctText(c.backupPercentage)].join('\t'));
    }
    return lines.join('\n');
  }

  function succeededToHtml(clients) {
    const rows = clients.map((c) => [
      escapeHtml(c.clientName),
      escapeHtml(c.seatsUsed ?? ''),
      escapeHtml(servicesCellHtml(c)),
      escapeHtml(backupPctText(c.backupPercentage)),
    ]);
    return copyTableHtml(['Client', 'Seats', 'Services Backed Up', 'Backup %'], rows);
  }

  // Plain-text/HTML pair for the clipboard write (see copyRichText()
  // below) -- real columns either way (tab-separated for text/plain,
  // a genuine HTML <table> for text/html). Mirrors whichever layout the
  // popup itself is showing, by request ("same format as the displayed
  // window") -- "Some Backups Failed" is a flat table on screen (Client/
  // Seats/Services Backed Up as real columns, one row per failing app),
  // while "All Backups"/"All Backups Failed" group by client on screen
  // (a heading + Seats/Services line per client, then that client's own
  // small table) -- so the copy for THOSE two is one same-shaped section
  // per client, not one giant flat table. Accept Until is left out of
  // every builder below -- it's a live date-picker + button in the popup
  // table, not a value to copy.
  function failuresToText(clients, bucket) {
    if (bucket === 'someFailed') {
      const header = ['Client', 'Seats', 'Services Backed Up', 'Application', 'Status', 'Last Successful Backup'];
      const lines = [header.join('\t')];
      for (const c of clients) {
        for (const a of c.apps || []) {
          const lastBackup = a.lastFullyProtectedTime ? formatDateTime(new Date(a.lastFullyProtectedTime).toISOString()) : '';
          lines.push([c.clientName, c.seatsUsed ?? '', servicesCellHtml(c), appTypeLabel(a.appType), a.status, lastBackup].join('\t'));
        }
      }
      return lines.join('\n');
    }

    // 'all'/'allFailed' -- one section per client: heading, Seats |
    // Services Backed Up, then that client's own Application/Status/Last
    // Successful Backup table, same seatsServicesText() the visible
    // resource-group-header uses.
    const lines = [];
    for (const c of clients) {
      lines.push(c.clientName);
      lines.push(seatsServicesText(c));
      lines.push(['Application', 'Status', 'Last Successful Backup'].join('\t'));
      for (const a of c.apps || []) {
        const lastBackup = a.lastFullyProtectedTime ? formatDateTime(new Date(a.lastFullyProtectedTime).toISOString()) : '';
        lines.push([appTypeLabel(a.appType), a.status, lastBackup].join('\t'));
      }
      // Two blank lines, not one -- same "make the gap between clients
      // read clearly" request as the HTML version's larger heading margin
      // above, just in a plain-text-safe form.
      lines.push('', '');
    }
    return lines.join('\n').trim();
  }

  function acceptedFailuresToText(items) {
    const header = ['Client', 'Application', 'Accepted From', 'Accepted Until', 'By'];
    const lines = [header.join('\t')];
    for (const i of items) {
      lines.push([i.clientName || '', appTypeLabel(i.appType), formatDate(i.startDate), formatDate(i.endDate), i.acceptedByName || ''].join('\t'));
    }
    return lines.join('\n');
  }

  // Every style lives inline, PER CELL, not once on <table>/<thead> --
  // Outlook/Word's own rendering engine (used for the desktop Outlook
  // email body, the single most likely destination for this) barely
  // supports CSS and does not reliably inherit styles down from an
  // ancestor element, which is what made the first version of this ("do
  // better", by request) paste as an unstyled, oversized, serif-font
  // table with heavy default borders -- a classic Outlook-paste rendering
  // gotcha, not a Chrome bug. Light grey borders + the dashboard's own
  // header-blue (#eff6ff, same var(--section-header-bg) value, not a new
  // one-off shade) read cleanly in Outlook, Teams, Word, and Excel alike.
  const COPY_CELL_STYLE = 'padding:4px 8px;border:1px solid #ccc;font-family:Arial,Helvetica,sans-serif;font-size:10px;text-align:left;';
  const COPY_HEADER_STYLE = `${COPY_CELL_STYLE}background:#eff6ff;font-weight:600;`;

  // `rows` is an array of already-escaped cell-string arrays. `boldFirstCol`
  // (default on) bolds the first column -- "identify the client at a
  // glance", same intent the visible popup tables' own Client column
  // carries -- but is turned off for the grouped per-client mini-tables
  // below, which have no Client column of their own (the client name is
  // the section heading above the table instead).
  function copyTableHtml(headers, rows, boldFirstCol = true) {
    const headHtml = headers.map((h) => `<th style="${COPY_HEADER_STYLE}">${escapeHtml(h)}</th>`).join('');
    const bodyHtml = rows
      .map((cells) => `<tr>${cells.map((cell, i) => `<td style="${COPY_CELL_STYLE}">${boldFirstCol && i === 0 ? `<b>${cell}</b>` : cell}</td>`).join('')}</tr>`)
      .join('');
    return `<table style="border-collapse:collapse;" cellspacing="0"><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`;
  }

  function failuresToHtml(clients, bucket) {
    if (bucket === 'someFailed') {
      const rows = [];
      for (const c of clients) {
        for (const a of c.apps || []) {
          const lastBackup = a.lastFullyProtectedTime ? formatDateTime(new Date(a.lastFullyProtectedTime).toISOString()) : '';
          rows.push([
            escapeHtml(c.clientName),
            escapeHtml(c.seatsUsed ?? ''),
            escapeHtml(servicesCellHtml(c)),
            escapeHtml(appTypeLabel(a.appType)),
            escapeHtml(a.status),
            escapeHtml(lastBackup),
          ]);
        }
      }
      return copyTableHtml(['Client', 'Seats', 'Services Backed Up', 'Application', 'Status', 'Last Successful Backup'], rows);
    }

    // 'all'/'allFailed' -- a bold heading + Seats/Services line per
    // client, then that client's own small table, same structure the
    // popup itself shows on screen (.resource-group/.resource-group-header
    // above), not one flat table. The gap between one client's table and
    // the next client's heading is a SPACER <div> with an explicit height
    // (plus a non-breaking space, so it has content and can't collapse to
    // 0), not `margin` -- margin on a block element next to a <table> is
    // exactly the CSS that Outlook/Word's own rendering engine (the most
    // likely destination for this) is notorious for dropping outright,
    // confirmed the hard way here ("no gap whatsoever"). An explicit-
    // height div is the standard cross-client-safe way to force vertical
    // space in HTML that might get pasted into Outlook.
    const spacer = '<div style="height:18px;line-height:18px;font-size:1px;">&nbsp;</div>';
    return clients
      .map((c, i) => {
        const rows = (c.apps || []).map((a) => {
          const lastBackup = a.lastFullyProtectedTime ? formatDateTime(new Date(a.lastFullyProtectedTime).toISOString()) : '';
          return [escapeHtml(appTypeLabel(a.appType)), escapeHtml(a.status), escapeHtml(lastBackup)];
        });
        const heading = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;margin:0 0 4px;"><b>${escapeHtml(c.clientName)}</b> -- ${escapeHtml(seatsServicesText(c))}</div>`;
        return (i === 0 ? '' : spacer) + heading + copyTableHtml(['Application', 'Status', 'Last Successful Backup'], rows, false);
      })
      .join('');
  }

  function acceptedFailuresToHtml(items) {
    const rows = items.map((i) => [
      escapeHtml(i.clientName || ''),
      escapeHtml(appTypeLabel(i.appType)),
      escapeHtml(formatDate(i.startDate)),
      escapeHtml(formatDate(i.endDate)),
      escapeHtml(i.acceptedByName || ''),
    ]);
    return copyTableHtml(['Client', 'Application', 'Accepted From', 'Accepted Until', 'By'], rows);
  }

  // Writes BOTH a plain-text and a styled HTML representation to the
  // clipboard -- a plain-text-only target (a terminal, a basic input)
  // still gets the plain fallback automatically; a rich-text target
  // (email, Teams, Word, a ticket note) gets the smaller/bold styled
  // version. Falls back to writeText() on a browser with no ClipboardItem
  // support.
  async function copyRichText(plainText, html) {
    if (window.ClipboardItem && navigator.clipboard.write) {
      const item = new ClipboardItem({
        'text/plain': new Blob([plainText], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      });
      await navigator.clipboard.write([item]);
    } else {
      await navigator.clipboard.writeText(plainText);
    }
  }

  // Swaps the button's own label to "Copied!" briefly for feedback -- no
  // separate flash element, same idea .order-copy-btn's own comment
  // (styles.css) already notes a dedicated Copy button could use instead
  // of a colour flash.
  function wireCopyButton(overlay, getText, getHtml) {
    const btn = overlay.querySelector('.saas-copy-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      try {
        await copyRichText(getText(), getHtml());
        const original = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => {
          btn.textContent = original;
        }, 1200);
      } catch (err) {
        alert(`Couldn't copy: ${err.message}`);
      }
    });
  }

  // The header always renders the Copy button up front (before the list
  // is known to be empty -- see openModal()'s own comment on why it has
  // to live in the header, decided before the fetch resolves). Hide it
  // rather than leave it wired to copy an empty string once the real
  // count comes back as zero.
  function hideCopyButton(overlay) {
    const btn = overlay.querySelector('.saas-copy-btn');
    if (btn) btn.hidden = true;
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
  // `leadingCellsHtml`/`rowClass` are only passed by the "Some Backups
  // Failed" flat table (the Client cell + its own per-client shade class)
  // -- the grouped 'all'/'allFailed' rendering calls this with neither,
  // same as before.
  function appFailureRowHtml(c, a, allowAccept, leadingCellsHtml, rowClass) {
    const acceptedNote = a.acceptedFailure
      ? `<br><span class="cell-flag-orange saas-accepted-note">Failure accepted for ${formatDate(a.acceptedFailure.startDate)} to ${formatDate(a.acceptedFailure.endDate)}</span>`
      : '';
    return `<tr${rowClass ? ` class="${rowClass}"` : ''}>
      ${leadingCellsHtml || ''}
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
