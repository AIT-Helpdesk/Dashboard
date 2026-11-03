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
      </div>
    </form>
    <p id="status" class="status">Type a client's Datto Site name above to pull a live report.</p>
    <div id="results"></div>
  `;

  const form = container.querySelector('#search-form');
  const siteInput = container.querySelector('#site-input');
  const exactInput = container.querySelector('#exact-site-input');
  const refreshButton = container.querySelector('#refresh-button');
  const statusEl = container.querySelector('#status');
  const resultsEl = container.querySelector('#results');

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    load(false);
  });
  refreshButton.addEventListener('click', () => load(true));

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
      render(data);
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    }
  }

  function render(data) {
    if (!data.connected) {
      statusEl.className = 'status error';
      statusEl.textContent = 'Datto RMM is not connected -- check DATTO_API_KEY in .env.';
      return;
    }
    if (!data.found) {
      statusEl.className = 'status';
      statusEl.textContent = `No Datto RMM devices matched "${data.siteTerm}".`;
      return;
    }
    statusEl.hidden = true;

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
      ${deviceList}
      ${data.alertsTruncated ? '<p class="inline-subtext">Note: the account-wide open-alerts list hit its safety cap -- this client\'s alert count may be incomplete.</p>' : ''}
    `;
    wireDeviceFilters(resultsEl);
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
