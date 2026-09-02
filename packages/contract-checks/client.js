export const id = "contract-checks";
export const label = "Contract Checks";

// Module-scope, not inside mount() -- the shell fully tears down and re-mounts
// a page's DOM on every navigation away and back, but the dynamically-imported
// module itself is cached by the browser and stays alive for the session, so a
// module-level variable survives across re-mounts and lets the last result
// restore instantly instead of coming back blank. Same convention Ingram
// Orders/Subscriptions already use.
let lastData = null;
let lastSince = null;
let lastFilter = '';
let lastStatusFilter = '';
let lastProductFilter = '';
let lastIncludeRenewals = false;
let lastIncludeAllRenewals = false;
let lastIncludeCancelled = true; // on by default, per request
let lastShowAllDone = false; // off by default, per request -- ALL DONE items start hidden
let lastHideRenewalOrProcessingOnly = true; // on by default, per request
let lastAllDates = false; // off by default -- the "All" checkbox that removes the Since restriction entirely

// Same pattern TC Elite Rollout's client.js uses for its own Amber-only
// gate (COLUMN_ADMIN_EMAIL there) -- populated via /api/me in mount()
// below, checked on click rather than used to hide the button, so a slow
// /api/me response never silently hides a control that would otherwise
// work; server.js's own PATCH /templates/:key checks this again, since a
// client-side-only check is trivially bypassed by anyone hitting the API
// directly.
let currentUserEmail = null;
const CONTRACT_CHECKS_ADMIN_EMAIL = 'amber@ambientit.com.au';

// The six checkbox-style fields every item row carries -- see this
// package's db.js/README for the schema. Duplicated here (not imported --
// this is a browser module, db.js is server-side) same way other pages
// duplicate small shared enums between client and server.
const TOGGLE_COLUMNS = [
  { field: 'checked_contract', atKey: 'checkedContractAt', label: 'Contract' },
  { field: 'm365_ok', atKey: 'm365OkAt', label: 'M365 OK' },
  { field: 'tc_elite', atKey: 'tcEliteAt', label: 'TC ELITE' },
  { field: 'tc_ess', atKey: 'tcEssAt', label: 'TC ESS' },
  { field: 'others', atKey: 'othersAt', label: 'OTHERS' },
  { field: 'all_done', atKey: 'allDoneAt', label: 'DONE' },
];
const TOGGLE_FIELD_SET = new Set(TOGGLE_COLUMNS.map((c) => c.field));

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

// The confirmReopenTicket() choices' own labels -- server-side status ids
// mirrored here (server.js's TICKET_STATUS_BILLING_CONTRACT/FIX_BILLING/
// NEEDS_INTERNAL_UPDATE), used to name the status in a failure alert.
const TICKET_STATUS_LABELS = {
  20: 'Billing - Contract',
  50: 'FIX Billing',
  15: 'Needs Internal Update',
};

export function mount(container) {
  // The REAL scrolling box is always .page-content -- app.js's own
  // overflow-y: auto region -- but `container` itself is only ever THAT
  // element when this page is standalone. Wrapped inside a tabbed page
  // (createTabbedPageMount(), tab-page-client.js), `container` is instead
  // an inner div (#tab-page-content) nested inside the real .page-content,
  // which itself never scrolls -- confirmed live (a real bug report:
  // container.scrollTop read 0 both before AND after a checkbox toggle's
  // own reload, every time, because that inner div genuinely never
  // scrolls; the actual page position was being lost on the ancestor this
  // code had no reference to at all). closest('.page-content') resolves
  // correctly either way: standalone, `container` already IS .page-content
  // so this just returns itself; tabbed, it walks up to the real one.
  const scrollContainer = container.closest('.page-content') || container;

  fetch('/api/me')
    .then((res) => res.json())
    .then((data) => {
      currentUserEmail = data.user ? data.user.email : null;
    })
    .catch(() => {
      // Non-essential for anything except the Edit Template gate below --
      // fails open to "not Amber" (the button just tells the user to see
      // her) rather than blocking the page.
    });

  container.innerHTML = `
    <div class="contract-checks-page">
    <header class="page-header">
      <h1>Contract Checks</h1>
      <form id="filter-form" class="date-form date-form--stacked">
        <div class="date-form-row">
          <label for="all-dates-input" class="inline-checkbox-label">
            <input type="checkbox" id="all-dates-input" /> All
          </label>
          <label for="since-input">Since</label>
          <input type="date" id="since-input" name="since" required />
          <label for="client-input">Client</label>
          <input type="text" id="client-input" name="client" placeholder="optional, e.g. Acme* (wildcards with *)" />
          <label for="process-type-input">Process Type</label>
          <select id="process-type-input">
            <option value="ingram_subscription">Ingram Micro Subscription Updates</option>
          </select>
        </div>
        <div class="date-form-row">
          <label for="status-input">Status</label>
          <input type="text" id="status-input" name="status" placeholder="optional, e.g. complet* (wildcards with *)" />
          <label for="product-input">Product</label>
          <input type="text" id="product-input" name="product" placeholder="optional, e.g. *Business Basic* (wildcards with *)" />
          <button type="submit" id="refresh-button">Refresh</button>
          <button type="button" id="sync-button">Check IM for More</button>
        </div>
        <div class="date-form-row">
          <label for="include-renewals-input" class="inline-checkbox-label">
            <input type="checkbox" id="include-renewals-input" /> Show Renewals
          </label>
          <label for="include-cancelled-input" class="inline-checkbox-label">
            <input type="checkbox" id="include-cancelled-input" /> Show Cancelled
          </label>
          <label for="include-all-renewals-input" class="inline-checkbox-label">
            <input type="checkbox" id="include-all-renewals-input" /> Show ALL Renewals
          </label>
          <label for="show-all-done-input" class="inline-checkbox-label">
            <input type="checkbox" id="show-all-done-input" /> Show All Done
          </label>
          <label for="hide-renewal-or-processing-only-input" class="inline-checkbox-label">
            <input type="checkbox" id="hide-renewal-or-processing-only-input" /> Hide Clients w/only Renewal & Pending
          </label>
        </div>
      </form>
    </header>
    <p id="status" class="status">Pick a date, optionally filter by client/status/product (wildcards with *), then click Refresh. A row still "processing" always shows regardless of the Since date -- that's exactly the kind of outstanding item this page exists to surface. "Check IM for More" pulls anything new (or changed) from Ingram Micro into this page's own database -- every other control here reads from that database, not Ingram live. A terminated subscription is flagged once, the first time it's seen, and shows up in this same list -- Type "Termination", Status "Terminated".</p>
    <div id="summary" class="summary" hidden></div>
    <div id="results" class="results"></div>
    </div>
  `;

  const form = container.querySelector('#filter-form');
  const allDatesInput = container.querySelector('#all-dates-input');
  const sinceInput = container.querySelector('#since-input');
  const clientInput = container.querySelector('#client-input');
  const processTypeInput = container.querySelector('#process-type-input');
  const statusInput = container.querySelector('#status-input');
  const productInput = container.querySelector('#product-input');
  const includeRenewalsInput = container.querySelector('#include-renewals-input');
  const includeCancelledInput = container.querySelector('#include-cancelled-input');
  const includeAllRenewalsInput = container.querySelector('#include-all-renewals-input');
  const showAllDoneInput = container.querySelector('#show-all-done-input');
  const hideRenewalOrProcessingOnlyInput = container.querySelector('#hide-renewal-or-processing-only-input');
  const refreshButton = container.querySelector('#refresh-button');
  const syncButton = container.querySelector('#sync-button');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const resultsEl = container.querySelector('#results');

  // Bulk-close row selection, by request -- mount-scope (not module-scope
  // like lastData etc.), so it resets on a fresh page visit but survives
  // render() rebuilding the DOM within this same visit (an unrelated
  // toggle elsewhere on the page shouldn't silently lose an in-progress
  // selection). itemIds are restored onto fresh checkboxes by
  // updateRowSelectionUI() after every render().
  let bulkSelection = { customerId: null, itemIds: new Set() };
  // Which of the currently-selected rows have had ALL DONE ticked LOCALLY
  // (not yet saved) -- a subset of bulkSelection.itemIds. Cleared whenever
  // bulkSelection itself clears (a successful bulk close, or the selection
  // being emptied out).
  let bulkAllDoneTicked = new Set();

  // AEST (UTC+10, no DST in Queensland) "today", not the browser's own local
  // timezone -- same convention as every other date-scoped page. Defaults
  // to the 1st of the current month -- EXCEPT when today is still early in
  // the month (before the 7th), where "this month" barely exists yet and
  // the 1st of LAST month is the more useful starting point instead, by
  // request.
  function defaultSinceISO() {
    const aestNow = new Date(Date.now() + 10 * 60 * 60 * 1000);
    const year = aestNow.getUTCFullYear();
    const month = aestNow.getUTCMonth(); // 0-indexed -- Date.UTC below rolls the year back correctly for month -1
    const day = aestNow.getUTCDate();
    const targetMonth = day < 7 ? month - 1 : month;
    return new Date(Date.UTC(year, targetMonth, 1)).toISOString().slice(0, 10);
  }
  sinceInput.value = lastSince || defaultSinceISO();
  clientInput.value = lastFilter;
  statusInput.value = lastStatusFilter;
  productInput.value = lastProductFilter;
  includeRenewalsInput.checked = lastIncludeRenewals;
  includeCancelledInput.checked = lastIncludeCancelled;
  includeAllRenewalsInput.checked = lastIncludeAllRenewals;
  showAllDoneInput.checked = lastShowAllDone;
  hideRenewalOrProcessingOnlyInput.checked = lastHideRenewalOrProcessingOnly;
  allDatesInput.checked = lastAllDates;
  sinceInput.disabled = lastAllDates;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    load();
  });

  // "All" removes the Since restriction entirely (server.js treats
  // since as optional when all=true), by request -- disabling the Since
  // input greys it out and also exempts it from its own `required`
  // constraint, so submitting the form with All checked doesn't get
  // blocked by an empty/stale Since value.
  allDatesInput.addEventListener('change', () => {
    sinceInput.disabled = allDatesInput.checked;
  });

  syncButton.addEventListener('click', async () => {
    syncButton.disabled = true;
    refreshButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Checking Ingram Micro for new or changed orders, and for new terminations -- this can take a little while...';
    try {
      const result = await fetchJson('/api/contract-checks/sync', 'POST');
      statusEl.textContent = result.message || 'Sync complete.';
      await load();
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      syncButton.disabled = false;
      refreshButton.disabled = false;
    }
  });

  async function load() {
    const allDates = allDatesInput.checked;
    const since = sinceInput.value;
    refreshButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = allDates ? 'Loading all contract checks...' : `Loading contract checks since ${since}...`;
    summaryEl.hidden = true;
    resultsEl.innerHTML = '';

    try {
      const params = new URLSearchParams({ processType: processTypeInput.value });
      if (allDates) {
        params.set('all', 'true');
      } else {
        params.set('since', since);
      }
      if (clientInput.value) params.set('client', clientInput.value);
      if (statusInput.value) params.set('status', statusInput.value);
      if (productInput.value) params.set('product', productInput.value);
      if (includeRenewalsInput.checked) params.set('includeRenewals', 'true');
      if (includeAllRenewalsInput.checked) params.set('includeAllRenewals', 'true');
      if (includeCancelledInput.checked) params.set('includeCancelled', 'true');
      if (showAllDoneInput.checked) params.set('showAllDone', 'true');
      if (hideRenewalOrProcessingOnlyInput.checked) params.set('hideRenewalOrProcessingOnly', 'true');

      const data = await fetchJson(`/api/contract-checks?${params.toString()}`, 'GET');
      lastData = data;
      lastAllDates = allDates;
      lastSince = since;
      lastFilter = clientInput.value;
      lastStatusFilter = statusInput.value;
      lastProductFilter = productInput.value;
      lastIncludeRenewals = includeRenewalsInput.checked;
      lastIncludeAllRenewals = includeAllRenewalsInput.checked;
      lastIncludeCancelled = includeCancelledInput.checked;
      lastShowAllDone = showAllDoneInput.checked;
      lastHideRenewalOrProcessingOnly = hideRenewalOrProcessingOnlyInput.checked;
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

    const filterClauses = [];
    if (data.filterTerm) filterClauses.push(`client "${escapeHtml(data.filterTerm)}"`);
    if (data.statusTerm) filterClauses.push(`status "${escapeHtml(data.statusTerm)}"`);
    if (data.productTerm) filterClauses.push(`product "${escapeHtml(data.productTerm)}"`);
    const filterSuffix = filterClauses.length ? ` matching ${filterClauses.join(', ')}` : '';

    const statusBreakdown = Object.entries(data.statusCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([status, count]) => `${count} ${capitalize(status)}`)
      .join(', ');

    // Same three-way renewals note as Ingram Orders, plus ALL DONE.
    const noteParts = [];
    if (!data.includeAllRenewals) {
      noteParts.push(data.includeRenewals ? 'renewals limited to clients with other orders' : 'renewals excluded');
    }
    if (!data.includeCancelled) noteParts.push('cancelled excluded');
    if (!data.showAllDone) noteParts.push('ALL DONE excluded');
    if (data.hideRenewalOrProcessingOnly) noteParts.push('clients with only Renewal/Processing orders hidden');
    const exclusionSuffix = noteParts.length ? ` (${noteParts.join(', ')})` : '';

    const sincePhrase = data.allDates ? '' : ` since ${data.sinceDate}`;

    summaryEl.hidden = false;
    summaryEl.innerHTML = `<strong>${data.totalCount}</strong> order${data.totalCount === 1 ? '' : 's'} (${statusBreakdown}) across ${data.byClient.length} client${data.byClient.length === 1 ? '' : 's'}${sincePhrase}${filterSuffix}${exclusionSuffix}<span class="inline-subtext"> -- as of ${formatDateTime(data.asOf)}</span>`;

    resultsEl.innerHTML = '';
    if (data.byClient.length === 0) {
      resultsEl.innerHTML = `<p class="status">No orders${filterSuffix}${sincePhrase}${exclusionSuffix}.</p>`;
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
            <th><input type="checkbox" class="cc-select-all-checkbox" title="Select/deselect all rows for this client (bulk)" /></th>
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
      resultsEl.appendChild(groupEl);
      wireRowActions(groupEl);
    }

    // Prune any selected id that's dropped out of view (a filter change,
    // or it just got closed) -- otherwise a stale id could linger in
    // bulkSelection with no checkbox left to represent it.
    const visibleIds = new Set(data.byClient.flatMap((g) => g.orders.map((o) => o.id)));
    for (const id of bulkSelection.itemIds) {
      if (!visibleIds.has(id)) {
        bulkSelection.itemIds.delete(id);
        bulkAllDoneTicked.delete(id);
      }
    }
    if (bulkSelection.itemIds.size === 0) {
      bulkSelection.customerId = null;
      bulkAllDoneTicked = new Set();
    }
    updateRowSelectionUI();
  }

  function orderRowsHtml(orders) {
    return orders
      .map(
        (o) => `
      <tr>
        <td><input type="checkbox" class="cc-row-select" data-id="${o.id}" data-customer-id="${escapeHtml(o.customerId ?? '')}" title="Select for bulk close (same client only)" /></td>
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

  // Single Provisioned column, by request -- shows the real provisioningDate
  // whenever Ingram has actually set it (unchanged real data), otherwise,
  // for a still-"processing" order, shows the Pending Date computed at sync
  // time instead, in red -- same merged-column convention (and red styling)
  // Ingram Orders' own provisionedCellHtml() uses. pending_date is still
  // stored as its OWN field in the database (per request -- never written
  // into provisioning_date), this is purely a display-time merge.
  function provisionedCellHtml(o) {
    if (o.status === 'cancelled') return `<span class="text-highlight-blue">Order Cancelled</span>`;
    if (o.provisioningDate) return formatDateTime(o.provisioningDate);
    if (o.status === 'processing' && o.pendingDate) {
      return `<span class="cell-flag-red">${formatDate(o.pendingDate)}</span>`;
    }
    return '';
  }

  // historyCount arrives already-attached to each row (db.js's
  // getHistoryCounts(), one batched COUNT query for the whole page), so the
  // icon's own tooltip needs no extra fetch to show a real number.
  function historyIconTitle(o) {
    const count = o.historyCount || 0;
    return `View history (${count} record${count === 1 ? '' : 's'})`;
  }

  function poNumberCellHtml(o) {
    // The edit icon is ALWAYS shown, by request -- even with no PO # yet,
    // there needs to be a way to add one, not just correct an existing one.
    // An inline SVG (fill="currentColor"), not the ✏️ emoji it replaced --
    // by request, a muted beige/yellow instead of the emoji's own fixed
    // bright colors, which CSS can't recolor at all (a colored emoji glyph
    // ignores `color`, unlike a currentColor SVG). Styled in styles.css.
    const editIcon = `<button type="button" class="wsp-icon-btn cc-po-edit-btn" data-id="${o.id}" title="Edit ticket number"><svg class="cc-po-edit-icon" viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.9959.9959 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg></button>`;
    if (!o.poNumber) return editIcon;
    // target="_blank" stays as a real fallback (middle-click/ctrl-click/
    // "open in new tab" all still work normally) -- the plain-click case is
    // intercepted in wireRowActions() below to open a real separate WINDOW
    // instead of a tab, positioned on the same monitor as this one, by
    // request. rel="noopener" either way -- the opened ticket page never
    // gets a handle back to this one.
    //
    // Hover tooltip, by request -- client/status/title straight from the
    // real Autotask ticket (server.js's attachTicketDetails(), not this
    // order's own Ingram-sourced clientName, which can legitimately name a
    // different client than the ticket's own company). Ticket # and status
    // share one line, by request; client and title each get their own.
    // Any piece that failed to fetch (or the ticket has none, e.g. no
    // title) is just left out of its line rather than showing "undefined".
    const tooltipLines = [];
    if (o.ticketClientName) tooltipLines.push(`Client: ${o.ticketClientName}`);
    tooltipLines.push(`Ticket #${o.poNumber}${o.ticketStatus ? ` -- ${o.ticketStatus}` : ''}`);
    if (o.ticketTitle) tooltipLines.push(`Title: ${o.ticketTitle}`);
    const tooltip = tooltipLines.join('\n');

    const linkOrText = o.ticketUrl
      ? `<a href="${escapeHtml(o.ticketUrl)}" target="_blank" rel="noopener" class="cc-ticket-link" title="${escapeHtml(tooltip)}">${escapeHtml(o.poNumber)}</a>`
      : `<span title="Ticket not found in Autotask">${escapeHtml(o.poNumber)}</span>`;
    return `${linkOrText}${poFlagIconHtml(o)} ${editIcon}${rewstIconHtml(o)}`;
  }

  // After the PO #, before the edit pencil, by request -- two mutually
  // exclusive icons over the same underlying signal (o.poNumberManual, set
  // by db.js's updateItemFields()):
  //   - green check, when this PO #/ticket was manually entered -- a human
  //     already confirmed it, nothing further to flag.
  //   - "?" (server.js's attachTicketDetails() -- o.ticketDateMismatch),
  //     when it wasn't manually entered AND the ticket's own creation date
  //     is more than a day from the order's, worth a second look. Deliberately
  //     never both at once -- server.js doesn't even compute the mismatch
  //     when poNumberManual is set, per request ("don't check the dates...
  //     if a new ticket number has been manually provided").
  function poFlagIconHtml(o) {
    if (o.poNumberManual) {
      return `<span class="cc-po-manual-icon" title="PO # / Ticket manually entered">✓</span>`;
    }
    if (o.ticketDateMismatch) {
      return `<span class="cc-po-mismatch-icon" title="This ticket was created more than a day away from the order's own creation date -- worth double-checking this is the right ticket">?</span>`;
    }
    return '';
  }

  // Small icon after the edit pencil, by request, when this ticket's
  // status history ever passed through "Rewst - Stage Done" (server.js's
  // attachRewstStageDoneFlags() -- a real Autotask history lookup, not
  // guessed from the ticket's current status alone, since it may have long
  // since moved on from there).
  function rewstIconHtml(o) {
    // Rewst's own real logo (packages/shell/public/rewst-icon.png), by
    // request -- served as a plain static asset, same convention as
    // logo.png/favicon.png already sitting in that same folder.
    return o.hasRewstStageDone
      ? `<img src="/rewst-icon.png" class="cc-rewst-icon" alt="Rewst" title="This ticket passed through Rewst - Stage Done" />`
      : '';
  }

  // Opens `url` as a genuine separate WINDOW (not just a new tab -- a
  // window.open() call with explicit size/position features is what
  // actually forces most browsers into "new window" rather than "new tab"),
  // sized/positioned relative to THIS window's own on-screen position
  // (window.screenX/screenY, window.outerWidth/outerHeight) rather than
  // fixed absolute coordinates -- on a multi-monitor setup, anchoring to the
  // current window's real position is what keeps the new window on the SAME
  // monitor, by request, instead of it possibly landing on a different one.
  function openInNewWindow(url) {
    const width = Math.round(window.outerWidth * 0.9);
    const height = Math.round(window.outerHeight * 0.9);
    const left = window.screenX + Math.round((window.outerWidth - width) / 2);
    const top = window.screenY + Math.round((window.outerHeight - height) / 2);
    window.open(url, '_blank', `noopener,width=${width},height=${height},left=${left},top=${top}`);
  }

  // Same delta/total rendering Ingram Orders' licensesCellHtml() uses --
  // see that file's own extensive comment for the full reasoning (signed
  // deltas on change orders, the pending-blue/processing-red cases, etc).
  // Reproduced here rather than shared since products/currentTotal/status
  // are always already on hand on this page (no on-demand detail fetch).
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

  // ON/OFF, newest first, one line per toggle event -- the hover tooltip.
  // toggleHistory arrives already-attached to each row (db.js's
  // getToggleHistories(), one batched query for the whole page), so this
  // needs no extra fetch per checkbox.
  function toggleHistoryTitle(historyArr) {
    if (!historyArr || historyArr.length === 0) return 'No history yet';
    return historyArr.map((e) => `${e.action === 'on' ? 'ON' : 'OFF'} - ${formatDateTime(e.at)} by ${e.byName}`).join('\n');
  }

  // Locked once ALL DONE is ticked, by request -- every OTHER checkbox
  // stops being editable until ALL DONE itself is unticked first (ALL DONE
  // is exempt from its own lock, obviously, or a row could never be
  // reopened). Server-side enforces the same rule (PATCH /items/:id/toggle
  // in server.js) -- this is the UI reflecting that, not the only guard.
  function toggleCellHtml(o, col) {
    const checked = !!o[col.atKey];
    const history = o.toggleHistory && o.toggleHistory[col.field];
    const locked = col.field !== 'all_done' && !!o.allDoneAt;
    const historyTitle = toggleHistoryTitle(history);
    const title = locked ? `${historyTitle}\n\n(Untick ALL DONE to change)` : historyTitle;
    return `<input type="checkbox" class="cc-toggle" data-id="${o.id}" data-field="${col.field}" ${checked ? 'checked' : ''} ${locked ? 'disabled' : ''} title="${escapeHtml(title)}" />`;
  }

  // The Info Q&A stamp -- same icon shapes/behaviour as Workshop's own
  // qaIconsHtml()/openQaModal() (packages/workshop/client.js), field names
  // swapped to infoQuestion/infoAnswer.
  function infoIconsHtml(o) {
    const hasQuestion = !!o.infoQuestion;
    const hasAnswer = !!o.infoAnswer;
    const hasNote = !!o.ticketNote;
    const dataAttrs = `data-id="${o.id}"`;

    let qaHtml;
    if (!hasQuestion && !hasAnswer) {
      qaHtml = `<span class="wsp-qa-icon wsp-qa-icon--q wsp-qa-icon--empty cc-info-icon" ${dataAttrs} title="Click to leave a question/answer">?</span>`;
    } else if (!hasQuestion && hasAnswer) {
      qaHtml = `<span class="wsp-qa-icon wsp-qa-icon--a wsp-qa-icon--set cc-info-icon" ${dataAttrs} title="${escapeHtml(o.infoAnswer)}">A</span>`;
    } else {
      const qIcon = `<span class="wsp-qa-icon wsp-qa-icon--q wsp-qa-icon--set cc-info-icon" ${dataAttrs} title="${escapeHtml(o.infoQuestion)}">?</span>`;
      qaHtml = hasAnswer ? `${qIcon}<span class="wsp-qa-icon wsp-qa-icon--a wsp-qa-icon--set cc-info-icon" ${dataAttrs} title="${escapeHtml(o.infoAnswer)}">A</span>` : qIcon;
    }

    // Ticket Note's own icon, by request -- always shown (unlike Q, which
    // only appears as the lone entry point when nothing's set yet) so
    // there's always a click target for it independent of whether Q/A
    // have anything. Hover shows the note text itself; click opens its OWN
    // separate form (openTicketNoteModal), not the Q&A one -- a different
    // click class (cc-ticket-note-icon) from the Q/A icons above, by
    // request, since these two are separate editors on purpose now.
    const tIcon = `<span class="wsp-qa-icon wsp-qa-icon--t ${hasNote ? 'wsp-qa-icon--set' : 'wsp-qa-icon--empty'} cc-ticket-note-icon" ${dataAttrs} title="${hasNote ? escapeHtml(o.ticketNote) : 'Click to leave a ticket note'}">T</span>`;

    return `${qaHtml}${tIcon}`;
  }

  function findOrder(id) {
    if (!lastData) return null;
    for (const client of lastData.byClient) {
      const found = client.orders.find((o) => String(o.id) === String(id));
      if (found) return found;
    }
    return null;
  }

  // load() fully rebuilds #results (resultsEl.innerHTML = '' then
  // re-populated) -- reloading after a toggle/Info save further down the
  // page destroys the checkbox/icon the user just interacted with, and
  // losing focus that way was jumping back to the top. scrollContainer
  // (resolved once at the top of mount(), see its own comment there) is
  // the ACTUAL scrolling element -- .page-content's own overflow-y: auto
  // in styles.css -- not window/document, which never scroll on this
  // dashboard at all (.layout is a fixed 100vh flex row). Restoring
  // window.scrollY was a no-op the first time around for exactly that
  // reason; scrollContainer.scrollTop is the real fix. Plain container
  // (rather than scrollContainer) was the original version of this fix --
  // correct only while this page is standalone; broke silently, always
  // restoring 0 onto an inner div that never itself scrolls, the moment
  // it got wrapped inside a tabbed page (confirmed live via console
  // logging -- see scrollContainer's own comment for the full story).
  async function loadPreservingScroll() {
    const y = scrollContainer.scrollTop;
    await load();
    scrollContainer.scrollTop = y;
  }

  // A real "Close Ticket" / "Write Note (Don't Close)" / "Do Neither"
  // confirmation, by request -- native confirm() can't relabel its own
  // buttons or offer a third choice, so this is a small custom modal (same
  // overlay/panel shell) instead. Resolves one of 'close' | 'note-only' |
  // 'none' (Escape and clicking outside the panel both resolve 'none',
  // same as the old Cancel button did); never rejects. Only ever shown for
  // ticking ALL DONE ON when there's a real linked ticket to act on (see
  // the .cc-toggle change handler below) -- unticking, or an item with no
  // ticket link, skips this entirely.
  //
  // `warningLines` (by request) -- one line per order whose linked ticket's
  // CURRENT status isn't "Billing - Contract", shown in a red box above the
  // main message. Uses o.ticketStatus, the same field server.js's
  // attachTicketDetails() already fetches for the ticket-number hover
  // tooltip -- no extra request needed here. Empty/omitted renders nothing.
  function confirmCloseTicket(count = 1, warningLines = []) {
    const message =
      count > 1
        ? `This will write ticket notes and mark ${count} tickets as COMPLETE.`
        : 'This will write the ticket note and mark the ticket as COMPLETE.';
    const warningHtml =
      warningLines.length > 0
        ? `<p class="cc-confirm-warning">${warningLines.map((l) => escapeHtml(l)).join('<br>')}</p>`
        : '';
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'history-modal-overlay';
      overlay.innerHTML = `
        <div class="history-modal-panel wsp-qa-modal-panel cc-confirm-close-modal-panel">
          <div class="history-modal-panel-header">
            <span>${count > 1 ? 'Close Tickets?' : 'Close Ticket?'}</span>
          </div>
          <div class="history-modal-body">
            ${warningHtml}
            <p class="status">${escapeHtml(message)}</p>
            <div class="wsp-form-actions">
              <button type="button" class="button-link cc-confirm-close-button">${count > 1 ? 'Write Notes<br>Complete Tickets' : 'Write Note<br>Complete Ticket'}</button>
              <button type="button" class="cc-confirm-note-only-button">${count > 1 ? "Write Notes<br>Don't Complete Tickets" : "Write Note<br>Don't Complete Ticket"}</button>
              <button type="button" class="cc-confirm-cancel-button">Cancel This</button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      const finish = (value) => {
        overlay.remove();
        document.removeEventListener('keydown', onKeydown);
        resolve(value);
      };
      function onKeydown(e) {
        if (e.key === 'Escape') finish('none');
      }
      document.addEventListener('keydown', onKeydown);
      overlay.querySelector('.cc-confirm-close-button').addEventListener('click', () => finish('close'));
      overlay.querySelector('.cc-confirm-note-only-button').addEventListener('click', () => finish('note-only'));
      overlay.querySelector('.cc-confirm-cancel-button').addEventListener('click', () => finish('none'));
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) finish('none');
      });
    });
  }

  // Same overlay/panel shell as confirmCloseTicket() above, for the
  // opposite action -- unticking ALL DONE on an item with a real linked
  // ticket, by request, asks which status to REOPEN it to rather than
  // always sending it back to Billing - Contract. Resolves 'leave' (the
  // ticket stays Complete, no Autotask call at all), a status id string
  // ('20'/'50'/'15'), or 'cancel' (Escape/outside-click/Cancel button all
  // resolve here, same as confirmCloseTicket()'s 'none') -- never rejects.
  function confirmReopenTicket() {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'history-modal-overlay';
      overlay.innerHTML = `
        <div class="history-modal-panel wsp-qa-modal-panel">
          <div class="history-modal-panel-header">
            <span>Reopen Ticket?</span>
          </div>
          <div class="history-modal-body">
            <p class="status">Unticking ALL DONE reopens this order. What should the linked ticket's status become?</p>
            <select class="wsp-field cc-reopen-status-select">
              <option value="20" selected>Set to Billing - Contract</option>
              <option value="50">Set to FIX Billing</option>
              <option value="15">Needs Internal Update</option>
              <option value="leave">Leave as COMPLETE</option>
            </select>
            <div class="wsp-form-actions">
              <button type="button" class="button-link cc-reopen-confirm-button">Confirm</button>
              <button type="button" class="cc-reopen-cancel-button">Cancel</button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      const finish = (value) => {
        overlay.remove();
        document.removeEventListener('keydown', onKeydown);
        resolve(value);
      };
      function onKeydown(e) {
        if (e.key === 'Escape') finish('cancel');
      }
      document.addEventListener('keydown', onKeydown);
      const select = overlay.querySelector('.cc-reopen-status-select');
      overlay.querySelector('.cc-reopen-confirm-button').addEventListener('click', () => finish(select.value));
      overlay.querySelector('.cc-reopen-cancel-button').addEventListener('click', () => finish('cancel'));
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) finish('cancel');
      });
    });
  }

  // Re-applies bulkSelection onto whatever .cc-row-select checkboxes are
  // currently in the DOM -- called after every render() (fresh checkboxes,
  // all unchecked by default) and after any selection change. Only
  // checkboxes for the selected client stay enabled once 1+ row is picked,
  // by request ("Only allow tickets of the same client to be chosen").
  function updateRowSelectionUI() {
    resultsEl.querySelectorAll('.cc-row-select').forEach((el) => {
      const id = Number(el.dataset.id);
      el.checked = bulkSelection.itemIds.has(id);
      el.disabled = bulkSelection.itemIds.size > 0 && el.dataset.customerId !== bulkSelection.customerId;
    });
    // The per-client-group "select all" header checkbox, by request --
    // re-derived fresh here too (not tracked as its own separate state),
    // same "recompute from bulkSelection every time" approach the row
    // checkboxes above already use. checked = every row in this group is
    // selected; indeterminate = some but not all (standard tri-state
    // select-all convention); disabled = same rule as its own rows
    // (another client's selection is active).
    resultsEl.querySelectorAll('.cc-select-all-checkbox').forEach((selectAllEl) => {
      const groupEl = selectAllEl.closest('.resource-group');
      const rowEls = groupEl ? [...groupEl.querySelectorAll('.cc-row-select')] : [];
      if (rowEls.length === 0) {
        selectAllEl.checked = false;
        selectAllEl.indeterminate = false;
        selectAllEl.disabled = true;
        return;
      }
      const groupCustomerId = rowEls[0].dataset.customerId;
      const selectedCount = rowEls.filter((el) => bulkSelection.itemIds.has(Number(el.dataset.id))).length;
      selectAllEl.disabled = bulkSelection.itemIds.size > 0 && groupCustomerId !== bulkSelection.customerId;
      selectAllEl.checked = selectedCount === rowEls.length;
      selectAllEl.indeterminate = selectedCount > 0 && selectedCount < rowEls.length;
    });
    // Restores any pending (unsaved) ALL DONE ticks too -- a render()
    // triggered by an unrelated toggle elsewhere on the page shouldn't
    // silently un-tick boxes the user already ticked as part of building
    // up the bulk set.
    resultsEl.querySelectorAll('.cc-toggle[data-field="all_done"]').forEach((el) => {
      const id = Number(el.dataset.id);
      if (bulkAllDoneTicked.has(id)) el.checked = true;
    });
  }

  function wireRowActions(groupEl) {
    groupEl.querySelectorAll('.cc-row-select').forEach((el) => {
      el.addEventListener('change', () => {
        const id = Number(el.dataset.id);
        if (el.checked) {
          if (bulkSelection.itemIds.size === 0) bulkSelection.customerId = el.dataset.customerId;
          bulkSelection.itemIds.add(id);
        } else {
          bulkSelection.itemIds.delete(id);
          bulkAllDoneTicked.delete(id); // deselecting a row also drops any pending (unsaved) ALL DONE tick on it
          if (bulkSelection.itemIds.size === 0) {
            bulkSelection.customerId = null;
            bulkAllDoneTicked = new Set();
          }
        }
        updateRowSelectionUI();
      });
    });

    // The header "select all" checkbox for this client's group, by request
    // -- ticks/unticks every row in THIS table only (bulk selection is
    // already single-client-only, so this never reaches across groups).
    // Goes through the exact same bulkSelection add/delete logic as a real
    // row click, just applied to every row at once, with updateRowSelectionUI()
    // called once at the end rather than per row.
    const selectAllEl = groupEl.querySelector('.cc-select-all-checkbox');
    if (selectAllEl) {
      selectAllEl.addEventListener('change', () => {
        const rowEls = [...groupEl.querySelectorAll('.cc-row-select')];
        if (selectAllEl.checked) {
          for (const el of rowEls) {
            const id = Number(el.dataset.id);
            if (bulkSelection.itemIds.size === 0) bulkSelection.customerId = el.dataset.customerId;
            bulkSelection.itemIds.add(id);
          }
        } else {
          for (const el of rowEls) {
            const id = Number(el.dataset.id);
            bulkSelection.itemIds.delete(id);
            bulkAllDoneTicked.delete(id);
          }
          if (bulkSelection.itemIds.size === 0) {
            bulkSelection.customerId = null;
            bulkAllDoneTicked = new Set();
          }
        }
        updateRowSelectionUI();
      });
    }

    groupEl.querySelectorAll('.cc-ticket-link').forEach((el) => {
      el.addEventListener('click', (e) => {
        // Only a plain left-click is redirected into openInNewWindow() --
        // ctrl/cmd/shift/middle-click stay native browser behavior (new
        // tab/background tab/new window per the browser's own convention),
        // same as any other link.
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        openInNewWindow(el.href);
      });
    });

    groupEl.querySelectorAll('.cc-po-edit-btn').forEach((el) => {
      el.addEventListener('click', () => openPoNumberModal(el.dataset.id, findOrder(el.dataset.id)));
    });

    groupEl.querySelectorAll('.cc-toggle').forEach((el) => {
      el.addEventListener('change', async () => {
        const itemId = Number(el.dataset.id);

        // Bulk-close path -- only for a row that's part of an active
        // multi-row selection (2+ rows chosen via the leading checkbox, all
        // the same client). Ticking (or unticking) ALL DONE here is purely
        // LOCAL and unsaved -- by request, nothing is sent to the server at
        // all until every selected row's ALL DONE is ticked. Whichever tick
        // completes that full set is what actually fires the whole batch --
        // not a fixed "last row in the list", the last one YOU tick,
        // whatever order that happens in. Unticking one before the set is
        // complete just removes it from the pending set, no save either way.
        if (el.dataset.field === 'all_done' && bulkSelection.itemIds.size > 1 && bulkSelection.itemIds.has(itemId)) {
          if (el.checked) bulkAllDoneTicked.add(itemId);
          else bulkAllDoneTicked.delete(itemId);

          const allTicked = [...bulkSelection.itemIds].every((id) => bulkAllDoneTicked.has(id));
          if (!allTicked) return; // still waiting on the rest -- nothing saved yet

          // One warning line per selected order whose linked ticket's
          // current status isn't "Billing - Contract" -- prefixed with its
          // own order number here (unlike the single-item call site below)
          // since a bulk batch can span several different tickets/statuses
          // at once.
          const bulkWarningLines = [...bulkSelection.itemIds]
            .map((id) => findOrder(String(id)))
            .filter((order) => order && order.ticketStatus && order.ticketStatus !== 'Billing - Contract')
            .map((order) => `Warning: ${order.orderNumber} Ticket Status is ${order.ticketStatus}`);
          const choice = await confirmCloseTicket(bulkSelection.itemIds.size, bulkWarningLines);
          if (choice === 'none') {
            // Revert just this last tick -- the OTHER already-ticked rows
            // stay ticked (still pending), ready to re-complete the set later.
            el.checked = false;
            bulkAllDoneTicked.delete(itemId);
            return;
          }
          el.disabled = true;
          try {
            const result = await fetchJson('/api/contract-checks/items/bulk-close', 'POST', {
              itemIds: [...bulkSelection.itemIds],
              closeTicket: choice === 'close', // false for "Write Note (Don't Close)" -- applies to the whole batch
            });
            // Several orders can share one real ticket -- server.js posts
            // ONE merged note/close per ticket, not one each, so group
            // failures by the ticketAction's own content here too (not
            // object identity -- JSON round-tripping over HTTP never
            // preserves that), rather than repeating the identical error
            // once per order that happened to share it.
            const failedByAction = new Map(); // JSON string -> { error, orderNumbers[] }
            for (const r of result.results || []) {
              if (!r.ticketAction || r.ticketAction.ok) continue;
              const key = JSON.stringify(r.ticketAction);
              if (!failedByAction.has(key)) failedByAction.set(key, { error: r.ticketAction.error, orderNumbers: [] });
              failedByAction.get(key).orderNumbers.push(r.orderNumber);
            }
            if (failedByAction.size > 0) {
              const lines = [...failedByAction.values()].map(({ error, orderNumbers }) => `${orderNumbers.join(', ')}: ${error}`);
              alert(`ALL DONE saved for every selected order, but some Autotask actions failed:\n${lines.join('\n')}`);
            }
            bulkSelection = { customerId: null, itemIds: new Set() };
            bulkAllDoneTicked = new Set();
            await loadPreservingScroll();
          } catch (err) {
            el.checked = false;
            bulkAllDoneTicked.delete(itemId);
            alert(`Error: ${err.message}`);
          } finally {
            el.disabled = false;
          }
          return;
        }

        // Confirm before ticking ALL DONE ON for an item with a real
        // linked ticket -- this is the one toggle with a real side effect
        // (writing a note, and by default closing the ticket), by request.
        // Unticking one asks a different question instead -- which status
        // to reopen the ticket to (confirmReopenTicket()), also by request.
        // An item with no ticket link (nothing will actually happen either
        // way) skips both popups entirely. `closeTicket`/`reopenStatus`
        // stay at their harmless defaults when there's nothing to confirm
        // -- the server only ever consults them when a ticketAction is
        // actually going to happen.
        let closeTicket = true;
        let reopenStatus = 'leave';
        if (el.dataset.field === 'all_done') {
          const order = findOrder(el.dataset.id);
          if (order && order.ticketAutotaskId) {
            if (el.checked) {
              const warningLines =
                order.ticketStatus && order.ticketStatus !== 'Billing - Contract' ? [`Warning: Ticket Status is ${order.ticketStatus}`] : [];
              const choice = await confirmCloseTicket(1, warningLines);
              if (choice === 'none') {
                el.checked = false; // the click already toggled it visually -- revert
                return;
              }
              closeTicket = choice === 'close'; // false for "Write Note (Don't Close)"
            } else {
              const choice = await confirmReopenTicket();
              if (choice === 'cancel') {
                el.checked = true; // the click already toggled it visually -- revert
                return;
              }
              reopenStatus = choice; // 'leave' or a status id string
            }
          }
        }
        el.disabled = true;
        try {
          const body = { field: el.dataset.field, value: el.checked };
          if (el.dataset.field === 'all_done') {
            body.closeTicket = closeTicket;
            body.reopenStatus = reopenStatus;
          }
          const result = await fetchJson(`/api/contract-checks/items/${el.dataset.id}/toggle`, 'PATCH', body);
          // Ticking ALL DONE, by request, also writes a note to the linked
          // Autotask ticket -- see PATCH /items/:id/toggle in server.js.
          // By default it also sets the ticket's status to Complete
          // (note titled "Closing Ticket using Dashboard Contract
          // Checks"); "Write Note (Don't Close)" posts the same note
          // (titled "NOT Closing Ticket..." instead) but leaves the status
          // untouched. Only happens when there's a resolved ticket link
          // and the box is being turned ON -- silently skipped otherwise
          // (no ticketAction in the response at all in that case).
          // Success is silent, by request -- the confirmation before the
          // action already told the user what would happen, so nothing
          // further is shown unless something actually went wrong. Both
          // directions now post a note first, then change status (fail-
          // closed -- server.js skips the status change if the note itself
          // failed): ticking ON posts a note and (unless "Write Note
          // (Don't Close)" was chosen) closes the ticket (notePosted/
          // statusClosed); unticking to anything but "Leave as COMPLETE"
          // posts a reopen note and reopens the ticket (notePosted/
          // statusReverted) -- server.js echoes the target status back as
          // newStatus (on success AND failure) so this message can name it.
          if (result.ticketAction && !result.ticketAction.ok) {
            const a = result.ticketAction;
            if ('statusReverted' in a) {
              const statusLabel = TICKET_STATUS_LABELS[a.newStatus] || `status ${a.newStatus}`;
              if (a.notePosted) {
                alert(`ALL DONE saved here, and the reopen note WAS posted to Autotask -- but setting the ticket to ${statusLabel} failed: ${a.error}`);
              } else {
                alert(`ALL DONE saved here, but posting the reopen note to Autotask failed (ticket status left unchanged): ${a.error}`);
              }
            } else if (a.notePosted) {
              // The note went through -- only the status change failed, so
              // don't imply nothing happened on the ticket.
              alert(`ALL DONE saved here, and the note WAS posted to Autotask -- but marking the ticket Complete failed: ${a.error}`);
            } else {
              alert(`ALL DONE saved here, but posting the note to Autotask failed: ${a.error}`);
            }
          }
          await loadPreservingScroll(); // re-fetch so the tooltip history and any ALL-DONE filtering stay correct
        } catch (err) {
          el.checked = !el.checked;
          alert(`Error: ${err.message}`);
        } finally {
          el.disabled = false;
        }
      });
    });

    // Locked once ALL DONE is ticked, by request -- these are <span>s, not
    // real <button>s, so there's no native `disabled` to lean on the way
    // the checkboxes above do; insisting via an alert() on click is the
    // active "no, untick ALL DONE first" this was asked for, rather than a
    // passive greyed-out look. Server-side enforces the same rule (PATCH
    // /items/:id in server.js) either way.
    groupEl.querySelectorAll('.cc-info-icon').forEach((el) => {
      el.addEventListener('click', () => {
        const order = findOrder(el.dataset.id);
        if (order && order.allDoneAt) {
          alert('Untick ALL DONE before changing Info on this order.');
          return;
        }
        openInfoModal(el.dataset.id, order);
      });
    });

    groupEl.querySelectorAll('.cc-ticket-note-icon').forEach((el) => {
      el.addEventListener('click', () => {
        const order = findOrder(el.dataset.id);
        if (order && order.allDoneAt) {
          alert('Untick ALL DONE before changing the Ticket Note on this order.');
          return;
        }
        openTicketNoteModal(el.dataset.id, order);
      });
    });

    groupEl.querySelectorAll('.cc-history-btn').forEach((el) => {
      el.addEventListener('click', () => openHistoryModal(el.dataset.id, findOrder(el.dataset.id)));
    });
  }

  // Combined Q&A popup form -- same shape as Workshop's openQaModal(),
  // reusing the shared .history-modal-* overlay/panel styles. Opened by
  // either Q/A icon (see wireRowActions above) -- both fields are always
  // editable together here. Ticket Note is a SEPARATE editor on purpose
  // (openTicketNoteModal below), by request -- the icon in this column is
  // display-only for it plus its own click target, not folded into this form.
  function openInfoModal(itemId, item) {
    const overlay = document.createElement('div');
    overlay.className = 'history-modal-overlay';
    const title = item ? `${item.orderNumber} -- Info` : `Item #${itemId} -- Info`;
    overlay.innerHTML = `
      <div class="history-modal-panel wsp-qa-modal-panel">
        <div class="history-modal-panel-header">
          <span>${escapeHtml(title)}</span>
          <button type="button" class="history-modal-close" aria-label="Close">✕</button>
        </div>
        <div class="history-modal-body">
          <label class="wsp-qa-modal-label">
            <span class="wsp-qa-icon wsp-qa-icon--q wsp-qa-icon--set">?</span>
            <input type="text" class="wsp-field cc-info-question-input" value="${escapeHtml((item && item.infoQuestion) || '')}" placeholder="Leave a question..." maxlength="300" />
          </label>
          <label class="wsp-qa-modal-label">
            <span class="wsp-qa-icon wsp-qa-icon--a wsp-qa-icon--set">A</span>
            <input type="text" class="wsp-field cc-info-answer-input" value="${escapeHtml((item && item.infoAnswer) || '')}" placeholder="Leave an answer..." maxlength="300" />
          </label>
          <p class="status error cc-info-modal-error" hidden></p>
          <div class="wsp-form-actions">
            <button type="button" class="button-link cc-info-save-button">Save</button>
            <button type="button" class="cc-info-cancel-button">Cancel</button>
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
    overlay.querySelector('.cc-info-cancel-button').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    const questionInput = overlay.querySelector('.cc-info-question-input');
    const answerInput = overlay.querySelector('.cc-info-answer-input');

    async function save() {
      const errorEl = overlay.querySelector('.cc-info-modal-error');
      errorEl.hidden = true;
      try {
        await fetchJson(`/api/contract-checks/items/${itemId}`, 'PATCH', {
          infoQuestion: questionInput.value.trim(),
          infoAnswer: answerInput.value.trim(),
        });
        close();
        await loadPreservingScroll();
      } catch (err) {
        errorEl.hidden = false;
        errorEl.textContent = `Error: ${err.message}`;
      }
    }
    overlay.querySelector('.cc-info-save-button').addEventListener('click', save);
    questionInput.focus();
  }

  // Ticket Note's own separate popup form, by request -- distinct from the
  // Q&A modal above (same overlay/panel shell, just its own single field).
  function openTicketNoteModal(itemId, item) {
    const overlay = document.createElement('div');
    overlay.className = 'history-modal-overlay';
    const title = item ? `${item.orderNumber} -- Ticket Note` : `Item #${itemId} -- Ticket Note`;
    overlay.innerHTML = `
      <div class="history-modal-panel wsp-qa-modal-panel cc-ticket-note-modal-panel">
        <div class="history-modal-panel-header">
          <span>${escapeHtml(title)}</span>
          <button type="button" class="history-modal-close" aria-label="Close">✕</button>
        </div>
        <div class="history-modal-body">
          <label class="wsp-qa-modal-label wsp-qa-modal-label--top">
            <span class="wsp-qa-icon wsp-qa-icon--t wsp-qa-icon--set">T</span>
            <textarea class="wsp-field cc-ticket-note-input" rows="11" placeholder="Leave a ticket note...">${escapeHtml((item && item.ticketNote) || '')}</textarea>
          </label>
          <p class="status error cc-ticket-note-modal-error" hidden></p>
          <div class="wsp-form-actions">
            <button type="button" class="button-link cc-ticket-note-save-button">Save</button>
            <button type="button" class="cc-ticket-note-cancel-button">Cancel</button>
            <button type="button" class="cc-ticket-note-template-button">Get Note Template</button>
            <button type="button" class="link-button cc-ticket-note-edit-template-button">Edit Template</button>
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
    overlay.querySelector('.cc-ticket-note-cancel-button').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    const noteInput = overlay.querySelector('.cc-ticket-note-input');
    const saveButton = overlay.querySelector('.cc-ticket-note-save-button');

    // Plain local save -- closing out the real Autotask ticket moved to
    // the ALL DONE checkbox instead (see the .cc-toggle change handler in
    // wireRowActions below), by request.
    async function save() {
      const errorEl = overlay.querySelector('.cc-ticket-note-modal-error');
      errorEl.hidden = true;
      saveButton.disabled = true;
      saveButton.textContent = 'Saving...';
      try {
        await fetchJson(`/api/contract-checks/items/${itemId}`, 'PATCH', { ticketNote: noteInput.value.trim() });
        close();
        await loadPreservingScroll();
      } catch (err) {
        errorEl.hidden = false;
        errorEl.textContent = `Error: ${err.message}`;
        saveButton.disabled = false;
        saveButton.textContent = 'Save';
      }
    }
    saveButton.addEventListener('click', save);

    // "Get Note Template" -- fetches the current DB-stored template (see
    // db.js -- editable via "Edit Template" below, so it can be kept up to
    // date without a code change) and fills it in directly when the note is
    // empty; when it isn't, warns before overwriting rather than silently
    // discarding whatever's already been typed, by request. Doesn't save on
    // its own -- it only fills the textarea, so Save/Cancel still work
    // normally afterward.
    overlay.querySelector('.cc-ticket-note-template-button').addEventListener('click', async () => {
      const errorEl = overlay.querySelector('.cc-ticket-note-modal-error');
      errorEl.hidden = true;
      if (noteInput.value.trim() && !confirm('This action will overwrite your current note. Save your current note first if needed. Continue?')) {
        return;
      }
      try {
        const template = await fetchJson('/api/contract-checks/templates/ticket_note', 'GET');
        noteInput.value = template.content;
        noteInput.focus();
      } catch (err) {
        errorEl.hidden = false;
        errorEl.textContent = `Error loading template: ${err.message}`;
      }
    });

    overlay.querySelector('.cc-ticket-note-edit-template-button').addEventListener('click', () => {
      if (!currentUserEmail || currentUserEmail.toLowerCase() !== CONTRACT_CHECKS_ADMIN_EMAIL) {
        alert('See Amber to edit the note template.');
        return;
      }
      openEditTemplateModal();
    });

    noteInput.focus();
  }

  // Small editor for the PO # (Ticket #), by request -- same overlay/panel
  // shell, opened from the pencil icon poNumberCellHtml() always shows.
  // Saving re-resolves the linked Autotask ticket server-side (see PATCH
  // /items/:id in server.js) -- correcting a PO # here also fixes/clears
  // its ticket link, not just the displayed text.
  function openPoNumberModal(itemId, item) {
    const overlay = document.createElement('div');
    overlay.className = 'history-modal-overlay';
    const title = item ? `${item.orderNumber} -- Ticket Number` : `Item #${itemId} -- Ticket Number`;
    overlay.innerHTML = `
      <div class="history-modal-panel wsp-qa-modal-panel">
        <div class="history-modal-panel-header">
          <span>${escapeHtml(title)}</span>
          <button type="button" class="history-modal-close" aria-label="Close">✕</button>
        </div>
        <div class="history-modal-body">
          <label class="wsp-qa-modal-label">
            <input type="text" class="wsp-field cc-po-input" value="${escapeHtml((item && item.poNumber) || '')}" placeholder="e.g. T20260828.0017" maxlength="50" />
          </label>
          <p class="status error cc-po-modal-error" hidden></p>
          <div class="wsp-form-actions">
            <button type="button" class="button-link cc-po-save-button">Save</button>
            <button type="button" class="cc-po-cancel-button">Cancel</button>
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
    overlay.querySelector('.cc-po-cancel-button').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    const poInput = overlay.querySelector('.cc-po-input');
    const saveButton = overlay.querySelector('.cc-po-save-button');

    saveButton.addEventListener('click', async () => {
      const errorEl = overlay.querySelector('.cc-po-modal-error');
      errorEl.hidden = true;
      saveButton.disabled = true;
      saveButton.textContent = 'Saving...'; // a real Autotask lookup happens server-side, not instant
      try {
        await fetchJson(`/api/contract-checks/items/${itemId}`, 'PATCH', { poNumber: poInput.value.trim() });
        close();
        await loadPreservingScroll();
      } catch (err) {
        errorEl.hidden = false;
        errorEl.textContent = `Error: ${err.message}`;
        saveButton.disabled = false;
        saveButton.textContent = 'Save';
      }
    });
    poInput.focus();
  }

  // A small editor for the DB-stored 'ticket_note' template itself, by
  // request ("so that it can be easily updated if required") -- reuses the
  // same overlay/panel shell, opened from the "Edit Template" link inside
  // openTicketNoteModal above. Saving here only updates the stored
  // template, not any order's own Ticket Note.
  async function openEditTemplateModal() {
    const overlay = document.createElement('div');
    overlay.className = 'history-modal-overlay';
    overlay.innerHTML = `
      <div class="history-modal-panel wsp-qa-modal-panel">
        <div class="history-modal-panel-header">
          <span>Edit Ticket Note Template</span>
          <button type="button" class="history-modal-close" aria-label="Close">✕</button>
        </div>
        <div class="history-modal-body">
          <p class="status">Loading...</p>
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

    const body = overlay.querySelector('.history-modal-body');
    try {
      const template = await fetchJson('/api/contract-checks/templates/ticket_note', 'GET');
      body.innerHTML = `
        <label class="wsp-qa-modal-label">
          <span class="wsp-qa-modal-field-label">Name</span>
          <input type="text" class="wsp-field cc-edit-template-name-input" value="${escapeHtml(template.name)}" maxlength="100" />
        </label>
        <label class="wsp-qa-modal-label wsp-qa-modal-label--top">
          <span class="wsp-qa-modal-field-label">Content</span>
          <textarea class="wsp-field cc-edit-template-input" rows="12">${escapeHtml(template.content)}</textarea>
        </label>
        <p class="status error cc-edit-template-error" hidden></p>
        <div class="wsp-form-actions">
          <button type="button" class="button-link cc-edit-template-save-button">Save</button>
          <button type="button" class="cc-edit-template-cancel-button">Cancel</button>
        </div>
      `;
      overlay.querySelector('.cc-edit-template-cancel-button').addEventListener('click', close);
      const nameInput = overlay.querySelector('.cc-edit-template-name-input');
      const contentInput = overlay.querySelector('.cc-edit-template-input');
      overlay.querySelector('.cc-edit-template-save-button').addEventListener('click', async () => {
        const errorEl = overlay.querySelector('.cc-edit-template-error');
        errorEl.hidden = true;
        if (!nameInput.value.trim()) {
          errorEl.hidden = false;
          errorEl.textContent = 'Name is required.';
          return;
        }
        try {
          await fetchJson('/api/contract-checks/templates/ticket_note', 'PATCH', { name: nameInput.value.trim(), content: contentInput.value });
          close();
        } catch (err) {
          errorEl.hidden = false;
          errorEl.textContent = `Error: ${err.message}`;
        }
      });
      nameInput.focus();
    } catch (err) {
      body.innerHTML = `<p class="status error">Error loading template: ${escapeHtml(err.message)}</p>`;
    }
  }

  // Full audit trail -- same shape as Workshop's openHistoryModal()/
  // historyEntryHtml(), reusing the shared .history-modal-* overlay/panel.
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
      // Multi-line content (the template text, most of the time) -- the
      // plain "old → new" single-line format every other text field uses
      // reads as a garbled run-on for this one, by request. Old/new shown
      // as their own preserved-whitespace blocks instead of side by side.
      const block = (value) =>
        value ? `<div class="cc-history-note-block">${escapeHtml(value)}</div>` : `<div class="cc-history-note-block cc-history-note-empty">(none)</div>`;
      changeText = `<div>${escapeHtml(label)}:</div><div class="cc-history-note-label">Before</div>${block(entry.oldValue)}<div class="cc-history-note-label">After</div>${block(entry.newValue)}`;
    } else {
      changeText = `${escapeHtml(label)}: ${escapeHtml(entry.oldValue || '(none)')} → ${escapeHtml(entry.newValue || '(none)')}`;
    }
    const when = `${escapeHtml(entry.changedByName)} -- ${escapeHtml(formatDateTime(entry.changedAt))}`;
    return `<li class="history-modal-entry"><div>${changeText}</div><div class="history-modal-when">${when}</div></li>`;
  }

  // No auto-load on mount, by request-following convention (same as Ingram
  // Orders/Subscriptions) -- this page only fetches when Refresh is
  // explicitly clicked. `lastData` still restores instantly on a
  // same-session re-mount.
  if (lastData) render(lastData);

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

  // Plain YYYY-MM-DD date (no time component) -- for pendingDate, a
  // calendar date (either parsed straight out of a description string or a
  // subscription's own renewalDate), not a real timestamp. Same
  // AEST-anchored convention Ingram Subscriptions/Orders already use.
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
