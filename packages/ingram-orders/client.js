export const id = "ingram-orders";
export const label = "Ingram Orders";

// Module-scope, not inside mount() -- the shell fully tears down and re-mounts a
// page's DOM on every navigation away and back, but the dynamically-imported
// module itself is cached by the browser and stays alive for the session, so a
// module-level variable survives across re-mounts and lets the last result
// restore instantly instead of coming back blank.
let lastData = null;
let lastSince = null;
let lastFilter = '';
let lastIncludeRenewals = false; // off by default, by request -- renewals are the highest-volume, least-actionable order type

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>Ingram Orders</h1>
      <form id="filter-form" class="date-form">
        <label for="include-renewals-input" class="inline-checkbox-label">
          <input type="checkbox" id="include-renewals-input" /> Show Renewal Orders
        </label>
        <label for="since-input">Since</label>
        <input type="date" id="since-input" name="since" required />
        <label for="client-input">Client</label>
        <input type="text" id="client-input" name="client" placeholder="optional, e.g. Acme* (wildcards with *)" />
        <button type="submit" id="refresh-button">Refresh</button>
        <button type="button" id="load-all-button" hidden>Load All Products &amp; Licenses</button>
      </form>
    </header>
    <p id="status" class="status">Pick a date, optionally type a client name (wildcards with *) to narrow the list, then click Refresh. Every order since that date is included, whatever its status -- renewal orders are excluded by default (tick "Show Renewal Orders" to include them). PO numbers and products aren't loaded up front -- click a client's name to fetch theirs, or use "Load All Products &amp; Licenses" above to fetch every client's at once.</p>
    <div id="summary" class="summary" hidden></div>
    <div id="results" class="results"></div>
  `;

  const form = container.querySelector('#filter-form');
  const includeRenewalsInput = container.querySelector('#include-renewals-input');
  const sinceInput = container.querySelector('#since-input');
  const clientInput = container.querySelector('#client-input');
  const refreshButton = container.querySelector('#refresh-button');
  const loadAllButton = container.querySelector('#load-all-button');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const resultsEl = container.querySelector('#results');

  // AEST (UTC+10, no DST in Queensland) "today", not the browser's own local
  // timezone -- same convention as every other date-scoped page. Defaults to
  // 7 days ago rather than today, since "orders since today" would usually
  // come back empty/near-empty on a page meant to review recent activity.
  function defaultSinceISO() {
    return new Date(Date.now() + 10 * 60 * 60 * 1000 - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }
  sinceInput.value = lastSince || defaultSinceISO();
  clientInput.value = lastFilter;
  includeRenewalsInput.checked = lastIncludeRenewals;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    load(sinceInput.value, clientInput.value, includeRenewalsInput.checked);
  });

  loadAllButton.addEventListener('click', loadAllDetails);

  // The server caches each search (keyed by the since-date, filter term, AND
  // the renewals toggle) for ~20 min. This is the fast base list -- client/
  // order number/type/status/dates -- NOT PO numbers or products, which are
  // fetched separately per client on demand (see loadDetailForClient()
  // below). Refresh always sends `force=true`, which bypasses that cache for
  // the current search and rebuilds -- a button literally labeled "Refresh"
  // should always get current data, not a cached one.
  async function load(since, clientFilter, includeRenewals) {
    refreshButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = `Loading orders since ${since}...`;
    summaryEl.hidden = true;
    resultsEl.innerHTML = '';

    try {
      const params = new URLSearchParams({ since, force: 'true' });
      if (clientFilter) params.set('client', clientFilter);
      if (includeRenewals) params.set('includeRenewals', 'true');
      const res = await fetch(`/api/ingram-orders?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastData = data;
      lastSince = since;
      lastFilter = clientFilter;
      lastIncludeRenewals = includeRenewals;
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
    // Generic status breakdown -- built from whatever keys statusCounts
    // actually has, rather than a fixed list, since every order is included
    // regardless of status (no filtering by completion state, by request).
    const statusBreakdown = Object.entries(data.statusCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([status, count]) => `${count} ${capitalize(status)}`)
      .join(', ');
    const renewalsSuffix = data.includeRenewals ? '' : ' (renewals excluded)';
    summaryEl.hidden = false;
    summaryEl.innerHTML = `<strong>${data.totalCount}</strong> order${data.totalCount === 1 ? '' : 's'} (${statusBreakdown}) across ${data.byClient.length} client${data.byClient.length === 1 ? '' : 's'} since ${data.sinceDate}${filterSuffix}${renewalsSuffix}<span class="inline-subtext"> -- as of ${formatDateTime(data.asOf)}</span>`;

    loadAllButton.hidden = data.byClient.length === 0;

    resultsEl.innerHTML = '';
    if (data.byClient.length === 0) {
      resultsEl.innerHTML = `<p class="status">No orders${filterSuffix} since ${data.sinceDate}${renewalsSuffix}.</p>`;
      return;
    }

    for (const client of data.byClient) {
      const groupEl = document.createElement('div');
      groupEl.className = 'resource-group';

      const header = document.createElement('div');
      header.className = 'resource-group-header';
      header.innerHTML = `<span><button type="button" class="link-button client-name-button">${escapeHtml(client.clientName)}</button></span>`;
      const nameButton = header.querySelector('.client-name-button');
      nameButton.addEventListener('click', () => loadDetailForClient(client, groupEl, nameButton));
      groupEl.appendChild(header);

      const table = document.createElement('table');
      table.className = 'ingram-orders-table';
      table.innerHTML = `
        <thead>
          <tr><th>Order #</th><th>Type</th><th>Status</th><th>Created</th><th>Provisioned</th><th>PO #</th><th>Product</th><th>Licenses</th></tr>
        </thead>
        <tbody>${orderRowsHtml(client.orders)}</tbody>
      `;
      groupEl.appendChild(table);
      resultsEl.appendChild(groupEl);
    }
  }

  function orderRowsHtml(orders) {
    return orders
      .map(
        (o) => `
      <tr>
        <td class="ticket-number">${escapeHtml(o.orderNumber)}</td>
        <td>${escapeHtml(capitalize(o.type))}</td>
        <td${o.status !== 'completed' ? ' class="cell-flag-blue"' : ''}>${escapeHtml(capitalize(o.status))}</td>
        <td class="ticket-number">${formatDateTime(o.creationDate)}</td>
        <td class="ticket-number">${formatDateTime(o.provisioningDate)}</td>
        <td class="ticket-number">${escapeHtml(o.poNumber ?? '')}</td>
        <td>${escapeHtml((o.products || []).map((p) => p.name).join(', '))}</td>
        <td class="ticket-number">${licensesCellHtml(o)}</td>
      </tr>`
      )
      .join('');
  }

  // Licenses cell content. Two shapes:
  //   - A `change` order with exactly one product line and a known
  //     quantity: the signed delta, colored green (added) or red (removed)
  //     -- confirmed against real data: a downgrade shows -1, adding seats
  //     shows a positive number -- followed by "= {currentTotal}" (the
  //     subscription's live current quantity, the best available proxy for
  //     "the new total after this change"; Ingram's API has no
  //     "resulting quantity" field). The "= N" part is deliberately plain
  //     text, not colored/bold, by request -- only the delta itself carries
  //     the color+weight (.cell-flag-green/.cell-flag-red).
  //   - Everything else (multiple product lines, a non-`change` order, or no
  //     quantity info at all): falls back to a plain comma-joined list of
  //     quantities (or blank), same as before -- there's no meaningful
  //     "delta + new total" concept for a fresh sale or a renewal.
  function licensesCellHtml(o) {
    const products = o.products || [];
    if (o.type === 'change' && products.length === 1 && typeof products[0].quantity === 'number') {
      const qty = products[0].quantity;
      const colorClass = qty > 0 ? 'cell-flag-green' : qty < 0 ? 'cell-flag-red' : '';
      const sign = qty > 0 ? '+' : '';
      const deltaHtml = colorClass ? `<span class="${colorClass}">${sign}${qty}</span>` : `${sign}${qty}`;
      const total = o.currentTotal;
      return total === null || total === undefined ? deltaHtml : `${deltaHtml} = ${total}`;
    }
    return escapeHtml(products.map((p) => formatLicenseEntry(p, o.type)).join(', '));
  }

  // "+1"/"-1" for a `change` order's quantity (a SIGNED delta), the plain
  // quantity for any other order type (not a delta -- e.g. "18" for a fresh
  // sale of 18 seats, or "450" for a renewal's current seat count), or blank
  // when there's no quantity info at all. Used for the fallback (non-colored)
  // Licenses rendering above -- the common single-product `change` case gets
  // the colored "+1 = 45" treatment instead, via licensesCellHtml().
  function formatLicenseEntry(p, orderType) {
    if (p.quantity === null || p.quantity === undefined) return '';
    if (orderType === 'change') return `${p.quantity > 0 ? '+' : ''}${p.quantity}`;
    return `${p.quantity}`;
  }

  // Fetches PO numbers/products for ONE client's orders and updates only
  // that client's rows in place -- every other client group on screen is
  // left exactly as it was, by request, rather than the whole page
  // reloading. Skips re-fetching if this client's detail is already loaded
  // (clicking again is a no-op, not a redundant round trip).
  async function loadDetailForClient(client, groupEl, nameButton) {
    if (client.detailLoaded || nameButton.disabled) return;
    nameButton.disabled = true;
    nameButton.textContent = `${client.clientName} (loading details...)`;

    try {
      const ids = client.orders.map((o) => o.id).join(',');
      const res = await fetch(`/api/ingram-orders/detail?ids=${encodeURIComponent(ids)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

      // Mutate the order objects in place -- they're the same objects
      // referenced from `lastData`, so this persists across a same-session
      // re-mount without needing a separate cache structure.
      for (const o of client.orders) {
        const detail = data.details[o.id];
        o.poNumber = detail?.poNumber ?? null;
        o.products = detail?.products ?? [];
        o.currentTotal = detail?.currentTotal ?? null;
      }
      client.detailLoaded = true;

      groupEl.querySelector('tbody').innerHTML = orderRowsHtml(client.orders);
      nameButton.textContent = client.clientName;
    } catch (err) {
      nameButton.textContent = `${client.clientName} (failed to load details -- click to retry)`;
    } finally {
      nameButton.disabled = false;
    }
  }

  // Loads PO numbers/products/Licenses for EVERY client still un-loaded in
  // one shot, instead of clicking each client name individually -- one
  // request carrying every un-loaded order ID across all clients together
  // (the server's own /detail route already batches with bounded
  // concurrency, so this is one round trip either way, just a bigger one),
  // rather than N separate per-client requests. Clients already loaded
  // (from an earlier individual click) are skipped, same "already loaded is
  // a no-op" rule loadDetailForClient() follows. A full re-render is the
  // simplest correct way to reflect every group's table and button label at
  // once, rather than patching each one individually.
  async function loadAllDetails() {
    if (!lastData) return;
    const clientsToLoad = lastData.byClient.filter((c) => !c.detailLoaded);
    if (clientsToLoad.length === 0) return;

    loadAllButton.disabled = true;
    refreshButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = `Loading products & licenses for ${clientsToLoad.length} client${clientsToLoad.length === 1 ? '' : 's'}...`;

    try {
      const ids = clientsToLoad.flatMap((c) => c.orders.map((o) => o.id));
      const res = await fetch(`/api/ingram-orders/detail?ids=${encodeURIComponent(ids.join(','))}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

      for (const client of clientsToLoad) {
        for (const o of client.orders) {
          const detail = data.details[o.id];
          o.poNumber = detail?.poNumber ?? null;
          o.products = detail?.products ?? [];
          o.currentTotal = detail?.currentTotal ?? null;
        }
        client.detailLoaded = true;
      }

      render(lastData);
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      loadAllButton.disabled = false;
      refreshButton.disabled = false;
    }
  }

  // No auto-load on mount, by request-following convention (same as Ingram
  // Subscriptions) -- this page only fetches when Refresh is explicitly
  // clicked. `lastData` still restores instantly on a same-session re-mount
  // (e.g. navigating to another page and back), same as every other page.
  if (lastData) render(lastData);

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
