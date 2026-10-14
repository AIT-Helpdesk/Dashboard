export const id = "saas-protection";
export const label = "SaaS Protection";

// Module-scope, not inside mount() -- same "survives a re-mount, instant
// restore" reasoning every other Ingram/Datto-style page on this dashboard
// already follows (see Ingram Subscriptions' own client.js for the fuller
// writeup).
let lastData = null;
let lastFilter = '';
let activeRender = null;

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
  // page here uses.
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
      activeRender(data);
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      refreshButton.disabled = false;
    }
  }

  function render(data) {
    statusEl.hidden = true;

    const filterSuffix = data.filterTerm ? ` matching client "${escapeHtml(data.filterTerm)}"` : '';
    summaryEl.hidden = false;
    summaryEl.innerHTML = `<strong>${data.totalClients}</strong> client${data.totalClients === 1 ? '' : 's'} (${data.totalSeats} seats total)${filterSuffix}<span class="inline-subtext"> -- as of ${formatDateTime(data.asOf)}</span>`;

    renderWidgets(data);

    resultsEl.innerHTML = '';
    if (data.byClient.length === 0) {
      resultsEl.innerHTML = `<p class="status">No clients${filterSuffix}.</p>`;
      return;
    }

    const table = document.createElement('table');
    table.className = 'saas-protection-table';
    table.innerHTML = `
      <thead>
        <tr><th>Client</th><th>Domain</th><th>Product</th><th>${seatsHeaderHtml(data.byClient)}</th><th>${servicesHeaderHtml(data.byClient)}</th><th>Backup %</th></tr>
      </thead>
      <tbody>${clientRowsHtml(data.byClient)}</tbody>
    `;
    resultsEl.appendChild(table);

    table.querySelectorAll('.client-name-button').forEach((btn) => {
      const client = data.byClient.find((c) => String(c.customerId) === btn.dataset.customerId);
      if (client) btn.addEventListener('click', () => openClientModal(client));
    });
  }

  // "All Backups" is a two-colour ring (green = services with a recent
  // backup, red = the rest) rather than a single flat colour, by request --
  // the centre number is the total SERVICE count, not a client count like
  // the other three widgets. The other three stay single-colour, with a
  // fixed colour tied to their own identity (danger/warning/healthy)
  // regardless of count -- same "fixed colour per widget identity"
  // convention About Me's own Overdue/Due Today donut cards already use
  // (ticketCountDonutHtml()).
  function renderWidgets(data) {
    widgetsEl.hidden = false;
    widgetsEl.innerHTML = '';
    widgetsEl.appendChild(allBackupsWidgetCard());
    widgetsEl.appendChild(
      widgetCard('allFailed', 'All Backups Failed', data.allFailedCount, data.totalClients, 'danger', `${data.allFailedCount} of ${data.totalClients} clients`)
    );
    widgetsEl.appendChild(
      widgetCard('someFailed', 'Some Backups Failed', data.someFailedCount, data.totalClients, 'warning', `${data.someFailedCount} of ${data.totalClients} clients`)
    );
    widgetsEl.appendChild(
      widgetCard('succeeded', 'Clients Succeeded', data.succeededCount, data.totalClients, 'healthy', `${data.succeededCount} of ${data.totalClients} clients`)
    );
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
  // blocking it, and the card shows a neutral placeholder ring until it
  // resolves. Clicking it opens the 'all' bucket's own popup, which -- by a
  // follow-up request -- shows exactly which clients/application types make
  // up the red part of this ring, not a plain client list (the server
  // reuses the exact same fetch behind the ring itself, see
  // getServiceAggregate() in server.js, so this is instant once the ring
  // has already loaded, and shares its in-flight fetch if clicked before
  // it has).
  function allBackupsWidgetCard() {
    const div = document.createElement('div');
    div.className = 'datto-card datto-card--clickable';
    div.title = 'Click to see the clients behind this number';
    div.innerHTML = `
      <div class="datto-donut-wrap">
        ${donutSvg(0, 0, STATUS_COLORS.neutral)}
        <div class="datto-donut-center"><span class="datto-donut-count">…</span></div>
      </div>
      <div class="datto-card-label">All Backups</div>
      <div class="datto-card-sub">Loading...</div>
    `;
    div.addEventListener('click', () => openWidgetModal('all', 'All Backups'));
    loadAllBackupsTotals(div);
    return div;
  }

  // Fills in the real two-colour donut once /service-totals resolves --
  // checks `card.isConnected` first in case a later Refresh click has
  // already replaced this exact element (a fresh renderWidgets() call
  // rebuilds the whole grid from scratch), so a slow, stale fetch can never
  // overwrite a newer render.
  async function loadAllBackupsTotals(card) {
    try {
      const res = await fetch('/api/saas-protection/service-totals');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      if (!card.isConnected) return;
      card.querySelector('.datto-donut-wrap').innerHTML = `
        ${twoColorDonutSvg(data.success, data.failure)}
        <div class="datto-donut-center"><span class="datto-donut-count">${data.total}</span></div>
      `;
      card.querySelector('.datto-card-sub').textContent = `${data.success} succeeded, ${data.failure} failed`;
    } catch (err) {
      if (!card.isConnected) return;
      card.querySelector('.datto-card-sub').textContent = `Error: ${err.message}`;
    }
  }

  function widgetCard(bucket, title, count, total, status, subtext) {
    const color = STATUS_COLORS[status] || STATUS_COLORS.neutral;
    const div = document.createElement('div');
    div.className = 'datto-card datto-card--clickable';
    div.title = 'Click to see the clients behind this number';
    div.innerHTML = `
      <div class="datto-donut-wrap">
        ${donutSvg(count, total, color)}
        <div class="datto-donut-center"><span class="datto-donut-count">${count}</span></div>
      </div>
      <div class="datto-card-label">${escapeHtml(title)}</div>
      <div class="datto-card-sub">${escapeHtml(subtext)}</div>
    `;
    div.addEventListener('click', () => openWidgetModal(bucket, title));
    return div;
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
    const overlay = openModal(`${client.clientName} -- SaaS Protection`);
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
  // factored out since both the per-client popup above and the four widget
  // popups below need the exact same open/close wiring, just different body
  // content.
  function openModal(title) {
    const overlay = document.createElement('div');
    overlay.className = 'history-modal-overlay';
    overlay.innerHTML = `
      <div class="history-modal-panel">
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
      <h3>Applications</h3>
      ${appsHtml}
      <h3>Seats (${data.seats.length})</h3>
      ${seatsHtml}
    `;
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
  // popup above.
  async function openWidgetModal(bucket, title) {
    const overlay = openModal(title);
    try {
      const res = await fetch(`/api/saas-protection/widget-detail?bucket=${encodeURIComponent(bucket)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      overlay.querySelector('.history-modal-body').innerHTML = widgetDetailBodyHtml(data);
    } catch (err) {
      overlay.querySelector('.history-modal-body').innerHTML = `<p class="status error">Error: ${escapeHtml(err.message)}</p>`;
    }
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

    return (
      truncatedNote +
      data.clients
        .map((c) => {
          const appsHtml = c.apps
            ? `<table class="saas-protection-detail-table">
                <thead><tr><th>Application</th><th>Status</th><th>Last Successful Backup</th></tr></thead>
                <tbody>${c.apps
                  .map(
                    (a) => `<tr>
                  <td>${escapeHtml(appTypeLabel(a.appType))}</td>
                  <td class="${a.healthy ? 'cell-flag-green' : 'cell-flag-red'}">${escapeHtml(a.status)}</td>
                  <td class="ticket-number">${a.lastFullyProtectedTime ? formatDateTime(new Date(a.lastFullyProtectedTime).toISOString()) : ''}</td>
                </tr>`
                  )
                  .join('')}</tbody>
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

  // Datto's own appType values are camelCase/compound ("Office365Exchange",
  // "Office365SharePoint", "Office365OneDrive", confirmed against real
  // data) -- split into a readable label rather than shown verbatim.
  function appTypeLabel(appType) {
    if (!appType) return '';
    return appType.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/(\d)([A-Z])/g, '$1 $2');
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
