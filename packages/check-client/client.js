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
let lastSince = null;
let lastMonth = null;
let lastOrdersData = null;
let lastSubscriptionsData = null;
let lastServicesData = null;

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

    <h2 class="chk-section-heading">Contracts <span class="inline-subtext">(Autotask)</span></h2>
    <p id="services-status" class="status" hidden></p>
    <div id="services-summary" class="summary" hidden></div>
    <div id="services-results" class="results"></div>
    </div>
  `;

  const form = container.querySelector('#filter-form');
  const clientLabelEl = container.querySelector('#client-label');
  const autotaskClientInput = container.querySelector('#autotask-client-input');
  const exactClientInput = container.querySelector('#exact-client-input');
  const ingramClientInput = container.querySelector('#ingram-client-input');
  const sinceInput = container.querySelector('#since-input');
  const monthInput = container.querySelector('#month-input');
  const searchButton = container.querySelector('#search-button');

  const ordersStatusEl = container.querySelector('#orders-status');
  const ordersSummaryEl = container.querySelector('#orders-summary');
  const ordersResultsEl = container.querySelector('#orders-results');
  const subsStatusEl = container.querySelector('#subs-status');
  const subsSummaryEl = container.querySelector('#subs-summary');
  const subsResultsEl = container.querySelector('#subs-results');
  const servicesStatusEl = container.querySelector('#services-status');
  const servicesSummaryEl = container.querySelector('#services-summary');
  const servicesResultsEl = container.querySelector('#services-results');

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
  autotaskClientInput.addEventListener('input', () => {
    if (!ingramClientManuallyEdited) ingramClientInput.value = autotaskClientInput.value;
  });
  ingramClientInput.addEventListener('input', () => {
    ingramClientManuallyEdited = true;
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
    const since = sinceInput.value;
    const month = monthInput.value;
    searchButton.disabled = true;
    try {
      await Promise.allSettled([loadOrders(ingramClient, since), loadSubscriptions(ingramClient), loadServices(autotaskClient, exactClient, month)]);
    } finally {
      lastAutotaskClient = autotaskClient;
      lastExactClient = exactClient;
      lastIngramClient = ingramClient;
      lastIngramClientManuallyEdited = ingramClientManuallyEdited;
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
    ordersStatusEl.className = 'status';
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
        <div class="history-modal-body"><p class="status">Loading...</p></div>
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
    subsStatusEl.className = 'status';
    subsStatusEl.textContent = `Loading subscriptions for "${client}"...`;
    subsSummaryEl.hidden = true;
    subsResultsEl.innerHTML = '';
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
    servicesStatusEl.className = 'status';
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
              (r) => `
            <tr${rowClass(r)}>
              <td><div class="col-service">${formatServiceName(r.serviceName)}${r.internalDescription ? `<span class="cell-subtext">${escapeHtml(r.internalDescription)}</span>` : ''}</div></td>
              <td>${contractLink(r)}</td>
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
    }
  }

  function formatServiceName(name) {
    return escapeHtml(name).replace(/\s+(AVC\d+)(?!.*AVC\d+)/i, '<br>$1');
  }

  function rowClass(r) {
    if (r.nextPeriodUnits === null) return ' class="row-no-next-period"';
    if (r.nextPeriodUnits !== r.units) return ' class="row-units-changed"';
    return '';
  }

  function unitsCell(r) {
    const current = escapeHtml(r.units);
    if (r.nextPeriodUnits === null) return current;
    const changeClass = r.nextPeriodUnits < r.units ? ' cell-flag-red' : r.nextPeriodUnits > r.units ? ' cell-flag-green' : '';
    return `${current} <span class="inline-subtext${changeClass}">(${escapeHtml(r.nextPeriodUnits)})</span>`;
  }

  function contractLink(r) {
    const label = escapeHtml(r.contractName);
    if (!r.contractUrl) return label;
    return `<a href="${escapeHtml(r.contractUrl)}" target="_blank" rel="noopener noreferrer" onclick="window.open(this.href, '_blank', 'noopener,noreferrer,width=1200,height=900'); return false;">${label}</a>`;
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

  // ---------------------------------------------------------------------
  // Shared boilerplate -- no shared module for this in the codebase (every
  // page keeps its own copy), so this is copied from Contract Checks'
  // own client.js.
  // ---------------------------------------------------------------------

  if (lastOrdersData) renderOrders(lastOrdersData);
  if (lastSubscriptionsData) renderSubscriptions(lastSubscriptionsData);
  if (lastServicesData) renderServices(lastServicesData);

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
