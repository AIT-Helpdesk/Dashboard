// Live Reports -- "Present to Client" -- by request: a live-pulled
// equivalent of Datto RMM's own canned "Executive Summary Report" PDF,
// for one client at a time. Reuses the exact same gauge/donut/KPI-tile
// widget builders Make Report/Meeting Prep's own Executive Summary widget
// already renders (gaugeSvg/donutWidget/kpiTileRow, /meeting-prep-report-
// render.js) -- same visual language as that page's own live data, not a
// second chart implementation. See server.js's own header for what is and
// isn't reproduced here (no Asset Management/Monitoring %, Open Alerts
// scoped to Critical/High only).
import { gaugeSvg, donutWidget, kpiTileRow, deviceTypeBarWidget, checkinFreshnessWidget, deviceListTableHtml, wireDeviceFilters } from '/meeting-prep-report-render.js';

export const id = 'live-reports';
export const label = 'Live Reports';

// Same hex values executiveSummaryWidgetsHtml()/patchManagementSummaryWidgetsHtml()
// (meeting-prep-report-render.js) already use for these exact legend
// labels -- kept as a small local copy rather than importing/exporting
// that function's own internal map, same "copy the small color literal,
// don't reach into another widget's private const" convention that file's
// own per-report-kind color maps already follow for each other.
const PATCH_COLORS = {
  'Fully Patched': '#16a34a',
  'Approved Pending': '#86c95e',
  'Install Error': '#f59e0b',
  'Reboot Required': '#dc2626',
  'No Data': '#7f1d1d',
  'No Policy': '#9aa3af',
};
const ANTIVIRUS_COLORS = {
  'Running and Up to Date': '#16a34a',
  'Not up to date': '#f59e0b',
  'Not Running': '#dc2626',
  'Not Detected': '#7f1d1d',
};
// 'Not Compliant' shown as its own real label here (not the "In Progress"
// rename Make Report's own PDF-derived Executive Summary widget applies)
// -- this page's numbers are live-computed from today's real device
// state, not a point-in-time PDF, so the literal Datto status reads more
// honestly than that page's own softened wording.
const SOFTWARE_COLORS = {
  Compliant: '#16a34a',
  'Not Compliant': '#f59e0b',
  Unmanaged: '#9aa3af',
};
const ALERT_COLORS = { Critical: '#dc2626', High: '#f59e0b' };

function donutFromLegend(title, legend, colors) {
  const segments = Object.entries(legend).map(([label, value]) => ({ label, value, color: colors[label] || '#9aa3af' }));
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  return donutWidget(title, segments, total);
}

// Module scope, not nested inside mount() like it used to be -- the
// vendor-summary functions below are top-level (built once, reused by
// every mount()), so they need their own escaping helper in a scope they
// can actually reach, not one buried inside mount()'s own closure.
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// "Other Systems" section, by request -- one small widget card per vendor
// that actually has live data worth showing on-screen during a client
// meeting (no quick-glance badge row above them anymore, by request -- a
// vendor with nothing live to show just contributes no card at all, no
// placeholder of any kind).
function vendorWidgetsHtml(vendors) {
  const widgets = [];

  // SaaS Alerts -- by request, a literal 30-day window (see server.js's
  // own comment on why this isn't the "1 month" Client Summary uses).
  // Layout by request: the 3 count tiles smaller, stacked down the left
  // (.live-reports-saas-alerts-layout/-kpis, styles.css), Top Events as
  // an actual list to their right instead of a comma-joined sentence.
  if (vendors.saasAlerts.status === 'ok' && vendors.saasAlerts.monitored) {
    const sa = vendors.saasAlerts;
    const eventsListHtml =
      sa.topEvents.length > 0
        ? `<ul class="live-reports-saas-alerts-events">${sa.topEvents.map((e) => `<li>${escapeHtml(e.name)} <span class="muted">(${e.count})</span></li>`).join('')}</ul>`
        : '<p class="inline-subtext">No alerts in this window.</p>';
    widgets.push(`
      <div class="mtg-widget">
        <p class="mtg-widget-title">SaaS Alerts (Last ${sa.windowDays} Days)</p>
        <div class="live-reports-saas-alerts-layout">
          <div class="live-reports-saas-alerts-kpis">
            ${kpiTileRow([
              { label: 'Critical', value: sa.criticalCount, tier: sa.criticalCount > 0 ? 'bad' : 'good' },
              { label: 'Medium', value: sa.mediumCount, tier: sa.mediumCount > 0 ? 'warn' : 'good' },
              { label: 'Low', value: sa.lowCount },
            ])}
          </div>
          ${eventsListHtml}
        </div>
      </div>`);
  }

  // SaaS Protection -- backupPercentage/billableSeatCount are the same
  // figures the badge's own hover detail already shows, repeated here
  // visibly since this page is meant to be read on-screen, not hovered.
  if (vendors.saasProtection.status === 'ok' && vendors.saasProtection.installed) {
    const sp = vendors.saasProtection;
    const tier = sp.backupPercentage == null ? undefined : sp.backupPercentage >= 95 ? 'good' : sp.backupPercentage >= 70 ? 'warn' : 'bad';
    const unhealthyHtml =
      sp.unhealthyAppTypes.length > 0
        ? `<p class="inline-subtext">Needs attention: ${sp.unhealthyAppTypes.map((a) => `${escapeHtml(a.appType)} (${escapeHtml(a.status)})`).join(', ')}</p>`
        : '';
    widgets.push(`
      <div class="mtg-widget">
        <p class="mtg-widget-title">SaaS Protection (Backup)</p>
        ${kpiTileRow([
          { label: 'Backup %', value: sp.backupPercentage ?? '--', tier },
          { label: 'Billable Seats', value: sp.billableSeatCount ?? '--' },
          { label: 'App Types Healthy', value: `${sp.appTypesHealthy}/${sp.appTypesTotal}` },
        ])}
        ${unhealthyHtml}
      </div>`);
  }

  // Datto EDR -- agentCount/activeAgentCount/alertCount are summed across
  // every matched Location (a client can have several, see server.js's
  // own comment), not just one.
  if (vendors.dattoEdr.status === 'ok' && vendors.dattoEdr.installed) {
    const edr = vendors.dattoEdr;
    widgets.push(`
      <div class="mtg-widget">
        <p class="mtg-widget-title">Datto EDR</p>
        ${kpiTileRow([
          { label: 'Locations', value: edr.locationCount },
          { label: 'Agents', value: edr.agentCount },
          { label: 'Active Agents', value: edr.activeAgentCount },
          { label: 'Open Alerts', value: edr.alertCount, tier: edr.alertCount > 0 ? 'bad' : 'good' },
        ])}
        ${edr.lastScannedOn ? `<p class="inline-subtext">Last scanned: ${new Date(edr.lastScannedOn).toLocaleString()}</p>` : ''}
      </div>`);
  }

  // Huntress -- incidentReportsCount is a LIFETIME total (Huntress's own
  // /organizations endpoint has no date-range param), explicitly labelled
  // as such rather than implied to be windowed like SaaS Alerts' figures.
  if (vendors.huntress.status === 'ok' && vendors.huntress.installed) {
    const h = vendors.huntress;
    const tiles = [
      { label: 'Agents Monitored', value: h.agentsCount ?? '--' },
      { label: 'Incident Reports', value: h.incidentReportsCount ?? '--', tier: h.incidentReportsCount > 0 ? 'warn' : 'good' },
    ];
    if (h.microsoft365UsersCount) tiles.push({ label: 'M365 Users', value: h.microsoft365UsersCount });
    widgets.push(`
      <div class="mtg-widget">
        <p class="mtg-widget-title">Huntress</p>
        ${kpiTileRow(tiles)}
        <p class="inline-subtext">Incident reports shown is a lifetime total, not limited to the last 30 days.</p>
      </div>`);
  }

  // AutoElevate -- confirmed live there's genuinely nothing more than a
  // match + deployed-since date available (see server.js's own comment),
  // so no KPI tiles here, just the one fact.
  if (vendors.autoElevate.status === 'ok' && vendors.autoElevate.installed && vendors.autoElevate.deployedSince) {
    widgets.push(`
      <div class="mtg-widget">
        <p class="mtg-widget-title">AutoElevate</p>
        <p class="inline-subtext">Deployed since ${new Date(vendors.autoElevate.deployedSince).toLocaleDateString()}.</p>
      </div>`);
  }

  return widgets.join('');
}

function vendorSummariesHtml(vendors) {
  if (!vendors) return '';
  // No "Other Systems" section heading anymore, by request -- each
  // vendor widget's own title (SaaS Alerts/SaaS Protection/...) is sized
  // up to that heading's own size instead (.live-reports-other-systems
  // scope in styles.css), carrying the same visual weight a section
  // heading would have without an extra label line above them.
  return `<div class="mtg-widget-grid live-reports-other-systems">${vendorWidgetsHtml(vendors)}</div>`;
}

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>Live Reports</h1>
    </header>
    <form id="search-form" class="date-form">
      <div class="date-form-row">
        <label for="site-input">Client (Datto Site)</label>
        <input type="text" id="site-input" placeholder="e.g. Acme* (wildcards with *, optional)" />
        <label class="inline-checkbox-label" title="Force an exact match on the Datto Site name (instead of the usual wildcard/contains search)">
          <input type="checkbox" id="exact-site-input" /> Exact
        </label>
        <button type="submit" id="search-button">Search</button>
        <button type="button" id="refresh-button" title="Re-fetch live Datto RMM data (bypasses the 20-minute cache)">Refresh</button>
        <button type="button" id="pdf-button" disabled title="Loads with the report above">Create PDF</button>
      </div>
    </form>
    <p id="status" class="status">Type a client's Datto Site name above to pull a live report.</p>
    <p id="pdf-status" class="status" hidden></p>
    <div id="results"></div>
  `;

  const form = container.querySelector('#search-form');
  const siteInput = container.querySelector('#site-input');
  const exactInput = container.querySelector('#exact-site-input');
  const refreshButton = container.querySelector('#refresh-button');
  const pdfButton = container.querySelector('#pdf-button');
  const statusEl = container.querySelector('#status');
  const pdfStatusEl = container.querySelector('#pdf-status');
  const resultsEl = container.querySelector('#results');

  // The PDF (ai-commentary.js/pdf-template.js on the server) is built
  // from whatever's CURRENTLY on screen -- these two are set once the
  // main report and the "Other Systems" section have each settled (see
  // render()/loadVendorSummaries() below), not re-fetched by the PDF
  // route itself, so the PDF always matches what the client can actually
  // see before clicking the button.
  let currentReportData = null;
  let currentVendorsData = null;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    load(false);
  });
  refreshButton.addEventListener('click', () => load(true));
  pdfButton.addEventListener('click', createPdf);

  async function createPdf() {
    if (!currentReportData || !currentVendorsData) return;
    pdfButton.disabled = true;
    pdfStatusEl.hidden = false;
    pdfStatusEl.className = 'status';
    pdfStatusEl.textContent = 'Generating PDF... this can take up to a minute.';
    try {
      const res = await fetch('/api/live-reports/pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ report: currentReportData, vendors: currentVendorsData }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${currentReportData.siteName} - Managed Services Report - ${new Date().toISOString().slice(0, 10)}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      pdfStatusEl.hidden = true;
    } catch (err) {
      pdfStatusEl.className = 'status error';
      pdfStatusEl.textContent = `Could not generate PDF: ${err.message}`;
    } finally {
      pdfButton.disabled = false;
    }
  }

  async function load(force) {
    const site = siteInput.value.trim();
    if (!site) {
      statusEl.hidden = false;
      statusEl.className = 'status';
      statusEl.textContent = "Type a client's Datto Site name above to pull a live report.";
      resultsEl.innerHTML = '';
      return;
    }
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    resultsEl.innerHTML = '';
    try {
      const params = new URLSearchParams({ site });
      if (exactInput.checked) params.set('exactSite', 'true');
      if (force) params.set('force', 'true');
      const res = await fetch(`/api/live-reports?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      render(data, force);
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    }
  }

  // "Other Systems" loads AFTER the main report above has already
  // rendered, via its own separate request -- confirmed live this
  // session that folding these 5 vendor calls into the main report made
  // the WHOLE page take 60-70+ seconds on a cold per-client cache, which
  // read as broken rather than slow. This keeps the fast Datto RMM report
  // fast (unchanged), with this section filling in underneath once it's
  // ready. Guarded on isConnected -- if the user searches a different
  // client before this resolves, resultsEl has already been replaced and
  // this placeholder is no longer on the page, so there's nothing to fill in.
  async function loadVendorSummaries(siteName, force) {
    const vendorEl = resultsEl.querySelector('#vendor-summaries');
    if (!vendorEl) return;
    try {
      const params = new URLSearchParams({ siteName });
      if (force) params.set('force', 'true');
      const res = await fetch(`/api/live-reports/vendors?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      if (!vendorEl.isConnected) return;
      vendorEl.outerHTML = vendorSummariesHtml(data.vendors);
      currentVendorsData = data.vendors;
    } catch (err) {
      if (vendorEl.isConnected) vendorEl.innerHTML = `<p class="inline-subtext">Could not load Other Systems: ${escapeHtml(err.message)}</p>`;
      // Create PDF still works even when "Other Systems" itself failed to
      // load -- a safe "nothing available" shape for every vendor rather
      // than blocking the whole PDF over one section's own transient
      // error (same shape pdf-template.js's own vendorMutedCard() already
      // renders as "Not connected" for any non-'ok' status).
      currentVendorsData = {
        saasAlerts: { status: 'not-configured' },
        saasProtection: { status: 'not-configured' },
        dattoEdr: { status: 'not-configured' },
        autoElevate: { status: 'not-configured' },
        huntress: { status: 'not-configured' },
      };
    }
    pdfButton.disabled = !currentReportData || !currentVendorsData;
    pdfButton.title = pdfButton.disabled ? 'Loads with the report above' : 'Download a branded PDF of this report';
  }

  function render(data, force) {
    if (!data.connected) {
      statusEl.className = 'status error';
      statusEl.textContent = 'Datto RMM is not connected -- check DATTO_API_KEY in .env.';
      currentReportData = null;
      currentVendorsData = null;
      pdfButton.disabled = true;
      return;
    }
    if (!data.found) {
      statusEl.className = 'status';
      statusEl.textContent = `No Datto RMM devices matched "${data.siteTerm}".`;
      currentReportData = null;
      currentVendorsData = null;
      pdfButton.disabled = true;
      return;
    }
    statusEl.hidden = true;
    currentReportData = data;
    currentVendorsData = null;
    pdfButton.disabled = true;
    pdfStatusEl.hidden = true;

    // Gauge first, by request -- no section heading (both "Executive
    // Summary" and "Datto RMM (Live)" headings removed, by request; "We
    // will modify what this shows later"). Score composition unchanged
    // (see its own subtext) -- only its position on the page moved.
    const gauge = `
      <div class="mtg-widget mtg-widget--gauge live-reports-gauge">
        ${gaugeSvg(data.overallScore)}
        <p class="inline-subtext">Overall Health Score</p>
      </div>`;

    // The 4 "boxed device counts" next, by request -- Total Devices/Seen
    // <7 Days/Seen 7-30 Days/Not Seen 30+ Days, same tiles Meeting Prep's
    // own dattoLiveDevicesWidgetsHtml() shows, built directly here (rather
    // than via that bundled function) so they can sit on their own,
    // separate from the device-type/freshness widgets below. Replaces the
    // old Total Devices/Online/Offline tile row entirely, by request
    // ("remove the 3 from what was the executive summary section").
    const dattoLive = data.dattoLive;
    const dattoLiveKpis = dattoLive
      ? kpiTileRow([
          { label: 'Total Devices', value: dattoLive.summary.total },
          { label: 'Seen <7 Days', value: dattoLive.summary.seenRecent, tier: 'good' },
          { label: 'Seen 7-30 Days', value: dattoLive.summary.seenAgeing, tier: 'warn' },
          { label: 'Not Seen 30+ Days', value: dattoLive.summary.notSeenStale, tier: 'bad' },
        ])
      : '';

    const alertSegments = (data.alertsByPriority || []).map((a) => ({ label: a.priority, value: a.count, color: ALERT_COLORS[a.priority] || '#9aa3af' }));
    const alertsDonut = donutWidget('Open Alerts (Critical / High)', alertSegments, data.alertsTotalCount);

    const typeWidget = dattoLive && dattoLive.byType.length > 0 ? deviceTypeBarWidget(dattoLive.byType, dattoLive.summary.total) : '';
    const freshnessWidget = dattoLive ? checkinFreshnessWidget(dattoLive.summary) : '';
    const deviceList = dattoLive ? deviceListTableHtml(dattoLive) : '';

    const groupWidgets = (groupLabel, g, note) => {
      if (!g) return '';
      return `
        <h2 class="client-summary-section-heading">${escapeHtml(groupLabel)} <span class="inline-subtext">(${g.total} device${g.total === 1 ? '' : 's'})</span></h2>
        ${note ? `<p class="inline-subtext">${escapeHtml(note)}</p>` : ''}
        <div class="mtg-widget-grid">
          ${donutFromLegend(`Patch Management (${g.patch.score}%)`, g.patch.legend, PATCH_COLORS)}
          ${donutFromLegend(`Software Management (${g.software.score}%)`, g.software.legend, SOFTWARE_COLORS)}
          ${donutFromLegend(`Antivirus (${g.antivirus.score}%)`, g.antivirus.legend, ANTIVIRUS_COLORS)}
        </div>`;
    };

    // 2x2, not the usual single wide row -- live-reports-kpi-grid
    // (styles.css) caps the wrapper's width to fit exactly 2 of
    // kpiTileRow's own tiles per line, so the 4 boxes wrap into a small
    // block that sits beside the gauge rather than spanning the page.
    const kpiGrid = dattoLiveKpis ? `<div class="live-reports-kpi-grid">${dattoLiveKpis}</div>` : '';

    resultsEl.innerHTML = `
      <p class="inline-subtext">${escapeHtml(data.siteName)} -- as of ${new Date(data.asOf).toLocaleString()}</p>
      <div class="mtg-widget-grid">${gauge}${kpiGrid}${alertsDonut}</div>
      <div class="mtg-widget-grid">${typeWidget}${freshnessWidget}</div>
      ${groupWidgets('Workstations', data.workstation)}
      ${groupWidgets(
        'Servers',
        data.server,
        'Patch Management and Software Management are not handled through this platform for servers, so they will always show as No Policy / Unmanaged below -- not counted in the Servers Health Score.'
      )}
      <div id="vendor-summaries"><p class="inline-subtext">Loading Other Systems...</p></div>
      ${deviceList}
      ${data.alertsTruncated ? '<p class="inline-subtext">Note: the account-wide open-alerts list hit its safety cap -- this client\'s alert count may be incomplete.</p>' : ''}
    `;
    wireDeviceFilters(resultsEl);
    loadVendorSummaries(data.siteName, force);
  }
}
