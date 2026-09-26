export const id = "check-client";
export const label = "Check Client";

// Module-scope, not inside mount() -- the shell fully tears down and
// re-mounts a page's DOM on every navigation away and back, but the
// dynamically-imported module itself is cached by the browser and stays
// alive for the session, so a module-level variable survives across
// re-mounts and lets the last search restore instantly instead of coming
// back blank. Same convention every other page on this dashboard uses.
// Two separate client fields, by request -- Autotask and Ingram sometimes
// carry a different name for the same real client, so one wildcard search
// can't reliably match both systems at once. Ingram Client defaults to
// whatever's typed into Autotask Client (see the 'input' wiring in mount()
// below) until the user directly edits Ingram Client themselves, at which
// point the auto-fill stops for the rest of this page visit --
// lastIngramClientManuallyEdited persists that across a same-session
// remount too, so navigating away and back doesn't silently re-link a
// value the user deliberately diverged.
let lastAutotaskClient = '';
let lastExactClient = false; // off by default -- the normal wildcard/contains search
let lastIngramClient = '';
let lastIngramClientManuallyEdited = false;
// Same one-way-mirror-until-edited pattern as Ingram Client -- Datto's own
// siteName is a third naming system, but in practice tends to track
// Autotask's own client naming more closely than Ingram's catalog-style
// names do (both are this MSP's own internal naming, not a distributor's),
// so Autotask Client is the more useful default to mirror here. Not a
// `required` field, unlike Autotask/Ingram Client -- the Datto RMM section
// is additive, and a client with no matching Datto site shouldn't block
// the rest of the search.
let lastDattoSite = '';
let lastDattoSiteManuallyEdited = false;
let lastSince = null;
let lastMonth = null;
let lastOrdersData = null;
let lastSubscriptionsData = null;
let lastM365Data = null;
let lastServicesData = null;
let lastDattoData = null;

// Same six checkbox-style fields Contract Checks itself carries -- see
// packages/contract-checks/db.js/README for the schema. Duplicated here
// (not imported -- this is a browser module, contract-checks' db.js is
// server-side) same way every page duplicates small shared enums between
// client and server.
const TOGGLE_COLUMNS = [
  { field: 'checked_contract', atKey: 'checkedContractAt', label: 'Contract' },
  { field: 'm365_ok', atKey: 'm365OkAt', label: 'M365 OK' },
  { field: 'tc_elite', atKey: 'tcEliteAt', label: 'TC ELITE' },
  { field: 'tc_ess', atKey: 'tcEssAt', label: 'TC ESS' },
  { field: 'others', atKey: 'othersAt', label: 'OTHERS' },
  { field: 'all_done', atKey: 'allDoneAt', label: 'DONE' },
];
const FIELD_LABELS = {
  checked_contract: 'Checked Contract',
  m365_ok: 'M365 OK',
  tc_elite: 'TC ELITE',
  tc_ess: 'TC ESS',
  others: 'OTHERS',
  all_done: 'ALL DONE',
  info_question: 'Info Question',
  info_answer: 'Info Answer',
  ticket_note: 'Ticket Note',
};
const TOGGLE_FIELD_SET = new Set(TOGGLE_COLUMNS.map((c) => c.field));

// Same fixed display order/labels Ingram Subscriptions' own client.js uses
// for its status breakdown.
const STATUS_ORDER = ['active', 'pending', 'hold', 'terminated', 'removed'];
const STATUS_LABELS = { active: 'active', pending: 'pending', hold: 'on hold', terminated: 'terminated', removed: 'removed' };

export function mount(container) {
  container.innerHTML = `
    <div class="check-client-page">
    <header class="page-header">
      <div class="chk-title-block">
        <h1>Check Client</h1>
        <p id="client-label" class="chk-client-label" hidden></p>
      </div>
      <form id="filter-form" class="date-form date-form--stacked">
        <div class="date-form-row chk-date-row">
          <label for="since-input">Since</label>
          <input type="date" id="since-input" name="since" required />
          <label for="month-input">Month</label>
          <input type="month" id="month-input" name="month" required />
          <!-- Invisible twin of the real Search button below, by request --
               "right justify Since/Month, but only up to before the Search
               button's position." Reserves exactly the Search button's own
               rendered width (same text/classes, so it's never a guessed
               pixel value) so justify-content: flex-end on this row lands
               Since/Month's right edge at the button's LEFT edge, not the
               far right of the form. -->
          <button type="button" class="chk-search-spacer" aria-hidden="true" tabindex="-1" disabled>Search</button>
        </div>
        <div class="date-form-row">
          <label for="autotask-client-input">Autotask Client</label>
          <input type="text" id="autotask-client-input" name="autotaskClient" placeholder="e.g. Acme* (wildcards with *)" required />
          <label class="inline-checkbox-label chk-exact-client-label" title="Force an exact match on the Autotask Client name (instead of the usual wildcard/contains search)">
            <input type="checkbox" id="exact-client-input" />
          </label>
          <label for="ingram-client-input">Ingram Client</label>
          <input type="text" id="ingram-client-input" name="ingramClient" placeholder="e.g. Acme* (wildcards with *)" required />
          <button type="submit" id="search-button">Search</button>
        </div>
        <div class="date-form-row">
          <label for="datto-site-input">Datto Site</label>
          <input type="text" id="datto-site-input" name="dattoSite" placeholder="e.g. Acme* (wildcards with *, optional)" />
        </div>
      </form>
    </header>
    <h2 class="chk-section-heading">Orders <span class="inline-subtext">(Ingram Micro)</span></h2>
    <p id="orders-status" class="status" hidden></p>
    <div id="orders-summary" class="summary" hidden></div>
    <div id="orders-results" class="results"></div>

    <h2 class="chk-section-heading">Subscriptions <span class="inline-subtext">(Ingram Micro)</span></h2>
    <p id="subs-status" class="status" hidden></p>
    <div id="subs-summary" class="summary" hidden></div>
    <div id="subs-results" class="results"></div>

    <h2 class="chk-section-heading">Microsoft 365 Tenancy <span class="inline-subtext">(Ingram tenant ID &rarr; Rewst &rarr; M365)</span></h2>
    <p id="m365-status" class="status" hidden></p>
    <div id="m365-summary" class="summary" hidden></div>
    <div id="m365-results" class="results"></div>

    <h2 class="chk-section-heading">Contracts <span class="inline-subtext">(Autotask)</span></h2>
    <p id="services-status" class="status" hidden></p>
    <div id="services-summary" class="summary" hidden></div>
    <div id="services-results" class="results"></div>

    <h2 class="chk-section-heading">Datto RMM <span class="inline-subtext">(devices &amp; open alerts)</span></h2>
    <p id="datto-status" class="status" hidden></p>
    <div id="datto-summary" class="summary" hidden></div>
    <div id="datto-results" class="results"></div>
    </div>
  `;

  const form = container.querySelector('#filter-form');
  const clientLabelEl = container.querySelector('#client-label');
  const autotaskClientInput = container.querySelector('#autotask-client-input');
  const exactClientInput = container.querySelector('#exact-client-input');
  const ingramClientInput = container.querySelector('#ingram-client-input');
  const dattoSiteInput = container.querySelector('#datto-site-input');
  const sinceInput = container.querySelector('#since-input');
  const monthInput = container.querySelector('#month-input');
  const searchButton = container.querySelector('#search-button');

  const ordersStatusEl = container.querySelector('#orders-status');
  const ordersSummaryEl = container.querySelector('#orders-summary');
  const ordersResultsEl = container.querySelector('#orders-results');
  const subsStatusEl = container.querySelector('#subs-status');
  const subsSummaryEl = container.querySelector('#subs-summary');
  const subsResultsEl = container.querySelector('#subs-results');
  const m365StatusEl = container.querySelector('#m365-status');
  const m365SummaryEl = container.querySelector('#m365-summary');
  const m365ResultsEl = container.querySelector('#m365-results');
  const servicesStatusEl = container.querySelector('#services-status');
  const servicesSummaryEl = container.querySelector('#services-summary');
  const servicesResultsEl = container.querySelector('#services-results');
  const dattoStatusEl = container.querySelector('#datto-status');
  const dattoSummaryEl = container.querySelector('#datto-summary');
  const dattoResultsEl = container.querySelector('#datto-results');

  // AEST (UTC+10, no DST in Queensland) "today", not the browser's own local
  // timezone -- same defaultSinceISO() Contract Checks' own client.js uses.
  // Defaults to the 1st of the current month -- EXCEPT when today is still
  // early in the month (before the 7th), where the 1st of LAST month is the
  // more useful starting point instead.
  function defaultSinceISO() {
    const aestNow = new Date(Date.now() + 10 * 60 * 60 * 1000);
    const year = aestNow.getUTCFullYear();
    const month = aestNow.getUTCMonth();
    const day = aestNow.getUTCDate();
    const targetMonth = day < 7 ? month - 1 : month;
    return new Date(Date.UTC(year, targetMonth, 1)).toISOString().slice(0, 10);
  }

  // Same currentMonthISO() Contract Services' own client.js uses.
  function currentMonthISO() {
    return new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString().slice(0, 7);
  }

  autotaskClientInput.value = lastAutotaskClient;
  exactClientInput.checked = lastExactClient;
  ingramClientInput.value = lastIngramClient;
  dattoSiteInput.value = lastDattoSite;
  sinceInput.value = lastSince || defaultSinceISO();
  monthInput.value = lastMonth || currentMonthISO();

  // "Client: <name>" under the page title, by request -- the REAL resolved
  // client name(s) each system actually matched, not the raw search text
  // typed into the boxes (a wildcard like "Acme*" resolves to whatever
  // real name(s) it matched). Widens to "Client: <Autotask names> /
  // <Ingram names>" the moment the two systems resolve to a different set
  // of names, so a real cross-system name mismatch is obvious at a glance
  // -- the whole reason these two fields were split apart in the first
  // place. Can only be computed from fetched data (not from the input
  // boxes), so this is called from each render*() function below as its
  // own section's data arrives/changes, not live as the fields are typed.
  // Autotask's resolved name(s) come from Contract Services' own
  // byCompany; Ingram's come from Orders' and Subscriptions' own byClient,
  // merged -- either one alone can be empty for a client with no matching
  // rows in that particular section (e.g. a brand new client with active
  // subscriptions but no order history yet), so neither is trusted alone.
  function uniqueNonEmpty(arr) {
    return [...new Set(arr.filter(Boolean))];
  }
  function updateClientLabel() {
    const autotaskNames = uniqueNonEmpty(lastServicesData ? lastServicesData.byCompany.map((c) => c.companyName) : []);
    const ingramNames = uniqueNonEmpty([
      ...(lastOrdersData ? lastOrdersData.byClient.map((c) => c.clientName) : []),
      ...(lastSubscriptionsData ? lastSubscriptionsData.byClient.map((c) => c.clientName) : []),
    ]);
    if (autotaskNames.length === 0 && ingramNames.length === 0) {
      clientLabelEl.hidden = true;
      return;
    }
    // More than one real match, by request, is flagged as "Multiple
    // Matches (<the search text that caused it>)" rather than listing every
    // name -- a wide wildcard matching several real clients isn't the same
    // situation as a genuine single-client name mismatch across systems,
    // and spelling out every match here got noisy fast.
    function nameFor(names, searchInput, notFoundText) {
      if (names.length === 0) return notFoundText;
      if (names.length > 1) return `Multiple Matches (${searchInput.value.trim()})`;
      return names[0];
    }
    const autotaskText = nameFor(autotaskNames, autotaskClientInput, '(no Autotask match)');
    const ingramText = nameFor(ingramNames, ingramClientInput, '(no Ingram match)');
    const sameSet = autotaskNames.length === ingramNames.length && autotaskNames.every((n) => ingramNames.includes(n));
    clientLabelEl.hidden = false;
    clientLabelEl.textContent = sameSet ? `Client: ${autotaskText}` : `Client: ${autotaskText} / ${ingramText}`;
  }

  // Ingram Client mirrors Autotask Client live as it's typed, UNTIL Ingram
  // Client itself receives a real user edit -- programmatic value changes
  // (the mirror below) never fire 'input', only genuine typing does, so
  // this is a clean one-way "linked until diverged" switch, by request.
  let ingramClientManuallyEdited = lastIngramClientManuallyEdited;
  let dattoSiteManuallyEdited = lastDattoSiteManuallyEdited;
  autotaskClientInput.addEventListener('input', () => {
    if (!ingramClientManuallyEdited) ingramClientInput.value = autotaskClientInput.value;
    if (!dattoSiteManuallyEdited) dattoSiteInput.value = autotaskClientInput.value;
  });
  ingramClientInput.addEventListener('input', () => {
    ingramClientManuallyEdited = true;
  });
  dattoSiteInput.addEventListener('input', () => {
    dattoSiteManuallyEdited = true;
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    search();
  });

  // Fires all three sections' fetches in parallel -- Section 1 (Orders) and
  // Section 2 (Subscriptions) both key off Ingram Client (their own
  // client_name data is Ingram-sourced, same as Ingram Subscriptions' own
  // page); Section 3 (Contract Services) keys off Autotask Client (Autotask
  // companyName). One of these being slow or down must not block the other
  // two -- each load*() function below catches its own errors and renders
  // its own section's status independently, so Promise.allSettled here is
  // only about running them concurrently and knowing when ALL are done (to
  // re-enable the Search button) -- not about propagating failures.
  async function search() {
    const autotaskClient = autotaskClientInput.value.trim();
    const exactClient = exactClientInput.checked;
    const ingramClient = ingramClientInput.value.trim();
    const dattoSite = dattoSiteInput.value.trim();
    const since = sinceInput.value;
    const month = monthInput.value;
    searchButton.disabled = true;
    try {
      // Datto RMM has no dependency on the other sections' own results
      // (unlike Microsoft 365 Tenancy below), so it runs alongside the
      // first three rather than waiting on them.
      await Promise.allSettled([
        loadOrders(ingramClient, since),
        loadSubscriptions(ingramClient),
        loadServices(autotaskClient, exactClient, month),
        loadDattoRmm(dattoSite),
      ]);
      // Runs only after all three above have settled -- Microsoft 365
      // Tenancy's own fallback path (see loadM365Tenancy()'s comment) wants
      // the resolved Autotask name too, not just Ingram's, and that only
      // exists once Contract Services' own load has finished.
      await loadM365Tenancy();
    } finally {
      lastAutotaskClient = autotaskClient;
      lastExactClient = exactClient;
      lastIngramClient = ingramClient;
      lastIngramClientManuallyEdited = ingramClientManuallyEdited;
      lastDattoSite = dattoSite;
      lastDattoSiteManuallyEdited = dattoSiteManuallyEdited;
      lastSince = since;
      lastMonth = month;
      searchButton.disabled = false;
    }
  }

  // ---------------------------------------------------------------------
  // Section 1 -- Orders (Contract Checks, read-only)
  // ---------------------------------------------------------------------

  async function loadOrders(client, since) {
    ordersStatusEl.hidden = false;
    ordersStatusEl.className = 'status loading';
    ordersStatusEl.textContent = `Loading orders for "${client}"...`;
    ordersSummaryEl.hidden = true;
    ordersResultsEl.innerHTML = '';
    try {
      const params = new URLSearchParams({ client, since });
      const data = await fetchJson(`/api/check-client/orders?${params.toString()}`, 'GET');
      lastOrdersData = data;
      renderOrders(data);
    } catch (err) {
      ordersStatusEl.className = 'status error';
      ordersStatusEl.textContent = `Error: ${err.message}`;
    }
  }

  function renderOrders(data) {
    updateClientLabel();
    ordersStatusEl.hidden = true;
    const statusBreakdown = Object.entries(data.statusCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([status, count]) => `${count} ${capitalize(status)}`)
      .join(', ');
    ordersSummaryEl.hidden = false;
    ordersSummaryEl.innerHTML = `<strong>${data.totalCount}</strong> order${data.totalCount === 1 ? '' : 's'} (${statusBreakdown}) across ${data.byClient.length} client${data.byClient.length === 1 ? '' : 's'} since ${data.sinceDate}`;

    ordersResultsEl.innerHTML = '';
    if (data.byClient.length === 0) {
      ordersResultsEl.innerHTML = '<p class="status">No orders found.</p>';
      return;
    }
    for (const client of data.byClient) {
      const groupEl = document.createElement('div');
      groupEl.className = 'resource-group';

      const header = document.createElement('div');
      header.className = 'resource-group-header';
      header.innerHTML = `<span>${escapeHtml(client.clientName || '(unknown)')}</span>`;
      groupEl.appendChild(header);

      const table = document.createElement('table');
      table.className = 'contract-checks-table';
      table.innerHTML = `
        <thead>
          <tr>
            <th>Order #</th><th>Type</th><th>Status</th><th>Created</th><th>Provisioned</th>
            <th>PO #</th><th>Product</th><th>Licenses</th>
            ${TOGGLE_COLUMNS.filter((c) => c.field !== 'all_done')
              .map((c) => `<th>${escapeHtml(c.label)}</th>`)
              .join('')}
            <th>Info</th><th>DONE</th>
          </tr>
        </thead>
        <tbody>${orderRowsHtml(client.orders)}</tbody>
      `;
      groupEl.appendChild(table);
      ordersResultsEl.appendChild(groupEl);
      wireOrderRowActions(groupEl);
    }
  }

  // Read-only variant of Contract Checks' own orderRowsHtml() -- no leading
  // row-select column (no bulk update, by request), every toggle checkbox
  // disabled with no change listener, PO # edit pencil dropped (nothing
  // here is editable). The PO#/ticket link itself stays -- opening Autotask
  // is navigation, not an edit.
  function orderRowsHtml(orders) {
    return orders
      .map(
        (o) => `
      <tr>
        <td class="ticket-number"><button type="button" class="wsp-icon-btn cc-history-btn" data-id="${o.id}" title="${historyIconTitle(o)}">\u{1F553}</button> ${escapeHtml(o.orderNumber)}</td>
        <td>${escapeHtml(capitalize(o.orderType))}</td>
        <td${o.status !== 'completed' ? ' class="cell-flag-blue"' : ''}>${escapeHtml(capitalize(o.status))}</td>
        <td class="ticket-number">${formatDateTime(o.creationDate)}</td>
        <td class="ticket-number">${provisionedCellHtml(o)}</td>
        <td class="ticket-number">${poNumberCellHtml(o)}</td>
        <td class="cc-product-cell">${escapeHtml((o.products || []).map((p) => p.name).join(', '))}</td>
        <td class="ticket-number">${licensesCellHtml(o)}</td>
        ${TOGGLE_COLUMNS.filter((c) => c.field !== 'all_done')
          .map((c) => `<td>${toggleCellHtml(o, c)}</td>`)
          .join('')}
        <td>${infoIconsHtml(o)}</td>
        <td>${toggleCellHtml(o, TOGGLE_COLUMNS.find((c) => c.field === 'all_done'))}</td>
      </tr>`
      )
      .join('');
  }

  function provisionedCellHtml(o) {
    if (o.status === 'cancelled') return `<span class="text-highlight-blue">Order Cancelled</span>`;
    if (o.provisioningDate) return formatDateTime(o.provisioningDate);
    if (o.status === 'processing' && o.pendingDate) {
      return `<span class="cell-flag-red">${formatDate(o.pendingDate)}</span>`;
    }
    return '';
  }

  function historyIconTitle(o) {
    const count = o.historyCount || 0;
    return `View history (${count} record${count === 1 ? '' : 's'})`;
  }

  function poNumberCellHtml(o) {
    if (!o.poNumber) return '';
    const linkOrText = o.ticketUrl
      ? `<a href="${escapeHtml(o.ticketUrl)}" target="_blank" rel="noopener" class="cc-ticket-link">${escapeHtml(o.poNumber)}</a>`
      : `<span title="Ticket not found in Autotask">${escapeHtml(o.poNumber)}</span>`;
    // Small icon after the link, by request, when this ticket's status
    // history ever passed through "Rewst - Stage Done" -- same
    // attachRewstStageDoneFlags() flag Contract Checks' own page shows
    // (check-client/server.js's /orders route calls it too, since this
    // page's Orders section bypasses that page's own GET / route where it
    // normally runs).
    // Rewst's own real logo (packages/shell/public/rewst-icon.png), by
    // request -- served as a plain static asset, same convention as
    // logo.png/favicon.png already sitting in that same folder.
    const rewstIcon = o.hasRewstStageDone
      ? `<img src="/rewst-icon.png" class="cc-rewst-icon" alt="Rewst" title="This ticket passed through Rewst - Stage Done" />`
      : '';
    // After the link, by request -- same two mutually exclusive icons
    // Contract Checks' own page shows (see that page's own poFlagIconHtml()
    // comment for the full reasoning): green check when o.poNumberManual
    // (a human already confirmed this PO#/ticket), else "?" when
    // o.ticketDateMismatch (the ticket's own creation date is more than a
    // day from the order's -- worth a second look). check-client/server.js's
    // /orders route calls attachTicketDetails() (where the mismatch is
    // computed) since this page bypasses Contract Checks' own GET / route.
    const flagIcon = o.poNumberManual
      ? `<span class="cc-po-manual-icon" title="PO # / Ticket manually entered">✓</span>`
      : o.ticketDateMismatch
        ? `<span class="cc-po-mismatch-icon" title="This ticket was created more than a day away from the order's own creation date -- worth double-checking this is the right ticket">?</span>`
        : '';
    return `${linkOrText}${flagIcon}${rewstIcon}`;
  }

  function licensesCellHtml(o) {
    const products = o.products || [];
    if (o.orderType === 'change' && products.length === 1 && typeof products[0].quantity === 'number') {
      const qty = products[0].quantity;
      const total = o.currentTotal;
      const isPendingAdd = qty > 0 && o.status === 'processing';

      if (isPendingAdd && typeof total === 'number' && qty < total) {
        const effectiveDelta = qty - total;
        return `<span class="cell-flag-red">${effectiveDelta}</span> (${total})`;
      }

      const colorClass = qty > 0 ? (isPendingAdd ? 'cell-flag-blue' : 'cell-flag-green') : qty < 0 ? 'cell-flag-red' : '';
      const sign = qty > 0 && !isPendingAdd ? '+' : '';
      const deltaHtml = colorClass ? `<span class="${colorClass}">${sign}${qty}</span>` : `${sign}${qty}`;
      return total === null || total === undefined ? deltaHtml : `${deltaHtml} (${total})`;
    }
    return escapeHtml(products.map((p) => formatLicenseEntry(p, o.orderType)).join(', '));
  }

  function formatLicenseEntry(p, orderType) {
    if (p.quantity === null || p.quantity === undefined) return '';
    if (orderType === 'change') return `${p.quantity > 0 ? '+' : ''}${p.quantity}`;
    return `${p.quantity}`;
  }

  function toggleHistoryTitle(historyArr) {
    if (!historyArr || historyArr.length === 0) return 'No history yet';
    return historyArr.map((e) => `${e.action === 'on' ? 'ON' : 'OFF'} - ${formatDateTime(e.at)} by ${e.byName}`).join('\n');
  }

  // Always disabled, no change listener -- read-only by request. `checked`
  // and the hover-history tooltip (the native `title` attribute) are pure
  // display and carry over unchanged from Contract Checks' own version.
  function toggleCellHtml(o, col) {
    const checked = !!o[col.atKey];
    const history = o.toggleHistory && o.toggleHistory[col.field];
    return `<input type="checkbox" disabled ${checked ? 'checked' : ''} title="${escapeHtml(toggleHistoryTitle(history))}" />`;
  }

  function infoIconsHtml(o) {
    const hasQuestion = !!o.infoQuestion;
    const hasAnswer = !!o.infoAnswer;
    const hasNote = !!o.ticketNote;
    const dataAttrs = `data-id="${o.id}"`;

    let qaHtml;
    if (!hasQuestion && !hasAnswer) {
      qaHtml = `<span class="wsp-qa-icon wsp-qa-icon--q wsp-qa-icon--empty cc-info-icon" ${dataAttrs} title="No question/answer left">?</span>`;
    } else if (!hasQuestion && hasAnswer) {
      qaHtml = `<span class="wsp-qa-icon wsp-qa-icon--a wsp-qa-icon--set cc-info-icon" ${dataAttrs} title="${escapeHtml(o.infoAnswer)}">A</span>`;
    } else {
      const qIcon = `<span class="wsp-qa-icon wsp-qa-icon--q wsp-qa-icon--set cc-info-icon" ${dataAttrs} title="${escapeHtml(o.infoQuestion)}">?</span>`;
      qaHtml = hasAnswer ? `${qIcon}<span class="wsp-qa-icon wsp-qa-icon--a wsp-qa-icon--set cc-info-icon" ${dataAttrs} title="${escapeHtml(o.infoAnswer)}">A</span>` : qIcon;
    }
    const tIcon = `<span class="wsp-qa-icon wsp-qa-icon--t ${hasNote ? 'wsp-qa-icon--set' : 'wsp-qa-icon--empty'} cc-ticket-note-icon" ${dataAttrs} title="${hasNote ? escapeHtml(o.ticketNote) : 'No ticket note left'}">T</span>`;
    return `${qaHtml}${tIcon}`;
  }

  function findOrder(id) {
    if (!lastOrdersData) return null;
    for (const client of lastOrdersData.byClient) {
      const found = client.orders.find((o) => String(o.id) === String(id));
      if (found) return found;
    }
    return null;
  }

  // Same "open as a real separate window, sized/positioned on the same
  // monitor" behaviour Contract Checks' own client.js uses for its PO#
  // link, reused verbatim.
  function openInNewWindow(url) {
    const width = Math.round(window.outerWidth * 0.9);
    const height = Math.round(window.outerHeight * 0.9);
    const left = window.screenX + Math.round((window.outerWidth - width) / 2);
    const top = window.screenY + Math.round((window.outerHeight - height) / 2);
    window.open(url, '_blank', `noopener,width=${width},height=${height},left=${left},top=${top}`);
  }

  function wireOrderRowActions(groupEl) {
    groupEl.querySelectorAll('.cc-ticket-link').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        openInNewWindow(el.href);
      });
    });
    groupEl.querySelectorAll('.cc-info-icon').forEach((el) => {
      el.addEventListener('click', () => openInfoModalReadOnly(findOrder(el.dataset.id)));
    });
    groupEl.querySelectorAll('.cc-ticket-note-icon').forEach((el) => {
      el.addEventListener('click', () => openTicketNoteModalReadOnly(findOrder(el.dataset.id)));
    });
    groupEl.querySelectorAll('.cc-history-btn').forEach((el) => {
      el.addEventListener('click', () => openHistoryModal(el.dataset.id, findOrder(el.dataset.id)));
    });
  }

  // Read-only variant of Contract Checks' own openInfoModal() -- same shell,
  // fields are readonly and there's no Save button, just Close.
  function openInfoModalReadOnly(item) {
    const overlay = document.createElement('div');
    overlay.className = 'history-modal-overlay';
    const title = item ? `${item.orderNumber} -- Info` : 'Info';
    overlay.innerHTML = `
      <div class="history-modal-panel wsp-qa-modal-panel">
        <div class="history-modal-panel-header">
          <span>${escapeHtml(title)}</span>
          <button type="button" class="history-modal-close" aria-label="Close">✕</button>
        </div>
        <div class="history-modal-body">
          <label class="wsp-qa-modal-label">
            <span class="wsp-qa-icon wsp-qa-icon--q wsp-qa-icon--set">?</span>
            <input type="text" class="wsp-field" value="${escapeHtml((item && item.infoQuestion) || '')}" readonly />
          </label>
          <label class="wsp-qa-modal-label">
            <span class="wsp-qa-icon wsp-qa-icon--a wsp-qa-icon--set">A</span>
            <input type="text" class="wsp-field" value="${escapeHtml((item && item.infoAnswer) || '')}" readonly />
          </label>
          <div class="wsp-form-actions">
            <button type="button" class="cc-info-close-button">Close</button>
          </div>
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
    overlay.querySelector('.cc-info-close-button').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
  }

  // Read-only variant of Contract Checks' own openTicketNoteModal() -- same
  // wider panel (.cc-ticket-note-modal-panel), textarea is readonly, no
  // Save/Get Template/Edit Template buttons, just Close.
  function openTicketNoteModalReadOnly(item) {
    const overlay = document.createElement('div');
    overlay.className = 'history-modal-overlay';
    const title = item ? `${item.orderNumber} -- Ticket Note` : 'Ticket Note';
    overlay.innerHTML = `
      <div class="history-modal-panel wsp-qa-modal-panel cc-ticket-note-modal-panel">
        <div class="history-modal-panel-header">
          <span>${escapeHtml(title)}</span>
          <button type="button" class="history-modal-close" aria-label="Close">✕</button>
        </div>
        <div class="history-modal-body">
          <label class="wsp-qa-modal-label wsp-qa-modal-label--top">
            <span class="wsp-qa-icon wsp-qa-icon--t wsp-qa-icon--set">T</span>
            <textarea class="wsp-field" rows="11" readonly>${escapeHtml((item && item.ticketNote) || '')}</textarea>
          </label>
          <div class="wsp-form-actions">
            <button type="button" class="cc-ticket-note-close-button">Close</button>
          </div>
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
    overlay.querySelector('.cc-ticket-note-close-button').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
  }

  // History is already pure view-only in Contract Checks itself -- reused
  // as-is, calling that page's own public route directly (the item IDs
  // Check Client's /orders route returns come straight from Contract
  // Checks' own DB rows, so they're the exact same IDs that route expects).
  async function openHistoryModal(itemId, item) {
    const overlay = document.createElement('div');
    overlay.className = 'history-modal-overlay';
    const title = item ? `${item.orderNumber} -- History` : `Item #${itemId} -- History`;
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

    try {
      const data = await fetchJson(`/api/contract-checks/items/${itemId}/history`, 'GET');
      const body = overlay.querySelector('.history-modal-body');
      if (!data.history || data.history.length === 0) {
        body.innerHTML = '<p class="status">No history found.</p>';
        return;
      }
      body.innerHTML = `<ul class="history-modal-list">${data.history.map(historyEntryHtml).join('')}</ul>`;
    } catch (err) {
      overlay.querySelector('.history-modal-body').innerHTML = `<p class="status error">Error: ${escapeHtml(err.message)}</p>`;
    }
  }

  function historyEntryHtml(entry) {
    const label = FIELD_LABELS[entry.field] || entry.field;
    let changeText;
    if (TOGGLE_FIELD_SET.has(entry.field)) {
      changeText = `${escapeHtml(label)}: ${entry.newValue ? 'ON' : 'OFF'}`;
    } else if (entry.field === 'ticket_note') {
      const block = (value) =>
        value ? `<div class="cc-history-note-block">${escapeHtml(value)}</div>` : `<div class="cc-history-note-block cc-history-note-empty">(none)</div>`;
      changeText = `<div>${escapeHtml(label)}:</div><div class="cc-history-note-label">Before</div>${block(entry.oldValue)}<div class="cc-history-note-label">After</div>${block(entry.newValue)}`;
    } else {
      changeText = `${escapeHtml(label)}: ${escapeHtml(entry.oldValue || '(none)')} → ${escapeHtml(entry.newValue || '(none)')}`;
    }
    const when = `${escapeHtml(entry.changedByName)} -- ${escapeHtml(formatDateTime(entry.changedAt))}`;
    return `<li class="history-modal-entry"><div>${changeText}</div><div class="history-modal-when">${when}</div></li>`;
  }

  // ---------------------------------------------------------------------
  // Section 2 -- Subscriptions (Ingram Subscriptions)
  // ---------------------------------------------------------------------

  async function loadSubscriptions(client) {
    subsStatusEl.hidden = false;
    subsStatusEl.className = 'status loading';
    subsStatusEl.textContent = `Loading subscriptions for "${client}"...`;
    subsSummaryEl.hidden = true;
    subsResultsEl.innerHTML = '';
    // Stale the moment a new search starts -- Microsoft 365 Tenancy is
    // derived from this section's (and Contract Services') own results (see
    // loadM365Tenancy() below), so the previous search's answer shouldn't
    // linger on screen while a new one is in flight.
    m365StatusEl.hidden = false;
    m365StatusEl.className = 'status loading';
    m365StatusEl.textContent = 'Waiting on Subscriptions and Contracts...';
    m365SummaryEl.hidden = true;
    m365ResultsEl.innerHTML = '';
    try {
      const params = new URLSearchParams({ client });
      const data = await fetchJson(`/api/check-client/subscriptions?${params.toString()}`, 'GET');
      lastSubscriptionsData = data;
      renderSubscriptions(data);
    } catch (err) {
      subsStatusEl.className = 'status error';
      subsStatusEl.textContent = `Error: ${err.message}`;
    }
  }

  // Microsoft 365 Tenancy -- runs after Orders/Subscriptions/Contracts have
  // ALL settled (called from search() itself, not from any one section's
  // own load), since its fallback path wants Contract Services' resolved
  // Autotask name too, not just Ingram's.
  //
  // PRIMARY: joins the client's real Microsoft tenant ID (Ingram's own
  // ms_customer_id, confirmed elsewhere this session to BE the real MS
  // tenant id -- see Match IDs) against Rewst's own tenant_id field for an
  // EXACT match, by request ("use the Tenant ID from Ingram Micro... is
  // that a better choice?") -- an exact GUID join can't misfire the way
  // name matching sometimes does (e.g. "Sleepys" vs "Sleepy's Pty Ltd").
  // Needs a real Microsoft-named Ingram subscription to read the tenant id
  // off of, and exactly one resolved Ingram client (an ambiguous multi-
  // client match isn't safe to guess a subscription from).
  //
  // FALLBACK, by request ("if not found in Ingram Micro, only then try
  // Rewst"): when there's no such subscription, the resolved Autotask/
  // Ingram client NAME (preferring Autotask's, since Autotask is this
  // MSP's own system of record) is sent instead, and server.js's own
  // matchRewstCustomerByName() -- the same normalize+cascade approach
  // Match IDs' bigger cross-reference uses -- tries to find the right
  // Rewst customer that way. Server-side always tries the tenant-id path
  // first when a subscriptionId is sent, falling back to the name only if
  // that doesn't resolve -- so sending both here is safe, never a
  // name-match overriding a good tenant-id match.
  async function loadM365Tenancy() {
    m365StatusEl.hidden = false;
    m365StatusEl.className = 'status';
    m365SummaryEl.hidden = true;
    m365ResultsEl.innerHTML = '';

    let subscriptionId = null;
    if (lastSubscriptionsData && lastSubscriptionsData.byClient.length === 1) {
      const msSub = lastSubscriptionsData.byClient[0].subscriptions.find((s) => /microsoft/i.test(s.name));
      if (msSub) subscriptionId = msSub.id;
    }

    const autotaskNames = lastServicesData ? [...new Set(lastServicesData.byCompany.map((c) => c.companyName))] : [];
    const ingramNames = lastSubscriptionsData ? [...new Set(lastSubscriptionsData.byClient.map((c) => c.clientName))] : [];
    const clientName = autotaskNames.length === 1 ? autotaskNames[0] : ingramNames.length === 1 ? ingramNames[0] : null;

    if (!subscriptionId && !clientName) {
      m365StatusEl.textContent = 'No single client resolved above -- narrow the search to look up Microsoft 365 Tenancy.';
      return;
    }

    m365StatusEl.className = 'status loading';
    m365StatusEl.textContent = 'Loading Microsoft 365 Tenancy...';
    try {
      const params = new URLSearchParams();
      if (subscriptionId) params.set('subscriptionId', subscriptionId);
      if (clientName) params.set('clientName', clientName);
      const data = await fetchJson(`/api/check-client/m365-tenancy?${params.toString()}`, 'GET');
      lastM365Data = data;
      renderM365Tenancy(data);
    } catch (err) {
      m365StatusEl.className = 'status error';
      m365StatusEl.textContent = `Error: ${err.message}`;
    }
  }

  function renderM365Tenancy(data) {
    if (!data.matched) {
      m365StatusEl.hidden = false;
      m365StatusEl.className = 'status';
      m365StatusEl.textContent = m365UnmatchedText(data);
      m365SummaryEl.hidden = true;
      m365ResultsEl.innerHTML = '';
      return;
    }
    m365StatusEl.hidden = true;
    m365SummaryEl.hidden = false;
    const sourceText = data.tenantSource === 'rewst-name-match' ? ' (matched by name via Rewst -- no Ingram Microsoft subscription found)' : '';
    // The client name was rendering at the line's own normal (larger)
    // font-size while the Tenant ID right beside it sits in
    // .inline-subtext's smaller 0.85em -- by request, sized to match
    // (font-size only, kept bold and at the normal text colour rather than
    // .inline-subtext's muted grey, so it still reads as the emphasised
    // "who" of the line, just no longer oversized next to the Tenant ID).
    m365SummaryEl.innerHTML = `<strong>${data.skus.length}</strong> SKU${data.skus.length === 1 ? '' : 's'} for <strong style="font-size: 0.85em">${escapeHtml(data.rewstClientName)}</strong><span class="inline-subtext"> -- Tenant ID ${escapeHtml(data.tenantId)}${sourceText}</span>`;

    m365ResultsEl.innerHTML = '';
    if (data.skus.length === 0) {
      m365ResultsEl.innerHTML = '<p class="status">No subscribed SKUs found.</p>';
      return;
    }
    // Split into the "Product Table" (everything worth checking -- real
    // paid products, PLUS anything unmapped, since the whole point of that
    // half is surfacing rows that still need a mapping) and the "Free
    // Product Table" (every mapped row product_mappings' own `free` column
    // marks as free -- Pacgold was the confirmed test case), by request --
    // a client with several free SKUs was burying the products actually
    // worth checking. The free table stays out of sight behind a button,
    // and that button only renders at all when there's at least one free
    // row to show.
    // Alphabetical by Product Name, with unmapped rows (no product_mappings
    // match at all, so no name to sort by) always pushed to the bottom
    // rather than interleaved by raw SKU -- by request. Client-side, not
    // server.js's own sort-by-raw-SKU (still there for its own reasons) --
    // this ordering only makes sense once productName is known and the
    // Free split has already happened.
    function sortM365(skus) {
      return [...skus].sort((a, b) => {
        if (!a.productName && !b.productName) return a.sku.localeCompare(b.sku);
        if (!a.productName) return 1;
        if (!b.productName) return -1;
        return a.productName.localeCompare(b.productName, undefined, { sensitivity: 'base' });
      });
    }
    const mainSkus = sortM365(data.skus.filter((s) => !s.isFree));
    const freeSkus = sortM365(data.skus.filter((s) => s.isFree));
    // Bare table (no .ingram-subscriptions-table -- that class's own
    // nth-child column widths are tuned for THAT section's 8 columns, wrong
    // fit for this one's 5), same plain-table-in-a-.resource-group pattern
    // CSP Customers' own client.js uses for its own differently-shaped table.
    // Product Name is looked up server-side from Contract Checks' own
    // product_mappings table, matched on its Microsoft SKU column. Falls
    // back to the raw SKU itself (muted, via .inline-subtext) when nothing
    // matches -- that reference table doesn't cover every SKU yet, and a
    // blank cell would read as a bug rather than "not mapped yet". The raw
    // SKU and the matched row's Ingram Micro Product Name both come back
    // too but, by request, neither is its own column -- shown only as this
    // cell's hover title, so they're there to check without taking up
    // table width.
    // .chk-m365-table -- by request, this table shouldn't stretch to the
    // page's full width the way a plain table normally does dashboard-wide
    // (table { width: 100% }); it's only 5 narrow columns, so it fits its
    // own content instead, and cells never wrap (see that class's own CSS
    // for both).
    function m365RowHtml(s) {
      // The "[N]" ambiguous-match count is its own span (reusing
      // .cell-flag-red, same red/bold every other mismatch flag on
      // this dashboard uses) rather than baked into the name text,
      // by request -- it needs to stand out from the name itself,
      // not just read as part of it. Its own hover tooltip lists the
      // shared MS SKU once up top (every matched row has the identical
      // one -- that's what makes it ambiguous in the first place, so
      // showing it per-row would just repeat itself) then every matched
      // row's own Ingram Micro name below it, one per line -- by request.
      // Separate from the product name span's own SKU/Ingram Micro tooltip
      // below, since this one is specifically about what the [N] count
      // actually consists of.
      const matchListTitle = s.ambiguousMatches
        ? [`[${s.ambiguousMatches[0].msSku}]`, ...s.ambiguousMatches.map((m) => m.ingramProductName)].join('\n')
        : '';
      const matchCountFlag = s.matchCount ? ` <span class="cell-flag-red" title="${escapeHtml(matchListTitle)}">[${s.matchCount}]</span>` : '';
      // SKU column hidden by request -- the raw SKU still shows up
      // as the fallback text for an unmapped row (it's the only
      // thing to show there), and as part of a mapped row's hover
      // title alongside its Ingram Micro name(s), so it's not gone
      // entirely, just out of the table's own width.
      const titleParts = [`SKU: ${s.sku}`];
      if (s.ingramProductName) titleParts.push(`Ingram Micro: ${s.ingramProductName}`);
      const productCell = s.productName
        ? `<span title="${escapeHtml(titleParts.join('\n'))}">${escapeHtml(s.productName)}</span>${matchCountFlag}`
        : `<span class="inline-subtext">${escapeHtml(s.sku)} (no mapping)</span>`;
      return `
            <tr${s.productName ? '' : ' class="row-no-mapping"'}>
              <td>${productCell}</td>
              <td${s.status !== 'Enabled' ? ' class="cell-flag-blue"' : ''}>${escapeHtml(s.status)}</td>
              <td class="ticket-number">${s.enabled ?? ''}</td>
              <td class="ticket-number">${s.consumed ?? ''}</td>
              <td class="ticket-number${s.suspended ? ' cell-flag-red' : ''}">${s.suspended ?? ''}</td>
            </tr>`;
    }
    function m365TableHtml(skus) {
      return `
      <table class="chk-m365-table">
        <thead>
          <tr class="shaded-row"><th>Product Name</th><th>Status</th><th>Enabled</th><th>Consumed</th><th>Suspended</th></tr>
        </thead>
        <tbody>
          ${skus.map(m365RowHtml).join('')}
        </tbody>
      </table>
    `;
    }

    const group = document.createElement('div');
    group.className = 'resource-group chk-m365-group';
    group.innerHTML = mainSkus.length ? m365TableHtml(mainSkus) : '<p class="status">No non-Free subscribed SKUs found.</p>';
    m365ResultsEl.appendChild(group);

    if (freeSkus.length) {
      const freeToggle = document.createElement('button');
      freeToggle.type = 'button';
      freeToggle.className = 'button-link button-link--small chk-m365-free-toggle';
      freeToggle.textContent = `Show Free Products (${freeSkus.length})`;
      m365ResultsEl.appendChild(freeToggle);

      const freeGroup = document.createElement('div');
      freeGroup.className = 'resource-group chk-m365-group';
      freeGroup.hidden = true;
      freeGroup.innerHTML = m365TableHtml(freeSkus);
      m365ResultsEl.appendChild(freeGroup);

      freeToggle.addEventListener('click', () => {
        freeGroup.hidden = !freeGroup.hidden;
        freeToggle.textContent = freeGroup.hidden ? `Show Free Products (${freeSkus.length})` : `Hide Free Products (${freeSkus.length})`;
      });
    }
  }

  function m365UnmatchedText(data) {
    if (data.reason === 'no-rewst-customer') {
      return data.tenantId
        ? `No Rewst customer found with tenant ID ${data.tenantId} -- this client may not be set up in Rewst yet.`
        : 'No Microsoft-named Ingram subscription and no name match in Rewst -- this client may not be set up in Rewst yet.';
    }
    if (data.reason === 'no-organisation-id') return `Rewst customer "${data.rewstClientName}" has no linked Organisation -- can’t look up licenses.`;
    return 'Could not resolve Microsoft 365 Tenancy for this client.';
  }

  function renderSubscriptions(data) {
    updateClientLabel();
    subsStatusEl.hidden = true;
    const statusBreakdown = STATUS_ORDER.filter((s) => data.statusCounts[s] > 0)
      .map((s) => `${data.statusCounts[s]} ${STATUS_LABELS[s]}`)
      .join(', ');
    subsSummaryEl.hidden = false;
    subsSummaryEl.innerHTML = `<strong>${data.totalCount}</strong> subscriptions (${statusBreakdown}) across ${data.byClient.length} client${data.byClient.length === 1 ? '' : 's'}<span class="inline-subtext"> -- as of ${formatDateTime(data.asOf)}</span>`;

    subsResultsEl.innerHTML = '';
    if (data.byClient.length === 0) {
      subsResultsEl.innerHTML = '<p class="status">No active or pending subscriptions found.</p>';
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
      // Click still works as a manual retry (loadLicensesForClient()'s own
      // guard skips it once already loaded), but no longer the ONLY way to
      // trigger it -- by request, licenses load automatically here rather
      // than waiting for a click. Unlike Ingram Subscriptions' own page
      // (where a broad, unfiltered search can return dozens of clients,
      // making an eager per-client license fetch expensive), Check Client
      // is already scoped to a specific client search, so this is cheap.
      nameButton.addEventListener('click', () => loadLicensesForClient(client, groupEl, nameButton));
      groupEl.appendChild(header);

      const table = document.createElement('table');
      table.className = 'ingram-subscriptions-table';
      table.innerHTML = `
        <thead>
          <tr><th>Subscription</th><th>Status</th><th>Auto-Renewal</th><th>Licenses</th><th>Term / Billing Period</th><th>Created</th><th>Renews</th><th>Expires</th></tr>
        </thead>
        <tbody>${subscriptionRowsHtml(client.subscriptions)}</tbody>
      `;
      groupEl.appendChild(table);
      subsResultsEl.appendChild(groupEl);
      loadLicensesForClient(client, groupEl, nameButton);
    }
  }

  function subscriptionRowsHtml(subscriptions) {
    return subscriptions
      .map(
        (s) => `
      <tr>
        <td>${escapeHtml(s.name)}</td>
        <td${s.status === 'pending' ? ' class="cell-flag-blue"' : ''}>${escapeHtml(s.status === 'hold' ? 'On Hold' : capitalize(s.status))}</td>
        <td class="${s.autoRenews ? 'cell-flag-green' : 'cell-flag-red'}">${s.autoRenews ? 'Yes' : 'No'}</td>
        <td class="ticket-number">${s.licenseCount ?? ''}</td>
        <td class="ticket-number">${formatPeriod(s.term)} / ${formatPeriod(s.billingPeriod)}</td>
        <td class="ticket-number">${formatDate(s.creationDate)}</td>
        <td class="ticket-number">${formatDate(s.renewalDate)}</td>
        <td class="ticket-number">${formatDate(s.expirationDate)}</td>
      </tr>`
      )
      .join('');
  }

  // Same on-demand per-client license lookup Ingram Subscriptions' own
  // client.js uses -- calls that page's own public /licenses route
  // directly (needs no proxy through check-client's server).
  async function loadLicensesForClient(client, groupEl, nameButton) {
    if (client.licensesLoaded || nameButton.disabled) return;
    nameButton.disabled = true;
    nameButton.textContent = `${client.clientName} (loading licenses...)`;
    try {
      const ids = client.subscriptions.map((s) => s.id).join(',');
      const data = await fetchJson(`/api/ingram-subscriptions/licenses?ids=${encodeURIComponent(ids)}`, 'GET');
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

  // Ingram's term/billing-period shape is {type: 'month'|'year'|..., duration: N}.
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

  // ---------------------------------------------------------------------
  // Section 3 -- Contract Services (current month by default)
  // ---------------------------------------------------------------------

  async function loadServices(client, exactClient, month) {
    servicesStatusEl.hidden = false;
    servicesStatusEl.className = 'status loading';
    servicesStatusEl.textContent = `Loading services active in ${formatMonth(month)}...`;
    servicesSummaryEl.hidden = true;
    servicesResultsEl.innerHTML = '';
    try {
      const params = new URLSearchParams({ client, month });
      if (exactClient) params.set('exactClient', 'true');
      const data = await fetchJson(`/api/check-client/services?${params.toString()}`, 'GET');
      lastServicesData = data;
      renderServices(data);
    } catch (err) {
      servicesStatusEl.className = 'status error';
      servicesStatusEl.textContent = `Error: ${err.message}`;
    }
  }

  function renderServices(data) {
    updateClientLabel();
    servicesStatusEl.hidden = true;
    servicesSummaryEl.hidden = false;
    servicesSummaryEl.innerHTML = `<strong>${data.totalCount}</strong> service item${data.totalCount === 1 ? '' : 's'} active in ${formatMonth(data.month)} (active contracts only)`;

    if (data.totalCount === 0) {
      servicesResultsEl.innerHTML = '<p class="status">No matching service items.</p>';
      return;
    }
    servicesResultsEl.innerHTML = '';
    for (const group of data.byCompany) {
      const groupEl = document.createElement('div');
      groupEl.className = 'resource-group';

      const header = document.createElement('div');
      header.className = 'resource-group-header';
      header.innerHTML = `<span>${escapeHtml(group.companyName)}</span><span class="count">${group.count} item${group.count === 1 ? '' : 's'}</span>`;
      groupEl.appendChild(header);

      const table = document.createElement('table');
      table.className = 'contract-services-table';
      table.innerHTML = `
        <thead>
          <tr><th>Service</th><th>Contract</th><th title="Bracketed figure is the unit count for the 1st of next month, where already known">Units</th><th>Cost</th><th>Sell</th><th>Total</th><th>Period</th><th>Last Changed</th></tr>
        </thead>
        <tbody>
          ${group.rows
            .map(
              // Rows arrive already sorted by contractName within a company
              // (contract-services/server.js's shared buildReport()), so
              // equal names are always contiguous -- same "differs from the
              // row right above it" boundary check Contract Services' own
              // client.js uses.
              (r, i) => `
            <tr${rowClass(r, i > 0 && r.contractName !== group.rows[i - 1].contractName)}>
              <td><div class="col-service">${formatServiceName(r.serviceName)}${r.internalDescription ? `<span class="cell-subtext">${escapeHtml(r.internalDescription)}</span>` : ''}</div></td>
              <td class="col-contract">${contractLink(r)}</td>
              <td class="ticket-number">${unitsCell(r)}</td>
              <td class="ticket-number">${formatPrice(perItem(r.cost, r.units))}</td>
              <td class="ticket-number">${formatPrice(perItem(r.price, r.units))}</td>
              <td class="ticket-number">${formatPrice(r.price)}</td>
              <td class="ticket-number">${formatServiceDate(r.startDate)} - ${formatServiceDate(r.endDate)}</td>
              <td class="ticket-number${isRecentChange(r.contractLastModified) ? ' cell-flag-red' : ''}" title="Contract's last-modified date -- the service unit itself has no modification timestamp">${formatServiceDate(r.contractLastModified)}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      `;
      groupEl.appendChild(table);
      servicesResultsEl.appendChild(groupEl);
      wireServiceRowActions(groupEl, group);
    }
  }

  // Finds the real row object a click's data-* attributes point at --
  // `group` is already the exact object rendered (not re-derived from
  // lastServicesData), same reasoning wireOrderRowActions()'s own
  // findOrder() has for going straight to what's on screen.
  function wireServiceRowActions(groupEl, group) {
    groupEl.querySelectorAll('.chk-units-clickable').forEach((el) => {
      el.addEventListener('click', () => {
        const unitId = el.dataset.unitId;
        const isBundle = el.dataset.isBundle === '1';
        const row = group.rows.find((r) => String(r.id) === unitId && !!r.isBundle === isBundle);
        if (row) openAdjustUnitsModal(row);
      });
    });
  }

  function formatServiceName(name) {
    return escapeHtml(name).replace(/\s+(AVC\d+)(?!.*AVC\d+)/i, '<br>$1');
  }

  function rowClass(r, isContractBoundary) {
    const classes = [];
    if (isContractBoundary) classes.push('row-contract-boundary');
    if (r.nextPeriodUnits === null) classes.push('row-no-next-period');
    else if (r.nextPeriodUnits !== r.units) classes.push('row-units-changed');
    return classes.length ? ` class="${classes.join(' ')}"` : '';
  }

  function unitsCell(r) {
    const current = escapeHtml(r.units);
    const bracket =
      r.nextPeriodUnits === null
        ? ''
        : ` <span class="inline-subtext${r.nextPeriodUnits < r.units ? ' cell-flag-red' : r.nextPeriodUnits > r.units ? ' cell-flag-green' : ''}">(${escapeHtml(r.nextPeriodUnits)})</span>`;
    const inner = `${current}${bracket}`;
    // Clickable only for a Contract Manager (server-supplied isManager flag
    // on lastServicesData, checked here rather than trusting a stale copy)
    // -- everyone else sees this exact cell unchanged. By request, the
    // click target is a small pencil icon IN FRONT of the number (not the
    // number itself); the number stays plain text, no dotted-underline.
    // Same real pencil-outline SVG path + .wsp-icon-btn shell that
    // contract-checks/client.js's own ticket-number edit button already
    // uses (a currentColor SVG recolors with CSS, unlike a colored emoji
    // glyph, which is why that one moved off emoji too). Identifying
    // fields for openAdjustUnitsModal() below are on the button itself via
    // data-* rather than a separate id-lookup helper -- this row's own
    // `r.id` is a raw Autotask entity id shared across two different
    // entity types (ContractServiceUnit/ContractServiceBundleUnit in the
    // same flat rows array), so isBundle travels with it too rather than
    // relying on `id` alone to stay unique.
    if (!lastServicesData?.isManager) return inner;
    const icon = `<button type="button" class="wsp-icon-btn chk-units-clickable" data-company-id="${escapeHtml(String(r.companyId))}" data-unit-id="${escapeHtml(String(r.id))}" data-is-bundle="${r.isBundle ? '1' : '0'}" title="Adjust units"><svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.9959.9959 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg></button>`;
    return `${icon} ${inner}`;
  }

  // The date-only ISO string (YYYY-MM-DD) for the start of this row's own
  // NEXT billing period -- one day after the CURRENT period's own
  // endDate, regardless of whether a real ContractServiceUnits row exists
  // for it yet (most don't, until either Autotask's own billing run
  // creates one or an adjustment like this page's own does) --
  // deterministic from the row's own endDate alone. Shared by the
  // Contract column's own "(next billing date)" annotation below and the
  // adjust-units popup's own date default.
  function nextPeriodStartISO(row) {
    const d = new Date(row.endDate);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  function contractLink(r) {
    const label = escapeHtml(r.contractName);
    // By request -- the contract's own next billing date, so it's visible
    // without having to open the adjust-units popup just to see it.
    const nextBilling = ` <span class="inline-subtext">(${formatServiceDate(nextPeriodStartISO(r))})</span>`;
    if (!r.contractUrl) return `${label}${nextBilling}`;
    return `<a href="${escapeHtml(r.contractUrl)}" target="_blank" rel="noopener noreferrer" onclick="window.open(this.href, '_blank', 'noopener,noreferrer,width=1200,height=900'); return false;">${label}</a>${nextBilling}`;
  }

  function formatMonth(month) {
    if (!month) return '';
    const [y, m] = month.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'Australia/Brisbane' });
  }

  // Contract Services' own rows carry real ISO datetimes (not date-only
  // strings), so this is a plain local-timezone parse -- kept as its own
  // function (not `formatDate` below) since that one is deliberately
  // AEST-anchored for the date-ONLY strings Orders/Subscriptions use.
  function formatServiceDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString();
  }

  function isRecentChange(iso) {
    if (!iso) return false;
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    return new Date(iso) >= thirtyDaysAgo;
  }

  function formatPrice(value) {
    if (value === null || value === undefined) return '';
    return '$' + Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function perItem(total, units) {
    if (total === null || total === undefined || !units) return total;
    return total / units;
  }

  // By request: default Effective Date is THIS row's own next billing
  // period start (nextPeriodStartISO() above) -- UNLESS today (AEST,
  // same Date.now() + 10h approximation defaultSinceISO() above already
  // uses elsewhere on this page, not DST-aware) is still within 5 days
  // after this row's own CURRENT period started (r.startDate -- "the last
  // effective date"), in which case default to THAT date instead. Same
  // "just after a period boundary probably means THIS period, not the
  // next one" intent the original version of this rule had -- that one
  // was anchored to calendar-month day-of-month (1st-4th); this one's
  // anchored to the row's own real period dates instead, since a period
  // only USUALLY starts on the 1st of a month (every monthly service
  // does, confirmed against real data -- but an annual/quarterly line's
  // own period boundary can fall on any date).
  function defaultEffectiveDateForRow(row) {
    const aestNow = new Date(Date.now() + 10 * 60 * 60 * 1000);
    // Whole-CALENDAR-DAY difference, not raw millisecond math -- comparing
    // the AEST-shifted "now" directly against row.startDate's own
    // unshifted UTC-midnight value produced a real boundary bug (5 days
    // in read as 5.4 fractional days, wrongly tipping into "next" a whole
    // day early); both sides are reduced to a plain UTC-midnight
    // calendar-date key first so only whole days are ever compared.
    const todayKey = Date.UTC(aestNow.getUTCFullYear(), aestNow.getUTCMonth(), aestNow.getUTCDate());
    const lastEffective = new Date(row.startDate);
    const lastKey = Date.UTC(lastEffective.getUTCFullYear(), lastEffective.getUTCMonth(), lastEffective.getUTCDate());
    const daysSinceLast = Math.round((todayKey - lastKey) / 86400000);
    if (daysSinceLast >= 0 && daysSinceLast <= 5) return lastEffective.toISOString().slice(0, 10);
    return nextPeriodStartISO(row);
  }

  // First popup -- Effective Date / +- / Units, by request. `prefill` is
  // only passed when returning here via the confirmation popup's own Back
  // button, so a Back-then-forward round trip never loses what was typed.
  // Shared 3-line heading for both adjust-units popups -- Client Name
  // (green, same #16a34a as .chk-section-heading elsewhere on this page),
  // Contract Name (plain text color, not a literal black, so it still
  // reads in dark mode), Service/Item name (orange, same #f59e0b this
  // page's own "Loading..." status text already uses) -- by request.
  // Service/Item line uses row.serviceItemName (the real Autotask Service's
  // own name), NOT row.serviceName (an invoice description, which can be
  // generic/shared across different services billed the same way) -- the
  // whole point of this popup is confirming exactly which item is being
  // changed.
  function adjustModalHeadingHtml(row) {
    return `
      <div class="chk-adjust-modal-heading">
        <div class="chk-adjust-modal-client">${escapeHtml(row.companyName)}</div>
        <div class="chk-adjust-modal-contract">${escapeHtml(row.contractName)}</div>
        <div class="chk-adjust-modal-service">${escapeHtml(row.serviceItemName)}</div>
      </div>`;
  }

  function openAdjustUnitsModal(row, prefill) {
    const overlay = document.createElement('div');
    overlay.className = 'history-modal-overlay';
    const sign = prefill?.sign ?? 1;
    overlay.innerHTML = `
      <div class="history-modal-panel chk-adjust-units-modal-panel">
        <div class="history-modal-panel-header">
          ${adjustModalHeadingHtml(row)}
          <button type="button" class="history-modal-close" aria-label="Close">✕</button>
        </div>
        <div class="history-modal-body">
          <label class="chk-adjust-field-label">
            Effective Date
            <input type="date" class="wsp-field chk-adjust-date-input" value="${escapeHtml(prefill?.effectiveDate || defaultEffectiveDateForRow(row))}" />
          </label>
          <div class="chk-adjust-sign-row">
            <button type="button" class="chk-adjust-sign-button${sign === 1 ? ' chk-adjust-sign-button--active' : ''}" data-sign="1">+ Add</button>
            <button type="button" class="chk-adjust-sign-button${sign === -1 ? ' chk-adjust-sign-button--active' : ''}" data-sign="-1">&minus; Remove</button>
          </div>
          <label class="chk-adjust-field-label">
            Units
            <input type="number" min="1" step="1" class="wsp-field chk-adjust-units-input" placeholder="0" value="${prefill?.unitsAmount || ''}" />
          </label>
          <p class="status error chk-adjust-modal-error" hidden></p>
          <div class="wsp-form-actions">
            <button type="button" class="button-link chk-adjust-save-button" disabled>Save</button>
            <button type="button" class="chk-adjust-exit-button">Exit</button>
          </div>
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
    overlay.querySelector('.chk-adjust-exit-button').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    let currentSign = sign;
    const signButtons = [...overlay.querySelectorAll('.chk-adjust-sign-button')];
    const dateInput = overlay.querySelector('.chk-adjust-date-input');
    const unitsInput = overlay.querySelector('.chk-adjust-units-input');
    const saveButton = overlay.querySelector('.chk-adjust-save-button');

    signButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        currentSign = Number(btn.dataset.sign);
        signButtons.forEach((b) => b.classList.toggle('chk-adjust-sign-button--active', b === btn));
      });
    });
    // Save greyed out with no units, exactly as specified -- a non-numeric
    // or zero amount is treated the same as empty, not a parse error.
    function updateSaveEnabled() {
      const amount = Number(unitsInput.value);
      saveButton.disabled = !unitsInput.value || !Number.isFinite(amount) || amount <= 0;
    }
    unitsInput.addEventListener('input', updateSaveEnabled);
    updateSaveEnabled();

    saveButton.addEventListener('click', () => {
      const effectiveDate = dateInput.value;
      const unitsAmount = Math.trunc(Number(unitsInput.value));
      const errorEl = overlay.querySelector('.chk-adjust-modal-error');
      if (!effectiveDate) {
        errorEl.hidden = false;
        errorEl.textContent = 'Effective Date is required.';
        return;
      }
      close();
      openAdjustUnitsConfirmModal(row, effectiveDate, currentSign, unitsAmount);
    });
    unitsInput.focus();
  }

  // Second popup -- by request, shows current (red) vs new (green) units,
  // cost, and sell before anything is actually sent, since a real Autotask
  // ContractServiceAdjustment can never be edited or deleted once created
  // (only reversed by a later opposite adjustment). New Cost/Sell are
  // computed from THIS row's own already-known per-unit rate
  // (perItem(cost/price, units) -- confirmed live against real contract
  // data that these divide evenly), not a separate fetch -- Autotask itself
  // prices the real adjustment the same way server-side, since
  // adjustedUnitPrice/adjustedUnitCost are deliberately never sent (see
  // contract-services/server.js's own adjustUnits()).
  function openAdjustUnitsConfirmModal(row, effectiveDate, sign, unitsAmount) {
    const unitChange = sign * unitsAmount;
    // By request: when a change is already pending for the next period
    // (row.nextPeriodUnits -- the same value the main table's own "1 (2)"
    // bracket already shows), base New on THAT pending count rather than
    // the currently-billing row.units. The Effective Date defaults to the
    // start of next period (see defaultEffectiveDateForRow()), so a new
    // adjustment almost always stacks on top of a change already scheduled
    // to take effect then, not on top of what's billing right now -- won't
    // always net out exactly right (a chain of several pending
    // adjustments, or one effective mid-period), but reads far clearer
    // than silently basing it on the current period alone.
    const baseUnits = row.nextPeriodUnits ?? row.units;
    const newUnits = baseUnits + unitChange;
    const costRate = perItem(row.cost, row.units);
    const priceRate = perItem(row.price, row.units);
    const newCost = costRate === null || costRate === undefined ? null : costRate * newUnits;
    const newPrice = priceRate === null || priceRate === undefined ? null : priceRate * newUnits;
    // Same "current (pending)" bracket format unitsCell() already uses on
    // the main table, so the Current column here reads consistently with
    // what's already on screen behind this popup -- full size, not
    // .inline-subtext's smaller size, since on this popup the bracketed
    // number is the one the New column's own math actually uses, not a
    // secondary detail.
    const currentUnitsDisplay =
      row.nextPeriodUnits === null || row.nextPeriodUnits === row.units
        ? escapeHtml(row.units)
        : `${escapeHtml(row.units)} <span class="chk-adjust-pending-count">(${escapeHtml(row.nextPeriodUnits)})</span>`;

    const overlay = document.createElement('div');
    overlay.className = 'history-modal-overlay';
    overlay.innerHTML = `
      <div class="history-modal-panel chk-adjust-units-modal-panel">
        <div class="history-modal-panel-header">
          <div>
            ${adjustModalHeadingHtml(row)}
            <div class="chk-adjust-modal-date"><span class="chk-adjust-modal-date-label">Effective Date:</span> <span class="chk-adjust-modal-date-value">${formatServiceDate(effectiveDate)}</span></div>
          </div>
          <button type="button" class="history-modal-close" aria-label="Close">✕</button>
        </div>
        <div class="history-modal-body">
          <table class="chk-adjust-confirm-table">
            <thead><tr><th></th><th>Current</th><th>New</th></tr></thead>
            <tbody>
              <tr><td>Units</td><td class="cell-flag-red">${currentUnitsDisplay}</td><td class="cell-flag-green">${escapeHtml(newUnits)}</td></tr>
              <tr><td>Cost</td><td class="cell-flag-red">${formatPrice(row.cost)}</td><td class="cell-flag-green">${formatPrice(newCost)}</td></tr>
              <tr><td>Sell</td><td class="cell-flag-red">${formatPrice(row.price)}</td><td class="cell-flag-green">${formatPrice(newPrice)}</td></tr>
            </tbody>
          </table>
          <p class="status error chk-adjust-modal-error" hidden></p>
          <div class="wsp-form-actions">
            <button type="button" class="button-link chk-adjust-confirm-button">Confirm</button>
            <button type="button" class="chk-adjust-back-button">Back</button>
          </div>
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
    overlay.querySelector('.chk-adjust-back-button').addEventListener('click', () => {
      close();
      openAdjustUnitsModal(row, { effectiveDate, sign, unitsAmount });
    });

    const confirmButton = overlay.querySelector('.chk-adjust-confirm-button');
    confirmButton.addEventListener('click', async () => {
      const errorEl = overlay.querySelector('.chk-adjust-modal-error');
      errorEl.hidden = true;
      confirmButton.disabled = true;
      confirmButton.textContent = 'Saving...';
      try {
        await fetchJson('/api/check-client/services/adjust-units', 'POST', {
          contractId: row.contractId,
          serviceId: row.serviceId,
          contractServiceID: row.contractServiceID,
          contractServiceBundleID: row.contractServiceBundleID,
          isBundle: row.isBundle,
          effectiveDate,
          unitChange,
        });
        close();
        await loadServices(autotaskClientInput.value.trim(), exactClientInput.checked, monthInput.value);
      } catch (err) {
        errorEl.hidden = false;
        errorEl.textContent = `Error: ${err.message}`;
        confirmButton.disabled = false;
        confirmButton.textContent = 'Confirm';
      }
    });
  }

  // ---------------------------------------------------------------------
  // Section 5 -- Datto RMM (devices & open alerts), read-only
  // ---------------------------------------------------------------------

  async function loadDattoRmm(site, force) {
    dattoStatusEl.hidden = false;
    dattoStatusEl.className = 'status';
    dattoSummaryEl.hidden = true;
    dattoResultsEl.innerHTML = '';
    if (!site) {
      dattoStatusEl.textContent = 'Type a Datto Site above (defaults to Autotask Client) to look up devices.';
      return;
    }
    dattoStatusEl.className = 'status loading';
    dattoStatusEl.textContent = `Loading Datto RMM devices for "${site}"...`;
    try {
      const params = new URLSearchParams({ site });
      if (force) params.set('force', 'true');
      const data = await fetchJson(`/api/check-client/datto-rmm?${params.toString()}`, 'GET');
      lastDattoData = data;
      renderDattoRmm(data);
    } catch (err) {
      dattoStatusEl.className = 'status error';
      dattoStatusEl.textContent = `Error: ${err.message}`;
    }
  }

  function renderDattoRmm(data) {
    if (!data.connected) {
      dattoStatusEl.hidden = false;
      dattoStatusEl.className = 'status';
      dattoStatusEl.textContent = 'Datto RMM is not configured in .env.';
      dattoSummaryEl.hidden = true;
      dattoResultsEl.innerHTML = '';
      return;
    }
    dattoStatusEl.hidden = true;
    dattoSummaryEl.hidden = false;
    const alertsText = data.alertsTotalCount > 0 ? `, ${data.alertsTotalCount} open High/Critical alert${data.alertsTotalCount === 1 ? '' : 's'}` : ', no open High/Critical alerts';
    dattoSummaryEl.innerHTML = `<strong>${data.totalDevices}</strong> device${data.totalDevices === 1 ? '' : 's'} (${data.onlineCount} online, ${data.offlineCount} offline, ${data.rebootRequiredCount} reboot required) across ${data.bySite.length} site${data.bySite.length === 1 ? '' : 's'}${alertsText}<span class="inline-subtext"> -- as of ${formatDateTime(data.asOf)}</span>`;

    dattoResultsEl.innerHTML = '';
    if (data.bySite.length === 0) {
      dattoResultsEl.innerHTML = '<p class="status">No matching Datto RMM sites found.</p>';
      return;
    }

    if (data.alertsTotalCount > 0) {
      const alertsGroup = document.createElement('div');
      alertsGroup.className = 'resource-group';
      alertsGroup.innerHTML = `
        <div class="resource-group-header"><span>Open Alerts (High/Critical)</span><span class="count">${data.alertsTotalCount}</span></div>
        <table>
          <thead>
            <tr class="shaded-row"><th>Time</th><th>Site</th><th>Priority</th><th>Device</th><th>Message</th></tr>
          </thead>
          <tbody>${alertRowsHtml(data.alerts)}</tbody>
        </table>
        ${data.alertsTruncated ? '<p class="inline-subtext" style="padding:0.5rem 1rem;">More alerts exist than shown -- the account-wide alert fetch hit its own cap.</p>' : ''}
      `;
      dattoResultsEl.appendChild(alertsGroup);
    }

    for (const site of data.bySite) {
      const groupEl = document.createElement('div');
      groupEl.className = 'resource-group';
      groupEl.innerHTML = `
        <div class="resource-group-header"><span>${escapeHtml(site.site)}</span><span class="count">${site.devices.length} device${site.devices.length === 1 ? '' : 's'}</span></div>
        <table>
          <thead>
            <tr class="shaded-row"><th>Hostname</th><th>Online</th><th>OS</th><th>Patch Status</th><th>Last User</th><th>Last Seen</th></tr>
          </thead>
          <tbody>${deviceRowsHtml(site.devices)}</tbody>
        </table>
      `;
      dattoResultsEl.appendChild(groupEl);
    }
  }

  function deviceRowsHtml(devices) {
    return devices
      .map(
        (d) => `
      <tr>
        <td>${escapeHtml(d.hostname)}${d.rebootRequired ? ' <span class="inline-subtext">(reboot required)</span>' : ''}</td>
        <td class="${d.online ? 'cell-flag-green' : 'cell-flag-red'}">${d.online ? 'Online' : 'Offline'}</td>
        <td>${escapeHtml(d.os)}</td>
        <td>${escapeHtml(d.patchStatus)}</td>
        <td>${escapeHtml(d.lastUser)}</td>
        <td class="ticket-number">${formatDateTime(d.lastSeen)}</td>
      </tr>`
      )
      .join('');
  }

  function alertRowsHtml(alerts) {
    return alerts
      .map(
        (a) => `
      <tr>
        <td class="ticket-number">${formatDateTime(a.timestamp)}</td>
        <td>${escapeHtml(a.siteName)}</td>
        <td class="${a.priority === 'Critical' ? 'cell-flag-red' : 'cell-flag-blue'}">${escapeHtml(a.priority)}</td>
        <td>${escapeHtml(a.deviceName)}</td>
        <td>${escapeHtml(a.message)}</td>
      </tr>`
      )
      .join('');
  }

  // ---------------------------------------------------------------------
  // Shared boilerplate -- no shared module for this in the codebase (every
  // page keeps its own copy), so this is copied from Contract Checks'
  // own client.js.
  // ---------------------------------------------------------------------

  if (lastOrdersData) renderOrders(lastOrdersData);
  if (lastSubscriptionsData) renderSubscriptions(lastSubscriptionsData);
  if (lastM365Data) renderM365Tenancy(lastM365Data);
  if (lastServicesData) renderServices(lastServicesData);
  if (lastDattoData) renderDattoRmm(lastDattoData);

  async function fetchJson(url, method, body) {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    if (res.status !== 204) data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data;
  }

  function capitalize(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  function formatDateTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString();
  }

  // Plain YYYY-MM-DD date (no time component) -- AEST-anchored, same
  // convention Contract Checks/Ingram Subscriptions/Orders already use for
  // their own date-only fields (pendingDate, subscription creation/renewal/
  // expiration dates).
  function formatDate(isoDateOnly) {
    if (!isoDateOnly) return '';
    return new Date(`${isoDateOnly}T00:00:00.000Z`).toLocaleDateString(undefined, { timeZone: 'Australia/Brisbane' });
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
