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
      list.className = 'resource-group client-match-list';
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
    const nameMatchingSection = renderClientNameMatching(data.nameMatchingUdfs);
    if (nameMatchingSection) resultsEl.appendChild(nameMatchingSection);
    resultsEl.appendChild(renderActiveContracts(data.activeContracts));
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
    wireNameMenu(wrap, data);
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

  // --- Client Name Matching ----------------------------------------------
  // Any "Name:*" Companies UDF that actually has a value -- e.g.
  // "Name:TPP", "Name:Ingram Client" -- written via @dashboard/data-
  // matching's own "Update" button. By request, the whole section is
  // omitted entirely (not shown empty) when there's nothing to list.
  function renderClientNameMatching(nameMatchingUdfs) {
    if (!nameMatchingUdfs || nameMatchingUdfs.length === 0) return null;

    const section = document.createElement('div');
    section.innerHTML = `<h2 class="client-summary-section-heading">Client Name Matching</h2>`;

    const wrap = document.createElement('div');
    wrap.className = 'resource-group client-summary-compact-table';
    wrap.innerHTML = `
      <table>
        <thead><tr class="shaded-row"><th>UDF Name:</th><th>Value</th></tr></thead>
        <tbody>
          ${nameMatchingUdfs.map((u) => `<tr><td>${escapeHtml(u.name.replace(/^name:\s*/i, ''))}</td><td>${escapeHtml(u.value)}</td></tr>`).join('')}
        </tbody>
      </table>
    `;
    section.appendChild(wrap);
    return section;
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
    // Cover Elite*" OR "Tech Cover Essentials*" contract (same wildcard-
    // prefix matches Active Contracts' own orange warnings below already
    // use). Default's own pill shows just the matched contract's own NAME
    // as its label (no "Default: " caption, by request) and stays blue
    // either way -- the Tech Cover pill instead keeps a fixed, short
    // label ("Tech Cover Elite"/"Tech Cover Essentials", whichever one
    // was actually found) when a match IS found (full contract name moved
    // to the hover tooltip only, since real names here -- "Tech Cover
    // Elite - Managed Support Plan" -- are long enough to otherwise widen
    // the pill row a lot), but turns RED with the label "No Tech Cover
    // Contract" when NEITHER an active "Tech Cover Elite*" nor "Tech
    // Cover Essentials*" contract is found, by request -- same red
    // .client-summary-service-badge--no every other "not installed" pill
    // on this page already uses. A client with BOTH active at once (by
    // request, should never happen -- a client is only ever meant to be
    // on one tier) gets its own big red warning banner below instead of
    // just one quietly-wrong pill. Same 2 pills TC Elite Services shows
    // for every TC Elite client at once, by request (that page's own
    // Elite-only half of this rule, unchanged).
    const defaultContractTitle = activeContracts.defaultContractName ? `Default: ${activeContracts.defaultContractName}` : 'Default: None';
    const defaultContractPill = pillHtml('client-summary-service-badge--info', activeContracts.defaultContractName || 'None', defaultContractTitle, activeContracts.defaultContractUrl);

    const techCoverName = activeContracts.eliteContractName || activeContracts.essentialsContractName || null;
    const techCoverLabel = activeContracts.eliteContractName ? 'Tech Cover Elite' : activeContracts.essentialsContractName ? 'Tech Cover Essentials' : 'No Tech Cover Contract';
    const techCoverUrl = activeContracts.eliteContractName ? activeContracts.eliteContractUrl : activeContracts.essentialsContractUrl;
    const techCoverCls = techCoverName ? 'client-summary-service-badge--info' : 'client-summary-service-badge--no';
    const techCoverTitle = techCoverName
      ? `${techCoverLabel}: ${techCoverName}`
      : 'No active contract starting with "Tech Cover Elite" or "Tech Cover Essentials" was found.';
    const techCoverPill = pillHtml(techCoverCls, techCoverLabel, techCoverTitle, techCoverUrl);

    const contractPillsHtml = defaultContractPill + techCoverPill;

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
      services.inky.status === 'not-configured'
        ? { label: 'Inky', installed: null }
        : { label: 'Inky', installed: services.inky.installed, detail: services.inky.inkyTeamLabel ? `Inky: ${services.inky.inkyTeamLabel}` : null },
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
        : services.huntress.status === 'ambiguous'
          ? {
              label: 'Huntress',
              installed: 'ambiguous',
              detail: `${services.huntress.candidateCount} matching Huntress organizations -- check manually`,
            }
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

    // "ambiguous" (orange/yellow -- multiple real matches, not a plain
    // pass/fail) sits between --unknown (grey, vendor not configured at
    // all) and --yes/--no, by request ("show these as our Orangy-Yellow
    // colour" -- see huntress.js's own findOrganizationMatch()).
    const wrap = document.createElement('div');
    wrap.className = 'client-summary-service-badges';
    wrap.innerHTML =
      contractPillsHtml +
      items
        .map((i) => {
          const cls =
            i.installed === null
              ? 'client-summary-service-badge--unknown'
              : i.installed === 'ambiguous'
                ? 'client-summary-service-badge--warn'
                : i.installed
                  ? 'client-summary-service-badge--yes'
                  : 'client-summary-service-badge--no';
          const title = i.installed === null ? 'Not yet connected' : i.installed === 'ambiguous' ? i.detail : i.detail ? i.detail : i.installed ? 'Installed' : 'Not installed';
          return `<span class="client-summary-service-badge ${cls}" title="${escapeHtml(title)}">${escapeHtml(i.label)}</span>`;
        })
        .join('');

    if (!activeContracts.bothTechCoverTiersActive) return wrap;

    // Big red warning, by request -- a client should never be on both
    // Tech Cover tiers at once. Same solid-red/white-text/centered
    // convention Tickets' own "Overdue tickets" banner already uses for
    // an alarming count (.tickets-dashboard-overdue-banner), not a new
    // one-off style.
    const container = document.createElement('div');
    const banner = document.createElement('div');
    banner.className = 'client-summary-tech-cover-conflict-banner';
    banner.textContent = `Both Tech Cover Elite (${activeContracts.eliteContractName}) and Tech Cover Essentials (${activeContracts.essentialsContractName}) are active at once -- this client should only ever be on one tier.`;
    container.appendChild(banner);
    container.appendChild(wrap);
    return container;
  }

  // --- Recent Tickets ------------------------------------------
  function renderRecentTickets(tickets) {
    const section = document.createElement('div');
    section.innerHTML = `<h2 class="client-summary-section-heading">Recent Tickets <span class="inline-subtext">(${tickets.openCount} open, ${tickets.closedCount} closed in the last 7 days)</span></h2>`;

    if (tickets.recent.length === 0) {
      section.insertAdjacentHTML('beforeend', '<p class="status">No tickets to show.</p>');
      return section;
    }

    const wrap = document.createElement('div');
    wrap.className = 'resource-group';
    wrap.innerHTML = `
      <table>
        <thead><tr><th>Ticket #</th><th>Title</th><th>Status</th><th>Allocated</th><th>Last Activity</th></tr></thead>
        <tbody>
          ${tickets.recent
            .map(
              (t) => `
            <tr>
              <td class="ticket-number">${ticketLink(t)}</td>
              <td>${escapeHtml(t.title)}</td>
              <td>${statusCell(t)}</td>
              <td>${allocatedCell(t)}</td>
              <td class="ticket-number">${formatDateTime(t.lastActivityDate)}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    `;
    section.appendChild(wrap);
    return section;
  }

  // Status 5 (Complete) green, status 20 (Billing - Contract) blue -- same
  // #16a34a/var(--accent) convention as .cell-flag-green/.cell-flag-blue
  // elsewhere on this dashboard; every open status stays plain text.
  function statusCell(t) {
    const flagClass = t.statusId === 5 ? ' class="cell-flag-green"' : t.statusId === 20 ? ' class="cell-flag-blue"' : '';
    return `<span${flagClass}>${escapeHtml(t.status)}</span>`;
  }

  function allocatedCell(t) {
    const primary = t.primaryResource ? escapeHtml(t.primaryResource) : '<span class="muted">--</span>';
    const secondary = t.secondaryResources && t.secondaryResources.length > 0
      ? `<span class="cell-subtext">${escapeHtml(t.secondaryResources.join(', '))}</span>`
      : '';
    return `${primary}${secondary}`;
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

  // Plain popup-window Autotask link, same convention this page's own
  // invoice/ticket links (and every other Autotask/IT Glue link on this
  // dashboard) use -- UNLESS an IT Glue organisation also resolved for
  // this Client (data.itGlueOrgUrl), in which case this renders as a
  // data-name-menu link instead, by request ("clicking on the Client
  // Name title should give the options of opening in Autotask or IT
  // Glue"); renderHeader() below wires its actual click handler (a real
  // click position is needed to place the menu, which doesn't exist yet
  // at template-build time here). Same "only becomes a choice when
  // there's a real second option" rule the 2 contract pills below
  // already follow -- plain direct link when there's nothing to choose
  // between.
  function companyLink(data) {
    const label = escapeHtml(data.companyName);
    if (!data.companyUrl) return label;
    if (!data.itGlueOrgUrl) {
      return `<a class="client-summary-name-link" href="${escapeHtml(data.companyUrl)}" target="_blank" rel="noopener noreferrer" onclick="window.open(this.href, '_blank', 'noopener,noreferrer,width=1200,height=900'); return false;">${label}</a>`;
    }
    return `<a class="client-summary-name-link" href="${escapeHtml(data.companyUrl)}" data-name-menu="1">${label}</a>`;
  }

  // Wires the Client Name's own "Open in Autotask / Open in IT Glue"
  // choice, by request -- reuses app.js's own window.showNavContextMenu()
  // (the exact same small menu the sidebar's own right-click uses) rather
  // than building a second popup-menu implementation. Only present at all
  // when companyLink() above rendered the data-name-menu variant (both
  // URLs resolved); a no-op otherwise.
  function wireNameMenu(wrap, data) {
    const nameLink = wrap.querySelector('a[data-name-menu]');
    if (!nameLink) return;
    nameLink.addEventListener('click', (e) => {
      e.preventDefault();
      window.showNavContextMenu(e.clientX, e.clientY, [
        { label: 'Open in Autotask', onClick: () => window.open(data.companyUrl, '_blank', 'noopener,noreferrer,width=1200,height=900') },
        { label: 'Open in IT Glue', onClick: () => window.open(data.itGlueOrgUrl, '_blank', 'noopener,noreferrer,width=1200,height=900') },
      ]);
    });
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
  // header badge already uses for a single resolved client. Laid out as
  // three fixed-width columns (Name/Status/Classification) rather than one
  // run-on line, by request ("make them look like columns so they line up
  // nicely") -- see .client-match-list .link-button in styles.css, same
  // "button styled as a grid with literal column widths" convention
  // Classification Summary's own .bar-row buttons already use so every
  // row's columns land in the same place regardless of each row's own
  // content length.
  function matchLabelHtml(m) {
    const statusBadge = m.isActive ? '<span class="cell-flag-green">Active</span>' : '<span class="cell-flag-red">Inactive</span>';
    return `<span class="cml-name" title="${escapeHtml(m.companyName)}">${escapeHtml(m.companyName)}</span><span class="cml-status">${statusBadge}</span><span class="cml-classification">${m.classification ? escapeHtml(m.classification) : ''}</span>`;
  }
}
