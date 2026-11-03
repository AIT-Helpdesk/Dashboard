const fs = require('fs');
const path = require('path');

// Builds the full, self-contained HTML document Puppeteer renders to a PDF
// (pdf-render.js) -- "self-contained" meaning everything it needs (CSS,
// the logo, the gauge/donut/KPI-tile SVG widgets) is inlined into the one
// HTML string, no HTTP requests or file:// paths for Puppeteer to resolve,
// which is both simpler and more reliable than trying to serve this page
// over the dashboard's own running Express server.
//
// gaugeSvg/donutSvg/donutWidget/kpiTileRow below are small, EXACT copies
// of the same-named functions in /meeting-prep-report-render.js (the
// widget builders Live Reports' own on-screen client.js already uses),
// so the PDF's charts look identical to what's on screen -- confirmed
// live this session that the real file can't just be imported here:
// it's a plain browser ES module with no document/window calls of its
// own, but it has a top-level `import ... from '/meeting-prep-
// recommendations.js'` (a browser-root-relative path meant for the
// dashboard's own running server), which fails to resolve at all when
// loaded via a raw file:// URL in Node -- the whole module throws on
// load before gaugeSvg() itself is ever reached, even though gaugeSvg()
// never touches that import. Small independent copies here instead, same
// "copy the small literal, don't fight cross-runtime import resolution"
// convention this dashboard already uses elsewhere for a genuinely small
// amount of shared code. If that source file's own gaugeSvg/donutSvg/
// donutWidget/kpiTileRow ever change, these 4 need updating to match.
const STYLES_PATH = path.join(__dirname, '..', 'shell', 'public', 'styles.css');
const LOGO_PATH = path.join(__dirname, '..', 'shell', 'public', 'logo.png');

// Ambient iT's own brand colours, eyeballed from the real logo.png (no
// documented brand guide found in this repo) -- the deep indigo/purple of
// the "Ambient" wordmark and the bright green of the "iT" circle/swoosh.
// If these ever look off against a real printed/branded asset, these two
// lines are the only place to correct.
const BRAND_PURPLE = '#2E2A7C';
const BRAND_GREEN = '#4DA64D';

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// Maps a 0-100 score to this report's own 3-tier status language (same
// "On track / Watch / Action needed" wording the DRG example report this
// was modeled on uses), but keeping THIS dashboard's own existing
// good=green/warn=amber/bad=red colour meaning (scoreBadge()/kpiTileRow's
// own --good/--warn/--bad tiers already mean exactly that everywhere else
// here) rather than copying the reference report's own blue-for-good
// scheme, which would only have made sense for a blue-branded MSP.
function statusForScore(score) {
  if (score === null || score === undefined) return { label: 'Unknown', cls: 'pdf-pill--muted' };
  if (score >= 90) return { label: 'On track', cls: 'pdf-pill--good' };
  if (score >= 70) return { label: 'Watch', cls: 'pdf-pill--watch' };
  return { label: 'Action needed', cls: 'pdf-pill--action' };
}
function pillHtml(status) {
  return `<span class="pdf-pill ${status.cls}">${escapeHtml(status.label)}</span>`;
}

// -- Exact copies of meeting-prep-report-render.js's own gaugeSvg()/
// donutSvg()/donutWidget()/kpiTileRow() -- see this file's own header
// comment for why these are copied rather than imported.
function gaugeSvg(score) {
  const cx = 90,
    cy = 90,
    r = 75;
  const point = (s) => {
    const a = ((180 - (s / 100) * 180) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy - r * Math.sin(a)];
  };
  const stops = [0, 25, 50, 75, 100];
  const colors = ['#dc2626', '#f59e0b', '#86c95e', '#16a34a'];
  const bands = stops
    .slice(0, -1)
    .map((s0, i) => {
      const [x0, y0] = point(s0);
      const [x1, y1] = point(stops[i + 1]);
      return `<path d="M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}" stroke="${colors[i]}" stroke-width="16" fill="none" stroke-linecap="round"/>`;
    })
    .join('');
  const clamped = Math.max(0, Math.min(100, score ?? 0));
  const [nx, ny] = point(clamped);
  const label = score === null || score === undefined ? '?' : `${score}%`;
  return `
    <svg width="180" height="105" viewBox="0 0 180 105" class="mtg-gauge">
      ${bands}
      <line x1="${cx}" y1="${cy}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
      <circle cx="${cx}" cy="${cy}" r="5" fill="currentColor"/>
      <text x="${cx}" y="${cy - 12}" text-anchor="middle" class="mtg-gauge-score">${label}</text>
    </svg>
  `;
}
function donutSvg(segments, centerLabel) {
  const r = 62,
    circ = 2 * Math.PI * r;
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  let offset = 0;
  const arcs = segments
    .filter((s) => s.value > 0)
    .map((s) => {
      const length = total > 0 ? (s.value / total) * circ : 0;
      const dash = `${length.toFixed(2)} ${(circ - length).toFixed(2)}`;
      const dashoffset = (-offset).toFixed(2);
      offset += length;
      return `<circle cx="72" cy="72" r="${r}" fill="none" stroke="${s.color}" stroke-width="18" stroke-dasharray="${dash}" stroke-dashoffset="${dashoffset}" transform="rotate(-90 72 72)"/>`;
    })
    .join('');
  return `
    <svg width="144" height="144" viewBox="0 0 144 144" class="mtg-donut">
      <circle cx="72" cy="72" r="${r}" fill="none" stroke="var(--border)" stroke-width="18"/>
      ${arcs}
      <text x="72" y="80" text-anchor="middle" class="mtg-donut-total">${centerLabel === undefined ? total : centerLabel}</text>
    </svg>
  `;
}
function donutWidget(title, segments, centerLabel) {
  const rows = segments
    .map(
      (s) =>
        `<div class="mtg-donut-legend-row" title="${escapeHtml(s.label)}"><span class="mtg-swatch" style="background:${s.color}"></span><span class="mtg-donut-legend-label">${escapeHtml(s.label)}</span><span class="mtg-donut-val">${s.value}</span></div>`
    )
    .join('');
  return `
    <div class="mtg-widget">
      ${title ? `<p class="mtg-widget-title">${escapeHtml(title)}</p>` : ''}
      <div class="mtg-donut-row">
        ${donutSvg(segments, centerLabel)}
        <div class="mtg-donut-legend">${rows}</div>
      </div>
    </div>
  `;
}
function kpiTileRow(tiles) {
  return `
    <div class="mtg-kpi-row">
      ${tiles
        .map(
          (t) => `
        <div class="mtg-kpi-tile${t.tier ? ` mtg-kpi-tile--${t.tier}` : ''}">
          <div class="mtg-kpi-value">${escapeHtml(String(t.value))}</div>
          <div class="mtg-kpi-label">${escapeHtml(t.label)}</div>
          ${t.sub ? `<div class="mtg-kpi-sub">${escapeHtml(t.sub)}</div>` : ''}
        </div>`
        )
        .join('')}
    </div>
  `;
}

const CSS = `
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #1a1a1a; margin: 0; font-size: 10.5px; }
  .pdf-section { padding: 0 0.1in; page-break-inside: avoid; }
  .pdf-section + .pdf-section { margin-top: 18px; }
  .pdf-page-break { page-break-before: always; }

  .pdf-cover {
    background: ${BRAND_PURPLE};
    color: #fff;
    padding: 28px 32px 34px;
    margin-bottom: 20px;
  }
  .pdf-cover img.logo { height: 42px; background: #fff; padding: 8px 14px; border-radius: 6px; }
  .pdf-cover .period { text-align: right; font-size: 11px; opacity: 0.85; text-transform: uppercase; letter-spacing: 0.04em; }
  .pdf-cover .period strong { display: block; font-size: 15px; margin-top: 2px; }
  .pdf-cover-row { display: flex; justify-content: space-between; align-items: flex-start; }
  .pdf-cover h1 { font-size: 30px; margin: 22px 0 4px; }
  .pdf-cover .subtitle { font-size: 14px; opacity: 0.9; margin: 0; }

  h2.pdf-heading {
    font-size: 15px;
    color: ${BRAND_PURPLE};
    border-bottom: 2px solid ${BRAND_PURPLE};
    padding-bottom: 4px;
    margin: 0 0 10px;
  }
  h3.pdf-subheading { font-size: 12px; color: #374151; margin: 14px 0 6px; }

  .pdf-pill { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 9.5px; font-weight: 700; color: #fff; white-space: nowrap; }
  .pdf-pill--good { background: ${BRAND_GREEN}; }
  .pdf-pill--watch { background: #d97706; }
  .pdf-pill--action { background: #dc2626; }
  .pdf-pill--muted { background: #9aa3af; }

  .pdf-callout {
    background: #f3f1fb;
    border-left: 4px solid ${BRAND_PURPLE};
    padding: 10px 14px;
    border-radius: 4px;
    margin-top: 10px;
    font-size: 10px;
    line-height: 1.5;
  }
  .pdf-callout strong { color: ${BRAND_PURPLE}; display: block; margin-bottom: 3px; font-size: 10.5px; }

  .pdf-cards { display: flex; gap: 10px; margin-top: 10px; }
  .pdf-card { flex: 1; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; }
  .pdf-card-head { padding: 6px 10px; font-weight: 700; font-size: 10.5px; color: #fff; }
  .pdf-card--good .pdf-card-head { background: ${BRAND_GREEN}; }
  .pdf-card--watch .pdf-card-head { background: #d97706; }
  .pdf-card--action .pdf-card-head { background: #dc2626; }
  .pdf-card ul { margin: 0; padding: 8px 10px 8px 22px; font-size: 9.5px; line-height: 1.6; }
  .pdf-card li { margin-bottom: 2px; }
  .pdf-card .pdf-card-empty { padding: 8px 10px; font-size: 9.5px; color: #9aa3af; font-style: italic; }

  table.pdf-table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 9.5px; }
  table.pdf-table th { text-align: left; background: ${BRAND_PURPLE}; color: #fff; padding: 6px 8px; font-weight: 600; }
  table.pdf-table td { padding: 5px 8px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
  table.pdf-table tr:nth-child(even) td { background: #f9fafb; }

  .pdf-widget-grid { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 8px; }
  .pdf-widget-grid > * { flex: 1 1 220px; }

  .pdf-vendor-card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 12px; flex: 1 1 220px; }
  .pdf-vendor-card h4 { margin: 0 0 6px; font-size: 10.5px; color: ${BRAND_PURPLE}; }
  .pdf-vendor-card .pdf-vendor-stat { display: flex; justify-content: space-between; font-size: 9.5px; padding: 2px 0; border-bottom: 1px dashed #e5e7eb; }
  .pdf-vendor-card .pdf-vendor-stat:last-child { border-bottom: none; }
  .pdf-vendor-card .pdf-vendor-stat span:last-child { font-weight: 700; }
  .pdf-vendor-card.pdf-vendor-card--muted { opacity: 0.55; }

  .pdf-footer-tagline { font-size: 9px; color: #9aa3af; margin-top: 4px; }
`;

// -- Device table (needs-attention, worst-first) -----------------------
// dattoLive.devices rows (meeting-prep/server.js's own
// buildDattoLiveDevicesComponent()) carry hostname/type/lastSeen/
// freshness/online/lastUser -- not per-device patch/AV/software status
// (that only exists as the WORKSTATION/SERVER GROUP aggregate this page
// already shows as donuts above this table), so "needs attention" here
// means stale or offline, the two per-device facts actually available.
const FRESHNESS_ORDER = { stale: 0, unknown: 1, ageing: 2, recent: 3 };
const FRESHNESS_LABEL = { stale: 'Not seen 30+ days', ageing: 'Seen 7-30 days', recent: 'Seen <7 days', unknown: 'Unknown' };

function deviceTableHtml(dattoLive) {
  if (!dattoLive || !dattoLive.devices || dattoLive.devices.length === 0) return '';
  const rows = [...dattoLive.devices].sort((a, b) => {
    const f = (FRESHNESS_ORDER[a.freshness] ?? 9) - (FRESHNESS_ORDER[b.freshness] ?? 9);
    if (f !== 0) return f;
    if (a.online !== b.online) return a.online ? 1 : -1;
    return (a.hostname || '').localeCompare(b.hostname || '');
  });
  return `
    <h3 class="pdf-subheading">All Devices (${rows.length}) -- oldest check-in first</h3>
    <table class="pdf-table">
      <thead><tr><th>Device</th><th>Type</th><th>Last Seen</th><th>Online</th><th>Last User</th></tr></thead>
      <tbody>
        ${rows
          .map(
            (d) => `
          <tr>
            <td>${escapeHtml(d.hostname)}</td>
            <td>${escapeHtml(d.type)}</td>
            <td>${escapeHtml(FRESHNESS_LABEL[d.freshness] || d.freshness)}${d.lastSeen ? ` <span style="color:#9aa3af;">(${escapeHtml(formatDate(d.lastSeen))})</span>` : ''}</td>
            <td>${d.online ? 'Yes' : 'No'}</td>
            <td>${escapeHtml(d.lastUser || '--')}</td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>`;
}

function vendorCardsHtml(vendors) {
  const cards = [];

  const sa = vendors.saasAlerts;
  if (sa.status === 'ok' && sa.monitored) {
    cards.push(`
      <div class="pdf-vendor-card">
        <h4>SaaS Alerts (Last ${sa.windowDays} Days)</h4>
        <div class="pdf-vendor-stat"><span>Critical alerts</span><span>${sa.criticalCount}</span></div>
        <div class="pdf-vendor-stat"><span>Medium alerts</span><span>${sa.mediumCount}</span></div>
        <div class="pdf-vendor-stat"><span>Low alerts</span><span>${sa.lowCount}</span></div>
      </div>`);
  } else {
    cards.push(vendorMutedCard('SaaS Alerts', sa.status));
  }

  const sp = vendors.saasProtection;
  if (sp.status === 'ok' && sp.installed) {
    cards.push(`
      <div class="pdf-vendor-card">
        <h4>SaaS Protection (Backup)</h4>
        <div class="pdf-vendor-stat"><span>Backup health</span><span>${sp.backupPercentage ?? '--'}%</span></div>
        <div class="pdf-vendor-stat"><span>Billable seats</span><span>${sp.billableSeatCount ?? '--'}</span></div>
        <div class="pdf-vendor-stat"><span>App types healthy</span><span>${sp.appTypesHealthy}/${sp.appTypesTotal}</span></div>
      </div>`);
  } else {
    cards.push(vendorMutedCard('SaaS Protection', sp.status));
  }

  const edr = vendors.dattoEdr;
  if (edr.status === 'ok' && edr.installed) {
    cards.push(`
      <div class="pdf-vendor-card">
        <h4>Datto EDR</h4>
        <div class="pdf-vendor-stat"><span>Locations</span><span>${edr.locationCount}</span></div>
        <div class="pdf-vendor-stat"><span>Agents (active)</span><span>${edr.agentCount} (${edr.activeAgentCount})</span></div>
        <div class="pdf-vendor-stat"><span>Open alerts</span><span>${edr.alertCount}</span></div>
      </div>`);
  } else {
    cards.push(vendorMutedCard('Datto EDR', edr.status));
  }

  const h = vendors.huntress;
  if (h.status === 'ok' && h.installed) {
    cards.push(`
      <div class="pdf-vendor-card">
        <h4>Huntress</h4>
        <div class="pdf-vendor-stat"><span>Agents monitored</span><span>${h.agentsCount ?? '--'}</span></div>
        <div class="pdf-vendor-stat"><span>Incident reports (lifetime)</span><span>${h.incidentReportsCount ?? '--'}</span></div>
      </div>`);
  } else {
    cards.push(vendorMutedCard('Huntress', h.status));
  }

  const ae = vendors.autoElevate;
  if (ae.status === 'ok' && ae.installed) {
    cards.push(`
      <div class="pdf-vendor-card">
        <h4>AutoElevate</h4>
        <div class="pdf-vendor-stat"><span>Deployed since</span><span>${escapeHtml(new Date(ae.deployedSince).toLocaleDateString('en-AU'))}</span></div>
      </div>`);
  } else {
    cards.push(vendorMutedCard('AutoElevate', ae.status));
  }

  return cards.join('');
}
function vendorMutedCard(label, status) {
  const text = status === 'not-configured' ? 'Not connected' : 'Not installed for this client';
  return `<div class="pdf-vendor-card pdf-vendor-card--muted"><h4>${escapeHtml(label)}</h4><div class="pdf-vendor-stat"><span>${escapeHtml(text)}</span><span></span></div></div>`;
}

function cardsRowHtml(commentary) {
  if (!commentary) return '';
  const col = (title, cls, items) => `
    <div class="pdf-card pdf-card--${cls}">
      <div class="pdf-card-head">${escapeHtml(title)}</div>
      ${items && items.length > 0 ? `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : '<div class="pdf-card-empty">Nothing to report</div>'}
    </div>`;
  return `
    <div class="pdf-cards">
      ${col('On Track', 'good', commentary.onTrack)}
      ${col('Watch', 'watch', commentary.watch)}
      ${col('Action Needed', 'action', commentary.actionNeeded)}
    </div>`;
}

function recommendationsTableHtml(commentary) {
  if (!commentary || !commentary.recommendations || commentary.recommendations.length === 0) return '';
  const priorityPill = (p) => pillHtml(p === 'Action needed' ? { label: 'Action needed', cls: 'pdf-pill--action' } : { label: 'Watch', cls: 'pdf-pill--watch' });
  return `
    <h2 class="pdf-heading">Our Recommendations</h2>
    <table class="pdf-table">
      <thead><tr><th style="width:110px;">Priority</th><th>Recommendation</th><th>Why It Matters</th></tr></thead>
      <tbody>
        ${commentary.recommendations
          .map((r) => `<tr><td>${priorityPill(r.priority)}</td><td>${escapeHtml(r.recommendation)}</td><td>${escapeHtml(r.whyItMatters)}</td></tr>`)
          .join('')}
      </tbody>
    </table>`;
}

// Stays declared `async` even though it no longer actually awaits
// anything internally -- server.js's own caller already does
// `await buildReportHtml(...)`, and a plain sync function is perfectly
// awaitable too (resolves immediately), so there's no reason to touch
// that call site over what's purely an internal implementation detail.
async function buildReportHtml({ report, vendors, commentary }) {
  const stylesCss = fs.readFileSync(STYLES_PATH, 'utf8');
  const logoDataUri = `data:image/png;base64,${fs.readFileSync(LOGO_PATH).toString('base64')}`;

  const PATCH_COLORS = { 'Fully Patched': '#16a34a', 'Approved Pending': '#86c95e', 'Install Error': '#f59e0b', 'Reboot Required': '#dc2626', 'No Data': '#7f1d1d', 'No Policy': '#9aa3af' };
  const ANTIVIRUS_COLORS = { 'Running and Up to Date': '#16a34a', 'Not up to date': '#f59e0b', 'Not Running': '#dc2626', 'Not Detected': '#7f1d1d' };
  const SOFTWARE_COLORS = { Compliant: '#16a34a', 'Not Compliant': '#f59e0b', Unmanaged: '#9aa3af' };
  const donutFromLegend = (title, legend, colors) => {
    const segments = Object.entries(legend).map(([label, value]) => ({ label, value, color: colors[label] || '#9aa3af' }));
    const total = segments.reduce((sum, s) => sum + s.value, 0);
    return donutWidget(title, segments, total);
  };

  const dattoLive = report.dattoLive;
  const overallStatus = statusForScore(report.overallScore);

  const atAGlanceKpis = kpiTileRow([
    { label: 'Total Devices', value: report.totalDevices },
    { label: 'Open Alerts', value: report.alertsTotalCount, tier: report.alertsTotalCount > 0 ? 'bad' : 'good' },
    { label: 'Workstation Score', value: report.workstation ? `${Math.round(report.workstation.healthScore)}%` : '--' },
    { label: 'Server Score', value: report.server ? `${Math.round(report.server.healthScore)}%` : '--' },
  ]);

  const scorecardRows = [
    report.workstation && ['Workstation Patch Management', `${report.workstation.patch.score}%`, statusForScore(report.workstation.patch.score)],
    report.workstation && ['Workstation Software Compliance', `${report.workstation.software.score}%`, statusForScore(report.workstation.software.score)],
    report.workstation && ['Workstation Antivirus', `${report.workstation.antivirus.score}%`, statusForScore(report.workstation.antivirus.score)],
    report.server && ['Server Antivirus', `${report.server.antivirus.score}%`, statusForScore(report.server.antivirus.score)],
    ['Open Alerts (Critical/High)', String(report.alertsTotalCount), statusForScore(report.alertsTotalCount > 0 ? 50 : 100)],
    vendors.saasAlerts.status === 'ok' && vendors.saasAlerts.monitored && [
      'SaaS Alerts (30 days)',
      `${vendors.saasAlerts.criticalCount} critical, ${vendors.saasAlerts.mediumCount} medium`,
      statusForScore(vendors.saasAlerts.criticalCount > 0 ? 40 : vendors.saasAlerts.mediumCount > 0 ? 75 : 100),
    ],
    vendors.saasProtection.status === 'ok' && vendors.saasProtection.installed && ['SaaS Protection (Backup)', `${vendors.saasProtection.backupPercentage}%`, statusForScore(vendors.saasProtection.backupPercentage)],
  ].filter(Boolean);

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>${stylesCss}</style>
<style>${CSS}</style>
</head>
<body>

  <div class="pdf-cover">
    <div class="pdf-cover-row">
      <img class="logo" src="${logoDataUri}" alt="Ambient iT" />
      <div class="period">As Of<strong>${escapeHtml(formatDate(report.asOf))}</strong></div>
    </div>
    <h1>Managed Services Report</h1>
    <p class="subtitle">Prepared for ${escapeHtml(report.siteName)}</p>
  </div>

  <div class="pdf-section">
    <h2 class="pdf-heading">At a Glance</h2>
    <div class="pdf-widget-grid" style="align-items:center;">
      <div class="mtg-widget mtg-widget--gauge" style="flex:0 0 220px;">
        ${gaugeSvg(report.overallScore)}
        <p class="inline-subtext">Overall Health Score -- ${pillHtml(overallStatus)}</p>
      </div>
      <div style="flex:1 1 320px;">${atAGlanceKpis}</div>
    </div>
    ${commentary ? `<div class="pdf-callout"><strong>Executive Summary</strong>${escapeHtml(commentary.executiveSummary)}</div>` : ''}
    ${cardsRowHtml(commentary)}
  </div>

  <div class="pdf-section">
    <h2 class="pdf-heading">Scorecard</h2>
    <table class="pdf-table">
      <thead><tr><th>Area</th><th>Result</th><th style="width:110px;">Status</th></tr></thead>
      <tbody>${scorecardRows.map(([area, result, status]) => `<tr><td>${escapeHtml(area)}</td><td>${escapeHtml(result)}</td><td>${pillHtml(status)}</td></tr>`).join('')}</tbody>
    </table>
  </div>

  <div class="pdf-section pdf-page-break">
    <h2 class="pdf-heading">Device Health</h2>
    <div class="pdf-widget-grid">
      ${report.workstation ? donutFromLegend(`Workstations -- Patch Management (${report.workstation.patch.score}%)`, report.workstation.patch.legend, PATCH_COLORS) : ''}
      ${report.workstation ? donutFromLegend(`Workstations -- Software (${report.workstation.software.score}%)`, report.workstation.software.legend, SOFTWARE_COLORS) : ''}
      ${report.workstation ? donutFromLegend(`Workstations -- Antivirus (${report.workstation.antivirus.score}%)`, report.workstation.antivirus.legend, ANTIVIRUS_COLORS) : ''}
      ${report.server ? donutFromLegend(`Servers -- Antivirus (${report.server.antivirus.score}%)`, report.server.antivirus.legend, ANTIVIRUS_COLORS) : ''}
    </div>
    ${report.server ? '<p class="inline-subtext">Patch Management and Software Management are not handled through this platform for servers.</p>' : ''}
    ${deviceTableHtml(dattoLive)}
  </div>

  <div class="pdf-section pdf-page-break">
    <h2 class="pdf-heading">Other Systems</h2>
    <div class="pdf-widget-grid">${vendorCardsHtml(vendors)}</div>
  </div>

  ${
    commentary && commentary.recommendations && commentary.recommendations.length > 0
      ? `<div class="pdf-section pdf-page-break">${recommendationsTableHtml(commentary)}</div>`
      : ''
  }

</body>
</html>`;
}

module.exports = { buildReportHtml };
