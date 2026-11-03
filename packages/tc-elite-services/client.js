export const id = "tc-elite-services";
export const label = "TC Elite Services";

// Every current "Tech Cover Elite" client, by request, each with its own
// 2 blue "contract pills" (Default Contract / "Tech Cover Elite*"
// contract) in a Contracts column, and the same green/red Installed
// Services pills Client Summary shows for one client at a time in a
// separate Services column, by request -- same badge CSS classes
// (client-summary-service-badge*), reused rather than duplicated, since
// the whole point of this page is "the exact same check Client Summary
// does, for every TC Elite client at once".

let lastData = null; // module-scope, survives the shell's teardown/re-mount, same convention every other page here uses

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>TC Elite Services</h1>
      <div class="date-form">
        <button type="button" id="refresh-button">Refresh</button>
      </div>
    </header>
    <p id="status" class="status">Loading...</p>
    <div id="summary" class="summary" hidden></div>
    <div id="results"></div>
  `;

  const refreshButton = container.querySelector('#refresh-button');
  const statusEl = container.querySelector('#status');
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

    // Clients with a parent company get their own separate list at the
    // bottom, by request -- same real parentCompanyID field Classification
    // Summary's own drilldown already splits on. A client with a parent
    // is usually billed/managed through that parent, so it's worth seeing
    // those as their own group rather than mixed in alphabetically with
    // every standalone TC Elite client above.
    const standaloneRows = data.rows.filter((r) => !r.hasParent);
    const parentRows = data.rows.filter((r) => r.hasParent);

    // The top count reflects the first group only (standalone clients),
    // not the combined total -- by request, since a client with a parent
    // is called out separately below and shouldn't also inflate this
    // headline number.
    summaryEl.hidden = false;
    summaryEl.innerHTML = `<strong>${standaloneRows.length}</strong> Tech Cover Elite client${standaloneRows.length === 1 ? '' : 's'} <span class="inline-subtext">(as of ${new Date(data.asOf).toLocaleString()})</span>`;

    resultsEl.innerHTML = '';

    if (data.rows.length === 0) {
      resultsEl.innerHTML = '<p class="status">No active "Tech Cover Elite" clients found.</p>';
      return;
    }

    resultsEl.appendChild(renderTable(standaloneRows, { showParentColumn: false }));

    if (parentRows.length > 0) {
      const section = document.createElement('div');
      section.innerHTML = `<h2 class="client-summary-section-heading">Clients with a Parent Company <span class="inline-subtext">(${parentRows.length})</span></h2>`;
      section.appendChild(renderTable(parentRows, { showParentColumn: true }));
      resultsEl.appendChild(section);
    }
  }

  function renderTable(rows, { showParentColumn }) {
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
              <td>${renderContractPills(r)}</td>
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
  // Tech Cover Elite's pill instead keeps a fixed, short label when a
  // match IS found (full contract name moved to the hover tooltip only),
  // but turns RED with the label "No Tech Cover Contract" when no active
  // contract starts with "Tech Cover Elite", by request -- same red
  // .client-summary-service-badge--no every other "not installed" pill
  // on this dashboard already uses, not a new one-off shade. Both pills
  // click through to their own matched contract in Autotask, by request
  // (same real popup-window convention every other contract link on this
  // dashboard already uses) -- a pill with no matched contract stays a
  // plain, non-clickable span.
  function renderContractPills(r) {
    const defaultTitle = r.defaultContractName ? `Default: ${r.defaultContractName}` : 'Default: None';
    const defaultPill = pillHtml('client-summary-service-badge--info', r.defaultContractName || 'None', defaultTitle, r.defaultContractUrl);

    const eliteCls = r.eliteContractName ? 'client-summary-service-badge--info' : 'client-summary-service-badge--no';
    const eliteText = r.eliteContractName ? 'Tech Cover Elite' : 'No Tech Cover Contract';
    const eliteTitle = r.eliteContractName ? `Tech Cover Elite: ${r.eliteContractName}` : 'No active contract starting with "Tech Cover Elite" was found.';
    const elitePill = pillHtml(eliteCls, eliteText, eliteTitle, r.eliteContractUrl);

    return `<div class="client-summary-service-badges" style="margin: 0;">${defaultPill}${elitePill}</div>`;
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
      services.rewst.status === 'not-configured'
        ? { label: 'Rewst', installed: null }
        : { label: 'Rewst', installed: services.rewst.installed, detail: services.rewst.rewstCompanyName ? `Rewst: ${services.rewst.rewstCompanyName}` : null },
    ];

    const servicePills = items
      .map((i) => {
        const cls = i.installed === null ? 'client-summary-service-badge--unknown' : i.installed ? 'client-summary-service-badge--yes' : 'client-summary-service-badge--no';
        const title = i.installed === null ? 'Not yet connected' : i.detail ? i.detail : i.installed ? 'Installed' : 'Not installed';
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
