const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

// Builds the branded Managed Services Report PDF directly with pdfkit --
// NOT a Puppeteer/Chrome HTML-to-PDF render (the first version of this
// file), by request after confirming live on production that launching a
// real browser from the AmbientDashboard Windows SERVICE (Local System,
// Session 0) fails every time (four different targeted fixes -- a
// package-local profile dir, extra launch flags, forced TEMP/TMP env
// vars, dumpio for diagnostics -- none changed the outcome even slightly,
// while the exact same operation works fine from an interactive session
// on the same machine with the same EDR), a well-documented, largely
// unfixable-from-code limitation of Session 0. pdfkit draws the PDF
// directly in-process -- no second process launched at all, so this
// class of problem doesn't apply. Same "pdfkit, not a browser" choice
// Invoice Intake's own email-pdf.js already made for its own (much
// simpler) PDF, just with real layout instead of plain flowing text.
const LOGO_PATH = path.join(__dirname, '..', 'shell', 'public', 'logo.png');

// Ambient iT's own brand colours, eyeballed from the real logo.png (no
// documented brand guide found in this repo).
const BRAND_PURPLE = '#2E2A7C';
const BRAND_GREEN = '#4DA64D';
const RED = '#dc2626';
const AMBER = '#d97706';
const MUTED = '#6b7280';
const INK = '#111827';
const BORDER = '#e5e7eb';
const CARD_BG = '#f9fafb';

const MARGIN = 40;

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function formatDateShort(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-AU');
}

// Same "On track / Watch / Action needed" 3-tier language the original
// DRG example report this was modeled on uses, mapped onto THIS
// dashboard's own existing good=green/warn=amber/bad=red colour meaning
// (scoreBadge()/kpiTileRow's own tiers already mean exactly that
// everywhere else on this dashboard) rather than the reference report's
// own blue-for-good scheme.
function statusForScore(score) {
  if (score === null || score === undefined) return { label: 'Unknown', color: MUTED };
  if (score >= 90) return { label: 'On track', color: BRAND_GREEN };
  if (score >= 70) return { label: 'Watch', color: AMBER };
  return { label: 'Action needed', color: RED };
}

function contentWidth(doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

// Starts a fresh page whenever the next block of the given height
// wouldn't fit -- the one page-break rule every section below shares,
// rather than each section re-deriving it.
function ensureSpace(doc, y, needed) {
  if (y + needed > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
    return doc.page.margins.top;
  }
  return y;
}

function drawPill(doc, x, y, label, color) {
  doc.font('Helvetica-Bold').fontSize(8);
  const w = doc.widthOfString(label) + 16;
  doc.roundedRect(x, y, w, 14, 7).fill(color);
  doc.fillColor('#ffffff').text(label, x, y + 3.5, { width: w, align: 'center' });
  doc.fillColor(INK);
  return w;
}

// `h` varies a lot by caller (a tall single score tile vs. 4 small tiles
// packed into the same overall height) -- font sizes and vertical
// offsets below are chosen from `h` itself rather than one fixed layout,
// so a short tile's value/label never collide the way a fixed offset
// tuned for the tall case did (confirmed live this session: literally
// overlapping text at the short tile height).
function drawTile(doc, x, y, w, h, label, value, color) {
  doc.roundedRect(x, y, w, h, 6).fillAndStroke(CARD_BG, BORDER);
  const compact = h < 40;
  const valueFontSize = compact ? 13 : 18;
  const labelFontSize = compact ? 6.5 : 7.5;
  doc.fillColor(color || INK).font('Helvetica-Bold').fontSize(valueFontSize).text(String(value), x + 4, y + 5, { width: w - 8, align: 'center' });
  doc.fillColor(MUTED).font('Helvetica').fontSize(labelFontSize).text(label, x + 4, y + h - (compact ? 11 : 18), { width: w - 8, align: 'center' });
}

// Cover header -- page 1 only, full-bleed navy band regardless of the
// document's own margins (pdfkit's margin option only affects where
// flowing text/the page-break boundary sits, not shapes drawn at
// explicit coordinates).
function drawCoverHeader(doc, report) {
  const pageWidth = doc.page.width;
  const bandHeight = 112;
  doc.rect(0, 0, pageWidth, bandHeight).fill(BRAND_PURPLE);

  try {
    doc.image(fs.readFileSync(LOGO_PATH), MARGIN, 20, { height: 34 });
  } catch (err) {
    console.error('live-reports: could not embed logo.png in PDF:', err.message);
  }

  doc.fillColor('#c9c6ec').font('Helvetica-Bold').fontSize(8).text('AS OF', pageWidth - MARGIN - 220, 24, { width: 220, align: 'right' });
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11).text(formatDate(report.asOf), pageWidth - MARGIN - 220, 36, { width: 220, align: 'right' });

  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(24).text('Managed Services Report', MARGIN, 66);
  doc.fillColor('#d9d7f0').font('Helvetica').fontSize(12).text(`Prepared for ${report.siteName}`, MARGIN, 94);

  doc.fillColor(INK);
  return bandHeight + 20;
}

function drawSectionHeading(doc, y, text) {
  doc.font('Helvetica-Bold').fontSize(13).fillColor(BRAND_PURPLE).text(text, MARGIN, y);
  const w = contentWidth(doc);
  doc.moveTo(MARGIN, y + 18).lineTo(MARGIN + w, y + 18).lineWidth(1.5).strokeColor(BRAND_PURPLE).stroke();
  doc.fillColor(INK);
  return y + 28;
}

function drawAtAGlance(doc, y, report) {
  y = drawSectionHeading(doc, y, 'At a Glance');
  const w = contentWidth(doc);
  const tileH = 78; // tall enough that each of the 4 packed sub-tiles below (h ~= 35) has real room for a value + label without colliding
  const scoreW = 130;
  const gap = 8;

  const status = statusForScore(report.overallScore);
  doc.roundedRect(MARGIN, y, scoreW, tileH, 6).fillAndStroke(CARD_BG, BORDER);
  doc.fillColor(status.color).font('Helvetica-Bold').fontSize(26).text(`${report.overallScore ?? '--'}%`, MARGIN, y + 12, { width: scoreW, align: 'center' });
  doc.fillColor(MUTED).font('Helvetica').fontSize(7.5).text('Overall Health Score', MARGIN, y + 46, { width: scoreW, align: 'center' });
  drawPill(doc, MARGIN + scoreW / 2 - 28, y + tileH - 20, status.label, status.color);

  const restX = MARGIN + scoreW + gap;
  const restW = w - scoreW - gap;
  const tileW = (restW - gap) / 2;
  const subH = (tileH - gap) / 2;
  drawTile(doc, restX, y, tileW, subH, 'Total Devices', report.totalDevices, INK);
  drawTile(doc, restX + tileW + gap, y, tileW, subH, 'Open Alerts', report.alertsTotalCount, report.alertsTotalCount > 0 ? RED : BRAND_GREEN);
  drawTile(doc, restX, y + subH + gap, tileW, subH, 'Workstation Score', report.workstation ? `${Math.round(report.workstation.healthScore)}%` : '--', INK);
  drawTile(doc, restX + tileW + gap, y + subH + gap, tileW, subH, 'Server Score', report.server ? `${Math.round(report.server.healthScore)}%` : '--', INK);

  return y + tileH + 18;
}

function drawCommentaryCards(doc, y, commentary) {
  const w = contentWidth(doc);
  doc.roundedRect(MARGIN, y, w, 0, 0); // no-op, keeps style consistent with callout below
  // Executive Summary callout
  doc.font('Helvetica').fontSize(9);
  const summaryHeight = doc.heightOfString(commentary.executiveSummary, { width: w - 24 }) + 34;
  y = ensureSpace(doc, y, summaryHeight);
  doc.roundedRect(MARGIN, y, w, summaryHeight, 4).fill('#f3f1fb');
  doc.fillColor(BRAND_PURPLE).font('Helvetica-Bold').fontSize(10).text('Executive Summary', MARGIN + 12, y + 10);
  doc.fillColor(INK).font('Helvetica').fontSize(9).text(commentary.executiveSummary, MARGIN + 12, y + 24, { width: w - 24 });
  y += summaryHeight + 14;

  const colGap = 10;
  const colW = (w - colGap * 2) / 3;
  const cols = [
    { title: 'On Track', color: BRAND_GREEN, items: commentary.onTrack },
    { title: 'Watch', color: AMBER, items: commentary.watch },
    { title: 'Action Needed', color: RED, items: commentary.actionNeeded },
  ];

  doc.font('Helvetica').fontSize(8);
  const bodyHeights = cols.map((c) => (c.items && c.items.length > 0 ? c.items.reduce((sum, item) => sum + doc.heightOfString(`• ${item}`, { width: colW - 16 }) + 3, 6) : 16));
  const cardHeight = Math.max(...bodyHeights) + 26;
  y = ensureSpace(doc, y, cardHeight);

  cols.forEach((col, i) => {
    const x = MARGIN + i * (colW + colGap);
    doc.roundedRect(x, y, colW, cardHeight, 4).fillAndStroke(CARD_BG, BORDER);
    doc.rect(x, y, colW, 20).fill(col.color);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9).text(col.title, x + 8, y + 5);
    let iy = y + 28;
    if (col.items && col.items.length > 0) {
      doc.font('Helvetica').fontSize(8).fillColor(INK);
      col.items.forEach((item) => {
        doc.text(`• ${item}`, x + 8, iy, { width: colW - 16 });
        iy = doc.y + 3;
      });
    } else {
      doc.font('Helvetica-Oblique').fontSize(8).fillColor(MUTED).text('Nothing to report', x + 8, iy);
    }
  });

  return y + cardHeight + 18;
}

function drawTable(doc, startY, columns, rows, { rowHeight = 20, headerHeight = 20 } = {}) {
  const x = MARGIN;
  const width = contentWidth(doc);
  let y = startY;

  const drawHeader = () => {
    doc.rect(x, y, width, headerHeight).fill(BRAND_PURPLE);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);
    let cx = x;
    columns.forEach((col) => {
      doc.text(col.label, cx + 6, y + headerHeight / 2 - 4, { width: col.width - 10 });
      cx += col.width;
    });
    y += headerHeight;
  };

  y = ensureSpace(doc, y, headerHeight + rowHeight);
  drawHeader();

  rows.forEach((row, i) => {
    if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = doc.page.margins.top;
      drawHeader();
    }
    if (i % 2 === 1) doc.rect(x, y, width, rowHeight).fill('#f9fafb');
    let cx = x;
    columns.forEach((col) => {
      if (col.render) {
        col.render(doc, cx + 6, y + rowHeight / 2 - 5, col.width - 10, row);
      } else {
        doc.fillColor(INK).font('Helvetica').fontSize(8).text(String(row[col.key] ?? ''), cx + 6, y + rowHeight / 2 - 5, { width: col.width - 10, ellipsis: true });
      }
      cx += col.width;
    });
    y += rowHeight;
  });

  return y;
}

function drawScorecard(doc, y, report, vendors) {
  y = drawSectionHeading(doc, y, 'Scorecard');
  const w = contentWidth(doc);
  const columns = [
    { key: 'area', label: 'AREA', width: w * 0.5 },
    { key: 'result', label: 'RESULT', width: w * 0.3 },
    {
      key: 'status',
      label: 'STATUS',
      width: w * 0.2,
      render: (doc, x, y, width, row) => drawPill(doc, x, y, row.status.label, row.status.color),
    },
  ];

  const rows = [
    report.workstation && { area: 'Workstation Patch Management', result: `${report.workstation.patch.score}%`, status: statusForScore(report.workstation.patch.score) },
    report.workstation && { area: 'Workstation Software Compliance', result: `${report.workstation.software.score}%`, status: statusForScore(report.workstation.software.score) },
    report.workstation && { area: 'Workstation Antivirus', result: `${report.workstation.antivirus.score}%`, status: statusForScore(report.workstation.antivirus.score) },
    report.server && { area: 'Server Antivirus', result: `${report.server.antivirus.score}%`, status: statusForScore(report.server.antivirus.score) },
    { area: 'Open Alerts (Critical/High)', result: String(report.alertsTotalCount), status: statusForScore(report.alertsTotalCount > 0 ? 50 : 100) },
    vendors.saasAlerts.status === 'ok' &&
      vendors.saasAlerts.monitored && {
        area: 'SaaS Alerts (30 days)',
        result: `${vendors.saasAlerts.criticalCount} critical, ${vendors.saasAlerts.mediumCount} medium`,
        status: statusForScore(vendors.saasAlerts.criticalCount > 0 ? 40 : vendors.saasAlerts.mediumCount > 0 ? 75 : 100),
      },
    vendors.saasProtection.status === 'ok' &&
      vendors.saasProtection.installed && { area: 'SaaS Protection (Backup)', result: `${vendors.saasProtection.backupPercentage}%`, status: statusForScore(vendors.saasProtection.backupPercentage) },
  ].filter(Boolean);

  return drawTable(doc, y, columns, rows, { rowHeight: 22, headerHeight: 20 }) + 18;
}

// Bar breakdown replaces the on-screen donut -- a true circular donut is
// a lot of fiddly manual arc math to get right in pdfkit for not much
// extra clarity over a simple stacked bar, which reads the segment
// proportions just as clearly.
function drawBreakdown(doc, x, y, w, title, legend, colors) {
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(BRAND_PURPLE).text(title, x, y, { width: w });
  y += 16;
  const total = Object.values(legend).reduce((a, b) => a + b, 0) || 1;
  const barH = 12;
  let bx = x;
  Object.entries(legend).forEach(([label, val]) => {
    if (val <= 0) return;
    const segW = (val / total) * w;
    doc.rect(bx, y, Math.max(segW, 0.5), barH).fill(colors[label] || '#9aa3af');
    bx += segW;
  });
  doc.rect(x, y, w, barH).lineWidth(0.5).strokeColor(BORDER).stroke();
  y += barH + 6;
  doc.font('Helvetica').fontSize(8);
  Object.entries(legend).forEach(([label, val]) => {
    doc.circle(x + 4, y + 4, 3).fill(colors[label] || '#9aa3af');
    doc.fillColor(INK).text(`${label}: ${val}`, x + 12, y, { width: w - 12 });
    y += 12;
  });
  return y + 6;
}

const PATCH_COLORS = { 'Fully Patched': '#16a34a', 'Approved Pending': '#86c95e', 'Install Error': '#f59e0b', 'Reboot Required': '#dc2626', 'No Data': '#7f1d1d', 'No Policy': '#9aa3af' };
const ANTIVIRUS_COLORS = { 'Running and Up to Date': '#16a34a', 'Not up to date': '#f59e0b', 'Not Running': '#dc2626', 'Not Detected': '#7f1d1d' };
const SOFTWARE_COLORS = { Compliant: '#16a34a', 'Not Compliant': '#f59e0b', Unmanaged: '#9aa3af' };

function drawDeviceHealth(doc, y, report) {
  y = drawSectionHeading(doc, y, 'Device Health');
  const w = contentWidth(doc);
  const colW = (w - 16) / 2;

  if (report.workstation) {
    const afterLeft = drawBreakdown(doc, MARGIN, y, colW, `Workstations -- Patch Management (${report.workstation.patch.score}%)`, report.workstation.patch.legend, PATCH_COLORS);
    const afterRight = drawBreakdown(doc, MARGIN + colW + 16, y, colW, `Workstations -- Software (${report.workstation.software.score}%)`, report.workstation.software.legend, SOFTWARE_COLORS);
    y = Math.max(afterLeft, afterRight) + 6;
  }
  if (report.workstation || report.server) {
    const leftY = report.workstation ? drawBreakdown(doc, MARGIN, y, colW, `Workstations -- Antivirus (${report.workstation.antivirus.score}%)`, report.workstation.antivirus.legend, ANTIVIRUS_COLORS) : y;
    const rightY = report.server ? drawBreakdown(doc, MARGIN + colW + 16, y, colW, `Servers -- Antivirus (${report.server.antivirus.score}%)`, report.server.antivirus.legend, ANTIVIRUS_COLORS) : y;
    y = Math.max(leftY, rightY) + 6;
  }
  if (report.server) {
    doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(MUTED).text('Patch Management and Software Management are not handled through this platform for servers.', MARGIN, y, { width: w });
    y += 16;
  }

  const devices = report.dattoLive && report.dattoLive.devices;
  if (devices && devices.length > 0) {
    const order = { stale: 0, unknown: 1, ageing: 2, recent: 3 };
    const freshnessLabel = { stale: 'Not seen 30+ days', ageing: 'Seen 7-30 days', recent: 'Seen <7 days', unknown: 'Unknown' };
    const sorted = [...devices].sort((a, b) => {
      const f = (order[a.freshness] ?? 9) - (order[b.freshness] ?? 9);
      if (f !== 0) return f;
      if (a.online !== b.online) return a.online ? 1 : -1;
      return (a.hostname || '').localeCompare(b.hostname || '');
    });

    y += 6;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(BRAND_PURPLE).text(`All Devices (${sorted.length}) -- oldest check-in first`, MARGIN, y);
    y += 16;

    const columns = [
      { key: 'hostname', label: 'DEVICE', width: w * 0.28 },
      { key: 'type', label: 'TYPE', width: w * 0.16 },
      { key: 'freshness', label: 'LAST SEEN', width: w * 0.22, render: (doc, x, y, width, row) => doc.fillColor(INK).font('Helvetica').fontSize(8).text(freshnessLabel[row.freshness] || row.freshness, x, y, { width, ellipsis: true }) },
      { key: 'online', label: 'ONLINE', width: w * 0.1, render: (doc, x, y, width, row) => doc.fillColor(INK).font('Helvetica').fontSize(8).text(row.online ? 'Yes' : 'No', x, y, { width }) },
      { key: 'lastUser', label: 'LAST USER', width: w * 0.24 },
    ];
    y = drawTable(doc, y, columns, sorted, { rowHeight: 16, headerHeight: 18 });
  }

  return y + 18;
}

function vendorCardRows(vendors) {
  const row = (label, status, lines) => ({ label, status, lines });
  return [
    row('SaaS Alerts', vendors.saasAlerts.status, vendors.saasAlerts.status === 'ok' && vendors.saasAlerts.monitored ? [`Critical: ${vendors.saasAlerts.criticalCount}`, `Medium: ${vendors.saasAlerts.mediumCount}`, `Low: ${vendors.saasAlerts.lowCount}`] : null),
    row(
      'SaaS Protection (Backup)',
      vendors.saasProtection.status,
      vendors.saasProtection.status === 'ok' && vendors.saasProtection.installed
        ? [`Backup health: ${vendors.saasProtection.backupPercentage}%`, `Billable seats: ${vendors.saasProtection.billableSeatCount ?? '--'}`, `App types healthy: ${vendors.saasProtection.appTypesHealthy}/${vendors.saasProtection.appTypesTotal}`]
        : null
    ),
    row(
      'Datto EDR',
      vendors.dattoEdr.status,
      vendors.dattoEdr.status === 'ok' && vendors.dattoEdr.installed
        ? [`Locations: ${vendors.dattoEdr.locationCount}`, `Agents (active): ${vendors.dattoEdr.agentCount} (${vendors.dattoEdr.activeAgentCount})`, `Open alerts: ${vendors.dattoEdr.alertCount}`]
        : null
    ),
    row('Huntress', vendors.huntress.status, vendors.huntress.status === 'ok' && vendors.huntress.installed ? [`Agents monitored: ${vendors.huntress.agentsCount ?? '--'}`, `Incident reports (lifetime): ${vendors.huntress.incidentReportsCount ?? '--'}`] : null),
    row('AutoElevate', vendors.autoElevate.status, vendors.autoElevate.status === 'ok' && vendors.autoElevate.installed && vendors.autoElevate.deployedSince ? [`Deployed since: ${formatDateShort(vendors.autoElevate.deployedSince)}`] : null),
  ];
}

function drawOtherSystems(doc, y, vendors) {
  y = drawSectionHeading(doc, y, 'Other Systems');
  const w = contentWidth(doc);
  const gap = 10;
  const colW = (w - gap) / 2;
  const rows = vendorCardRows(vendors);

  let colX = [MARGIN, MARGIN + colW + gap];
  let colY = [y, y];
  rows.forEach((row, i) => {
    const col = i % 2;
    const x = colX[col];
    let cy = colY[col];
    const lineCount = row.lines ? row.lines.length : 1;
    const h = 24 + lineCount * 12 + 6;
    cy = ensureSpace(doc, cy, h);
    doc.roundedRect(x, cy, colW, h, 4).fillAndStroke(row.lines ? '#ffffff' : CARD_BG, BORDER);
    doc.fillColor(row.lines ? BRAND_PURPLE : MUTED).font('Helvetica-Bold').fontSize(9.5).text(row.label, x + 10, cy + 8);
    let ly = cy + 22;
    if (row.lines) {
      doc.font('Helvetica').fontSize(8).fillColor(INK);
      row.lines.forEach((line) => {
        doc.text(line, x + 10, ly, { width: colW - 20 });
        ly += 12;
      });
    } else {
      doc.font('Helvetica-Oblique').fontSize(8).fillColor(MUTED).text(row.status === 'not-configured' ? 'Not connected' : 'Not installed for this client', x + 10, ly);
    }
    colY[col] = cy + h + gap;
  });

  return Math.max(colY[0], colY[1]) + 10;
}

function drawRecommendations(doc, y, commentary) {
  y = drawSectionHeading(doc, y, 'Our Recommendations');
  const w = contentWidth(doc);
  const columns = [
    {
      key: 'priority',
      label: 'PRIORITY',
      width: w * 0.16,
      render: (doc, x, y, width, row) => drawPill(doc, x, y, row.priority, row.priority === 'Action needed' ? RED : AMBER),
    },
    { key: 'recommendation', label: 'RECOMMENDATION', width: w * 0.42 },
    { key: 'whyItMatters', label: 'WHY IT MATTERS', width: w * 0.42 },
  ];
  return drawTable(doc, y, columns, commentary.recommendations, { rowHeight: 30, headerHeight: 20 }) + 18;
}

// Page numbers/footer, drawn in one final pass once every page exists --
// pdfkit's own bufferPages:true option (see buildReportPdf below) is
// what makes doc.switchToPage()/doc.bufferedPageRange() available at all
// here, since the total page count isn't known until everything above
// has already been drawn.
function addFootersAndPageNumbers(doc, footerText) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // The footer sits BELOW doc.page.margins.bottom on purpose (in the
    // margin area itself) -- confirmed live this session that pdfkit's
    // own .text() silently calls addPage() first whenever the given y
    // would land past maxY() (page.height - margins.bottom), REGARDLESS
    // of switchToPage() already having picked a specific existing page,
    // which was quietly doubling the real page count (an extra blank
    // page per real one, each holding just this footer). Zeroing the
    // bottom margin for just this one write sidesteps that check
    // entirely; restored right after so nothing else drawn later is
    // affected.
    const realBottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = doc.page.height - realBottomMargin + 12;
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED);
    doc.text(footerText, MARGIN, y, { width: contentWidth(doc) / 2, lineBreak: false });
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, doc.page.width - MARGIN - 150, y, { width: 150, align: 'right', lineBreak: false });
    doc.page.margins.bottom = realBottomMargin;
  }
}

function buildReportPdf({ report, vendors, commentary }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      let y = drawCoverHeader(doc, report);
      y = drawAtAGlance(doc, y, report);
      if (commentary) y = drawCommentaryCards(doc, y, commentary);
      y = drawScorecard(doc, y, report, vendors);

      doc.addPage();
      y = doc.page.margins.top;
      y = drawDeviceHealth(doc, y, report);

      doc.addPage();
      y = doc.page.margins.top;
      y = drawOtherSystems(doc, y, vendors);

      if (commentary && commentary.recommendations && commentary.recommendations.length > 0) {
        doc.addPage();
        y = doc.page.margins.top;
        drawRecommendations(doc, y, commentary);
      }

      addFootersAndPageNumbers(doc, `Ambient iT | Managed Services Report | ${report.siteName}`);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { buildReportPdf };
