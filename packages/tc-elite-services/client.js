export const id = "tc-elite-services";
export const label = "TC Services";

// Every current "Tech Cover Elite"/"Tech Cover Essentials" client, as two
// tabs, by request -- each client still gets its own 2 blue "contract
// pills" (Default Contract / "Tech Cover <X>*" contract) in a Contracts
// column, and the same green/red Installed Services pills Client Summary
// shows for one client at a time in a separate Services column, by
// request -- same badge CSS classes (client-summary-service-badge*),
// reused rather than duplicated, since the whole point of this page is
// "the exact same check Client Summary does, for every TC client at
// once". Tabs look/behave like RMM Filter Checks' own top row, by request
// -- same .rmmf-tabs/.rmmf-tab classes (the "real browser tab" look),
// reused rather than a new tab system.

let lastData = null; // module-scope, survives the shell's teardown/re-mount, same convention every other page here uses
let activeTabIndex = 0; // same "stay on the tab you were on" convention RMM Filter Checks' own activeTabIndex follows

export function mount(container) {
  // Wrapped in its own .tc-elite-services-page class so styles.css can
  // scope the green "yes" pill's outlined look to just this page, by
  // request, without touching the same .client-summary-service-badge--yes
  // class Client Summary/Live Reports still show with their regular
  // tinted-background style. Class name kept as-is (not renamed to match
  // the page's own new "TC Services" label) -- it's an internal styling
  // hook, not anything user-visible, and renaming it would just be extra
  // churn across this file and styles.css for no visible difference.
  container.innerHTML = `
    <div class="tc-elite-services-page">
      <header class="page-header">
        <h1>TC Services</h1>
        <div class="date-form">
          <button type="button" id="refresh-button">Refresh</button>
        </div>
      </header>
      <p id="status" class="status">Loading...</p>
      <div id="as-of" class="inline-subtext" hidden></div>
      <div id="tabs" class="rmmf-tabs rmmf-tabs--primary" hidden></div>
      <div id="summary" class="summary" hidden></div>
      <div id="results"></div>
    </div>
  `;

  const refreshButton = container.querySelector('#refresh-button');
  const statusEl = container.querySelector('#status');
  const asOfEl = container.querySelector('#as-of');
  const tabsEl = container.querySelector('#tabs');
  const summaryEl = container.querySelector('#summary');
  const resultsEl = container.querySelector('#results');

  refreshButton.addEventListener('click', () => load(true));

  if (lastData) render(lastData);
  else load(false);

  async function load(force) {
    refreshButton.disabled = true;
    resultsEl.innerHTML = '';
    summaryEl.hidden = true;
    try {
      const res = await fetch(`/api/tc-elite-services${force ? '?force=true' : ''}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastData = data;
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
    asOfEl.hidden = false;
    asOfEl.textContent = `As of ${new Date(data.asOf).toLocaleString()}`;

    if (activeTabIndex >= data.tabs.length) activeTabIndex = 0;

    // Same top-row tab strip RMM Filter Checks' own filter tabs use
    // (.rmmf-tab/.rmmf-tab--active), just one row here (no second "sub-
    // tab" row -- this page has no Missing/Wrongly Included/Correct
    // concept, only the two classifications).
    tabsEl.hidden = false;
    tabsEl.innerHTML = data.tabs
      .map((t, i) => `<button type="button" class="rmmf-tab${i === activeTabIndex ? ' rmmf-tab--active' : ''}" data-tab-index="${i}">${escapeHtml(t.label)} (${t.rows.length})</button>`)
      .join('');
    tabsEl.querySelectorAll('.rmmf-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeTabIndex = Number(btn.dataset.tabIndex);
        render(lastData);
      });
    });

    renderTab(data.tabs[activeTabIndex]);
  }

  function renderTab(tab) {
    // Clients with a parent company get their own separate list at the
    // bottom, by request -- same real parentCompanyID field Classification
    // Summary's own drilldown already splits on. A client with a parent
    // is usually billed/managed through that parent, so it's worth seeing
    // those as their own group rather than mixed in alphabetically with
    // every standalone client above.
    const standaloneRows = tab.rows.filter((r) => !r.hasParent);
    const parentRows = tab.rows.filter((r) => r.hasParent);

    // The top count reflects the first group only (standalone clients),
    // not the combined total -- by request, since a client with a parent
    // is called out separately below and shouldn't also inflate this
    // headline number.
    summaryEl.hidden = false;
    summaryEl.innerHTML = `<strong>${standaloneRows.length}</strong> ${escapeHtml(tab.classificationLabel)} client${standaloneRows.length === 1 ? '' : 's'}`;

    resultsEl.innerHTML = '';

    if (tab.rows.length === 0) {
      resultsEl.innerHTML = `<p class="status">No active "${escapeHtml(tab.classificationLabel)}" clients found.</p>`;
      return;
    }

    resultsEl.appendChild(renderTable(standaloneRows, { showParentColumn: false }, tab));

    if (parentRows.length > 0) {
      const section = document.createElement('div');
      section.innerHTML = `<h2 class="client-summary-section-heading">Clients with a Parent Company <span class="inline-subtext">(${parentRows.length})</span></h2>`;
      section.appendChild(renderTable(parentRows, { showParentColumn: true }, tab));
      resultsEl.appendChild(section);
    }
  }

  function renderTable(rows, { showParentColumn }, tab) {
    const wrap = document.createElement('div');
    wrap.className = 'resource-group';
    if (rows.length === 0) {
      wrap.innerHTML = '<p class="status" style="margin: 0.75rem;">No clients.</p>';
      return wrap;
    }
    wrap.innerHTML = `
      <table>
        <thead><tr><th>Client</th>${showParentColumn ? '<th>Parent</th>' : ''}<th>Contracts</th><th>Services</th></tr></thead>
        <tbody>
          ${rows
            .map(
              (r) => `
            <tr>
              <td>${companyLink(r)}</td>
              ${showParentColumn ? `<td>${escapeHtml(r.parentCompanyName)}</td>` : ''}
              <td>${renderContractPills(r, tab)}</td>
              <td>${renderServicePills(r)}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    `;
    return wrap;
  }

  // The 2 "contract pills" -- split into their own column, by request,
  // separate from the green/red/grey Installed Services pills below.
  // Default's own pill shows just the matched contract NAME as its label
  // (no "Default: " caption, by request) and stays blue either way --
  // the target classification's own pill instead keeps a fixed, short
  // label when a match IS found (full contract name moved to the hover
  // tooltip only), but turns RED with the label "No Tech Cover Contract"
  // when no active contract starts with this tab's own classification
  // label (e.g. "TECH COVER ESSENTIALS"), by request -- same red
  // .client-summary-service-badge--no every other "not installed" pill
  // on this dashboard already uses, not a new one-off shade. Both pills
  // click through to their own matched contract in Autotask, by request
  // (same real popup-window convention every other contract link on this
  // dashboard already uses) -- a pill with no matched contract stays a
  // plain, non-clickable span.
  function renderContractPills(r, tab) {
    const defaultTitle = r.defaultContractName ? `Default: ${r.defaultContractName}` : 'Default: None';
    // Grey instead of the usual blue "info" look specifically when the
    // matched default contract is a plain T&M one, by request -- same
    // case-insensitive "starts with T&M" prefix check Contract Checks'
    // own normalizeContractName()/hasTmDefault logic already uses
    // elsewhere on this dashboard, kept as a small independent copy here
    // rather than imported (this page has no dependency on that one).
    const defaultCls = r.defaultContractName && /^T&M/i.test(r.defaultContractName.trim()) ? 'client-summary-service-badge--tm' : 'client-summary-service-badge--info';
    const defaultPill = pillHtml(defaultCls, r.defaultContractName || 'None', defaultTitle, r.defaultContractUrl);

    const targetCls = r.targetContractName ? 'client-summary-service-badge--info' : 'client-summary-service-badge--no';
    const targetText = r.targetContractName ? tab.classificationLabel : 'No Tech Cover Contract';
    const targetTitle = r.targetContractName ? `${tab.classificationLabel}: ${r.targetContractName}` : `No active contract starting with "${tab.classificationLabel}" was found.`;
    const targetPill = pillHtml(targetCls, targetText, targetTitle, r.targetContractUrl);

    return `<div class="client-summary-service-badges" style="margin: 0;">${defaultPill}${targetPill}</div>`;
  }

  // Same real popup-window convention companyLink() above already uses.
  // Renders as a plain <span> (not clickable) when there's no contract to
  // link to -- the "None"/"No Tech Cover Contract" case.
  function pillHtml(cls, text, title, url) {
    const safeText = escapeHtml(text);
    const safeTitle = escapeHtml(title);
    if (!url) return `<span class="client-summary-service-badge ${cls}" title="${safeTitle}">${safeText}</span>`;
    return `<a class="client-summary-service-badge ${cls}" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="${safeTitle}" onclick="window.open(this.href, '_blank', 'noopener,noreferrer,width=1200,height=900'); return false;">${safeText}</a>`;
  }

  // Same badge markup/classes Client Summary's own renderInstalledServiceBadges()
  // builds for its green/red/grey Installed Services pills -- its own
  // column here, separate from the 2 contract pills above, by request.
  function renderServicePills(r) {
    const services = r.installedServices;
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
      services.rewst.status === 'not-configured'
        ? { label: 'Rewst', installed: null }
        : { label: 'Rewst', installed: services.rewst.installed, detail: services.rewst.rewstCompanyName ? `Rewst: ${services.rewst.rewstCompanyName}` : null },
    ];

    // "ambiguous" (orange/yellow -- multiple real matches, not a plain
    // pass/fail) sits between --unknown (grey, vendor not configured at
    // all) and --yes/--no, by request ("show these as our Orangy-Yellow
    // colour" -- see huntress.js's own findOrganizationMatch()).
    const servicePills = items
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

    return `<div class="client-summary-service-badges" style="margin: 0;">${servicePills}</div>`;
  }

  function companyLink(r) {
    const label = escapeHtml(r.companyName);
    if (!r.companyUrl) return label;
    // Real popup window, not just a new tab -- same convention every other
    // Autotask/IT Glue link on this dashboard uses.
    return `<a href="${escapeHtml(r.companyUrl)}" target="_blank" rel="noopener noreferrer" onclick="window.open(this.href, '_blank', 'noopener,noreferrer,width=1200,height=900'); return false;">${label}</a>`;
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
