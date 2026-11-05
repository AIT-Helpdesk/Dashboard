// Live Reports -- "Present to Client" -- by request: a live-pulled
// equivalent of Datto RMM's own canned "Executive Summary Report" PDF,
// for one client at a time. Reuses the exact same gauge/donut/KPI-tile
// widget builders Make Report/Meeting Prep's own Executive Summary widget
// already renders (gaugeSvg/donutWidget/kpiTileRow, /meeting-prep-report-
// render.js) -- same visual language as that page's own live data, not a
// second chart implementation. See server.js's own header for what is and
// isn't reproduced here -- Open Alerts is Critical/High only; Asset
// Management/Monitoring ARE now shown (Scorecard below, plus their own
// breakdown tables -- see assetManagementTableHtml()/monitoringTableHtml()
// below), computed via server.js's own real re-creation of Datto's canned-
// report formulas (see server.js's own computeAssetManagementDetail()/
// computeMonitoringDetail() comments).
import { gaugeSvg, donutWidget, donutSvg, kpiTileRow, deviceTypeBarWidget, checkinFreshnessWidget, deviceListTableHtml, wireDeviceFilters } from '/meeting-prep-report-render.js';

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

// Scorecard, by request ("show the Scorecard on the on screen view before
// the Workstations") -- same AREA/RESULT/STATUS rows and same 90/70
// On Track/Watch/In Progress thresholds pdf-template.js's own
// statusForScore()/scorecardStatus() already use, so the on-screen page
// and the exported PDF read as the same scorecard, not two different
// ones. "Action needed" shows as "In Progress" here too, same PDF-only
// relabel reasoning (a lower score reads as actively being worked
// through, not a fixed hard failure) -- this IS that same scorecard, on
// screen now as well as in the PDF.
function scorecardStatus(score) {
  if (score === null || score === undefined) return { label: 'Unknown', tier: '' };
  if (score >= 90) return { label: 'On track', tier: 'good' };
  if (score >= 70) return { label: 'Watch', tier: 'warn' };
  return { label: 'In Progress', tier: 'bad' };
}
function scorecardRow(area, result, score) {
  const status = scorecardStatus(score);
  return `<tr><td>${escapeHtml(area)}</td><td>${escapeHtml(result)}</td><td><span class="mtg-score-badge mtg-score-badge--${status.tier}">${escapeHtml(status.label)}</span></td></tr>`;
}
// `vendors` is OPTIONAL -- the Scorecard renders immediately off the main
// report alone (SaaS Alerts/SaaS Protection rows just don't exist yet),
// then loadVendorSummaries() below re-renders it with those 2 rows added
// once vendors has actually loaded, same "fast first paint, fill in
// vendor data after" split this page's own Other Systems section already
// uses.
function scorecardHtml(report, vendors) {
  const rows = [
    report.assetManagement != null && scorecardRow('Asset Management', `${report.assetManagement}%`, report.assetManagement),
    report.monitoring != null && scorecardRow('Monitoring', `${report.monitoring}%`, report.monitoring),
    report.workstation && scorecardRow('Workstation Patch Management', `${report.workstation.patch.score}%`, report.workstation.patch.score),
    report.workstation && scorecardRow('Workstation Software Compliance', `${report.workstation.software.score}%`, report.workstation.software.score),
    report.workstation && scorecardRow('Workstation Antivirus', `${report.workstation.antivirus.score}%`, report.workstation.antivirus.score),
    report.server && scorecardRow('Server Antivirus', `${report.server.antivirus.score}%`, report.server.antivirus.score),
    scorecardRow('Open Alerts (Critical/High)', String(report.alertsTotalCount), report.alertsTotalCount > 0 ? 50 : 100),
    vendors &&
      vendors.saasAlerts.status === 'ok' &&
      vendors.saasAlerts.monitored &&
      scorecardRow(
        'SaaS Alerts (30 days)',
        `${vendors.saasAlerts.criticalCount} critical, ${vendors.saasAlerts.mediumCount} medium`,
        vendors.saasAlerts.criticalCount > 0 ? 40 : vendors.saasAlerts.mediumCount > 0 ? 75 : 100
      ),
    vendors && vendors.saasProtection.status === 'ok' && vendors.saasProtection.installed && scorecardRow('SaaS Protection (Backup)', `${vendors.saasProtection.backupPercentage}%`, vendors.saasProtection.backupPercentage),
  ]
    .filter(Boolean)
    .join('');
  return `
    <div id="scorecard-table">
      <h2 class="client-summary-section-heading">Scorecard</h2>
      <table class="live-reports-scorecard-table">
        <thead><tr><th>Area</th><th>Result</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// Asset Management / Monitoring breakdown tables, by request ("I thought
// you were going to give me some widgets and device info") -- the Scorecard
// above already shows each one's rolled-up %, but these are the REAL
// per-check/per-priority numbers behind it (server.js's own
// computeAssetManagementDetail()/computeMonitoringDetail()), same structure
// as Datto's own canned report's own "Asset Management" and "Total Alerts
// by Priority" tables. Reuses .live-reports-scorecard-table (same look as
// the Scorecard immediately above -- not a new table style) rather than a
// donut/KPI-tile treatment, since the real content here IS a small table,
// same as Datto's own report shows it.
function assetManagementTableHtml(detail) {
  if (!detail || !detail.checks || detail.checks.length === 0) return '';
  const rows = detail.checks
    .map((c) => `<tr><td>${escapeHtml(c.label)}</td><td>${c.passed} / ${c.total}</td><td><span class="mtg-score-badge mtg-score-badge--${scorecardStatus(c.score).tier}">${c.score == null ? 'No data' : `${c.score}%`}</span></td></tr>`)
    .join('');
  return `
    <h2 class="client-summary-section-heading">Asset Management <span class="inline-subtext">${detail.score != null ? `(${detail.score}%)` : ''}</span></h2>
    <table class="live-reports-scorecard-table">
      <thead><tr><th>Check</th><th>Passed</th><th>Score</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}
function monitoringTableHtml(detail) {
  if (!detail || !detail.byPriority) return '';
  const rows = detail.byPriority
    .map((p) => `<tr><td>${escapeHtml(p.priority)}</td><td>${p.raised}</td><td>${p.resolved}</td><td>${p.unresolved}</td><td><span class="mtg-score-badge mtg-score-badge--${scorecardStatus(p.score).tier}">${p.score}%</span></td></tr>`)
    .join('');
  return `
    <h2 class="client-summary-section-heading">Monitoring <span class="inline-subtext">(${detail.score}%)</span></h2>
    <table class="live-reports-scorecard-table">
      <thead><tr><th>Priority</th><th>Raised</th><th>Resolved</th><th>Unresolved</th><th>Score</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// Proactive Maintenance, by request -- same list the PDF now shows (top of
// its own Devices page), server.js's own getProactiveMaintenanceItems()
// (configurable via PROACTIVE_MAINTENANCE_ITEMS in .env), sourced once on
// the server rather than duplicated here, so the two surfaces can't drift
// apart. Moved above the Replacement Recommendation/Operating System
// donuts and styled as the same purple card the PDF's own
// drawProactiveMaintenanceNote() draws (2 columns, dash-bulleted, italic
// caption) -- literal brand-purple hex values, not the --purple/--card
// theme tokens, by design: this is the dashboard's one fixed brand-colour
// card treatment (same as the PDF, which is always on a white page), not
// something that should shift with light/dark mode.
function proactiveMaintenanceHtml(items) {
  if (!items || items.length === 0) return '';
  const half = Math.ceil(items.length / 2);
  const col = (colItems) => `<ul class="live-reports-proactive-maintenance-list">${colItems.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
  return `
    <div class="live-reports-proactive-maintenance-box">
      <p class="live-reports-proactive-maintenance-heading">Proactive Maintenance</p>
      <div class="live-reports-proactive-maintenance-cols">${col(items.slice(0, half))}${col(items.slice(half))}</div>
      <p class="live-reports-proactive-maintenance-caption">Standard activities performed across all managed devices -- not scored.</p>
    </div>`;
}

// Microsoft License Counts, by request ("add a set of Microsoft license
// counts... Use the Product counts from the M365 Contract in Autotask") --
// the only section on this page backed by a real Autotask Company/Contract
// lookup rather than a Datto-site-name cross-reference (see server.js's own
// getM365LicenseCounts() comment for exactly how "current" counts are
// derived from Autotask's real ContractServiceUnits data, and why an
// ambiguous/missing company match is surfaced honestly rather than guessed
// past). Reuses .live-reports-scorecard-table's own look (grey header,
// centred last column) rather than a new table style.
function m365LicensesHtml(m365) {
  if (!m365) return '';
  const plainHeading = '<h2 class="client-summary-section-heading">Microsoft License Counts</h2>';
  if (m365.status === 'ambiguous') {
    return `${plainHeading}<p class="inline-subtext">Multiple Autotask companies match this client's name -- can't show license counts without risking the wrong one. Matches: ${m365.matches.map((m) => escapeHtml(m.companyName)).join(', ')}</p>`;
  }
  if (m365.status === 'not-found') {
    return `${plainHeading}<p class="inline-subtext">No matching Autotask company found for this client.</p>`;
  }
  if (m365.status === 'no-contract') {
    return `${plainHeading}<p class="inline-subtext">No active M365 contract found in Autotask for ${escapeHtml(m365.companyName)}.</p>`;
  }
  if (m365.status !== 'ok') {
    return `${plainHeading}<p class="inline-subtext">Could not load Microsoft license counts.</p>`;
  }
  // Literal "(from contract)" now, by request -- not the real contract
  // name (which could be more than one contract anyway now that several
  // active M365*-named contracts are combined -- see server.js's own
  // getM365LicenseCounts()).
  const heading = '<h2 class="client-summary-section-heading">Microsoft License Counts <span class="inline-subtext">(from contract)</span></h2>';
  if (!m365.items || m365.items.length === 0) {
    return `${heading}<p class="inline-subtext">No current license counts found.</p>`;
  }
  // No header row, by request ("Product / Count... seems kind of
  // obvious") -- same showHeader: false the Scorecard table already uses
  // for the same reason, on the PDF side (drawM365LicensesTable()). Term
  // (Monthly/Annual) is its own column now, by request -- "--" when
  // Autotask's own invoiceDescription doesn't name one (a real case, see
  // parseM365Product()'s own comment).
  const rows = m365.items.map((item) => `<tr><td>${escapeHtml(item.product)}</td><td>${escapeHtml(item.term || '--')}</td><td>${item.count}</td></tr>`).join('');
  return `
    ${heading}
    <table class="live-reports-scorecard-table">
      <tbody>${rows}</tbody>
    </table>`;
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
    // Critical-severity event names coloured red, by request -- same
    // "severity carried through, not lost once merged by name" data
    // server.js's own buildSaasAlertsSummary() now returns.
    // Counts shown here are each event name's own REAL critical/medium
    // counts, never merged into one combined number -- confirmed live this
    // session (Back 2 Basics) that merging them made the red-coloured
    // numbers add up to MORE than the real Critical tile, a genuine
    // accuracy bug a client could (and did) catch.
    const formatEventCounts = (e) => (e.criticalCount > 0 && e.mediumCount > 0 ? `${e.criticalCount} critical, ${e.mediumCount} medium` : String(e.criticalCount || e.mediumCount));
    const eventsListHtml =
      sa.topEvents.length > 0
        ? `<ul class="live-reports-saas-alerts-events">${sa.topEvents
            .map((e) => `<li${e.criticalCount > 0 ? ' class="live-reports-event-critical"' : ''}>${escapeHtml(e.name)} <span class="muted">(${formatEventCounts(e)})</span></li>`)
            .join('')}</ul>`
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

  // SaaS Backups (renamed from "SaaS Protection (Backup)", by request) --
  // backupPercentage/billableSeatCount are the same figures the badge's
  // own hover detail already shows, repeated here visibly since this page
  // is meant to be read on-screen, not hovered. Layout by request, after
  // the first cut (3 tiles in one row + a list beside the whole row) read
  // wrong on a real screenshot -- "App Types Healthy"'s own longer label
  // wrapped to 2 lines, making that tile visibly taller than the other
  // two even though their widths matched. Now: Backup %/Seats on their own
  // row 1, App Types Healthy alone on row 2 with the per-app seat
  // breakdown sitting beside THAT one tile specifically, not the row
  // above.
  if (vendors.saasProtection.status === 'ok' && vendors.saasProtection.installed) {
    const sp = vendors.saasProtection;
    const tier = sp.backupPercentage == null ? undefined : sp.backupPercentage >= 95 ? 'good' : sp.backupPercentage >= 70 ? 'warn' : 'bad';
    // Per-app breakdown (Email/OneDrive/SharePoint/Teams), by request --
    // replaces the old "Needs attention: ..." summary line entirely (this
    // shows the same unhealthy-app information, just per-app and with a
    // seat count alongside it, so the summary line would just be
    // repeating a subset of this).
    const breakdownHtml =
      sp.appBreakdown.length > 0
        ? `<ul class="live-reports-app-breakdown">${sp.appBreakdown
            .map((a) => {
              const seatText = a.seatCount != null ? `${a.seatCount} seat${a.seatCount === 1 ? '' : 's'}` : a.status;
              return `<li${a.healthy ? '' : ' class="live-reports-app-unhealthy"'}>${escapeHtml(a.label)}: ${escapeHtml(seatText)}${a.healthy ? '' : ` <span class="muted">(${escapeHtml(a.status)})</span>`}</li>`;
            })
            .join('')}</ul>`
        : '';
    widgets.push(`
      <div class="mtg-widget">
        <p class="mtg-widget-title">SaaS Backups</p>
        <div class="live-reports-saas-protection-row live-reports-saas-protection-row1">
          ${kpiTileRow([
            { label: 'Backup %', value: sp.backupPercentage ?? '--', tier },
            { label: 'Seats', value: sp.billableSeatCount ?? '--' },
          ])}
        </div>
        <div class="live-reports-saas-protection-row live-reports-saas-protection-row2">
          ${kpiTileRow([{ label: 'App Types Healthy', value: `${sp.appTypesHealthy}/${sp.appTypesTotal}` }])}
          ${breakdownHtml}
        </div>
      </div>`);
  }

  // Datto EDR -- agentCount/activeAgentCount/alertCount/alertCount30d are
  // summed/filtered across every matched Location (a client can have
  // several, see server.js's own comment), not just one. Locations tile
  // removed, 30-day alert tile added, by request -- see
  // buildDattoEdrSummary()'s own comment for how alertCount30d is derived
  // (the API itself has no working date-range filter). A real 2x2 grid
  // for these 4 tiles, by request -- kpiTileRow's own plain flex-wrap left
  // 3 tiles on row 1 and stretched the 4th alone across all of row 2
  // (confirmed wrong on a real screenshot); .live-reports-dattoedr-kpis
  // overrides it the same way .live-reports-kpi-grid already does for
  // Meeting Prep's own 4 Datto Live tiles.
  if (vendors.dattoEdr.status === 'ok' && vendors.dattoEdr.installed) {
    const edr = vendors.dattoEdr;
    widgets.push(`
      <div class="mtg-widget">
        <p class="mtg-widget-title">Datto EDR</p>
        <div class="live-reports-dattoedr-kpis">
          ${kpiTileRow([
            { label: 'Agents', value: edr.agentCount },
            { label: 'Active Agents', value: edr.activeAgentCount },
            { label: 'Open Alerts', value: edr.alertCount, tier: edr.alertCount > 0 ? 'bad' : 'good' },
            { label: 'Alerts (30 Days)', value: edr.alertCount30d, tier: edr.alertCount30d > 0 ? 'warn' : 'good' },
          ])}
        </div>
        ${edr.lastScannedOn ? `<p class="inline-subtext">Last scanned: ${new Date(edr.lastScannedOn).toLocaleString()}</p>` : ''}
      </div>`);
  }

  // Huntress -- incidentReportsCount is a LIFETIME total (Huntress's own
  // /organizations endpoint has no date-range param); caption shortened to
  // just that fact, by request.
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
        <p class="inline-subtext">Lifetime total incidents.</p>
      </div>`);
  }

  // AutoElevate -- elevation requests/events widgets, by request. "Approved
  // (Manual)" is deliberately not labelled "by a technician" -- see
  // server.js's own classifyElevationOutcomes() comment for why that
  // distinction isn't reliably knowable from the API. donutSvg() used
  // directly rather than the full donutWidget() (which wraps itself in its
  // OWN .mtg-widget card) -- this already has its own outer .mtg-widget
  // card below, same as every other vendor widget here; nesting another
  // .mtg-widget inside it would double the border/padding.
  if (vendors.autoElevate.status === 'ok' && vendors.autoElevate.installed && vendors.autoElevate.deployedSince) {
    const ae = vendors.autoElevate;
    const el = ae.elevation;
    let body = '';
    if (el) {
      // Donut/KPI tile/top-apps widgets always shown now, by request --
      // even with zero elevation activity in the window (donutSvg() itself
      // already renders a plain empty ring + "0" centre label when every
      // segment is 0, same as every other zero-count donut on this page,
      // so there's no special-case rendering needed here beyond always
      // building `body` whenever `el` exists).
      const segments = [
        { label: 'Approved (Auto)', value: el.outcomes.autoApproved, color: '#16a34a' },
        { label: 'Approved (Manual)', value: el.outcomes.manualApproved, color: '#2563eb' },
        { label: 'Denied', value: el.outcomes.denied, color: '#dc2626' },
        { label: 'Pending', value: el.outcomes.pending, color: '#f59e0b' },
      ];
      const legendRows = segments
        .map(
          (s) =>
            `<div class="mtg-donut-legend-row" title="${escapeHtml(s.label)}"><span class="mtg-swatch" style="background:${s.color}"></span><span class="mtg-donut-legend-label">${escapeHtml(s.label)}</span><span class="mtg-donut-val">${s.value}</span></div>`
        )
        .join('');
      const topAppsHtml =
        el.topApps.length > 0
          ? `<ul class="live-reports-saas-alerts-events">${el.topApps.map((a) => `<li>${escapeHtml(a.name)} <span class="muted">(${a.count})</span></li>`).join('')}</ul>`
          : '<p class="inline-subtext">No elevation requests in this window.</p>';
      // Requests Handled KPI tile (and the "Deployed since" line below, and
      // the trend-vs-previous-period calc it used to need) removed, by
      // request -- the donut + legend + top-apps list already say
      // everything that tile repeated. "(30 days)" moved into the title
      // itself (grey, via .muted), also by request, instead of the window
      // length only showing inside that now-removed tile's own label.
      body = `
        <div class="live-reports-saas-alerts-layout">
          <div class="mtg-donut-row">${donutSvg(segments, el.handledCount)}<div class="mtg-donut-legend">${legendRows}</div></div>
          ${topAppsHtml}
        </div>`;
    }
    widgets.push(`
      <div class="mtg-widget">
        <p class="mtg-widget-title">AutoElevate${el ? ` <span class="muted">(${el.windowDays} days)</span>` : ''}</p>
        ${body}
      </div>`);
  }

  return widgets.join('');
}

function vendorSummariesHtml(vendors) {
  if (!vendors) return '';
  // "Cybersecurity Systems" heading restored, by request (removed earlier
  // this session, now wanted back) -- same name as the PDF's own section
  // (pdf-template.js's drawCybersecurityLayers(), renamed from
  // "Cybersecurity Layers" at the same time) so the two surfaces read as
  // the same section.
  return `<h2 class="client-summary-section-heading">Cybersecurity Systems</h2><div class="mtg-widget-grid live-reports-other-systems">${vendorWidgetsHtml(vendors)}</div>`;
}

// Generate Summary / edit-before-PDF, by request -- see server.js's own
// /commentary route comment for the full flow. `commentary` here is
// exactly the shape ai-commentary.js's buildCommentary() returns:
// { executiveSummary, onTrack, actionNeeded, watch, recommendations }.
// Bullet lists are edited as one-line-per-item plain text (simplest
// reliable editing UI for a short list, no add/remove-row wiring needed) --
// only Recommendations (each row has 3 distinct fields: priority/
// recommendation/why it matters) gets its own repeatable-row UI below.
function commentaryEditorHtml(commentary) {
  const bulletsToText = (arr) => (arr || []).join('\n');
  const recRows = (commentary.recommendations || []).map((r) => recommendationRowHtml(r)).join('');
  return `
    <div class="live-reports-commentary-editor">
      <h2 class="client-summary-section-heading">Report Narrative (Editable)</h2>
      <p class="inline-subtext">AI-drafted from the report above -- edit anything below before creating the PDF. The PDF uses exactly what's here, as-is.</p>

      <label class="live-reports-commentary-label" for="commentary-exec-summary">Executive Summary</label>
      <textarea id="commentary-exec-summary" class="live-reports-commentary-field live-reports-commentary-textarea" rows="4">${escapeHtml(commentary.executiveSummary || '')}</textarea>

      <div class="live-reports-commentary-cols">
        <div>
          <label class="live-reports-commentary-label live-reports-commentary-label--on-track" for="commentary-on-track">On Track <span class="inline-subtext">(one per line)</span></label>
          <textarea id="commentary-on-track" class="live-reports-commentary-field live-reports-commentary-textarea" rows="4">${escapeHtml(bulletsToText(commentary.onTrack))}</textarea>
        </div>
        <div>
          <label class="live-reports-commentary-label live-reports-commentary-label--action-needed" for="commentary-action-needed">Action Needed <span class="inline-subtext">(one per line)</span></label>
          <textarea id="commentary-action-needed" class="live-reports-commentary-field live-reports-commentary-textarea" rows="4">${escapeHtml(bulletsToText(commentary.actionNeeded))}</textarea>
        </div>
        <div>
          <label class="live-reports-commentary-label live-reports-commentary-label--watch" for="commentary-watch">Watch <span class="inline-subtext">(one per line)</span></label>
          <textarea id="commentary-watch" class="live-reports-commentary-field live-reports-commentary-textarea" rows="4">${escapeHtml(bulletsToText(commentary.watch))}</textarea>
        </div>
      </div>

      <label class="live-reports-commentary-label">Our Recommendations</label>
      <div id="commentary-recommendations">${recRows}</div>
      <button type="button" id="commentary-add-recommendation" class="button-link button-link--small">+ Add Recommendation</button>
    </div>
  `;
}

function recommendationRowHtml(r) {
  const rec = r || { priority: 'Watch', recommendation: '', whyItMatters: '' };
  return `
    <div class="live-reports-commentary-rec-row" data-rec-row>
      <select class="live-reports-commentary-field live-reports-commentary-rec-priority">
        <option value="Action needed" ${rec.priority === 'Action needed' ? 'selected' : ''}>Action needed</option>
        <option value="Watch" ${rec.priority === 'Watch' ? 'selected' : ''}>Watch</option>
      </select>
      <input type="text" class="live-reports-commentary-field live-reports-commentary-rec-text" placeholder="Recommendation" value="${escapeHtml(rec.recommendation || '')}" />
      <input type="text" class="live-reports-commentary-field live-reports-commentary-rec-why" placeholder="Why it matters" value="${escapeHtml(rec.whyItMatters || '')}" />
      <button type="button" class="button-link button-link--small live-reports-commentary-rec-remove" title="Remove this recommendation">Remove</button>
    </div>`;
}

// Event delegation (one listener on the editor root) rather than wiring
// each row's own Remove button individually -- rows can be added/removed
// after this runs once (the +Add Recommendation button itself), so a
// per-row listener would need re-wiring on every add anyway.
function wireCommentaryEditor(root) {
  const addButton = root.querySelector('#commentary-add-recommendation');
  const rowsEl = root.querySelector('#commentary-recommendations');
  if (addButton && rowsEl) {
    addButton.addEventListener('click', () => {
      rowsEl.insertAdjacentHTML('beforeend', recommendationRowHtml(null));
    });
  }
  root.addEventListener('click', (e) => {
    const removeButton = e.target.closest('.live-reports-commentary-rec-remove');
    if (removeButton) removeButton.closest('[data-rec-row]').remove();
  });
}

// Reads whatever's CURRENTLY in the editor form (edited or not) at the
// moment Create PDF is clicked -- not a copy kept in sync on every
// keystroke, so there's exactly one source of truth (the DOM itself) and
// no risk of it drifting from what's actually on screen. Returns null when
// the editor was never opened (Generate Summary not clicked this session),
// which createPdf() uses to mean "let the server draft its own", same as
// before this feature existed.
function readCommentaryFromEditor(root) {
  const editor = root.querySelector('.live-reports-commentary-editor');
  if (!editor) return null;
  const linesOf = (selector) =>
    (editor.querySelector(selector).value || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  const recommendations = [...editor.querySelectorAll('[data-rec-row]')]
    .map((row) => ({
      priority: row.querySelector('.live-reports-commentary-rec-priority').value,
      recommendation: row.querySelector('.live-reports-commentary-rec-text').value.trim(),
      whyItMatters: row.querySelector('.live-reports-commentary-rec-why').value.trim(),
    }))
    .filter((r) => r.recommendation); // a row left blank (e.g. added then never filled in) is dropped, not sent as an empty row
  return {
    executiveSummary: editor.querySelector('#commentary-exec-summary').value.trim(),
    onTrack: linesOf('#commentary-on-track'),
    actionNeeded: linesOf('#commentary-action-needed'),
    watch: linesOf('#commentary-watch'),
    recommendations,
  };
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
        <button type="submit" id="search-button" class="button-link button-link--small refresh-button--emphasis" title="Pull a report for this client (uses the 20-minute cache if still warm)">Search</button>
        <button type="button" id="refresh-button" class="button-link button-link--small" title="Re-fetch live Datto RMM data (bypasses the 20-minute cache) -- use this when you need the absolute latest, not what was cached up to 20 minutes ago">Refresh</button>
        <button type="button" id="generate-commentary-button" class="button-link button-link--small" disabled title="Loads with the report above">Generate Summary</button>
        <button type="button" id="pdf-button" class="button-link button-link--small" disabled title="Loads with the report above">Create PDF</button>
      </div>
    </form>
    <p id="status" class="status">Type a client's Datto Site name above to pull a live report.</p>
    <p id="pdf-status" class="status" hidden></p>
    <p id="commentary-status" class="status" hidden></p>
    <div id="commentary-editor-container"></div>
    <div id="results"></div>
  `;

  const form = container.querySelector('#search-form');
  const siteInput = container.querySelector('#site-input');
  const exactInput = container.querySelector('#exact-site-input');
  const refreshButton = container.querySelector('#refresh-button');
  const pdfButton = container.querySelector('#pdf-button');
  const generateCommentaryButton = container.querySelector('#generate-commentary-button');
  const statusEl = container.querySelector('#status');
  const pdfStatusEl = container.querySelector('#pdf-status');
  const commentaryStatusEl = container.querySelector('#commentary-status');
  const commentaryEditorContainer = container.querySelector('#commentary-editor-container');
  const resultsEl = container.querySelector('#results');

  // The PDF (ai-commentary.js/pdf-template.js on the server) is built
  // from whatever's CURRENTLY on screen -- these two are set once the
  // main report and the "Other Systems" section have each settled (see
  // render()/loadVendorSummaries() below), not re-fetched by the PDF
  // route itself, so the PDF always matches what the client can actually
  // see before clicking the button.
  let currentReportData = null;
  let currentVendorsData = null;

  function resetCommentaryEditor() {
    commentaryEditorContainer.innerHTML = '';
    commentaryStatusEl.hidden = true;
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    load(false);
  });
  refreshButton.addEventListener('click', () => load(true));
  pdfButton.addEventListener('click', createPdf);
  generateCommentaryButton.addEventListener('click', generateCommentary);

  // Generate Summary -> edit -> Create PDF, by request ("a button to
  // generate the Executive Summary, On Track, Action Needed, Watch, and
  // Our Recommendations sections before requesting the PDF... allow us to
  // edit the content before creating the PDF"). Separate from createPdf()
  // below -- this only drafts the narrative and renders it as an editable
  // form; nothing is sent to /pdf until the Create PDF button is clicked,
  // at which point readCommentaryFromEditor() reads whatever is currently
  // in that form (edited or not) and sends it along instead of letting the
  // server draft its own (see server.js's own /commentary and /pdf
  // routes).
  async function generateCommentary() {
    if (!currentReportData || !currentVendorsData) return;
    generateCommentaryButton.disabled = true;
    generateCommentaryButton.textContent = 'Generating...';
    pdfButton.disabled = true;
    commentaryStatusEl.hidden = false;
    commentaryStatusEl.className = 'status loading';
    commentaryStatusEl.textContent = 'Drafting the report narrative with AI... this can take up to a minute.';
    try {
      const res = await fetch('/api/live-reports/commentary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ report: currentReportData, vendors: currentVendorsData }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      commentaryEditorContainer.innerHTML = commentaryEditorHtml(data.commentary);
      wireCommentaryEditor(commentaryEditorContainer);
      commentaryStatusEl.hidden = true;
    } catch (err) {
      commentaryStatusEl.className = 'status error';
      commentaryStatusEl.textContent = `Could not generate report narrative: ${err.message}`;
    } finally {
      generateCommentaryButton.disabled = false;
      generateCommentaryButton.textContent = 'Generate Summary';
      pdfButton.disabled = !currentReportData || !currentVendorsData;
    }
  }

  async function createPdf() {
    if (!currentReportData || !currentVendorsData) return;
    // Wait here too -- actively generating, same "not available" state as
    // the report/vendor-data-loading windows above (this one also has its
    // own pdfStatusEl progress line below, but the button itself should
    // read the same way every other "disabled because something's in
    // flight" moment on this page does).
    pdfButton.disabled = true;
    pdfButton.textContent = 'Loading';
    generateCommentaryButton.disabled = true;
    pdfStatusEl.hidden = false;
    // 'status loading', not plain 'status', by request -- picks up the
    // shared orange .status.loading convention (styles.css) instead of the
    // default muted grey, same "a process is running" treatment Microsoft
    // License Counts/Other Systems' own loading placeholders below now get.
    pdfStatusEl.className = 'status loading';
    pdfStatusEl.textContent = 'Generating PDF... this can take up to a minute.';
    // Whatever's currently in the (possibly-edited) Generate Summary form
    // is used as-is -- null when that form was never opened at all (no
    // commentary key sent), which falls back to server.js's own
    // auto-generate-or-skip behaviour, same as before this feature existed.
    const editedCommentary = readCommentaryFromEditor(commentaryEditorContainer);
    try {
      const res = await fetch('/api/live-reports/pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ report: currentReportData, vendors: currentVendorsData, ...(editedCommentary ? { commentary: editedCommentary } : {}) }),
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
      pdfButton.textContent = 'Create PDF';
      generateCommentaryButton.disabled = false;
    }
  }

  async function load(force) {
    const site = siteInput.value.trim();
    // A previous client's (or a previous fetch's) generated/edited
    // narrative is no longer valid once new report data is about to load --
    // cleared unconditionally here, same as currentReportData/
    // currentVendorsData themselves get reset below, so a stale edited
    // paragraph can never silently end up in a different client's PDF.
    resetCommentaryEditor();
    if (!site) {
      statusEl.hidden = false;
      statusEl.className = 'status';
      statusEl.textContent = "Type a client's Datto Site name above to pull a live report.";
      resultsEl.innerHTML = '';
      return;
    }
    statusEl.hidden = false;
    // 'status loading', not plain 'status', by request -- same orange
    // "a process is running" treatment as the PDF status line above.
    statusEl.className = 'status loading';
    statusEl.textContent = 'Loading...';
    resultsEl.innerHTML = '';
    // Disabled + "Wait" from the moment a fetch starts, by request -- not
    // just once the main report lands (render()'s own `pdfButton.disabled
    // = true` further down). Without this, a Create PDF click mid-search
    // (while the OLD client's report is still showing and its own PDF data
    // is still sitting in currentReportData/currentVendorsData) would
    // silently generate a PDF for the WRONG client.
    pdfButton.disabled = true;
    pdfButton.textContent = 'Loading';
    generateCommentaryButton.disabled = true;
    try {
      const params = new URLSearchParams({ site });
      if (exactInput.checked) params.set('exactSite', 'true');
      if (force) params.set('force', 'true');
      // cache: 'no-store' -- defensive, by request (ruling out a stale
      // browser-cached response as a possible cause of "the page doesn't
      // reflect what the server now returns" reports). This route's
      // response changes between calls (force, live data), so it should
      // never be served from the browser's own HTTP cache regardless of
      // whatever headers the response happens to carry.
      const res = await fetch(`/api/live-reports?${params.toString()}`, { cache: 'no-store' });
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
    const m365El = resultsEl.querySelector('#m365-licenses');
    if (!vendorEl) return;
    try {
      const params = new URLSearchParams({ siteName });
      if (force) params.set('force', 'true');
      const res = await fetch(`/api/live-reports/vendors?${params.toString()}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      if (!vendorEl.isConnected) return;
      currentVendorsData = data.vendors;
      // "Other Systems" and "Microsoft License Counts" are now rendered in
      // their OWN try/catch each, by request -- confirmed this session
      // that a bug in ONE of them (either a thrown exception, or one
      // vendor's own transient failure) could silently prevent the OTHER
      // from ever updating, since they used to share one try block and
      // vendorSummariesHtml() ran first. Each failure is also logged to
      // the browser console now, so a real bug shows up there instead of
      // just reading as "nothing happened".
      try {
        vendorEl.outerHTML = vendorSummariesHtml(data.vendors);
      } catch (err) {
        console.error('Live Reports: failed to render Other Systems:', err);
        if (vendorEl.isConnected) vendorEl.innerHTML = `<p class="inline-subtext">Could not render Other Systems: ${escapeHtml(err.message)}</p>`;
      }
      if (m365El && m365El.isConnected) {
        try {
          m365El.innerHTML = m365LicensesHtml(data.vendors.m365Licenses);
        } catch (err) {
          console.error('Live Reports: failed to render Microsoft License Counts:', err, data.vendors.m365Licenses);
          m365El.innerHTML = `<h2 class="client-summary-section-heading">Microsoft License Counts</h2><p class="inline-subtext">Could not render license counts: ${escapeHtml(err.message)}</p>`;
        }
      }
    } catch (err) {
      console.error('Live Reports: /vendors request failed:', err);
      if (vendorEl.isConnected) vendorEl.innerHTML = `<p class="inline-subtext">Could not load Other Systems: ${escapeHtml(err.message)}</p>`;
      if (m365El && m365El.isConnected) m365El.innerHTML = m365LicensesHtml({ status: 'error' });
      // Create PDF still works even when "Other Systems" itself failed to
      // load -- a safe "nothing available" shape for every vendor rather
      // than blocking the whole PDF over one section's own transient
      // error (same shape pdf-template.js's own vendorMutedCard() already
      // renders as "Not connected" for any non-'ok' status). Scorecard's
      // own SaaS Alerts/SaaS Protection rows check `status === 'ok'`, so
      // this safe fallback just means those 2 rows stay omitted below too,
      // same as if vendors hadn't loaded at all.
      currentVendorsData = {
        saasAlerts: { status: 'not-configured' },
        saasProtection: { status: 'not-configured' },
        dattoEdr: { status: 'not-configured' },
        autoElevate: { status: 'not-configured' },
        huntress: { status: 'not-configured' },
        m365Licenses: { status: 'error' },
      };
    }
    // Scorecard re-rendered with vendors now available, adding the 2
    // vendor-dependent rows it couldn't show on the first (report-only)
    // render -- guarded the same way the Other Systems replace above is
    // (a different client's search may have already replaced resultsEl).
    const scorecardEl = resultsEl.querySelector('#scorecard-table');
    if (scorecardEl && scorecardEl.isConnected && currentReportData) {
      scorecardEl.outerHTML = scorecardHtml(currentReportData, currentVendorsData);
    }
    pdfButton.disabled = !currentReportData || !currentVendorsData;
    // Still waiting (a newer search landed its report but not its vendor
    // data yet) vs. genuinely ready -- same Wait/Create PDF distinction as
    // everywhere else this button's label changes.
    pdfButton.textContent = pdfButton.disabled ? 'Loading' : 'Create PDF';
    pdfButton.title = pdfButton.disabled ? 'Loads with the report above' : 'Download a branded PDF of this report';
    generateCommentaryButton.disabled = pdfButton.disabled;
    generateCommentaryButton.title = pdfButton.title;
  }

  function render(data, force) {
    if (!data.connected) {
      statusEl.className = 'status error';
      statusEl.textContent = 'Datto RMM is not connected -- check DATTO_API_KEY in .env.';
      currentReportData = null;
      currentVendorsData = null;
      // Create PDF, not Wait -- nothing is in flight any more, this is a
      // dead end until the user fixes the underlying connection, not a
      // "still loading" state.
      pdfButton.disabled = true;
      pdfButton.textContent = 'Create PDF';
      generateCommentaryButton.disabled = true;
      return;
    }
    if (!data.found) {
      statusEl.className = 'status';
      statusEl.textContent = `No Datto RMM devices matched "${data.siteTerm}".`;
      currentReportData = null;
      currentVendorsData = null;
      // Same reasoning as the not-connected branch above -- a dead end
      // until the user changes the search, not something to wait out.
      pdfButton.disabled = true;
      pdfButton.textContent = 'Create PDF';
      generateCommentaryButton.disabled = true;
      return;
    }
    statusEl.hidden = true;
    currentReportData = data;
    currentVendorsData = null;
    // Still Wait here -- the main report landed, but "Other Systems"
    // (loadVendorSummaries(), called at the end of this function) hasn't
    // finished yet, and the PDF needs both.
    pdfButton.disabled = true;
    pdfButton.textContent = 'Loading';
    generateCommentaryButton.disabled = true;
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

    // Replacement Recommendation / Operating System, in the Device Health
    // area now (moved off the device list, by request -- "move the
    // Replacement Recommendations & Operating Systems to the Device
    // [Health] section") -- see computeHardwareLifecycle()'s own comment in
    // server.js for how these are derived from live Datto RMM data.
    // "Operating System" (not "OS Support") and the donut itself only ever
    // uses 2 colours (not a 3rd "unsupported unless extended support
    // arranged" tier), both by request -- but its LEGEND now lists the real
    // OS names found (build numbers stripped), each coloured green/red by
    // whether THAT one is supported, rather than 2 generic Supported/
    // Unsupported rows, by request ("List what they are instead of
    // Supported and Unsupported but colour them red and green to match...
    // Keep the widget as just supported and unsupported though" -- the ring
    // itself still only ever uses those same 2 colours). Falls back to the
    // old 2-row legend when there's no OS data at all to name individually.
    // Same shape the PDF's own buildHardwareLifecycleSpecs() builds.
    const hl = data.hardwareLifecycle;
    const osByName = (hl && hl.osSupport.byName) || [];
    const osLegend = osByName.length > 0 ? Object.fromEntries(osByName.map((o) => [o.name, o.count])) : hl ? { Supported: hl.osSupport.supported, Unsupported: hl.osSupport.unsupported } : {};
    const osColors =
      osByName.length > 0 ? Object.fromEntries(osByName.map((o) => [o.name, o.supported ? '#16a34a' : '#dc2626'])) : { Supported: '#16a34a', Unsupported: '#dc2626' };
    const hardwareLifecycleWidgets = hl
      ? `<div class="mtg-widget-grid">
          ${donutFromLegend(
            'Replacement Recommendation',
            { 'Within 12 months': hl.replacementRecommendation.within12, '12 to 24 months': hl.replacementRecommendation.from12to24, 'Suitable 24+ months': hl.replacementRecommendation.suitable24Plus, Unknown: hl.replacementRecommendation.unknown },
            { 'Within 12 months': '#dc2626', '12 to 24 months': '#f59e0b', 'Suitable 24+ months': '#16a34a', Unknown: '#9aa3af' }
          )}
          ${donutFromLegend('Operating System', osLegend, osColors)}
        </div>`
      : '';

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
      <div class="live-reports-overview-grid">
        ${typeWidget}
        ${freshnessWidget}
        <div class="live-reports-scorecard-span">${scorecardHtml(data, null)}</div>
      </div>
      <div class="mtg-widget-grid">
        <div>${assetManagementTableHtml(data.assetManagementDetail)}</div>
        <div>${monitoringTableHtml(data.monitoringDetail)}</div>
      </div>
      ${groupWidgets('Workstations', data.workstation)}
      ${groupWidgets(
        'Servers',
        data.server,
        'Patch Management and Software Management are not handled through this platform for servers, so they will always show as No Policy / Unmanaged below -- not counted in the Servers Health Score.'
      )}
      ${hardwareLifecycleWidgets}
      <div id="vendor-summaries"><p class="inline-subtext live-reports-loading-text">Loading Other Systems...</p></div>
      <div id="m365-licenses"><h2 class="client-summary-section-heading">Microsoft License Counts</h2><p class="inline-subtext live-reports-loading-text">Loading...</p></div>
      ${proactiveMaintenanceHtml(data.proactiveMaintenance)}
      <div class="live-reports-device-list">${deviceList}</div>
      ${data.alertsTruncated ? '<p class="inline-subtext">Note: the account-wide open-alerts list hit its safety cap -- this client\'s alert count may be incomplete.</p>' : ''}
    `;
    wireDeviceFilters(resultsEl);
    loadVendorSummaries(data.siteName, force);
  }
}
