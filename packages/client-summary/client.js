export const id = "client-summary";
export const label = "Client Summary";

// Module-scope, not inside mount() -- the shell fully tears down and re-mounts a
// page's DOM on every navigation away and back, but the dynamically-imported
// module itself is cached by the browser and stays alive for the session, so a
// module-level variable survives across re-mounts and lets the last result
// restore instantly instead of coming back blank.
let lastQuery = null; // { client }
let lastData = null;

// Whichever mount() is CURRENTLY on screen registers its own render()
// here. Fixes a real bug: load()'s render(data) call is a closure over
// THAT mount's own statusEl/resultsEl -- if you navigate away before a
// search resolves and come back before it actually finishes, the old
// mount's load() still runs to completion and would otherwise call its
// own (now detached, invisible) render(), so the currently-visible new
// mount never shows the result. Routing load()'s render call through this
// instead means whichever mount is actually visible always receives it.
let activeRender = null;

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>Client Summary</h1>
      <form id="filter-form" class="date-form">
        <label for="client-input">Client</label>
        <input type="text" id="client-input" name="client" placeholder="e.g. Cloud King Hosting" required />
        <button type="submit" id="search-button">Search</button>
      </form>
    </header>
    <p id="status" class="status">Type a client name (wildcards with *) and click Search. This is a single-client, at-a-glance summary, so a wildcard must match exactly one company.</p>
    <div id="results" class="results"></div>
  `;

  const form = container.querySelector('#filter-form');
  const clientInput = container.querySelector('#client-input');
  const searchButton = container.querySelector('#search-button');
  const statusEl = container.querySelector('#status');
  const resultsEl = container.querySelector('#results');

  if (lastQuery) clientInput.value = lastQuery.client;

  // This mount is now the active one -- see activeRender's own comment
  // up top.
  activeRender = render;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    load(clientInput.value);
  });

  async function load(clientName, companyId) {
    searchButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    resultsEl.innerHTML = '';

    try {
      const params = new URLSearchParams({ client: clientName });
      if (companyId) params.set('companyId', companyId);
      const res = await fetch(`/api/client-summary?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastQuery = { client: clientName };
      lastData = data;
      if (data.status === 'ok') clientInput.value = data.companyName;
      activeRender(data);
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      searchButton.disabled = false;
    }
  }

  function render(data) {
    if (data.status === 'not-found') {
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.textContent = `No client found matching "${data.client}".`;
      resultsEl.innerHTML = '';
      return;
    }
    if (data.status === 'ambiguous') {
      statusEl.hidden = false;
      statusEl.className = 'status';
      statusEl.textContent = `"${data.client}" matched ${data.matches.length} clients -- pick one:`;
      resultsEl.innerHTML = '';

      const list = document.createElement('div');
      list.className = 'resource-group';
      list.innerHTML = `
        <table>
          <tbody>
            ${data.matches
              .map((m) => `<tr><td><button type="button" class="link-button${m.isActive ? '' : ' link-button--inactive'}" data-company-id="${m.id}">${matchLabelHtml(m)}</button></td></tr>`)
              .join('')}
          </tbody>
        </table>
      `;
      list.querySelectorAll('button[data-company-id]').forEach((btn) => {
        btn.addEventListener('click', () => load(data.client, btn.dataset.companyId));
      });
      resultsEl.appendChild(list);
      return;
    }

    statusEl.hidden = true;
    resultsEl.innerHTML = '';

    resultsEl.appendChild(renderHeader(data));
    resultsEl.appendChild(renderInstalledServiceBadges(data.installedServices, data.activeContracts));
    resultsEl.appendChild(renderActiveContracts(data.activeContracts));
    resultsEl.appendChild(renderFinancialSnapshot(data.financialSnapshot));
    resultsEl.appendChild(renderRecentTickets(data.recentTickets));
    resultsEl.appendChild(renderSecurityAlerts(data.securityAlerts));
  }

  // --- Company details header --------------------------------------------
  function renderHeader(data) {
    const wrap = document.createElement('div');
    wrap.className = 'resource-group';

    const addressParts = [data.address.line1, data.address.line2, [data.address.city, data.address.state, data.address.postalCode].filter(Boolean).join(' ')].filter(Boolean);
    const addressHtml = addressParts.length ? escapeHtml(addressParts.join(', ')) : '<span class="muted">--</span>';

    const activeBadge = data.isActive
      ? '<span class="client-summary-service-badge client-summary-service-badge--yes">Active</span>'
      : '<span class="client-summary-service-badge client-summary-service-badge--no">Inactive</span>';

    const udfRows = data.contactUdfs
      .map((u) => `<div><span class="muted">${escapeHtml(u.name)}:</span> ${u.value ? escapeHtml(u.value) : '<span class="muted">--</span>'}</div>`)
      .join('');

    wrap.innerHTML = `
      <div class="resource-group-header">
        <span><strong>${companyLink(data)}</strong> ${activeBadge}${classificationHtml(data.classification)}</span>
      </div>
      <div class="client-summary-header-grid">
        <div>
          <div><span class="muted">Address:</span> ${addressHtml}</div>
          <div><span class="muted">Phone:</span> ${data.phone ? escapeHtml(data.phone) : '<span class="muted">--</span>'}</div>
        </div>
        <div>
          <div><span class="muted">Primary Contact:</span> ${contactHtml(data.primaryContact)}</div>
          <div><span class="muted">Main Billing Contact:</span> ${contactHtml(data.billingContact)}</div>
        </div>
        <div>
          ${udfRows}
        </div>
      </div>
    `;
    return wrap;
  }

  // Tech Cover Elite / Tech Cover Essentials get their own colour, by
  // request -- same purple TC Elite Rollout's own "Issue" status already
  // uses dashboard-wide (.cell-flag-purple), not a new one-off shade.
  // Every other classification stays plain text, same as before this
  // change.
  function classificationHtml(classification) {
    if (!classification) return '';
    const cls = classification === 'Tech Cover Elite' ? 'cell-flag-green' : classification === 'Tech Cover Essentials' ? 'cell-flag-purple' : null;
    const label = escapeHtml(classification);
    return ` -- ${cls ? `<span class="${cls}">${label}</span>` : label}`;
  }

  function contactHtml(contact) {
    if (!contact || !contact.name) return '<span class="muted">--</span>';
    const parts = [escapeHtml(contact.name)];
    if (contact.email) parts.push(`(${escapeHtml(contact.email)})`);
    return parts.join(' ');
  }

  // --- Financial snapshot --------------------------------------------------
  function renderFinancialSnapshot(snap) {
    const section = document.createElement('div');
    section.innerHTML = `<h2 class="client-summary-section-heading">Financial Snapshot <span class="inline-subtext">-- last 4 months, plus 12-month total</span></h2>`;

    const wrap = document.createElement('div');
    wrap.className = 'resource-group';
    wrap.style.overflowX = 'auto'; // recent months + total column is wider than a normal table -- scrolls within its own container rather than the page, same as Client Financials' full grid
    const t = snap.twelveMonthTotals;
    const months = snap.recentMonths;
    wrap.innerHTML = `
      <table>
        <thead>
          <tr class="shaded-row">
            <th>Category</th>
            ${months.map((m) => `<th class="ticket-number">${escapeHtml(m.label)}</th>`).join('')}
            <th class="ticket-number">12-Month Total</th>
          </tr>
        </thead>
        <tbody>
          ${financialRow('Labour', months.map((m) => m.labour), t.labour)}
          ${financialRow('Labour in Charges', months.map((m) => m.chargesLabour), t.chargesLabour)}
          ${financialRow('Other Charges', months.map((m) => m.chargesOther), t.chargesOther)}
          ${financialRow('Recurring Services', months.map((m) => m.recurringOther), t.recurringOther)}
          ${financialRow('Tech Cover', months.map((m) => m.recurringTechCover), t.recurringTechCover)}
          ${financialRow('Total', months.map((m) => m.total), t.total, true)}
        </tbody>
      </table>
      <p class="inline-subtext" style="margin: 0.5rem 0 0;">
        ${snap.mostRecentInvoice
          ? `Most recent invoice: ${invoiceLink(snap.mostRecentInvoice)} on ${formatDate(snap.mostRecentInvoice.invoiceDate)} (${formatPrice(snap.mostRecentInvoice.total)})`
          : 'No invoices in the last 12 months.'}
      </p>
    `;
    section.appendChild(wrap);
    return section;
  }

  function financialRow(label, monthValues, total, isTotalRow) {
    const rowClass = isTotalRow ? ' class="shaded-row"' : '';
    const rowStyle = isTotalRow ? ' style="font-weight: 600; border-top: 2px solid var(--border);"' : '';
    return `
      <tr${rowClass}${rowStyle}>
        <td>${escapeHtml(label)}</td>
        ${monthValues.map((v) => `<td class="ticket-number">${formatPrice(v)}</td>`).join('')}
        <td class="ticket-number">${formatPrice(total)}</td>
      </tr>`;
  }

  // --- Active contracts ------------------------------------------------
  function renderActiveContracts(activeContracts) {
    const { rows: contracts, warnings } = activeContracts;
    const section = document.createElement('div');
    section.innerHTML = `<h2 class="client-summary-section-heading">Active Contracts <span class="inline-subtext">(${contracts.length})</span></h2>`;

    // Orange "worth a look, nothing's actually broken" warnings, by
    // request -- missing T&M default contract (every client), plus a
    // missing matching Tech Cover Elite/Essentials contract when the
    // client's own classification says it should have one. Same
    // .status.warn amber this dashboard already uses for this exact
    // "needs a look" meaning elsewhere (Meeting Prep's own
    // needsAttention banner), not a new one-off color.
    for (const warning of warnings) {
      section.insertAdjacentHTML('beforeend', `<p class="status warn">⚠ ${escapeHtml(warning)}</p>`);
    }

    if (contracts.length === 0) {
      section.insertAdjacentHTML('beforeend', '<p class="status">No active contracts.</p>');
      return section;
    }

    const wrap = document.createElement('div');
    wrap.className = 'resource-group';
    wrap.innerHTML = `
      <table>
        <thead><tr class="shaded-row"><th>Contract</th><th>Type</th><th>Start</th><th>End</th><th>Next Billing</th></tr></thead>
        <tbody>
          ${contracts
            .map(
              (c) => `
            <tr>
              <td>${contractLink(c)}</td>
              <td>${escapeHtml(c.contractType)}</td>
              <td class="ticket-number">${formatDate(c.startDate)}</td>
              <td class="ticket-number">${isPastDate(c.endDate) ? `<span class="cell-flag-red">${formatDate(c.endDate)}</span>` : formatDate(c.endDate)}</td>
              <td class="ticket-number">${c.nextBillingDate ? formatDate(c.nextBillingDate) : '<span class="muted">--</span>'}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    `;
    section.appendChild(wrap);
    return section;
  }

  // --- Installed Services -- a row of green/red pill badges, by request,
  // placed right under the company header rather than as its own table
  // section further down. Detail (seats/agents/locations) is a native
  // title= tooltip on hover -- plenty for a one-line fact, no reason for a
  // custom hover widget. "installed" null (Datto EDR's/AutoElevate's/
  // Huntress's own "not-configured" status) is its own grey/muted third
  // state, same reasoning as the earlier table version had: SaaS
  // Protection's/Datto EDR's/AutoElevate's/Huntress's own "installed: false"
  // doesn't distinguish "genuinely not a client" from "name didn't match
  // confidently" either (see server.js's own comments on each findX()) --
  // shown as a plain red "not installed" either way, same as every other
  // not-installed badge, since this page has no way to tell those two
  // apart.
  function renderInstalledServiceBadges(services, activeContracts) {
    // 2 "contract pills", by request -- which active contract (if any)
    // is this client's billing default, and which (if any) is its "Tech
    // Cover Elite*" contract (same wildcard-prefix match Active
    // Contracts' own orange warning below already uses). Default's own
    // pill shows just the matched contract's own NAME as its label (no
    // "Default: " caption, by request) and stays blue either way -- the
    // Tech Cover Elite pill instead keeps a fixed, short label ("Tech
    // Cover Elite") when a match IS found (full contract name moved to
    // the hover tooltip only, since real names here -- "Tech Cover Elite
    // - Managed Support Plan" -- are long enough to otherwise widen the
    // pill row a lot), but turns RED with the label "No Tech Cover
    // Contract" when no active contract starts with "Tech Cover Elite",
    // by request -- same red .client-summary-service-badge--no every
    // other "not installed" pill on this page already uses. Same 2 pills
    // TC Elite Services shows for every TC Elite client at once, by
    // request.
    const defaultContractTitle = activeContracts.defaultContractName ? `Default: ${activeContracts.defaultContractName}` : 'Default: None';
    const defaultContractPill = pillHtml('client-summary-service-badge--info', activeContracts.defaultContractName || 'None', defaultContractTitle, activeContracts.defaultContractUrl);

    const eliteContractCls = activeContracts.eliteContractName ? 'client-summary-service-badge--info' : 'client-summary-service-badge--no';
    const eliteContractText = activeContracts.eliteContractName ? 'Tech Cover Elite' : 'No Tech Cover Contract';
    const eliteContractTitle = activeContracts.eliteContractName
      ? `Tech Cover Elite: ${activeContracts.eliteContractName}`
      : 'No active contract starting with "Tech Cover Elite" was found.';
    const eliteContractPill = pillHtml(eliteContractCls, eliteContractText, eliteContractTitle, activeContracts.eliteContractUrl);

    const contractPillsHtml = defaultContractPill + eliteContractPill;

    const items = [
      { label: 'SaaS Alerts', installed: services.saasAlerts.installed },
      {
        label: 'SaaS Backups',
        installed: services.saasProtection.installed,
        detail: services.saasProtection.installed
          ? [
              services.saasProtection.billableSeatCount != null ? `${services.saasProtection.billableSeatCount} billable seats` : null,
              services.saasProtection.backupPercentage != null ? `${services.saasProtection.backupPercentage}% backed up` : null,
            ]
              .filter(Boolean)
              .join(', ')
          : null,
      },
      services.dattoEdr.status === 'not-configured'
        ? { label: 'Datto EDR', installed: null }
        : {
            label: 'Datto EDR',
            installed: services.dattoEdr.installed,
            detail: services.dattoEdr.installed ? `${services.dattoEdr.locationCount} location${services.dattoEdr.locationCount === 1 ? '' : 's'}` : null,
          },
      services.autoElevate.status === 'not-configured' ? { label: 'AutoElevate', installed: null } : { label: 'AutoElevate', installed: services.autoElevate.installed },
      services.huntress.status === 'not-configured'
        ? { label: 'Huntress', installed: null }
        : {
            label: 'Huntress',
            installed: services.huntress.installed,
            detail: services.huntress.agentsCount != null ? `${services.huntress.agentsCount} agent${services.huntress.agentsCount === 1 ? '' : 's'}` : null,
          },
      // Detail is just the matched Rewst customer's own name, not a real
      // connected-integrations list -- that data isn't available from the
      // one Rewst workflow this reuses (see server.js's own comment).
      services.rewst.status === 'not-configured'
        ? { label: 'Rewst', installed: null }
        : { label: 'Rewst', installed: services.rewst.installed, detail: services.rewst.rewstCompanyName ? `Rewst: ${services.rewst.rewstCompanyName}` : null },
    ];

    const wrap = document.createElement('div');
    wrap.className = 'client-summary-service-badges';
    wrap.innerHTML =
      contractPillsHtml +
      items
        .map((i) => {
          const cls = i.installed === null ? 'client-summary-service-badge--unknown' : i.installed ? 'client-summary-service-badge--yes' : 'client-summary-service-badge--no';
          const title = i.installed === null ? 'Not yet connected' : i.detail ? i.detail : i.installed ? 'Installed' : 'Not installed';
          return `<span class="client-summary-service-badge ${cls}" title="${escapeHtml(title)}">${escapeHtml(i.label)}</span>`;
        })
        .join('');
    return wrap;
  }

  // --- Recent ticket activity ------------------------------------------
  function renderRecentTickets(tickets) {
    const section = document.createElement('div');
    section.innerHTML = `<h2 class="client-summary-section-heading">Recent Ticket Activity <span class="inline-subtext">(${tickets.openCount} open)</span></h2>`;

    if (tickets.recent.length === 0) {
      section.insertAdjacentHTML('beforeend', '<p class="status">No open tickets.</p>');
      return section;
    }

    const wrap = document.createElement('div');
    wrap.className = 'resource-group';
    wrap.innerHTML = `
      <table>
        <thead><tr><th>Ticket #</th><th>Title</th><th>Status</th><th>Last Activity</th></tr></thead>
        <tbody>
          ${tickets.recent
            .map(
              (t) => `
            <tr>
              <td class="ticket-number">${ticketLink(t)}</td>
              <td>${escapeHtml(t.title)}</td>
              <td>${escapeHtml(t.status)}</td>
              <td class="ticket-number">${formatDateTime(t.lastActivityDate)}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
      ${tickets.openCount > tickets.recent.length ? `<p class="inline-subtext" style="margin: 0.5rem 0 0;">Showing the ${tickets.recent.length} most recently active of ${tickets.openCount} open tickets.</p>` : ''}
    `;
    section.appendChild(wrap);
    return section;
  }

  // --- Security Alerts (1 month) ------------------------------------------
  function renderSecurityAlerts(alerts) {
    const section = document.createElement('div');
    section.innerHTML = `<h2 class="client-summary-section-heading">Security Alerts <span class="inline-subtext">-- last 1 month</span></h2>`;

    if (!alerts.monitored) {
      section.insertAdjacentHTML('beforeend', '<p class="status">This client isn\'t mapped to a SaaS Alerts customer.</p>');
      return section;
    }

    const wrap = document.createElement('div');
    wrap.className = 'resource-group';
    if (alerts.totalCount === 0) {
      wrap.innerHTML = `<p class="status" style="margin: 0.75rem;">No medium/critical alerts from ${formatDate(alerts.periodStart)} to ${formatDate(alerts.periodEnd)}.</p>`;
      section.appendChild(wrap);
      return section;
    }

    wrap.innerHTML = `
      <div class="resource-group-header">
        <span><strong>${alerts.totalCount}</strong> alert${alerts.totalCount === 1 ? '' : 's'} (<span class="cell-flag-red">${alerts.criticalCount} critical</span>, <span class="cell-flag-blue">${alerts.mediumCount} medium</span>) from ${formatDate(alerts.periodStart)} to ${formatDate(alerts.periodEnd)}</span>
      </div>
      <table>
        <thead><tr><th>Alert</th><th class="ticket-number">Count</th></tr></thead>
        <tbody>
          ${alerts.topEvents.map((e) => `<tr><td>${escapeHtml(e.name)}</td><td class="ticket-number">${e.count}</td></tr>`).join('')}
        </tbody>
      </table>
    `;
    section.appendChild(wrap);
    return section;
  }

  if (lastData) render(lastData);

  // Both real popup windows, not just a new tab -- same convention this
  // page's own invoice/ticket links (and every other Autotask/IT Glue link
  // on this dashboard) use.
  function companyLink(data) {
    const label = escapeHtml(data.companyName);
    if (!data.companyUrl) return label;
    return `<a class="client-summary-name-link" href="${escapeHtml(data.companyUrl)}" target="_blank" rel="noopener noreferrer" onclick="window.open(this.href, '_blank', 'noopener,noreferrer,width=1200,height=900'); return false;">${label}</a>`;
  }

  function contractLink(c) {
    const label = escapeHtml(c.contractName);
    if (!c.contractUrl) return label;
    return `<a href="${escapeHtml(c.contractUrl)}" target="_blank" rel="noopener noreferrer" onclick="window.open(this.href, '_blank', 'noopener,noreferrer,width=1200,height=900'); return false;">${label}</a>`;
  }

  // The 2 contract pills click through to their own matched contract in
  // Autotask, by request -- same real popup-window convention
  // contractLink() above already uses. Renders as a plain <span> (not
  // clickable) when there's no contract to link to -- the "None"/"No
  // Tech Cover Contract" case.
  function pillHtml(cls, text, title, url) {
    const safeText = escapeHtml(text);
    const safeTitle = escapeHtml(title);
    if (!url) return `<span class="client-summary-service-badge ${cls}" title="${safeTitle}">${safeText}</span>`;
    return `<a class="client-summary-service-badge ${cls}" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="${safeTitle}" onclick="window.open(this.href, '_blank', 'noopener,noreferrer,width=1200,height=900'); return false;">${safeText}</a>`;
  }

  function invoiceLink(inv) {
    const label = escapeHtml(inv.invoiceNumber || `#${inv.id}`);
    if (!inv.invoiceUrl) return label;
    // A real popup window, not just a new tab -- same pattern as Client
    // Financials' invoice links.
    return `<a href="${escapeHtml(inv.invoiceUrl)}" target="_blank" rel="noopener noreferrer" onclick="window.open(this.href, '_blank', 'noopener,noreferrer,width=1000,height=800'); return false;">${label}</a>`;
  }

  function ticketLink(t) {
    const label = escapeHtml(t.ticketNumber);
    if (!t.ticketUrl) return label;
    // A real popup window, not just a new tab -- specifying window features
    // (width/height/etc.) is what signals that to the browser. Same pattern
    // as Service Calls' own ticket links. target/rel kept as a fallback for
    // JS-disabled or a manual middle-click/right-click "open in new tab".
    return `<a href="${escapeHtml(t.ticketUrl)}" target="_blank" rel="noopener noreferrer" onclick="window.open(this.href, '_blank', 'noopener,noreferrer,width=1200,height=900'); return false;">${label}</a>`;
  }

  function formatDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString();
  }

  // Active Contracts' own End date, by request -- red when it's already
  // passed, flags a contract still showing "In Effect" (status 1) in
  // Autotask despite its own end date already lapsing. No end date at all
  // (open-ended contract) is never flagged -- nothing to compare.
  function isPastDate(iso) {
    if (!iso) return false;
    return new Date(iso).getTime() < Date.now();
  }

  function formatDateTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString();
  }

  function formatPrice(value) {
    if (value === null || value === undefined) return '';
    return '$' + Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Classification + Active/Inactive after the name on every client-picker
  // list on this dashboard, by request -- same convention this page's own
  // header badge already uses for a single resolved client.
  function matchLabelHtml(m) {
    const statusBadge = m.isActive ? '<span class="cell-flag-green">Active</span>' : '<span class="cell-flag-red">Inactive</span>';
    return `${escapeHtml(m.companyName)} ${statusBadge}${m.classification ? ` -- ${escapeHtml(m.classification)}` : ''}`;
  }
}
