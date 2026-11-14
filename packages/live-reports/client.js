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
import { gaugeSvg, donutWidget, donutSvg, kpiTileRow, deviceTypeBarWidget, checkinFreshnessWidget, deviceListTableHtml, wireDeviceFilters, checkIconSvg } from '/meeting-prep-report-render.js';

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

function donutFromLegend(title, legend, colors, deviceHealthItemKey) {
  const segments = Object.entries(legend).map(([label, value]) => ({ label, value, color: colors[label] || '#9aa3af' }));
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const widget = donutWidget(title, segments, total);
  if (!deviceHealthItemKey) return widget;
  // Corner checkbox, by request ("Allow Each of the Workstation widgets to
  // have their own tick box") -- donutWidget() is shared with other pages
  // (meeting-prep-report-render.js), so its own markup is never touched
  // beyond adding a class and inserting the checkbox right after its own
  // opening tags (string surgery, not a wrapping div -- a wrapper div
  // would sit OUTSIDE the flex item .mtg-widget-grid actually sizes/
  // stretches, breaking row-height matching with its siblings; this way
  // .live-reports-cyber-card lands on the real .mtg-widget div itself,
  // same as the 6 Cybersecurity Systems cards above do directly).
  return widget
    .replace('class="mtg-widget"', 'class="mtg-widget live-reports-cyber-card"')
    .replace('<p class="mtg-widget-title">', `${deviceHealthItemCornerToggleHtml(deviceHealthItemKey)}<p class="mtg-widget-title">`);
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

// "Include in PDF" tick boxes, by request -- every section (sits inline
// right next to its own heading, by request) and every Cybersecurity
// Systems/Device Health widget box (small checkbox in its own corner)
// gets one, ticked by default. No visible "Include in PDF" text, by
// request -- just the checkbox, with a tooltip. Pure markup here --
// mount() below tracks the actual on/off state (sectionToggles/
// cyberCardToggles/deviceHealthItemToggles, via one delegated change
// listener on `container` itself) and sends it as `sections`/
// `sections.cyberCards`/`sections.deviceHealthItems` on the /pdf request;
// pdf-template.js treats a missing/undefined key as shown, so an unticked
// box is the only thing that ever hides something.
function sectionToggleHtml(key, label) {
  return `<input type="checkbox" class="live-reports-section-toggle-input" data-section="${key}" title="Untick to leave ${escapeHtml(label)} out of the PDF" checked />`;
}
// Same toggle, but WITH the section's own name shown -- for the 4
// narrative sections below, which have no on-screen heading of their own
// to sit next to (they're PDF-only, written by Generate Summary), so the
// name has to be shown here or nowhere.
function namedSectionToggleHtml(key, label) {
  return `<label class="live-reports-section-toggle" title="Untick to leave ${escapeHtml(label)} out of the PDF"><input type="checkbox" class="live-reports-section-toggle-input" data-section="${key}" checked /> ${escapeHtml(label)}</label>`;
}
// `checked` defaults true (every card starts ticked) -- Email Domain
// Protection passes false when there's no resolvable domain yet, by
// request ("untick this section so that it is excluded from the PDF"),
// since there's nothing real to show in that case.
function cyberCardToggleHtml(key, checked = true) {
  return `<label class="live-reports-card-toggle" title="Untick to leave this card out of the PDF"><input type="checkbox" class="live-reports-card-toggle-input" data-cyber-card="${key}" ${checked ? 'checked' : ''} /></label>`;
}
// Device Health's own sub-items (Asset Management/Monitoring tables, each
// Workstations donut), by request -- a separate tracked bucket/data
// attribute from cyberCardToggleHtml above since these nest under
// sections.deviceHealthItems, not sections.cyberCards, on the server.
function deviceHealthItemToggleHtml(key, label) {
  return `<input type="checkbox" class="live-reports-device-health-item-toggle-input" data-device-health-item="${key}" title="Untick to leave ${escapeHtml(label)} out of the PDF" checked />`;
}
// Corner-positioned variant of the above, for a widget (like each
// Workstations donut) whose own heading lives inside a SHARED component
// (donutWidget(), meeting-prep-report-render.js) this file can't reach
// into without touching a module other pages also use -- same
// .live-reports-cyber-card/.live-reports-card-toggle corner treatment the
// Cybersecurity Systems cards already use, just a different data
// attribute so it's tracked separately.
function deviceHealthItemCornerToggleHtml(key) {
  return `<label class="live-reports-card-toggle" title="Untick to leave this out of the PDF"><input type="checkbox" class="live-reports-device-health-item-toggle-input" data-device-health-item="${key}" checked /></label>`;
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
      <h2 class="client-summary-section-heading">Scorecard ${sectionToggleHtml('scorecard', 'Scorecard')}</h2>
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
    <h2 class="client-summary-section-heading">Asset Management <span class="inline-subtext">${detail.score != null ? `(${detail.score}%)` : ''}</span> ${deviceHealthItemToggleHtml('assetManagement', 'Asset Management')}</h2>
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
    <h2 class="client-summary-section-heading">Monitoring <span class="inline-subtext">(${detail.score}%)</span> ${deviceHealthItemToggleHtml('monitoring', 'Monitoring')}</h2>
    <table class="live-reports-scorecard-table">
      <thead><tr><th>Priority</th><th>Raised</th><th>Resolved</th><th>Unresolved</th><th>Score</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// Raised-in-last-30-days vs currently-Open counts, Critical/High/Moderate,
// by request ("show that widget with Raised in last 30 days and open
// alerts critical, high, moderate on the widget with their counts") --
// replaces the old plain "Open Alerts (Critical/High)" donut. `summary`
// is server.js's own alertSummaryByPriority ([{priority,
// raisedLast30Days, open}], from datto-rmm/lib.js's own
// getSiteAlertsBreakdown()). Wrapped in .mtg-widget itself (donutWidget()
// did the same for the widget it's replacing) so it still sizes/sits
// correctly inside the Overall Health View's own .mtg-widget-grid.
const ALERT_PRIORITY_BADGE_TIER = { Critical: 'bad', High: 'warn', Moderate: 'ok' };
function alertSummaryTableHtml(summary) {
  if (!summary || summary.length === 0) return '';
  const rows = summary
    .map(
      (p) =>
        `<tr><td><span class="mtg-score-badge mtg-score-badge--${ALERT_PRIORITY_BADGE_TIER[p.priority] || 'warn'}">${escapeHtml(p.priority)}</span></td><td>${p.raisedLast30Days}</td><td>${p.open}</td></tr>`
    )
    .join('');
  return `
    <div class="mtg-widget">
      <p class="mtg-widget-title">Alerts (Critical / High / Moderate)</p>
      <table class="live-reports-scorecard-table">
        <thead><tr><th>Priority</th><th>Raised (30d)</th><th>Open</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// A Datto RMM alert message can run to hundreds of characters (real
// example: a disk cleanup alert whose message is mostly a long run of
// "=" separator padding) -- blows the row out sideways instead of
// wrapping sensibly. Cut to a sensible on-screen length with a small
// glasses-icon link to the real full text in a popup
// (openAlertMessageModal() below), by request. Also addresses "line up
// the end with the Alerts box above" -- .live-reports-scorecard-table's
// own base width is `auto` (shrink-wraps to its own content, confirmed
// in styles.css; nothing here forces it to stretch), so the shorter the
// Message column's text, the closer this table's own natural width lands
// to the Alerts summary widget's own (just a tiny 3-column table, so
// it's already about as narrow as a real widget on this page gets).
const ALERT_MESSAGE_TRUNCATE_LEN = 50;

// The open Critical/High/Moderate alerts themselves, by request ("also
// list them") -- lets this be cross-checked directly against Datto RMM's
// own console instead of just trusting the widget's counts. On-screen
// only, not sent to the PDF (server.js's own `openAlerts` field carries
// the same mapAlert() shape datto-rmm/lib.js's getSiteAlertsBreakdown()
// returns) -- the PDF never shows this list at all, so the truncation
// here is purely a screen-rendering concern.
function openAlertsListHtml(alerts) {
  if (!alerts || alerts.length === 0) return '';
  const rows = alerts
    .map((a, i) => {
      const full = a.message || '';
      const isLong = full.length > ALERT_MESSAGE_TRUNCATE_LEN;
      const shown = isLong ? `${full.slice(0, ALERT_MESSAGE_TRUNCATE_LEN)}…` : full;
      return `<tr>
        <td><span class="mtg-score-badge mtg-score-badge--${ALERT_PRIORITY_BADGE_TIER[a.priority] || 'warn'}">${escapeHtml(a.priority)}</span></td>
        <td>${escapeHtml(a.deviceName)}</td>
        <td>${escapeHtml(shown || '—')}${
          isLong
            ? ` <button type="button" class="lr-alert-view-full-btn" data-alert-index="${i}" title="View full message"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="6" cy="14" r="4"/><circle cx="18" cy="14" r="4"/><path d="M10 14h4"/><path d="M2 13c0-3.5 1-7 4-7"/><path d="M22 13c0-3.5-1-7-4-7"/></svg></button>`
            : ''
        }</td>
        <td>${a.timestamp ? new Date(a.timestamp).toLocaleString() : '—'}</td>
      </tr>`;
    })
    .join('');
  return `
    <h2 class="client-summary-section-heading">Open Critical/High/Moderate Alerts <span class="inline-subtext">(${alerts.length})</span></h2>
    <table class="live-reports-scorecard-table">
      <thead><tr><th>Priority</th><th>Device</th><th>Message</th><th>Raised</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// `data-alert-index` above is this SAME alerts array's own index -- cheap
// and safe (just an int in the DOM), rather than trying to carry the
// full message text through an HTML attribute.
function wireOpenAlertsLinks(container, alerts) {
  if (!alerts || alerts.length === 0) return;
  container.querySelectorAll('.lr-alert-view-full-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const alert = alerts[Number(btn.dataset.alertIndex)];
      if (alert) openAlertMessageModal(alert);
    });
  });
}

// Same .history-modal-overlay/.history-modal-panel shell + open/close/
// Escape/click-outside wiring every other popup on this dashboard uses
// (openInfoModal() in contract-checks/client.js is the direct model).
function openAlertMessageModal(alert) {
  const overlay = document.createElement('div');
  overlay.className = 'history-modal-overlay';
  overlay.innerHTML = `
    <div class="history-modal-panel wsp-qa-modal-panel lr-alert-message-modal-panel">
      <div class="history-modal-panel-header">
        <span>${escapeHtml(alert.deviceName)} -- ${escapeHtml(alert.priority)} Alert</span>
        <button type="button" class="history-modal-close" aria-label="Close">✕</button>
      </div>
      <div class="history-modal-body">
        <p class="inline-subtext">${alert.timestamp ? new Date(alert.timestamp).toLocaleString() : '—'}</p>
        <p class="lr-alert-full-message">${escapeHtml(alert.message || '—')}</p>
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
}

// Proactive Maintenance, by request -- same list the PDF now shows (top of
// its own Devices page), server.js's own getProactiveMaintenanceItems()
// (live off the intranet's own Proactive Maintenance Jobs table, same as
// the Cybersecurity Systems descriptions -- see sharepoint-client.js),
// sourced once on the server rather than duplicated here, so the two
// surfaces can't drift apart. Now sits INSIDE the Device Health section
// box, last (after the Replacement Recommendation/Operating System
// donuts), by request -- it used to be its own separate top-level section
// further down the page. Styled as the same purple card the PDF's own
// drawProactiveMaintenanceNote() draws (2 columns, dash-bulleted, italic
// caption) -- literal brand-purple hex values, not the --purple/--card
// theme tokens, by design: this is the dashboard's one fixed brand-colour
// card treatment (same as the PDF, which is always on a white page), not
// something that should shift with light/dark mode. Being a plain inline
// card (not its own .lr-section-box) is exactly what lets it nest inside
// Device Health's own box without a double border.
function proactiveMaintenanceHtml(items) {
  if (!items || items.length === 0) return '';
  const half = Math.ceil(items.length / 2);
  const col = (colItems) => `<ul class="live-reports-proactive-maintenance-list">${colItems.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
  return `
    <div class="live-reports-proactive-maintenance-box">
      <p class="live-reports-proactive-maintenance-heading">Proactive Maintenance ${sectionToggleHtml('proactiveMaintenance', 'Proactive Maintenance')}</p>
      <p class="live-reports-source-note">Source: live from the intranet's "Proactive Maintenance Jobs" table (falls back to a fixed built-in list if that table can't be reached). On screen only.</p>
      <div class="live-reports-proactive-maintenance-cols">${col(items.slice(0, half))}${col(items.slice(half))}</div>
      <p class="live-reports-proactive-maintenance-caption">Standard activities performed across all managed devices -- not scored.</p>
    </div>`;
}

// Understanding Your Scores / Cybersecurity Module Descriptions -- on
// screen now too, by request (both were PDF-only before: pdf-template.js's
// own drawScoreExplanations()/drawCybersecurityExplanations()). Fetched
// once per page load via loadReportExplanations() below (server.js's new
// GET /report-explanations, not siteName-scoped -- this reference text is
// the same regardless of which client's report is currently showing) and
// cached module-scope, same "survives a re-search, no need to re-fetch"
// reasoning every other module-scope cache on this page already follows.
// Sits at the very bottom of the page, after everything else, by request.
let reportExplanationsCache = null; // { scoreExplanations, cyberModules } | null (fetch failed)
let reportExplanationsPromise = null;

async function loadReportExplanations() {
  if (reportExplanationsCache) return reportExplanationsCache;
  if (!reportExplanationsPromise) {
    reportExplanationsPromise = fetch('/api/live-reports/report-explanations')
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        reportExplanationsCache = data;
        return data;
      })
      .catch((err) => {
        console.error('Live Reports: report-explanations load failed:', err);
        return null;
      })
      .finally(() => {
        reportExplanationsPromise = null;
      });
  }
  return reportExplanationsPromise;
}

// Shared boxed title+body list, same purple-card look as the PDF's own
// drawExplanationsBox() (pdf-template.js) -- see .live-reports-
// explanations-box (styles.css) for why these are literal brand-purple
// hex values, not theme tokens.
function explanationsBoxHtml(items) {
  if (!items || items.length === 0) return '';
  return `<div class="live-reports-explanations-box">${items
    .map((item) => `<p class="live-reports-explanations-title">${escapeHtml(item.title)}</p><p class="live-reports-explanations-body">${escapeHtml(item.body)}</p>`)
    .join('')}</div>`;
}

// Order matches how the user asked for these two ("Understanding your
// scores and Cybersecurity Module Descriptions"), same order the PDF
// itself draws them in.
function reportExplanationsHtml(data) {
  if (!data) return '';
  return `
    <h2 class="client-summary-section-heading">Understanding Your Scores</h2>
    <p class="live-reports-source-note">Source: fixed methodology notes maintained in this report's own template -- not derived from this client's live data. On screen only.</p>
    ${explanationsBoxHtml(data.scoreExplanations)}
    <h2 class="client-summary-section-heading">Cybersecurity Module Descriptions</h2>
    <p class="live-reports-source-note">Source: live from the intranet's "Cybersecurity Services for Managed Service Clients" table (falls back to a fixed built-in list if that table can't be reached). On screen only.</p>
    ${explanationsBoxHtml(data.cyberModules)}
  `;
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
  const plainHeading = `<h2 class="client-summary-section-heading">Microsoft License Counts ${sectionToggleHtml('m365Licenses', 'Microsoft License Counts')}</h2>`;
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
  const heading = `<h2 class="client-summary-section-heading">Microsoft License Counts <span class="inline-subtext">(from contract)</span> ${sectionToggleHtml('m365Licenses', 'Microsoft License Counts')}</h2>`;
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
    // Critical-severity event names shown bold (red removed, by later
    // request) -- same "severity carried through, not lost once merged by
    // name" data server.js's own buildSaasAlertsSummary() now returns.
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
      <div class="mtg-widget live-reports-cyber-card">
        ${cyberCardToggleHtml('saasAlerts')}
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
      <div class="mtg-widget live-reports-cyber-card">
        ${cyberCardToggleHtml('saasProtection')}
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

  // Inky (email security) -- messagesProcessed/cautionCount/dangerCount are
  // INKY's own last-30-days statistics totals (server.js's own
  // buildInkySummary(): neutral/caution/danger daily counts, summed), same
  // "Last 30 Days" window every other date-ranged card in this section
  // already uses. Top Threat Reasons mirrors SaaS Alerts' own tiles-then-
  // list layout (.live-reports-inky-layout/-kpis/-reasons, styles.css), by
  // request.
  if (vendors.inky.status === 'ok' && vendors.inky.installed) {
    const ik = vendors.inky;
    const reasonsListHtml =
      ik.topReasons.length > 0
        ? `<ul class="live-reports-inky-reasons">${ik.topReasons.map((r) => `<li>${escapeHtml(r.label)} <span class="muted">(${r.count})</span></li>`).join('')}</ul>`
        : '<p class="inline-subtext">No threats flagged in this window.</p>';
    widgets.push(`
      <div class="mtg-widget live-reports-cyber-card">
        ${cyberCardToggleHtml('inky')}
        <p class="mtg-widget-title">Email Security <span class="muted">(30 days)</span></p>
        <div class="live-reports-inky-layout">
          <div class="live-reports-inky-top-kpis">
            ${kpiTileRow([
              { label: 'Protected Mailboxes', value: ik.protectedMailboxCount ?? '--', tier: 'good' },
              { label: 'Messages Processed', value: ik.messagesProcessed },
            ])}
          </div>
          <div class="live-reports-inky-bottom-row">
            <div class="live-reports-inky-severity-kpis">
              ${kpiTileRow([
                { label: 'Caution', value: ik.cautionCount, tier: ik.cautionCount > 0 ? 'warn' : 'good' },
                { label: 'Danger', value: ik.dangerCount, tier: ik.dangerCount > 0 ? 'bad' : 'good' },
              ])}
            </div>
            ${reasonsListHtml}
          </div>
        </div>
      </div>`);
  } else if (vendors.inky.status === 'error') {
    // By request: unlike every other vendor card here (which just vanishes
    // on a catchVendorError() failure, same as "not installed"), Inky's own
    // card STAYS, with a plain-English note instead of the real figures --
    // nothing here claims to know WHY it failed (could be anything from a
    // network blip to INKY's own API genuinely changing shape), so the
    // wording stays deliberately generic/reassuring rather than echoing the
    // real underlying error.message, which would be too technical to put
    // in front of a client reading this report.
    widgets.push(`
      <div class="mtg-widget live-reports-cyber-card">
        ${cyberCardToggleHtml('inky')}
        <p class="mtg-widget-title">Email Security <span class="muted">(30 days)</span></p>
        <p class="status warn">Email security platform is currently updating how it connects to this report, so live threat data couldn't be pulled in this time. This usually resolves on its own -- no action needed, and the figures will be back next time this report runs.</p>
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
      <div class="mtg-widget live-reports-cyber-card">
        ${cyberCardToggleHtml('dattoEdr')}
        <p class="mtg-widget-title">Endpoint Detection and Response (EDR)</p>
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
      <div class="mtg-widget live-reports-cyber-card">
        ${cyberCardToggleHtml('huntress')}
        <p class="mtg-widget-title">Huntress Threat Watch</p>
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
      // No "No elevation requests" placeholder for the empty case, by
      // request -- the donut/legend already show 0 for every category, so
      // the caption was just repeating what's obvious from the zero.
      const topAppsHtml = el.topApps.length > 0 ? `<ul class="live-reports-saas-alerts-events">${el.topApps.map((a) => `<li>${escapeHtml(a.name)} <span class="muted">(${a.count})</span></li>`).join('')}</ul>` : '';
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
      <div class="mtg-widget live-reports-cyber-card live-reports-autoelevate-card">
        ${cyberCardToggleHtml('autoElevate')}
        <p class="mtg-widget-title">AutoElevate${el ? ` <span class="muted">(${el.windowDays} days)</span>` : ''}</p>
        ${body}
      </div>`);
  }

  return widgets.join('');
}

// Email Domain Protection -- live DNS checks (DMARC/SPF/DKIM), by
// request. A brand new, separate card from Mail Domain Protection
// Monitoring (the manual-entry one, mdpCardHtml() below).
//
// IT Glue's own Domains feature turned out to be READ-ONLY via their
// public API (confirmed live -- GET works, every write shape tried
// 404s), so there's no "Save to IT Glue" button here any more. Instead,
// by request ("Allow the user of Live Reports to choose or enter a
// domain and prompt them to fix IT Glue"): when IT Glue has no
// resolvable primary domain, the admin can pick one of the client's
// existing IT Glue domains or type a brand new one, which runs the real
// DNS checks for THIS report only -- the 'needs-domain' card itself (not
// the resolved 'ok' card, by request) carries the small red reminder to
// go fix it for real in IT Glue, next to its own "Use this domain"
// button.
//
// The "include in PDF" checkbox starts UNTICKED whenever there's no
// resolved domain yet, by request ("untick this section so that it is
// excluded from the PDF") -- there's nothing real to show in that case,
// unlike every other card here which defaults ticked.
// Shared select/input pair, by request ("allow untick/tick to re-choose
// or enter primary domain even if the correct domain was selected
// automatically") -- used both by the 'ok' card's own hidden picker
// (revealed by unticking the include-in-PDF checkbox, see
// renderEmailDomainProtection() below) and the unresolved states' own
// always-visible one. `selectedDomain` pre-selects the dropdown's current
// match (the 'ok' case only -- there's nothing to pre-select when
// nothing's resolved yet).
function edpPickerFieldsHtml(domains, selectedDomain) {
  return `
    ${
      domains.length > 0
        ? `<label for="edp-domain-select">Use an existing IT Glue domain</label>
           <select id="edp-domain-select">
             <option value="">-- choose a domain --</option>
             ${domains.map((d) => `<option value="${escapeHtml(d.name)}" ${d.name === selectedDomain ? 'selected' : ''}>${escapeHtml(d.name)}</option>`).join('')}
           </select>`
        : ''
    }
    <label for="edp-new-domain">Or use this domain instead</label>
    <input type="text" id="edp-new-domain" placeholder="example.com.au" />
  `;
}

function emailDomainProtectionCardHtml(state) {
  if (state.status === 'loading') {
    return `
      <div class="mtg-widget live-reports-cyber-card" id="edp-card">
        ${cyberCardToggleHtml('emailDomainProtection', false)}
        <p class="mtg-widget-title">Mail Domain Protection DNS Check</p>
        <p class="inline-subtext live-reports-loading-text">Loading...</p>
      </div>`;
  }
  if (state.status === 'ok') {
    // Tagged with whichever provider's own record was actually found
    // (Microsoft/Google), by request -- email-domain-protection.js's own
    // checkSpf()/checkDkim() set `provider`; neither found (or not
    // present at all) leaves the row untagged.
    const providerTag = (provider) => (provider === 'microsoft' ? ' (Microsoft)' : provider === 'google' ? ' (Google)' : '');
    const rows = [
      {
        label: 'DMARC',
        present: state.dmarc.exists,
        status: !state.dmarc.exists
          ? null
          : state.dmarc.policy === 'reject'
            ? { text: 'Reject bad emails', cls: 'good' }
            : state.dmarc.policy === 'quarantine'
              ? { text: 'Quarantine bad emails', cls: 'warn' }
              : { text: 'Exists', cls: 'muted' },
      },
      { label: `SPF${providerTag(state.spf.provider)}`, present: state.spf.exists, status: null },
      { label: `DKIM${providerTag(state.dkim.provider)}`, present: state.dkim.exists, status: null },
    ];
    const rowsHtml = rows
      .map(
        (r) => `
      <div class="live-reports-edp-row">
        ${checkIconSvg(r.present ? 'pass' : 'fail')}
        <span class="live-reports-edp-row-label">${escapeHtml(r.label)}</span>
        ${r.status ? `<span class="live-reports-edp-row-status live-reports-edp-row-status--${r.status.cls}">${escapeHtml(r.status.text)}</span>` : ''}
      </div>`
      )
      .join('');
    // No "fix IT Glue" reminder here any more, by request -- that
    // instruction now lives only on the 'needs-domain' card itself (next
    // to its own Use this domain button, below), not repeated again here
    // once a domain's actually resolved. The picker itself DOES still live
    // here though, just hidden -- untick the "include in PDF" box to
    // reveal it (renderEmailDomainProtection() below wires that), by
    // request, so a correctly auto-resolved domain can still be
    // overridden for this report.
    return `
      <div class="mtg-widget live-reports-cyber-card" id="edp-card">
        ${cyberCardToggleHtml('emailDomainProtection')}
        <p class="mtg-widget-title">Mail Domain Protection DNS Check</p>
        <p class="live-reports-edp-domain">Domain: ${escapeHtml(state.domain)}</p>
        <div class="live-reports-edp-rows">${rowsHtml}</div>
        <div class="live-reports-edp-picker" id="edp-picker" hidden>
          <p class="live-reports-edp-reason">Pick a different domain for this report:</p>
          ${edpPickerFieldsHtml(state.domains || [], state.domain)}
          <div class="live-reports-edp-action-row">
            <button type="button" id="edp-save-button" class="button-link button-link--small">Use this domain</button>
          </div>
          <p class="status error" id="edp-error" hidden></p>
        </div>
      </div>`;
  }
  // 'needs-domain' / 'org-not-found' / 'org-ambiguous' / 'error' -- no
  // resolvable domain from IT Glue, for whatever reason. The manual
  // picker/entry shows regardless of WHY (even an unresolved organization
  // doesn't stop the admin typing a domain by hand), by request.
  const domains = state.domains || [];
  // Short, by request ("Change this ... to be small text and just 'No
  // primary domain found in IT Glue'") -- the other 3 reasons keep their
  // own instruction sentence (there's genuinely more to explain there:
  // WHY there's no org match at all), just needs-domain is trimmed down.
  const reason =
    state.status === 'org-not-found'
      ? "Could not find this client's organization in IT Glue. Pick one below, or type one, to check it for this report."
      : state.status === 'org-ambiguous'
        ? "More than one IT Glue organization matches this client's name. Pick one below, or type one, to check it for this report."
        : state.status === 'needs-domain'
          ? 'No primary domain found in IT Glue'
          : 'Could not load Mail Domain Protection. Pick one below, or type one, to check it for this report.';
  return `
    <div class="mtg-widget live-reports-cyber-card" id="edp-card">
      ${cyberCardToggleHtml('emailDomainProtection', false)}
      <p class="mtg-widget-title">Mail Domain Protection DNS Check</p>
      <p class="live-reports-edp-reason">${escapeHtml(reason)}</p>
      ${edpPickerFieldsHtml(domains, null)}
      <div class="live-reports-edp-action-row">
        <button type="button" id="edp-save-button" class="button-link button-link--small">Use this domain</button>
        ${state.status === 'needs-domain' ? `<p class="live-reports-edp-fix-note">Please update IT Glue Domain Tracker</p>` : ''}
      </div>
      ${
        state.status === 'needs-domain'
          ? `<p class="live-reports-edp-fix-note live-reports-edp-fix-note--full">Add the domain or type "Primary." at the beginning of the Notes field</p>`
          : ''
      }
      <p class="status error" id="edp-error" hidden></p>
    </div>`;
}

function vendorSummariesHtml(vendors, mdpState, isTcElite) {
  if (!vendors) return '';
  // "Cybersecurity Systems" heading restored, by request (removed earlier
  // this session, now wanted back) -- same name as the PDF's own section
  // (pdf-template.js's drawCybersecurityLayers(), renamed from
  // "Cybersecurity Layers" at the same time) so the two surfaces read as
  // the same section. Mail Domain Protection (the live DNS one, its own
  // placeholder slot filled in once loadEmailDomainProtection() below has
  // run) and Mail Domain Protection Monitoring (the manual-entry one,
  // mdpCardHtml() below) sit together inside their own light-red
  // surrounding box, on screen only, by request -- both commonly need
  // manual attention (an unresolved IT Glue domain; the EasyDMARC values
  // themselves), so the shared box is a visual flag for that, not a PDF
  // concept (pdf-template.js's own drawCybersecurityLayers() just packs
  // them as 2 plain cards like everything else there).
  // id/class repeated here (not just on the loading placeholder in the main
  // template) because loadVendorSummaries() below replaces that placeholder
  // WHOLESALE (vendorEl.outerHTML = ...), so this returned string is the
  // only thing that actually ends up in the DOM once real data loads --
  // without its own id="vendor-summaries" class="lr-section-box" here, the
  // border box (and the ability to find this element again) would vanish
  // the moment this replaces the loading placeholder.
  return `<div class="lr-section-box" id="vendor-summaries"><h2 class="client-summary-section-heading">Cybersecurity Systems ${sectionToggleHtml('cybersecurity', 'Cybersecurity Systems')}</h2><div class="mtg-widget-grid live-reports-other-systems">${vendorWidgetsHtml(vendors)}<div class="live-reports-domain-protection-alert"><div id="edp-card-slot">${emailDomainProtectionCardHtml({ status: 'loading' })}</div>${mdpCardHtml(mdpState, isTcElite)}</div></div></div>`;
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

      <label class="live-reports-commentary-label" for="commentary-exec-summary">Executive Summary ${sectionToggleHtml('executiveSummary', 'Executive Summary')}</label>
      <textarea id="commentary-exec-summary" class="live-reports-commentary-field live-reports-commentary-textarea" rows="4">${escapeHtml(commentary.executiveSummary || '')}</textarea>

      <div class="live-reports-commentary-cols">
        <div>
          <label class="live-reports-commentary-label live-reports-commentary-label--on-track" for="commentary-on-track">On Track <span class="inline-subtext">(one per line)</span> ${sectionToggleHtml('onTrackActionWatch', 'On Track / Action Needed / Watch')}</label>
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

      <label class="live-reports-commentary-label">Our Recommendations ${sectionToggleHtml('recommendations', 'Our Recommendations')}</label>
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

// Mail Domain Protection -- same look as EasyDMARC's own per-domain
// dashboard (score + DMARC/SPF/DKIM status + enforcement policy), by
// request, but there's no EasyDMARC API connected to this dashboard yet.
// These values are looked up manually in EasyDMARC for whichever client
// is loaded and typed in here -- never fabricated -- and Create PDF sends
// exactly what's currently set here through to the PDF (mdpState, tracked
// live by mount()'s own wireMdpWidget() below, the same way
// currentReportData/currentVendorsData are tracked). Reset to
// mdpDefaults() on every new client search (load() below), same reasoning
// resetCommentaryEditor() already has -- a previous client's
// manually-entered numbers must never silently end up in a different
// client's PDF. Card joins the SAME Cybersecurity Systems grid as the
// vendor widgets now, by request ("put it in the Cybersecurity section" /
// "size more like the other Cybersecurity items") -- see
// vendorSummariesHtml() below, which appends mdpCardHtml() into the same
// .mtg-widget-grid.
//
// Score and the 3 dot levels are picked by hand, by request ("I want to
// choose the X of 10, light green, medium green, dark green dots ...
// these aren't related to the Pass Rates") -- NOT derived from
// spfPassRate/dkimPassRate/dmarcPolicy any more. Those 2 rate numbers and
// the policy stay in the form purely as their own separate display fields
// (EasyDMARC data worth showing), with zero effect on score/dots. Same 3
// named levels/colours as pdf-template.js's own MDP_LEVELS -- kept in sync
// by hand (small enough, and one's browser JS/the other's Node, so
// there's no single module both could import from without a bigger
// refactor than this feature needs).
const MDP_LEVELS = {
  light: { label: 'Light Green', dots: 1, color: '#86efac' },
  medium: { label: 'Medium Green', dots: 2, color: '#4ade80' },
  dark: { label: 'Dark Green', dots: 3, color: '#16a34a' },
};
// Defaults are 10/10, Dark Green across the board, 100% -- "best case", by
// request -- rather than a lower starting point that would otherwise read
// as a real finding before anyone's actually looked anything up.
function mdpDefaults() {
  return { score: 10, dmarcPolicy: 'reject', dmarcLevel: 'dark', spfLevel: 'dark', dkimLevel: 'dark', spfPassRate: 100, dkimPassRate: 100 };
}
function mdpScoreTier(score) {
  if (score >= 8) return 'good';
  if (score >= 5) return 'warn';
  return 'bad';
}
// Each dot has its OWN fixed shade at its position (1st = light, 2nd =
// medium, 3rd = dark) when lit, regardless of which level is picked --
// only how many are lit changes, same "signal strength" shorthand the
// pdf-template.js side draws.
function mdpDotsHtml(levelKey) {
  const level = MDP_LEVELS[levelKey] || MDP_LEVELS.dark;
  const shades = [MDP_LEVELS.light.color, MDP_LEVELS.medium.color, MDP_LEVELS.dark.color];
  return Array.from({ length: 3 }, (_, i) => `<span class="mdp-dot" style="background:${i < level.dots ? shades[i] : '#e5e7eb'}"></span>`).join('');
}
function mdpLevelSelectHtml(id, selected) {
  return `<select id="${id}" class="live-reports-mdp-level-select live-reports-mdp-edit-only" disabled>
    ${Object.entries(MDP_LEVELS)
      .map(([key, l]) => `<option value="${key}" ${selected === key ? 'selected' : ''}>${l.label}</option>`)
      .join('')}
  </select>`;
}

// DMARC Policy as a pill-styled <select> (reuses .mtg-score-badge--good/
// warn/bad's own tint, same as the score badge above), by request ("put
// the Dmarc policy in a pill next to the Dmarc row") -- no longer its own
// line underneath the card.
const MDP_POLICY_TIERS = { reject: 'good', quarantine: 'warn', none: 'bad' };
function mdpPolicySelectHtml(selected) {
  return `<select id="mdp-dmarc-policy" class="live-reports-mdp-policy-select mtg-score-badge--${MDP_POLICY_TIERS[selected] || 'bad'}" disabled>
    <option value="none" ${selected === 'none' ? 'selected' : ''}>None</option>
    <option value="quarantine" ${selected === 'quarantine' ? 'selected' : ''}>Quarantine</option>
    <option value="reject" ${selected === 'reject' ? 'selected' : ''}>Reject</option>
  </select>`;
}
// 2 segments (score-coloured + a light grey remainder) so donutSvg() draws
// a ring filled score/10 -- centerLabel passed as '' since the number sits
// in its own overlay <input> instead (see mdpCardHtml() below), not
// donutSvg()'s own plain SVG <text>, so it stays editable.
function mdpScoreSegments(score) {
  const color = mdpScoreTier(score) === 'good' ? '#16a34a' : mdpScoreTier(score) === 'warn' ? '#f59e0b' : '#dc2626';
  return [
    { label: 'Score', value: score, color },
    { label: 'Remaining', value: Math.max(0, 10 - score), color: '#e5e7eb' },
  ];
}

// Card-sized like the other Cybersecurity Systems widgets (.mtg-widget),
// by request -- same ring widget AutoElevate's own card uses (donutSvg(),
// same size/geometry) on the left, DMARC/SPF/DKIM as 3 rows (dots right
// next to the name, by request), vertically centred next to the ring, by
// request. A cog in the corner (not "Manual Entry Required" text, by
// request) flags that there's no EasyDMARC API connected yet -- these
// values are typed in by hand; see pdf-template.js's own drawMdpCard() for
// why the PDF itself shows no such flag at all.
// Every editable control here starts `disabled`, by request ("enable the
// edit capability of Mail Domain Protection Monitoring only after the cog
// is clicked") -- clicking the cog (wireMdpWidget() below) is what enables
// them, guarding against an accidental edit while just reading the card.
// The DMARC/SPF/DKIM level dropdowns and the SPF/DKIM rate inputs
// (.live-reports-mdp-edit-only, CSS-hidden by default) go further and
// stay HIDDEN until then too, by request ("hidden, not just disabled" --
// a disabled <select>/<input> still rendered as a grey box, redundant
// with the dots already showing the same level). The score input and the
// DMARC policy pill stay visible either way -- they're each the only
// place their own value is shown at all (the ring's own centerLabel is
// deliberately blank; the policy pill already reads as a plain colored
// label, not a boxy control), so hiding them would hide real information,
// not just an edit affordance.
// `isTcElite` (server.js's own resolveCyberServiceTierColumn() result on
// the main report) defaults this card's own "include in PDF" tick to
// UNTICKED for anyone who isn't TC Elite, by request -- every other card
// here still starts ticked regardless of tier.
function mdpCardHtml(state, isTcElite) {
  return `
    <div class="mtg-widget live-reports-mdp-widget live-reports-cyber-card" id="mdp-widget">
      ${cyberCardToggleHtml('mailDomainProtection', isTcElite)}
      <button type="button" id="mdp-cog" class="live-reports-mdp-cog" title="Manual entry -- EasyDMARC isn't connected yet, these values are looked up and typed in by hand. Click to edit.">⚙</button>
      <p class="mtg-widget-title">Mail Domain Protection Monitoring</p>
      <div class="live-reports-mdp-body">
        <div class="live-reports-mdp-score-wrap">
          <span id="mdp-score-svg">${donutSvg(mdpScoreSegments(state.score), '')}</span>
          <input type="number" id="mdp-score" class="live-reports-mdp-score-overlay" min="0" max="10" step="1" value="${state.score}" disabled />
        </div>
        <div class="live-reports-mdp-rows">
          <div class="live-reports-mdp-row">
            <span id="mdp-dmarc-dots" class="live-reports-mdp-dots">${mdpDotsHtml(state.dmarcLevel)}</span>
            <span class="live-reports-mdp-row-name">DMARC</span>
            ${mdpLevelSelectHtml('mdp-dmarc-level', state.dmarcLevel)}
            ${mdpPolicySelectHtml(state.dmarcPolicy)}
          </div>
          <div class="live-reports-mdp-row">
            <span id="mdp-spf-dots" class="live-reports-mdp-dots">${mdpDotsHtml(state.spfLevel)}</span>
            <span class="live-reports-mdp-row-name">SPF</span>
            ${mdpLevelSelectHtml('mdp-spf-level', state.spfLevel)}
            <span class="live-reports-mdp-edit-only"><input type="number" id="mdp-spf-rate" class="live-reports-mdp-rate-input" min="0" max="100" step="0.01" value="${state.spfPassRate}" disabled />%</span>
          </div>
          <div class="live-reports-mdp-row">
            <span id="mdp-dkim-dots" class="live-reports-mdp-dots">${mdpDotsHtml(state.dkimLevel)}</span>
            <span class="live-reports-mdp-row-name">DKIM</span>
            ${mdpLevelSelectHtml('mdp-dkim-level', state.dkimLevel)}
            <span class="live-reports-mdp-edit-only"><input type="number" id="mdp-dkim-rate" class="live-reports-mdp-rate-input" min="0" max="100" step="0.01" value="${state.dkimPassRate}" disabled />%</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

// Reads whatever's CURRENTLY in the form (not a copy kept in sync on every
// keystroke), same "the DOM is the one source of truth" convention
// readCommentaryFromEditor() above already follows. Takes the #mdp-widget
// element itself (not a container to query into) -- mount()'s own
// wireMdpWidget() below is the only caller, and it always has the widget
// element in hand already (outerHTML replaces during a vendor-data
// refresh mean the ORIGINAL container reference goes stale, so re-querying
// from resultsEl there each time is what actually stays correct).
function readMdpStateFromWidget(widget) {
  if (!widget) return mdpDefaults();
  const score = Math.max(0, Math.min(10, Math.round(Number(widget.querySelector('#mdp-score').value) || 0)));
  return {
    score,
    dmarcPolicy: widget.querySelector('#mdp-dmarc-policy').value,
    dmarcLevel: widget.querySelector('#mdp-dmarc-level').value,
    spfLevel: widget.querySelector('#mdp-spf-level').value,
    dkimLevel: widget.querySelector('#mdp-dkim-level').value,
    spfPassRate: Number(widget.querySelector('#mdp-spf-rate').value) || 0,
    dkimPassRate: Number(widget.querySelector('#mdp-dkim-rate').value) || 0,
  };
}

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>Live Reports</h1>
    </header>
    <form id="search-form" class="date-form">
      <div class="date-form-row">
        <label for="site-input">Autotask Client</label>
        <input type="text" id="site-input" placeholder="e.g. Acme* (wildcards with *, optional)" />
        <label class="inline-checkbox-label" title="Force an exact match on the Autotask Client name (instead of the usual wildcard/contains search)">
          <input type="checkbox" id="exact-site-input" /> Exact
        </label>
        <button type="submit" id="search-button" class="button-link button-link--small refresh-button--emphasis" title="Pull a report for this client (uses the 20-minute cache if still warm)">Search</button>
        <button type="button" id="refresh-button" class="button-link button-link--small" title="Re-fetch live Datto RMM data (bypasses the 20-minute cache) -- use this when you need the absolute latest, not what was cached up to 20 minutes ago">Refresh</button>
        <button type="button" id="generate-commentary-button" class="button-link button-link--small" disabled title="Loads with the report above">Generate Summary</button>
        <button type="button" id="pdf-button" class="button-link button-link--small" disabled title="Loads with the report above">Create PDF</button>
      </div>
    </form>
    <p id="status" class="status">Type an Autotask Client name above to pull a live report.</p>
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
  // The real Autotask company resolved by resolveClientAndLoad() below --
  // load()/the Refresh button both key off resolvedDattoSite (never read
  // siteInput.value directly any more), so Refresh re-fetches live data
  // for the SAME already-resolved client rather than re-running the
  // Autotask lookup. resolvedCompanyId is threaded into the main report
  // and /vendors fetches below so a real id/UDF match is tried before a
  // plain name match throughout the rest of the report, by request
  // ("ensure a UDF match is used before a direct name match").
  let resolvedCompanyName = null;
  let resolvedCompanyId = null;
  let resolvedDattoSite = null;
  // Mail Domain Protection's own tracked state -- kept in sync on every
  // keystroke/select by wireMdpWidget() below, rather than read fresh from
  // the DOM at Create PDF time, because its card lives inside the
  // Cybersecurity Systems grid, which loadVendorSummaries() below replaces
  // wholesale (vendorEl.outerHTML = ...) once vendor data loads -- this is
  // what survives that replace instead of needing to re-derive "what was
  // on screen" from a DOM node that may already be gone.
  let mdpState = mdpDefaults();

  // "Include in PDF" tick boxes -- every key defaults true (ticked), only
  // ever flipped false by an explicit untick (see the delegated listener
  // below). Delegated on `container` itself (not resultsEl/vendorEl,
  // which get destroyed and rebuilt by render()/loadVendorSummaries()) so
  // it keeps working across every re-render without needing to be rewired
  // -- the SAME reason mdpState above is tracked in a variable rather than
  // read from the DOM at Create PDF time, just via delegation instead of
  // per-field listeners since there are a couple dozen of these checkboxes
  // scattered across the page.
  let sectionToggles = {};
  let cyberCardToggles = {};
  let deviceHealthItemToggles = {};
  // Email Domain Protection's own resolved domain -- whatever's currently
  // shown on screen (IT Glue's own automatic match, or an admin's manual
  // pick/typed domain for this report), kept in sync by
  // renderEmailDomainProtection() below. Sent through on Create PDF so
  // the PDF's own fresh DNS re-check runs against the SAME domain that's
  // on screen, not an independent IT Glue re-resolution that could land
  // on "unresolved" again if IT Glue itself was never actually fixed.
  let edpDomain = null;
  container.addEventListener('change', (e) => {
    const sectionInput = e.target.closest('.live-reports-section-toggle-input');
    if (sectionInput) {
      sectionToggles[sectionInput.dataset.section] = sectionInput.checked;
      return;
    }
    const cardInput = e.target.closest('.live-reports-card-toggle-input');
    if (cardInput) {
      cyberCardToggles[cardInput.dataset.cyberCard] = cardInput.checked;
      return;
    }
    const itemInput = e.target.closest('.live-reports-device-health-item-toggle-input');
    if (itemInput) deviceHealthItemToggles[itemInput.dataset.deviceHealthItem] = itemInput.checked;
  });

  // Re-reads the #mdp-widget inside resultsEl (NOT a stale element
  // reference -- loadVendorSummaries() below replaces it via outerHTML,
  // which detaches any previously queried node) and wires its inputs to
  // keep mdpState in sync, patching just the derived bits (score badge
  // tint, dots) in place rather than a full re-render that would blow away
  // focus/cursor position in whichever field is being edited.
  function wireMdpWidget() {
    const widget = resultsEl.querySelector('#mdp-widget');
    if (!widget) return;
    const editableFields = ['#mdp-score', '#mdp-dmarc-policy', '#mdp-dmarc-level', '#mdp-spf-level', '#mdp-dkim-level', '#mdp-spf-rate', '#mdp-dkim-rate'];
    // Locked until the cog's clicked, by request -- mdpCardHtml() above
    // renders every one of these `disabled`; this is the only thing that
    // turns editing on, one-way for as long as this card stays rendered
    // (a fresh Search re-renders it locked again).
    widget.querySelector('#mdp-cog').addEventListener('click', () => {
      editableFields.forEach((sel) => {
        widget.querySelector(sel).disabled = false;
      });
      // Reveals .live-reports-mdp-edit-only (the level dropdowns + rate
      // inputs, CSS-hidden by default), by request.
      widget.classList.add('live-reports-mdp-unlocked');
    });
    const onChange = () => {
      mdpState = readMdpStateFromWidget(widget);
      // Only the SVG inside #mdp-score-svg is replaced -- never the
      // sibling <input> itself, which is what keeps focus/cursor position
      // intact while actively typing a score.
      widget.querySelector('#mdp-score-svg').innerHTML = donutSvg(mdpScoreSegments(mdpState.score), '');
      widget.querySelector('#mdp-dmarc-dots').innerHTML = mdpDotsHtml(mdpState.dmarcLevel);
      widget.querySelector('#mdp-spf-dots').innerHTML = mdpDotsHtml(mdpState.spfLevel);
      widget.querySelector('#mdp-dkim-dots').innerHTML = mdpDotsHtml(mdpState.dkimLevel);
      widget.querySelector('#mdp-dmarc-policy').className = `live-reports-mdp-policy-select mtg-score-badge--${MDP_POLICY_TIERS[mdpState.dmarcPolicy] || 'bad'}`;
    };
    editableFields.forEach((sel) => {
      const el = widget.querySelector(sel);
      el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', onChange);
    });
  }

  // Email Domain Protection -- fills #edp-card-slot (created by
  // vendorSummariesHtml() above) once the real IT Glue + DNS status is
  // known. Its own fetch, separate from /vendors above -- the slot
  // genuinely doesn't exist until AFTER that vendors HTML lands, so this
  // can't start any earlier anyway, unlike the independent-for-speed
  // split that reasoning above describes for Other Systems/M365 itself.
  async function loadEmailDomainProtection(siteName) {
    const slot = resultsEl.querySelector('#edp-card-slot');
    if (!slot) return;
    let state;
    try {
      const res = await fetch(`/api/live-reports/email-domain-protection?siteName=${encodeURIComponent(siteName)}`, { cache: 'no-store' });
      state = await res.json();
      if (!res.ok) throw new Error(state.error || `Request failed (${res.status})`);
    } catch (err) {
      console.error('Live Reports: Email Domain Protection load failed:', err);
      state = { status: 'error' };
    }
    if (slot.isConnected) renderEmailDomainProtection(slot, siteName, state);
  }

  // Renders the card for whatever state was just fetched/checked, and
  // keeps 2 bits of TRACKED state in sync with it (not just the DOM,
  // which the admin may never interact with by hand): cyberCardToggles.
  // emailDomainProtection (Create PDF's own "include in PDF" source of
  // truth -- see this file's own sectionToggles/cyberCardToggles comment)
  // and edpDomain (the domain name Create PDF sends through for the PDF's
  // own fresh re-check -- see createPdf() below). Wires the picker's own
  // "Use this domain" button always now, by request ("allow untick/tick
  // to re-choose or enter primary domain even if the correct domain was
  // selected automatically") -- the 'ok' card has one too now, just
  // hidden inside #edp-picker until the checkbox below reveals it.
  function renderEmailDomainProtection(slot, siteName, state) {
    slot.innerHTML = emailDomainProtectionCardHtml(state);
    cyberCardToggles.emailDomainProtection = state.status === 'ok';
    edpDomain = state.status === 'ok' ? state.domain : null;
    const card = slot.querySelector('#edp-card');

    // Untick to reveal the 'ok' card's own hidden picker, by request --
    // a SECOND, direct listener on this same checkbox (the delegated one
    // on `container`, wired once in mount() above, still separately
    // updates cyberCardToggles -- the two don't conflict). Re-ticking
    // without having picked anything new just hides it again; nothing
    // else changes, since nothing was actually re-checked.
    const picker = card.querySelector('#edp-picker');
    if (picker) {
      const toggle = card.querySelector('.live-reports-card-toggle-input');
      toggle.addEventListener('change', () => {
        picker.hidden = toggle.checked;
      });
    }

    const select = card.querySelector('#edp-domain-select');
    const newInput = card.querySelector('#edp-new-domain');
    const saveButton = card.querySelector('#edp-save-button');
    if (!saveButton) return;
    const errorEl = card.querySelector('#edp-error');
    saveButton.addEventListener('click', async () => {
      errorEl.hidden = true;
      const existingDomain = select ? select.value : '';
      const newDomain = newInput.value.trim();
      const domain = existingDomain || newDomain;
      if (!domain) {
        errorEl.hidden = false;
        errorEl.textContent = 'Pick an existing domain, or type one.';
        return;
      }
      saveButton.disabled = true;
      saveButton.textContent = 'Checking...';
      try {
        const res = await fetch('/api/live-reports/email-domain-protection/check-domain', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain }),
        });
        const newState = await res.json();
        if (!res.ok) throw new Error(newState.error || `Request failed (${res.status})`);
        // check-domain only ever returns the DNS result, not the client's
        // own IT Glue domains list (it doesn't touch IT Glue at all) --
        // carried forward from whatever was last known so the dropdown
        // stays populated across a manual re-check, instead of emptying
        // out after the first one.
        if (!newState.domains) newState.domains = state.domains || [];
        if (slot.isConnected) renderEmailDomainProtection(slot, siteName, newState);
      } catch (err) {
        errorEl.hidden = false;
        errorEl.textContent = `Could not check this domain: ${err.message}`;
        saveButton.disabled = false;
        saveButton.textContent = 'Use this domain';
      }
    });
  }

  function resetCommentaryEditor() {
    commentaryEditorContainer.innerHTML = '';
    commentaryStatusEl.hidden = true;
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    resolveClientAndLoad();
  });
  // Refresh reuses whatever client was last resolved -- never re-runs the
  // Autotask lookup (load() below reads resolvedDattoSite, not
  // siteInput.value, so this stays correct even if the box's text has
  // since been edited without hitting Search again).
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
    // commentary key sent), in which case server.js's /pdf route no longer
    // calls the AI itself either, by request -- the PDF just ships with
    // placeholder space in those sections instead.
    const editedCommentary = readCommentaryFromEditor(commentaryEditorContainer);
    const mailDomainProtection = mdpState;
    const sections = { ...sectionToggles, cyberCards: cyberCardToggles, deviceHealthItems: deviceHealthItemToggles };
    try {
      const res = await fetch('/api/live-reports/pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          report: currentReportData,
          vendors: currentVendorsData,
          mailDomainProtection,
          emailDomainProtectionDomain: edpDomain,
          sections,
          ...(editedCommentary ? { commentary: editedCommentary } : {}),
        }),
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

  // The Autotask Client lookup, by request ("change to using the Autotask
  // Client as the lookup... provide a list to choose from" when more than
  // one real company matches). Resolves the typed text to a real Autotask
  // company (or a picker, if ambiguous), then that company's own
  // "Name:Datto RMM" UDF if it has one -- see useResolvedClient() below
  // for the fallback when it doesn't.
  async function resolveClientAndLoad() {
    const clientSearch = siteInput.value.trim();
    if (!clientSearch) {
      statusEl.hidden = false;
      statusEl.className = 'status';
      statusEl.textContent = 'Type an Autotask Client name above to pull a live report.';
      resultsEl.innerHTML = '';
      return;
    }
    resolvedCompanyName = null;
    resolvedDattoSite = null;
    statusEl.hidden = false;
    statusEl.className = 'status loading';
    statusEl.textContent = 'Looking up Autotask Client...';
    resultsEl.innerHTML = '';
    try {
      const params = new URLSearchParams({ client: clientSearch });
      if (exactInput.checked) params.set('exactClient', 'true');
      const res = await fetch(`/api/live-reports/resolve-client?${params.toString()}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      const matches = data.matches || [];
      if (matches.length === 0) {
        statusEl.className = 'status error';
        statusEl.textContent = `No Autotask Client found matching "${clientSearch}".`;
        return;
      }
      if (matches.length === 1) {
        useResolvedClient(matches[0]);
        return;
      }
      statusEl.hidden = true;
      renderClientPicker(matches, clientSearch);
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    }
  }

  // More than one real Autotask company matched -- by request, a plain
  // clickable list rather than a <select> (this is the page's own main
  // lookup, not a small in-widget picker like Mail Domain Protection's
  // own org picker further down, so it gets full prominence in the
  // results area rather than squeezed into a dropdown).
  function renderClientPicker(matches, clientSearch) {
    resultsEl.innerHTML = `
      <p class="inline-subtext">More than one Autotask Client matches "${escapeHtml(clientSearch)}" -- choose one:</p>
      <ul class="live-reports-client-picker">
        ${matches
          .map((m) => `<li><button type="button" class="live-reports-client-picker-btn" data-company-id="${m.companyId}">${escapeHtml(m.companyName)}</button></li>`)
          .join('')}
      </ul>
    `;
    resultsEl.querySelectorAll('.live-reports-client-picker-btn').forEach((btn, i) => {
      btn.addEventListener('click', () => useResolvedClient(matches[i]));
    });
  }

  function useResolvedClient(match) {
    resolvedCompanyName = match.companyName;
    resolvedCompanyId = match.companyId;
    // Use the "Name:Datto RMM" UDF if the company has one on record; if
    // it's blank, fall back to a normal lookup using the SAME Autotask
    // Client name text (by request -- a strict "never guess, report not
    // found" version of this blocked real, working clients whose UDF
    // simply hadn't been filled in, e.g. a real "Smart Mortgages" lookup
    // that should have just worked). load() below still does its own
    // real Datto RMM match-or-not-found against whichever name this
    // ends up being -- "No Datto RMM devices matched" still shows
    // honestly if even the company name itself doesn't match any real
    // Datto site.
    resolvedDattoSite = match.dattoSite || match.companyName;
    statusEl.hidden = false;
    load(false);
  }


  async function load(force) {
    const site = resolvedDattoSite;
    // A previous client's (or a previous fetch's) generated/edited
    // narrative is no longer valid once new report data is about to load --
    // cleared unconditionally here, same as currentReportData/
    // currentVendorsData themselves get reset below, so a stale edited
    // paragraph can never silently end up in a different client's PDF.
    resetCommentaryEditor();
    // Same reasoning for Mail Domain Protection -- back to the defaults,
    // not whatever the previous client's manually-looked-up numbers were.
    mdpState = mdpDefaults();
    // Same for every "include in PDF" tick box -- back to all-ticked.
    // Every one of these checkboxes lives inside either resultsEl/the
    // Cybersecurity grid (rebuilt fresh by load()/loadVendorSummaries()
    // below) or the commentary editor (cleared by resetCommentaryEditor()
    // above), so their own markup already defaults back to checked -- no
    // DOM to reset by hand here, just the tracked state objects.
    sectionToggles = {};
    cyberCardToggles = {};
    deviceHealthItemToggles = {};
    edpDomain = null;
    if (!site) {
      statusEl.hidden = false;
      statusEl.className = 'status';
      statusEl.textContent = 'Type an Autotask Client name above to pull a live report.';
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
      const params = new URLSearchParams({ site, exactSite: 'true' });
      if (force) params.set('force', 'true');
      if (resolvedCompanyId) params.set('companyId', String(resolvedCompanyId));
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

  // "Systems Not Found" summary, by request -- when a client has no real
  // Datto RMM match, the page still proceeds with whatever else is
  // available (loadVendorSummaries() below), rather than stopping dead;
  // this reports which of those OTHER systems also came back with no
  // real match for this client, in one short list at the top. Each
  // vendor's own "installed/monitored: false" IS its own "no match
  // found" signal (confirmed in server.js's own buildXSummary()
  // functions -- there's no separate "matched but not subscribed" state,
  // !match already means exactly this). 'not-configured' is excluded --
  // that means THIS DASHBOARD has no credentials for that vendor at all,
  // a setup gap, not a per-client match failure.
  const SYSTEM_NOT_FOUND_CHECKS = [
    { key: 'saasAlerts', label: 'SaaS Alerts', notFound: (v) => v.status === 'ok' && v.monitored === false },
    { key: 'saasProtection', label: 'SaaS Protection', notFound: (v) => v.status === 'ok' && v.installed === false },
    { key: 'dattoEdr', label: 'Datto EDR', notFound: (v) => v.status === 'ok' && v.installed === false },
    { key: 'autoElevate', label: 'AutoElevate', notFound: (v) => v.status === 'ok' && v.installed === false },
    { key: 'huntress', label: 'Huntress', notFound: (v) => v.status === 'ok' && v.installed === false },
    { key: 'inky', label: 'Email Security', notFound: (v) => v.status === 'ok' && v.installed === false },
  ];
  function computeSystemsNotFound(vendors, includeDattoRmm) {
    const notFound = includeDattoRmm ? ['Datto RMM'] : [];
    for (const check of SYSTEM_NOT_FOUND_CHECKS) {
      const v = vendors[check.key];
      if (v && check.notFound(v)) notFound.push(check.label);
    }
    return notFound;
  }
  function systemsNotFoundHtml(notFoundLabels) {
    if (notFoundLabels.length === 0) return '<div id="systems-not-found-slot" hidden></div>';
    return `<p id="systems-not-found-slot" class="live-reports-systems-not-found">Client Match not found: ${notFoundLabels.map(escapeHtml).join(', ')}</p>`;
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
  async function loadVendorSummaries(siteName, force, isTcElite, companyId, noDattoMatch) {
    const vendorEl = resultsEl.querySelector('#vendor-summaries');
    const m365El = resultsEl.querySelector('#m365-licenses');
    if (!vendorEl) return;
    // The ONLY thing shown up near the top of the page while these two
    // sections are still loading, by request -- the real Cybersecurity
    // Systems/Microsoft License Counts content itself always renders down
    // in its usual spot (#vendor-summaries/#m365-licenses above, between
    // Device Health and the device list), never up here. Removed the
    // moment each section's own fill-in below finishes, success or
    // failure alike -- there's nothing left to report "still loading" on
    // past that point.
    const removeTopLoading = (id) => resultsEl.querySelector(id)?.remove();
    try {
      const params = new URLSearchParams({ siteName });
      if (force) params.set('force', 'true');
      if (companyId) params.set('companyId', String(companyId));
      const res = await fetch(`/api/live-reports/vendors?${params.toString()}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      if (!vendorEl.isConnected) return;
      currentVendorsData = data.vendors;
      // "Systems Not Found" summary at the top of the page, by request --
      // only ever built when there's a no-Datto-match slot waiting for it
      // (render()'s own degraded-report branch); the normal success path
      // has no such slot, so this is a no-op there.
      const notFoundSlot = resultsEl.querySelector('#systems-not-found-slot');
      if (notFoundSlot && notFoundSlot.isConnected) {
        notFoundSlot.outerHTML = systemsNotFoundHtml(computeSystemsNotFound(data.vendors, noDattoMatch));
      }
      // "Other Systems" and "Microsoft License Counts" are now rendered in
      // their OWN try/catch each, by request -- confirmed this session
      // that a bug in ONE of them (either a thrown exception, or one
      // vendor's own transient failure) could silently prevent the OTHER
      // from ever updating, since they used to share one try block and
      // vendorSummariesHtml() ran first. Each failure is also logged to
      // the browser console now, so a real bug shows up there instead of
      // just reading as "nothing happened".
      try {
        vendorEl.outerHTML = vendorSummariesHtml(data.vendors, mdpState, isTcElite);
        // Matches the checkbox's own rendered default -- see mdpCardHtml()'s
        // own comment -- rather than leaving this key absent, which
        // pdf-template.js treats as "shown" regardless of what's actually
        // ticked on screen.
        cyberCardToggles.mailDomainProtection = isTcElite;
        wireMdpWidget();
        loadEmailDomainProtection(siteName);
      } catch (err) {
        console.error('Live Reports: failed to render Other Systems:', err);
        if (vendorEl.isConnected) vendorEl.innerHTML = `<p class="inline-subtext">Could not render Other Systems: ${escapeHtml(err.message)}</p>`;
      }
      removeTopLoading('#vendor-summaries-loading');
      if (m365El && m365El.isConnected) {
        try {
          m365El.innerHTML = m365LicensesHtml(data.vendors.m365Licenses);
        } catch (err) {
          console.error('Live Reports: failed to render Microsoft License Counts:', err, data.vendors.m365Licenses);
          m365El.innerHTML = `<h2 class="client-summary-section-heading">Microsoft License Counts</h2><p class="inline-subtext">Could not render license counts: ${escapeHtml(err.message)}</p>`;
        }
      }
      removeTopLoading('#m365-licenses-loading');
    } catch (err) {
      console.error('Live Reports: /vendors request failed:', err);
      if (vendorEl.isConnected) vendorEl.innerHTML = `<p class="inline-subtext">Could not load Other Systems: ${escapeHtml(err.message)}</p>`;
      if (m365El && m365El.isConnected) m365El.innerHTML = m365LicensesHtml({ status: 'error' });
      removeTopLoading('#vendor-summaries-loading');
      removeTopLoading('#m365-licenses-loading');
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
      // No real Datto RMM match for this client -- by request, still
      // proceed with whatever else is available (Other Systems/M365
      // Licenses/Mail Domain Protection, all via loadVendorSummaries()
      // below, matched on the plain Autotask company name since there's
      // no real Datto site to key off), rather than stopping dead here.
      // "Create PDF"/"Generate Summary" stay disabled permanently (not
      // "Loading") -- the PDF builder needs a full Datto-based report
      // (gauge, device counts, etc.) that genuinely doesn't exist for
      // this client, not something loadVendorSummaries() below ever
      // produces.
      statusEl.hidden = true;
      currentReportData = null;
      currentVendorsData = null;
      pdfButton.disabled = true;
      pdfButton.textContent = 'Create PDF';
      generateCommentaryButton.disabled = true;
      generateCommentaryButton.hidden = true;
      resultsEl.innerHTML = `
        <p class="live-reports-client-heading">${escapeHtml(resolvedCompanyName || data.siteTerm)} <span class="live-reports-client-asof">${new Date().toLocaleString()}</span></p>
        <p id="systems-not-found-slot" class="live-reports-systems-not-found">Client Match not found: Datto RMM</p>
        <div class="lr-section-box" id="vendor-summaries"><h2 class="client-summary-section-heading">Cybersecurity Systems</h2><p class="inline-subtext live-reports-loading-text">Loading Other Systems...</p></div>
        <div class="lr-section-box" id="m365-licenses"><h2 class="client-summary-section-heading">Microsoft License Counts</h2><p class="inline-subtext live-reports-loading-text">Loading...</p></div>
      `;
      loadVendorSummaries(resolvedCompanyName || data.siteTerm, force, data.isTcElite, data.companyId, true);
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
    // Generate Summary only shows for people in ALLOW_REPORT_AI_GENERATION
    // (.env), by request -- the real gate is server-side (the /commentary
    // route itself 403s for anyone else), this just keeps the button from
    // ever appearing for someone it would only reject anyway.
    generateCommentaryButton.hidden = !data.canGenerateAi;
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

    const alertsWidget = alertSummaryTableHtml(data.alertSummaryByPriority);

    const typeWidget = dattoLive && dattoLive.byType.length > 0 ? deviceTypeBarWidget(dattoLive.byType, dattoLive.summary.total) : '';
    const freshnessWidget = dattoLive ? checkinFreshnessWidget(dattoLive.summary) : '';
    // "All Devices" toggle sits right in the filter row, by request -- its
    // own heading lives inside deviceListTableHtml() (a shared component,
    // meeting-prep-report-render.js, never touched directly), so this is
    // the same string-surgery approach donutFromLegend() uses above:
    // inject the checkbox as the filter box's first child instead.
    // No-ops harmlessly when there are no devices at all (that branch
    // returns a plain "No devices to list." paragraph with no filter row
    // to match against).
    const deviceList = dattoLive ? deviceListTableHtml(dattoLive).replace('<div class="mtg-device-filter">', `<div class="mtg-device-filter">${sectionToggleHtml('deviceList', 'All Devices')}`) : '';

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
            { 'Within 12 months': '#dc2626', '12 to 24 months': '#f59e0b', 'Suitable 24+ months': '#16a34a', Unknown: '#9aa3af' },
            'replacementRecommendation'
          )}
          ${donutFromLegend('Operating System', osLegend, osColors, 'operatingSystem')}
        </div>`
      : '';

    // itemKeys (Device Health "include in PDF" sub-toggles, by request --
    // "Allow Each of the Workstation widgets to have their own tick box")
    // is only ever passed for the Workstations call below, not Servers --
    // Servers' own Antivirus donut stays bundled under the Device Health
    // section toggle, same as before, since that's all that was asked for.
    const groupWidgets = (groupLabel, g, note, itemKeys) => {
      if (!g) return '';
      return `
        <h2 class="client-summary-section-heading">${escapeHtml(groupLabel)} <span class="inline-subtext">(${g.total} device${g.total === 1 ? '' : 's'})</span></h2>
        ${note ? `<p class="inline-subtext">${escapeHtml(note)}</p>` : ''}
        <div class="mtg-widget-grid">
          ${donutFromLegend(`Patch Management (${g.patch.score}%)`, g.patch.legend, PATCH_COLORS, itemKeys && itemKeys.patch)}
          ${donutFromLegend(`Software Management (${g.software.score}%)`, g.software.legend, SOFTWARE_COLORS, itemKeys && itemKeys.software)}
          ${donutFromLegend(`Antivirus (${g.antivirus.score}%)`, g.antivirus.legend, ANTIVIRUS_COLORS, itemKeys && itemKeys.antivirus)}
        </div>`;
    };

    // 2x2, not the usual single wide row -- live-reports-kpi-grid
    // (styles.css) caps the wrapper's width to fit exactly 2 of
    // kpiTileRow's own tiles per line, so the 4 boxes wrap into a small
    // block that sits beside the gauge rather than spanning the page.
    const kpiGrid = dattoLiveKpis ? `<div class="live-reports-kpi-grid">${dattoLiveKpis}</div>` : '';

    resultsEl.innerHTML = `
      <p class="live-reports-client-heading">${escapeHtml(resolvedCompanyName || data.siteName)} <span class="live-reports-client-asof">${new Date(data.asOf).toLocaleString()}</span></p>
      <p id="vendor-summaries-loading" class="inline-subtext live-reports-loading-text">Loading Cybersecurity Systems...</p>
      <p id="m365-licenses-loading" class="inline-subtext live-reports-loading-text">Loading Microsoft License Counts...</p>
      <div class="lr-section-box">
        ${namedSectionToggleHtml('overallHealthView', 'Overall Health View')}
        <div class="mtg-widget-grid">${gauge}${kpiGrid}${alertsWidget}</div>
        ${openAlertsListHtml(data.openAlerts)}
      </div>
      <div class="lr-section-box">
        ${typeWidget || freshnessWidget ? namedSectionToggleHtml('deviceOverview', 'Devices by Type / Check-in Freshness') : ''}
        <div class="live-reports-overview-grid">
          ${typeWidget}
          ${freshnessWidget}
          <div class="live-reports-scorecard-span">${scorecardHtml(data, null)}</div>
        </div>
      </div>
      <div class="lr-section-box">
        ${namedSectionToggleHtml('deviceHealth', 'Device Health')}
        <div class="mtg-widget-grid">
          <div>${assetManagementTableHtml(data.assetManagementDetail)}</div>
          <div>${monitoringTableHtml(data.monitoringDetail)}</div>
        </div>
        ${groupWidgets('Workstations', data.workstation, undefined, { patch: 'workstationPatch', software: 'workstationSoftware', antivirus: 'workstationAntivirus' })}
        ${groupWidgets(
          'Servers',
          data.server,
          'Patch Management and Software Management are not handled through this platform for servers, so they will always show as No Policy / Unmanaged below -- not counted in the Servers Health Score.'
        )}
        ${hardwareLifecycleWidgets}
        ${proactiveMaintenanceHtml(data.proactiveMaintenance)}
      </div>
      <div class="lr-section-box" id="vendor-summaries"></div>
      <div class="lr-section-box" id="m365-licenses"></div>
      <div class="lr-section-box live-reports-device-list">${deviceList}</div>
      <div class="lr-section-box" id="report-explanations-slot"><p class="inline-subtext live-reports-loading-text">Loading...</p></div>
    `;
    wireDeviceFilters(resultsEl);
    wireOpenAlertsLinks(resultsEl, data.openAlerts);
    loadVendorSummaries(data.siteName, force, data.isTcElite, data.companyId);
    // "Understanding Your Scores"/"Cybersecurity Module Descriptions", by
    // request, at the very bottom of the page -- isConnected-guarded same
    // as every other async fill-in on this page (loadVendorSummaries() et
    // al.), in case a different client's search already replaced
    // resultsEl before this resolves.
    loadReportExplanations().then((explanationsData) => {
      const slot = resultsEl.querySelector('#report-explanations-slot');
      if (slot && slot.isConnected) slot.outerHTML = reportExplanationsHtml(explanationsData);
    });
  }
}
