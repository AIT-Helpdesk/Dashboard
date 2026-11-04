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

// Real semi-circle gauge -- same shape/bands/needle as the on-screen
// page's own gaugeSvg() (meeting-prep-report-render.js), redrawn with
// pdfkit's own SVG-arc path support (`doc.path('M.. A r r 0 0 1 ..')`,
// confirmed this session to exist -- pdfkit implements the full SVG path
// mini-language, arcs included, not just M/L/C) rather than the flat
// tile+pill this file used at first: that first cut was a deliberate
// "skip the arc math" simplification, but it's what the user is pointing
// at by "no gauges, completely different" -- this is the fix, not a new
// design. `x`,`y` is the box's top-left, `w` the box width the gauge
// should fill edge-to-edge; height follows the original 180x105 aspect
// ratio automatically. Returns the height actually drawn so the caller
// can place the label/pill below it without guessing.
function drawGauge(doc, x, y, w, score) {
  const scale = w / 180;
  const cx = x + w / 2;
  const cy = y + 90 * scale;
  const r = 75 * scale;
  const lw = 16 * scale;
  const stops = [0, 25, 50, 75, 100];
  const colors = ['#dc2626', '#f59e0b', '#86c95e', '#16a34a'];
  const point = (s) => {
    const a = ((180 - (s / 100) * 180) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy - r * Math.sin(a)];
  };

  doc.lineCap('round');
  stops.slice(0, -1).forEach((s0, i) => {
    const [x0, y0] = point(s0);
    const [x1, y1] = point(stops[i + 1]);
    const d = `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r.toFixed(2)} ${r.toFixed(2)} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
    doc.path(d).lineWidth(lw).strokeColor(colors[i]).stroke();
  });

  const clamped = Math.max(0, Math.min(100, score ?? 0));
  const [nx, ny] = point(clamped);
  doc.lineWidth(Math.max(2, 3 * scale)).strokeColor(INK);
  doc.moveTo(cx, cy).lineTo(nx, ny).stroke();
  doc.lineCap('butt');
  doc.circle(cx, cy, Math.max(3, 5 * scale)).fillColor(INK).fill();

  const status = statusForScore(score);
  const label = score === null || score === undefined ? '?' : `${score}%`;
  const fontSize = Math.max(12, 15 * scale);
  doc.fillColor(status.color).font('Helvetica-Bold').fontSize(fontSize);
  doc.text(label, x, cy - 12 * scale - fontSize / 2, { width: w, align: 'center' });
  doc.fillColor(INK);

  return 105 * scale;
}

// Real ring donut -- same shape as the on-screen page's own donutSvg()
// (meeting-prep-report-render.js), replacing the stacked-bar
// approximation this file started with for the same "no gauges,
// completely different" reason the gauge above was redrawn: a stacked bar
// reads proportions fine but doesn't look like the rest of the dashboard.
// Draws each non-zero segment as its own stroked arc starting at 12
// o'clock and sweeping clockwise -- the same angle convention
// donutSvg's stroke-dasharray trick produces, just drawn as real arcs
// since pdfkit has no dasharray-on-a-circle primitive. Legend lists every
// segment (zero-value included), matching donutWidget's own legend.
function drawDonutArcSegment(doc, cx, cy, r, startFrac, endFrac, lw, color) {
  const angleDeg = (frac) => -90 + frac * 360;
  const toPoint = (deg) => {
    const rad = (deg * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  };
  const sweepDeg = (endFrac - startFrac) * 360;
  doc.lineWidth(lw).strokeColor(color);
  if (sweepDeg >= 359.9) {
    doc.circle(cx, cy, r).stroke();
    return;
  }
  const [x0, y0] = toPoint(angleDeg(startFrac));
  const [x1, y1] = toPoint(angleDeg(endFrac));
  const largeArc = sweepDeg > 180 ? 1 : 0;
  const d = `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r.toFixed(2)} ${r.toFixed(2)} 0 ${largeArc} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  doc.path(d).stroke();
}

function drawDonut(doc, x, y, w, title, legend, colors) {
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(BRAND_PURPLE).text(title, x, y, { width: w });
  y += 16;

  const entries = Object.entries(legend);
  const total = entries.reduce((sum, [, v]) => sum + v, 0);
  const diameter = 64;
  const strokeW = 13;
  const cx = x + diameter / 2;
  const cy = y + diameter / 2;
  const r = diameter / 2 - strokeW / 2;

  doc.lineWidth(strokeW).strokeColor(BORDER);
  doc.circle(cx, cy, r).stroke();

  let cum = 0;
  entries.forEach(([label, val]) => {
    if (val <= 0 || total <= 0) return;
    const startFrac = cum / total;
    cum += val;
    const endFrac = cum / total;
    drawDonutArcSegment(doc, cx, cy, r, startFrac, endFrac, strokeW, colors[label] || '#9aa3af');
  });

  doc.fillColor(INK).font('Helvetica-Bold').fontSize(11).text(String(total), x, cy - 5, { width: diameter, align: 'center' });

  const legendX = x + diameter + 14;
  const legendW = Math.max(60, w - diameter - 14);
  let ly = y;
  doc.font('Helvetica').fontSize(8);
  entries.forEach(([label, val]) => {
    doc.circle(legendX + 3, ly + 5, 3).fillColor(colors[label] || '#9aa3af').fill();
    doc.fillColor(INK).text(`${label}: ${val}`, legendX + 11, ly, { width: legendW - 11 });
    ly = doc.y + 3;
  });

  doc.fillColor(INK).lineWidth(1);
  return Math.max(y + diameter, ly) + 6;
}

// Measures a donut widget's own natural content height (title + donut/
// legend block) WITHOUT drawing it -- same measure-then-draw split
// measureCyberCardHeight()/drawCyberCard() already use for the
// Cybersecurity Layers cards, reused here so Device Health's own donuts
// can sit in matching bordered cards (by request), each card sized to fit
// its own (variable -- legend length differs per category) content.
function measureDonutHeight(doc, w, legend) {
  const entries = Object.entries(legend);
  const diameter = 64;
  const legendW = Math.max(60, w - diameter - 14);
  doc.font('Helvetica').fontSize(8);
  let legendH = 0;
  entries.forEach(([label, val]) => {
    legendH += doc.heightOfString(`${label}: ${val}`, { width: legendW - 11 }) + 3;
  });
  return 16 + Math.max(diameter, legendH);
}

// A white bordered card (same style as the Cybersecurity Layers cards)
// wrapped around one drawDonut() call, at a caller-chosen height (so two
// cards sharing a row can be drawn at the SAME height and line up exactly
// -- see drawDonutRow() below). lineWidth(1) explicitly set right before
// the card border -- confirmed necessary: drawDonut()/drawDonutArcSegment()
// each set a thick 13px lineWidth for the donut ring itself and never
// reset it, which otherwise silently carries over into THIS rect's own
// border stroke (every card after the first in a row rendered with a
// thick grey halo around it, not a thin border).
function drawDonutCard(doc, x, y, w, h, title, legend, colors) {
  const pad = 10;
  doc.lineWidth(1).roundedRect(x, y, w, h, 4).fillAndStroke('#ffffff', BORDER);
  drawDonut(doc, x + pad, y + pad, w - pad * 2, title, legend, colors);
}

// Shared by drawDonutRow() (actually drawing) and drawDeviceHealth() (needs
// the height up front, before anything's drawn, to size the section's own
// background rect -- see drawDeviceHealth() below) -- kept as ONE
// calculation so the two can never drift apart.
function measureDonutRowHeight(doc, w, leftSpec, rightSpec) {
  const gap = 16;
  const colW = (w - gap) / 2;
  const pad = 10;
  const leftH = leftSpec ? measureDonutHeight(doc, colW - pad * 2, leftSpec.legend) + pad * 2 : 0;
  const rightH = rightSpec ? measureDonutHeight(doc, colW - pad * 2, rightSpec.legend) + pad * 2 : 0;
  return Math.max(leftH, rightH);
}

// One row of up to 2 donut cards (either slot can be null -- e.g. Servers
// has no Patch/Software row at all), both sized to the TALLER of the two
// so their borders line up symmetrically rather than each card hugging its
// own (possibly shorter) content height.
function drawDonutRow(doc, y, w, leftSpec, rightSpec) {
  const gap = 16;
  const colW = (w - gap) / 2;
  const rowH = measureDonutRowHeight(doc, w, leftSpec, rightSpec);
  if (leftSpec) drawDonutCard(doc, MARGIN, y, colW, rowH, leftSpec.title, leftSpec.legend, leftSpec.colors);
  if (rightSpec) drawDonutCard(doc, MARGIN + colW + gap, y, colW, rowH, rightSpec.title, rightSpec.legend, rightSpec.colors);
  return y + rowH;
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
// packed into the same overall height) -- font sizes are chosen from `h`
// itself rather than one fixed layout, so a short tile's value/label never
// collide the way a fixed offset tuned for the tall case did (confirmed
// live this session: literally overlapping text at the short tile height).
// The value+label PAIR is vertically centred as one block (not value
// pinned near the top / label pinned near the bottom, by request -- a
// taller tile just left a big dead gap in the middle with the number
// stuck up near the top edge, "looks dumb").
function drawTile(doc, x, y, w, h, label, value, color) {
  doc.roundedRect(x, y, w, h, 6).fillAndStroke(CARD_BG, BORDER);
  const compact = h < 40;
  const valueFontSize = compact ? 13 : 18;
  const labelFontSize = compact ? 6.5 : 7.5;
  const valueLineH = valueFontSize * 1.2;
  const labelLineH = labelFontSize * 1.2;
  const lineGap = 3;
  const blockH = valueLineH + lineGap + labelLineH;
  const blockY = y + Math.max(4, (h - blockH) / 2);
  doc.fillColor(color || INK).font('Helvetica-Bold').fontSize(valueFontSize).text(String(value), x + 4, blockY, { width: w - 8, align: 'center' });
  doc.fillColor(MUTED).font('Helvetica').fontSize(labelFontSize).text(label, x + 4, blockY + valueLineH + lineGap, { width: w - 8, align: 'center' });
}

// Cover header -- page 1 only, full-bleed navy band regardless of the
// document's own margins (pdfkit's margin option only affects where
// flowing text/the page-break boundary sits, not shapes drawn at
// explicit coordinates).
// White card with a thin green border, by request -- replaces the earlier
// full-bleed navy band entirely. Logo + date (no "AS OF" label anymore)
// stacked top-right; Client Name is now the main title, "Managed Services
// Report" moved down to the subtitle line (swapped from the original
// layout, by request). Box height is computed from the actual title
// height, not a fixed guess -- a long client name wrapping to 2 lines
// pushes the subtitle down with it instead of overlapping it.
function drawCoverHeader(doc, report) {
  const pageWidth = doc.page.width;
  const boxX = MARGIN;
  // doc.page.margins.top, not the raw MARGIN constant -- so the reduced
  // top margin (see buildReportPdf()'s own PDFDocument options) actually
  // gains page 1 some room too, not just every later page's own `y =
  // doc.page.margins.top` reset.
  const boxY = doc.page.margins.top;
  const boxW = pageWidth - MARGIN * 2;
  const pad = 16;
  const rightColW = 150;
  const leftColW = boxW - rightColW - pad * 2;

  doc.font('Helvetica-Bold').fontSize(20);
  const titleH = doc.heightOfString(report.siteName, { width: leftColW });
  const leftContentH = titleH + 6 + 14; // title + gap + subtitle line
  const rightContentH = 26 + 8 + 12; // logo height + gap + date line
  const boxH = Math.max(leftContentH, rightContentH, 70) + pad * 2;

  doc.roundedRect(boxX, boxY, boxW, boxH, 6).lineWidth(3).fillAndStroke('#ffffff', BRAND_GREEN);

  const rightX = boxX + boxW - pad - rightColW;
  try {
    doc.image(fs.readFileSync(LOGO_PATH), rightX, boxY + pad, { fit: [rightColW, 26], align: 'right' });
  } catch (err) {
    console.error('live-reports: could not embed logo.png in PDF:', err.message);
  }
  doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(9.5).text(formatDate(report.asOf), rightX, boxY + pad + 26 + 8, { width: rightColW, align: 'right' });

  // Bottom-left, not top-left, by request -- the logo/date stay top-right
  // where they were; only the client name + subtitle move.
  const leftStartY = boxY + boxH - pad - leftContentH;
  doc.fillColor(BRAND_PURPLE).font('Helvetica-Bold').fontSize(20).text(report.siteName, boxX + pad, leftStartY, { width: leftColW });
  doc.fillColor(MUTED).font('Helvetica').fontSize(12).text('Managed Services Report', boxX + pad, leftStartY + titleH + 6, { width: leftColW });

  doc.fillColor(INK);
  return boxY + boxH + 20;
}

function drawSectionHeading(doc, y, text) {
  doc.font('Helvetica-Bold').fontSize(13).fillColor(BRAND_PURPLE).text(text, MARGIN, y);
  const w = contentWidth(doc);
  doc.moveTo(MARGIN, y + 18).lineTo(MARGIN + w, y + 18).lineWidth(1.5).strokeColor(BRAND_PURPLE).stroke();
  doc.fillColor(INK);
  return y + 28;
}

function drawAtAGlance(doc, y, report) {
  y = drawSectionHeading(doc, y, 'Overall Health View');
  const w = contentWidth(doc);
  const gap = 8;
  // Box is 1/2 the content width now, by request -- but tileH is back to
  // its ORIGINAL fixed 112 (by request, "set the height to what it was
  // before the last change") so the Scorecard below it doesn't get pushed
  // into overrunning the page. A semicircle gauge's own height scales with
  // whatever width it's drawn at, so stretching it to fill a half-width
  // box would need far more height than 112 has room for -- instead the
  // gauge/label/pill group keeps the SAME size it always had (gaugeDrawW
  // below, the original box's own 130-16 padding) and is centred in the
  // new wider box, rather than stretched.
  const scoreW = w / 2 - gap / 2;
  const tileH = 112;
  const gaugeDrawW = 114;
  const gaugeX = MARGIN + (scoreW - gaugeDrawW) / 2;

  const status = statusForScore(report.overallScore);
  doc.roundedRect(MARGIN, y, scoreW, tileH, 6).fillAndStroke(CARD_BG, BORDER);
  const gaugeH = drawGauge(doc, gaugeX, y + 6, gaugeDrawW, report.overallScore);
  doc.fillColor(MUTED).font('Helvetica').fontSize(7.5).text('Overall Health Score', MARGIN, y + 6 + gaugeH - 8, { width: scoreW, align: 'center' });
  drawPill(doc, MARGIN + scoreW / 2 - 28, y + tileH - 20, status.label, status.color);

  // Same 2x2 layout as before, by request -- restW (and so tileW) shrank
  // to fit, now that scoreW takes half the row instead of a third.
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

function measureStatusCardBodyHeight(doc, w, items) {
  doc.font('Helvetica').fontSize(8);
  return items && items.length > 0 ? items.reduce((sum, item) => sum + doc.heightOfString(`• ${item}`, { width: w - 16 }) + 3, 6) : 16;
}

function drawStatusCard(doc, x, y, w, h, title, color, items) {
  doc.roundedRect(x, y, w, h, 4).fillAndStroke(CARD_BG, BORDER);
  doc.rect(x, y, w, 20).fill(color);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9).text(title, x + 8, y + 5);
  let iy = y + 28;
  if (items && items.length > 0) {
    doc.font('Helvetica').fontSize(8).fillColor(INK);
    items.forEach((item) => {
      doc.text(`• ${item}`, x + 8, iy, { width: w - 16 });
      iy = doc.y + 3;
    });
  } else {
    doc.font('Helvetica-Oblique').fontSize(8).fillColor(MUTED).text('Nothing to report', x + 8, iy);
  }
}

// Split into separate pieces (Executive Summary / On Track+Action Needed
// row / Watch), by request -- buildReportPdf() below needs to measure and
// conditionally reorder the Watch card on its own (moved to the top of the
// Device Health page when the full page 1 content doesn't fit), which a
// single monolithic draw-everything function couldn't support.
function drawExecutiveSummary(doc, y, commentary) {
  const w = contentWidth(doc);
  doc.font('Helvetica').fontSize(9);
  const summaryHeight = doc.heightOfString(commentary.executiveSummary, { width: w - 24 }) + 34;
  y = ensureSpace(doc, y, summaryHeight);
  doc.roundedRect(MARGIN, y, w, summaryHeight, 4).fill('#f3f1fb');
  doc.fillColor(BRAND_PURPLE).font('Helvetica-Bold').fontSize(10).text('Executive Summary', MARGIN + 12, y + 10);
  doc.fillColor(INK).font('Helvetica').fontSize(9).text(commentary.executiveSummary, MARGIN + 12, y + 24, { width: w - 24 });
  return y + summaryHeight + 14;
}

// On Track + Action Needed share a row, by request -- replaces the old
// 3-equal-column layout, which forced these two up to whatever Watch's own
// height happened to be (usually the longest list), wasting space in the
// shorter two. Watch itself is now a separate full-width card (see
// measureWatchHeight()/drawWatchCard() below) drawn either right after this
// row (when everything fits on page 1) or at the top of the Device Health
// page (when it doesn't) -- buildReportPdf() below decides which.
function measureTopRowHeight(doc, commentary) {
  const w = contentWidth(doc);
  const rowGap = 10;
  const topColW = (w - rowGap) / 2;
  const onTrackH = measureStatusCardBodyHeight(doc, topColW, commentary.onTrack);
  const actionH = measureStatusCardBodyHeight(doc, topColW, commentary.actionNeeded);
  return Math.max(onTrackH, actionH) + 26;
}
function drawTopRow(doc, y, commentary) {
  const w = contentWidth(doc);
  const rowGap = 10;
  const topColW = (w - rowGap) / 2;
  const topRowH = measureTopRowHeight(doc, commentary);
  y = ensureSpace(doc, y, topRowH);
  drawStatusCard(doc, MARGIN, y, topColW, topRowH, 'On Track', BRAND_GREEN, commentary.onTrack);
  drawStatusCard(doc, MARGIN + topColW + rowGap, y, topColW, topRowH, 'Action Needed', RED, commentary.actionNeeded);
  return y + topRowH;
}

function measureWatchHeight(doc, commentary) {
  const w = contentWidth(doc);
  return measureStatusCardBodyHeight(doc, w, commentary.watch) + 26;
}
function drawWatchCard(doc, y, commentary) {
  const w = contentWidth(doc);
  const watchH = measureWatchHeight(doc, commentary);
  y = ensureSpace(doc, y, watchH);
  drawStatusCard(doc, MARGIN, y, w, watchH, 'Watch', AMBER, commentary.watch);
  return y + watchH;
}

// Scorecard's own row count, without drawing it -- same filter logic
// drawScorecard() itself uses (kept in sync manually; both are short and
// read side by side), needed here only to ESTIMATE its height for the
// page-1-overrun check below. Scorecard's own cell text (area names/%
// results) is always short, fixed-shape strings that never wrap in
// practice, so rowHeight*count is a safe estimate, not just a guess.
function countScorecardRows(report, vendors) {
  return [
    report.assetManagement != null,
    report.monitoring != null,
    Boolean(report.workstation),
    Boolean(report.workstation),
    Boolean(report.workstation),
    Boolean(report.server),
    true, // Open Alerts, always shown
    vendors.saasAlerts.status === 'ok' && vendors.saasAlerts.monitored,
    vendors.saasProtection.status === 'ok' && vendors.saasProtection.installed,
  ].filter(Boolean).length;
}

function drawTable(doc, startY, columns, rows, { rowHeight = 20, headerHeight = 20, showHeader = true } = {}) {
  const x = MARGIN;
  const width = contentWidth(doc);
  let y = startY;

  // showHeader: false, by request, for the Scorecard specifically --
  // dropping its AREA/RESULT/STATUS header row saves just enough height
  // for the whole table to fit on one page instead of spilling a row or
  // two onto a second. A no-op here (not skipped at the call site) so the
  // page-break continuation below doesn't re-draw a header that was never
  // shown in the first place.
  const drawHeader = () => {
    if (!showHeader) return;
    doc.rect(x, y, width, headerHeight).fill(BRAND_PURPLE);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);
    let cx = x;
    columns.forEach((col) => {
      doc.text(col.label, cx + 6, y + headerHeight / 2 - 4, { width: col.width - 10 });
      cx += col.width;
    });
    y += headerHeight;
  };

  y = ensureSpace(doc, y, (showHeader ? headerHeight : 0) + rowHeight);
  drawHeader();

  rows.forEach((row, i) => {
    // Row height grows to fit whatever the tallest PLAIN-TEXT cell actually
    // needs (a `render` cell -- a pill, say -- is assumed short/fixed and
    // isn't measured) -- fixes a real clipping bug found this session: the
    // Recommendations table's "Why It Matters" column can genuinely wrap to
    // 3 lines of real AI-written text, which the old fixed rowHeight (sized
    // for 2 lines) silently cut off into the next row's background.
    doc.font('Helvetica').fontSize(8);
    let thisRowHeight = rowHeight;
    columns.forEach((col) => {
      if (col.render) return;
      const h = doc.heightOfString(String(row[col.key] ?? ''), { width: col.width - 10 }) + 10;
      if (h > thisRowHeight) thisRowHeight = h;
    });

    if (y + thisRowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = doc.page.margins.top;
      drawHeader();
    }
    if (i % 2 === 1) doc.rect(x, y, width, thisRowHeight).fill('#f9fafb');
    let cx = x;
    columns.forEach((col) => {
      if (col.render) {
        col.render(doc, cx + 6, y + thisRowHeight / 2 - 5, col.width - 10, row);
      } else {
        doc.fillColor(INK).font('Helvetica').fontSize(8).text(String(row[col.key] ?? ''), cx + 6, y + 5, { width: col.width - 10 });
      }
      cx += col.width;
    });
    y += thisRowHeight;
  });

  return y;
}

// Scorecard-only status label, by request -- "Action needed" reads as
// "In Progress" here (a lower score on the Scorecard table reads as
// actively being worked through, not a fixed hard failure), while every
// OTHER use of statusForScore() (At a Glance's own gauge status pill) is
// untouched -- the request was scoped to "on the scorecard" specifically.
function scorecardStatus(score) {
  const status = statusForScore(score);
  return status.label === 'Action needed' ? { label: 'In Progress', color: status.color } : status;
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
    // First 2 entries, by request -- live-computed proxies, not Datto's
    // own real Asset Management/Monitoring figures (see
    // assetManagementScore()/monitoringScore() in live-reports/server.js
    // for exactly what each one checks and why).
    report.assetManagement != null && { area: 'Asset Management', result: `${report.assetManagement}%`, status: scorecardStatus(report.assetManagement) },
    report.monitoring != null && { area: 'Monitoring', result: `${report.monitoring}%`, status: scorecardStatus(report.monitoring) },
    report.workstation && { area: 'Workstation Patch Management', result: `${report.workstation.patch.score}%`, status: scorecardStatus(report.workstation.patch.score) },
    report.workstation && { area: 'Workstation Software Compliance', result: `${report.workstation.software.score}%`, status: scorecardStatus(report.workstation.software.score) },
    report.workstation && { area: 'Workstation Antivirus', result: `${report.workstation.antivirus.score}%`, status: scorecardStatus(report.workstation.antivirus.score) },
    report.server && { area: 'Server Antivirus', result: `${report.server.antivirus.score}%`, status: scorecardStatus(report.server.antivirus.score) },
    { area: 'Open Alerts (Critical/High)', result: String(report.alertsTotalCount), status: scorecardStatus(report.alertsTotalCount > 0 ? 50 : 100) },
    vendors.saasAlerts.status === 'ok' &&
      vendors.saasAlerts.monitored && {
        area: 'SaaS Alerts (30 days)',
        result: `${vendors.saasAlerts.criticalCount} critical, ${vendors.saasAlerts.mediumCount} medium`,
        status: scorecardStatus(vendors.saasAlerts.criticalCount > 0 ? 40 : vendors.saasAlerts.mediumCount > 0 ? 75 : 100),
      },
    vendors.saasProtection.status === 'ok' &&
      vendors.saasProtection.installed && { area: 'SaaS Protection (Backup)', result: `${vendors.saasProtection.backupPercentage}%`, status: scorecardStatus(vendors.saasProtection.backupPercentage) },
  ].filter(Boolean);

  // No header row, by request -- dropping AREA/RESULT/STATUS is what makes
  // the whole table fit on one page instead of spilling onto a second.
  // rowHeight trimmed slightly (22 -> 19), by request, to help page 1 fit
  // without overrunning -- drawTable()'s own per-row height still grows
  // past this for any row whose real content needs more, so nothing here
  // risks clipping, just a smaller minimum.
  return drawTable(doc, y, columns, rows, { rowHeight: 19, headerHeight: 20, showHeader: false }) + 18;
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

// Donut breakdowns only -- the big device-by-device table used to live
// right under these on the same page; moved to its own drawDeviceList()
// below, now placed right before Recommendations instead (by request),
// so this function stops reaching into report.dattoLive at all.
// Asset Management / Monitoring breakdown tables, by request ("I thought
// you were going to give me some widgets and device info") -- same data as
// client.js's own assetManagementTableHtml()/monitoringTableHtml(), drawn
// here with the existing generic drawTable() helper instead of a second
// table implementation. Placed at the top of the Device Health page (see
// buildReportPdf() below) -- that page already starts fresh, and these two
// scores feed directly into the same Overall Health Score the donuts below
// them are also part of.
function drawAssetManagementTable(doc, y, detail) {
  if (!detail || !detail.checks || detail.checks.length === 0) return y;
  y = drawSectionHeading(doc, y, `Asset Management${detail.score != null ? ` (${detail.score}%)` : ''}`);
  const w = contentWidth(doc);
  const columns = [
    { key: 'label', label: 'CHECK', width: w * 0.55 },
    { key: 'passedOf', label: 'PASSED', width: w * 0.25 },
    { key: 'score', label: 'SCORE', width: w * 0.2 },
  ];
  const rows = detail.checks.map((c) => ({ label: c.label, passedOf: `${c.passed} / ${c.total}`, score: c.score == null ? 'No data' : `${c.score}%` }));
  return drawTable(doc, y, columns, rows, { rowHeight: 18, headerHeight: 18 }) + 14;
}
function drawMonitoringTable(doc, y, detail) {
  if (!detail || !detail.byPriority) return y;
  y = drawSectionHeading(doc, y, `Monitoring (${detail.score}%)`);
  const w = contentWidth(doc);
  const columns = [
    { key: 'priority', label: 'PRIORITY', width: w * 0.3 },
    { key: 'raised', label: 'RAISED', width: w * 0.175 },
    { key: 'resolved', label: 'RESOLVED', width: w * 0.175 },
    { key: 'unresolved', label: 'UNRESOLVED', width: w * 0.175 },
    { key: 'score', label: 'SCORE', width: w * 0.175 },
  ];
  const rows = detail.byPriority.map((p) => ({ priority: p.priority, raised: p.raised, resolved: p.resolved, unresolved: p.unresolved, score: `${p.score}%` }));
  return drawTable(doc, y, columns, rows, { rowHeight: 16, headerHeight: 18 }) + 14;
}

function drawDeviceHealth(doc, y, report) {
  y = drawAssetManagementTable(doc, y, report.assetManagementDetail);
  y = drawMonitoringTable(doc, y, report.monitoringDetail);
  // Extra breathing room before Device Health, by request -- the Monitoring
  // table's own trailing gap (14px, drawMonitoringTable above) read as too
  // tight, same "bigger gap for visibility" fix as the Understanding Your
  // Scores -> Our Recommendations gap elsewhere in this file.
  y += 16;
  y = drawSectionHeading(doc, y, 'Device Health');
  // A bit more room under the heading too, by request ("a little more
  // spacing... top and bottom").
  y += 10;
  const w = contentWidth(doc);
  // Rows of bordered cards now (drawDonutRow()/drawDonutCard() above), not
  // bare donuts floating on the page, by request ("put nice boxes around
  // the Device Health widgets... line them up symmetrically") -- each row's
  // 2 cards share one height (the taller of the two) so their borders
  // align, same card look the Cybersecurity Systems section already uses.
  const rowGap = 14; // was 6 -- more breathing room between rows, by request
  const bgPad = 10;

  const row1 = report.workstation
    ? [
        { title: `Workstations -- Patch Management (${report.workstation.patch.score}%)`, legend: report.workstation.patch.legend, colors: PATCH_COLORS },
        { title: `Workstations -- Software (${report.workstation.software.score}%)`, legend: report.workstation.software.legend, colors: SOFTWARE_COLORS },
      ]
    : null;
  const row2 =
    report.workstation || report.server
      ? [
          report.workstation ? { title: `Workstations -- Antivirus (${report.workstation.antivirus.score}%)`, legend: report.workstation.antivirus.legend, colors: ANTIVIRUS_COLORS } : null,
          report.server ? { title: `Servers -- Antivirus (${report.server.antivirus.score}%)`, legend: report.server.antivirus.legend, colors: ANTIVIRUS_COLORS } : null,
        ]
      : null;

  if (row1 || row2) {
    // Same solid background treatment as Cybersecurity Systems
    // (drawCybersecurityLayers()), by request -- measured up front (pure
    // arithmetic, the same measureDonutRowHeight() drawDonutRow() itself
    // uses, so the two can never drift apart) so it can be drawn FIRST,
    // with the white cards on top of it after.
    const row1H = row1 ? measureDonutRowHeight(doc, w, row1[0], row1[1]) : 0;
    const row2H = row2 ? measureDonutRowHeight(doc, w, row2[0], row2[1]) : 0;
    const totalH = row1H + (row1 && row2 ? rowGap : 0) + row2H;
    doc.roundedRect(MARGIN - bgPad, y - bgPad, w + bgPad * 2, totalH + bgPad * 2, 6).fill(BRAND_PURPLE);

    if (row1) {
      y = drawDonutRow(doc, y, w, row1[0], row1[1]);
      y += rowGap;
    }
    if (row2) {
      y = drawDonutRow(doc, y, w, row2[0], row2[1]);
      y += rowGap;
    }
  }

  if (report.server) {
    doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(MUTED).text('Patch Management and Software Management are not handled through this platform for servers.', MARGIN, y, { width: w });
    y += 16;
  }

  return y + 14;
}

// Microsoft License Counts, by request ("add a set of Microsoft license
// counts... Use the Product counts from the M365 Contract in Autotask") --
// right after All Devices. Same status-handling/messaging as the on-screen
// page's own m365LicensesHtml() (client.js) -- see server.js's own
// getM365LicenseCounts() for exactly how these counts are derived and why
// an ambiguous/missing Autotask company match is surfaced honestly rather
// than guessed past.
function drawM365LicensesTable(doc, y, m365) {
  if (!m365) return y;
  // No data found (ambiguous company match / company not found / no
  // active M365 contract / a load error) -- section is left off the PDF
  // entirely, by request. On-screen still explains why (client.js's own
  // m365LicensesHtml()), just not here.
  if (m365.status !== 'ok') return y;
  if (!m365.items || m365.items.length === 0) return y;

  const w = contentWidth(doc);

  // Whole section forced onto a fresh page if it wouldn't otherwise fit,
  // by request -- the earlier plain ensureSpace(doc, y, 60) only guarded
  // the heading itself, not the real table height, which meant the
  // heading could land alone at the bottom of a page with the entire
  // table pushed to the next one (confirmed on a real PDF). Estimated
  // here the same way the Watch-reflow page-1 check elsewhere in this
  // file does -- rowHeight(18) * row count, product/term text is always
  // short enough not to wrap in practice, so this is a safe estimate, not
  // just a guess.
  const estimatedHeight = 28 + m365.items.length * 18 + 18;
  const pageBottom = doc.page.height - doc.page.margins.bottom;
  if (y + estimatedHeight > pageBottom) {
    doc.addPage();
    y = doc.page.margins.top;
  }

  // No "(from contract)" suffix on the PDF, by request -- on-screen still
  // shows it (client.js's own m365LicensesHtml()), just not here.
  y = drawSectionHeading(doc, y, 'Microsoft License Counts');

  // No header row, by request ("Product / Count... seems kind of
  // obvious") -- same showHeader: false the Scorecard table already uses
  // for the same reason. Term (Monthly/Annual) is its own column now, by
  // request -- "--" when Autotask's own invoiceDescription doesn't name
  // one (a real case, see parseM365Product()'s own comment, server.js).
  const columns = [
    { key: 'product', label: 'PRODUCT', width: w * 0.55 },
    { key: 'term', label: 'TERM', width: w * 0.25 },
    { key: 'count', label: 'COUNT', width: w * 0.2 },
  ];
  const rows = m365.items.map((item) => ({ product: item.product, term: item.term || '--', count: String(item.count) }));
  return drawTable(doc, y, columns, rows, { rowHeight: 18, headerHeight: 18, showHeader: false }) + 18;
}

// The full device-by-device table -- its own section now, placed right
// before Recommendations (by request), not folded into Device Health
// above anymore.
function drawDeviceList(doc, y, report) {
  const devices = report.dattoLive && report.dattoLive.devices;
  if (!devices || devices.length === 0) return y;
  const w = contentWidth(doc);

  const order = { stale: 0, unknown: 1, ageing: 2, recent: 3 };
  const freshnessLabel = { stale: 'Not seen 30+ days', ageing: 'Seen 7-30 days', recent: 'Seen <7 days', unknown: 'Unknown' };
  const sorted = [...devices].sort((a, b) => {
    const f = (order[a.freshness] ?? 9) - (order[b.freshness] ?? 9);
    if (f !== 0) return f;
    if (a.online !== b.online) return a.online ? 1 : -1;
    return (a.hostname || '').localeCompare(b.hostname || '');
  });

  y = drawSectionHeading(doc, y, `All Devices (${sorted.length})`);
  doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(MUTED).text('Oldest check-in first.', MARGIN, y);
  y += 14;

  // Disk Used % replaces Online, by request (matching Datto's own Storage
  // Report's own coloured-bar-+-%-used column) -- Device shrunk from 0.28
  // to 0.22 to make room. Same 15%-free / 85%-used threshold Asset
  // Management's own disk check already uses (DISK_FREE_PERCENT_THRESHOLD)
  // for the red cutoff, so a red bar here lines up with what actually
  // fails that scorecard check; amber is an earlier "getting tight"
  // warning, not itself a failure.
  const columns = [
    { key: 'hostname', label: 'DEVICE NAME', width: w * 0.22 },
    { key: 'type', label: 'TYPE', width: w * 0.16 },
    { key: 'freshness', label: 'LAST SEEN', width: w * 0.22, render: (doc, x, y, width, row) => doc.fillColor(INK).font('Helvetica').fontSize(8).text(freshnessLabel[row.freshness] || row.freshness, x, y, { width, ellipsis: true }) },
    {
      key: 'diskUsedPercent',
      label: 'DISK USED',
      width: w * 0.16,
      render: (doc, x, y, width, row) => {
        if (row.diskUsedPercent == null) {
          doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(7.5).text('No data', x, y, { width });
          return;
        }
        const pct = row.diskUsedPercent;
        const color = pct >= 85 ? RED : pct >= 70 ? AMBER : BRAND_GREEN;
        const barW = Math.min(60, width * 0.5);
        const barH = 7;
        const barY = y + 1;
        doc.rect(x, barY, barW, barH).fill(BORDER);
        doc.rect(x, barY, Math.max(2, (barW * Math.min(100, pct)) / 100), barH).fill(color);
        doc.fillColor(INK).font('Helvetica').fontSize(7.5).text(`${pct.toFixed(1)}%`, x + barW + 6, y, { width: width - barW - 6 });
      },
    },
    { key: 'lastUser', label: 'LAST USER', width: w * 0.24 },
  ];
  y = drawTable(doc, y, columns, sorted, { rowHeight: 16, headerHeight: 18 });

  return y + 18;
}

// Cybersecurity Layers (renamed from "Other Systems", by request) --
// rebuilt to use the same KPI-tile-row look the on-screen page's own
// vendor widgets use (kpiTileRow(), meeting-prep-report-render.js)
// instead of plain text lines, via drawTile() (already used for At a
// Glance's own tiles) rather than a second tile-drawing implementation.
// No placeholder card for a vendor with nothing live to show, same as the
// on-screen page's own vendorWidgetsHtml() -- "a vendor with nothing live
// just contributes no card at all, no placeholder of any kind".
// `cols` defaults to one row (every tile across); pass a smaller `cols` to
// wrap into a grid instead -- added for Datto EDR's own 4 tiles (by
// request, 2x2 instead of a cramped single row of 4).
function kpiTileGridRows(tileCount, cols) {
  return Math.ceil(tileCount / cols);
}
function drawKpiTileRow(doc, x, y, w, tiles, cols = tiles.length, h = 38) {
  const gap = 6;
  const tileW = (w - gap * (cols - 1)) / cols;
  tiles.forEach((t, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const tx = x + col * (tileW + gap);
    const ty = y + row * (h + gap);
    const color = t.tier === 'good' ? BRAND_GREEN : t.tier === 'warn' ? AMBER : t.tier === 'bad' ? RED : INK;
    drawTile(doc, tx, ty, tileW, h, t.label, t.value, color);
  });
  return y + kpiTileGridRows(tiles.length, cols) * h + (kpiTileGridRows(tiles.length, cols) - 1) * gap;
}

function vendorCardSpecs(vendors) {
  const specs = [];

  // SaaS Alerts -- critical-severity Top Events coloured red, by request
  // (same severity data buildSaasAlertsSummary() now carries through).
  if (vendors.saasAlerts.status === 'ok' && vendors.saasAlerts.monitored) {
    const sa = vendors.saasAlerts;
    specs.push({
      title: `SaaS Alerts (Last ${sa.windowDays} Days)`,
      kpis: [
        { label: 'Critical', value: sa.criticalCount, tier: sa.criticalCount > 0 ? 'bad' : 'good' },
        { label: 'Medium', value: sa.mediumCount, tier: sa.mediumCount > 0 ? 'warn' : 'good' },
        { label: 'Low', value: sa.lowCount },
      ],
      // Counts shown are each event name's own REAL critical/medium
      // counts, never merged into one combined number -- confirmed live
      // this session (Back 2 Basics) that merging them made the
      // red-coloured numbers add up to MORE than the real Critical tile, a
      // genuine accuracy bug a client could (and did) catch. See
      // buildSaasAlertsSummary()'s own comment in server.js.
      lines:
        sa.topEvents.length > 0
          ? sa.topEvents.map((e) => ({
              text: `${e.name} (${e.criticalCount > 0 && e.mediumCount > 0 ? `${e.criticalCount} critical, ${e.mediumCount} medium` : e.criticalCount || e.mediumCount})`,
              color: e.criticalCount > 0 ? RED : INK,
              bold: e.criticalCount > 0,
            }))
          : [{ text: 'No alerts in this window.', color: MUTED, italic: true }],
    });
  }

  // SaaS Protection -- per-app (Email/OneDrive/SharePoint/Teams) seat
  // breakdown, by request, replacing the old single "Needs attention"
  // summary line (this covers the same unhealthy-app information, just
  // per-app and with a seat count). "Billable Seats" relabelled "Seats",
  // by request.
  if (vendors.saasProtection.status === 'ok' && vendors.saasProtection.installed) {
    const sp = vendors.saasProtection;
    const tier = sp.backupPercentage == null ? undefined : sp.backupPercentage >= 95 ? 'good' : sp.backupPercentage >= 70 ? 'warn' : 'bad';
    specs.push({
      title: 'SaaS Backups',
      kpis: [
        { label: 'Backup %', value: sp.backupPercentage ?? '--', tier },
        { label: 'Seats', value: sp.billableSeatCount ?? '--' },
        { label: 'App Types Healthy', value: `${sp.appTypesHealthy}/${sp.appTypesTotal}` },
      ],
      // One consolidated, wrapped line (mixed-colour `segments`, not one
      // line per app) sitting right under the tile row, by request --
      // replaces the earlier 4-line stacked list.
      lines: [
        {
          segments: sp.appBreakdown.map((a) => {
            const seatText = a.seatCount != null ? `${a.seatCount} seat${a.seatCount === 1 ? '' : 's'}` : a.status;
            return { text: `${a.label}: ${seatText}`, color: a.healthy ? INK : AMBER };
          }),
        },
      ],
    });
  }

  // Datto EDR -- Locations tile removed, Alerts (30 Days) tile added, by
  // request. See buildDattoEdrSummary()'s own comment for how
  // alertCount30d is derived (the API itself has no working date filter).
  if (vendors.dattoEdr.status === 'ok' && vendors.dattoEdr.installed) {
    const edr = vendors.dattoEdr;
    specs.push({
      title: 'Datto EDR',
      // 2x2 grid, by request (kpiCols) -- was a cramped single row of 4.
      kpiCols: 2,
      kpis: [
        { label: 'Agents', value: edr.agentCount },
        { label: 'Active', value: edr.activeAgentCount },
        { label: 'Open Alerts', value: edr.alertCount, tier: edr.alertCount > 0 ? 'bad' : 'good' },
        { label: 'Alerts (30d)', value: edr.alertCount30d, tier: edr.alertCount30d > 0 ? 'warn' : 'good' },
      ],
      lines: edr.lastScannedOn ? [{ text: `Last scanned: ${formatDate(edr.lastScannedOn)}`, color: MUTED, italic: true }] : [],
    });
  }

  // Huntress -- caption shortened to just "Lifetime total incidents.", by request.
  if (vendors.huntress.status === 'ok' && vendors.huntress.installed) {
    const h = vendors.huntress;
    const kpis = [
      { label: 'Agents Monitored', value: h.agentsCount ?? '--' },
      { label: 'Incident Reports', value: h.incidentReportsCount ?? '--', tier: h.incidentReportsCount > 0 ? 'warn' : 'good' },
    ];
    if (h.microsoft365UsersCount) kpis.push({ label: 'M365 Users', value: h.microsoft365UsersCount });
    specs.push({ title: 'Huntress', kpis, lines: [{ text: 'Lifetime total incidents.', color: MUTED, italic: true }] });
  }

  if (vendors.autoElevate.status === 'ok' && vendors.autoElevate.installed && vendors.autoElevate.deployedSince) {
    specs.push({ title: 'AutoElevate', kpis: [], lines: [{ text: `Deployed since ${formatDateShort(vendors.autoElevate.deployedSince)}.`, color: INK }] });
  }

  return specs;
}

function measureCyberCardHeight(doc, w, spec) {
  let h = 8 + 16; // top padding + title line
  if (spec.kpis.length > 0) {
    const cols = spec.kpiCols || spec.kpis.length;
    const rows = kpiTileGridRows(spec.kpis.length, cols);
    h += rows * 38 + (rows - 1) * 6 + 8; // tile grid + gap
  }
  doc.font('Helvetica').fontSize(8);
  spec.lines.forEach((line) => {
    const text = line.segments ? line.segments.map((s) => s.text).join('   ') : line.text;
    h += doc.heightOfString(text, { width: w - 20 }) + 2;
  });
  return h + 8; // bottom padding
}

function drawCyberCard(doc, x, y, w, spec) {
  const h = measureCyberCardHeight(doc, w, spec);
  doc.roundedRect(x, y, w, h, 4).fillAndStroke('#ffffff', BORDER);
  doc.fillColor(BRAND_PURPLE).font('Helvetica-Bold').fontSize(9.5).text(spec.title, x + 10, y + 8, { width: w - 20 });
  let cy = y + 24;
  if (spec.kpis.length > 0) {
    cy = drawKpiTileRow(doc, x + 10, cy, w - 20, spec.kpis, spec.kpiCols || spec.kpis.length) + 8;
  }
  spec.lines.forEach((line) => {
    if (line.segments) {
      // Mixed-colour single line (SaaS Backups' own per-app breakdown,
      // by request) -- pdfkit's own continued-text chaining, width/x/y set
      // only on the FIRST segment of the chain (pdfkit tracks flow for the
      // rest itself).
      doc.font('Helvetica').fontSize(8);
      line.segments.forEach((seg, i) => {
        doc.fillColor(seg.color || INK);
        const text = seg.text + (i < line.segments.length - 1 ? '   ' : '');
        if (i === 0) doc.text(text, x + 10, cy, { continued: i < line.segments.length - 1, width: w - 20 });
        else doc.text(text, { continued: i < line.segments.length - 1 });
      });
      cy = doc.y + 2;
      return;
    }
    doc
      .font(line.italic ? 'Helvetica-Oblique' : line.bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(8)
      .fillColor(line.color || INK);
    doc.text(line.text, x + 10, cy, { width: w - 20 });
    cy = doc.y + 2;
  });
  doc.fillColor(INK);
  return h;
}

function drawCybersecurityLayers(doc, y, vendors) {
  // Always its own fresh page now, by request -- the earlier "continues
  // straight on from Device Health when it fits" behaviour is gone.
  doc.addPage();
  const pageTop = doc.page.margins.top;
  const pageBottom = doc.page.height - doc.page.margins.bottom;
  y = pageTop;
  y = drawSectionHeading(doc, y, 'Cybersecurity Systems');
  const w = contentWidth(doc);
  const gap = 10;
  const colW = (w - gap) / 2;
  const specs = vendorCardSpecs(vendors);

  // Layout simulated first (pure arithmetic, nothing drawn yet) -- same
  // shortest-column-first packing as before (fixes a real bug confirmed on
  // a real PDF: strict i%2 alternation left one tall card, e.g. SaaS Alerts
  // with several Top Events lines, stranding the next card assigned to
  // that column far down the page) -- so the solid background behind the
  // whole grid (by request, "around them and between", like the table
  // header purple -- not inside each card) can be drawn FIRST, sized to
  // exactly what each page's own cards need, with the white cards drawn on
  // top of it after. Grouped into `pages` in case the grid itself ever
  // needs to spill onto more than one (unusual, but the same per-page
  // background treatment still applies if it does).
  const colX = [MARGIN, MARGIN + colW + gap];
  let colY = [y, y];
  const pages = [[]];
  specs.forEach((spec) => {
    const h = measureCyberCardHeight(doc, colW, spec);
    const col = colY[0] <= colY[1] ? 0 : 1;
    let cy = colY[col];
    if (cy + h > pageBottom) {
      cy = pageTop;
      colY = [cy, cy];
      pages.push([]);
    }
    pages[pages.length - 1].push({ spec, x: colX[col], y: cy, h });
    colY[col] = cy + h + gap;
  });

  const bgPad = 10;
  pages.forEach((items, pageIndex) => {
    if (pageIndex > 0) doc.addPage();
    if (items.length === 0) return;
    const top = pageIndex === 0 ? y : pageTop;
    const bottom = Math.max(...items.map((it) => it.y + it.h));
    // Top padding now matches the bottom (bgPad both sides), by request --
    // the cards' own y positions (computed above, starting at `top`) don't
    // move, only the purple rect's own top edge extends upward by bgPad to
    // sit evenly above them, same amount of purple as below.
    doc.roundedRect(MARGIN - bgPad, top - bgPad, w + bgPad * 2, bottom - top + bgPad * 2, 6).fill(BRAND_PURPLE);
    items.forEach((it) => drawCyberCard(doc, it.x, it.y, colW, it.spec));
  });

  const lastPageItems = pages[pages.length - 1];
  const finalY = lastPageItems.length > 0 ? Math.max(...lastPageItems.map((it) => it.y + it.h)) : y;
  return finalY + bgPad + 10;
}

// Score-methodology glossary, by request -- fixed reference copy (not
// derived from report data), placed right before Recommendations.
const SCORE_EXPLANATIONS = [
  {
    title: 'Asset Management',
    body: "The Asset Management score represents the capability of the network to function as is required by today's standards. Compliancy checks are made against the device to ensure devices meet the set criteria. Included in the checks are Warranty Status, Disk Capacity, Memory Capacity and if the Operating system is still supported.",
  },
  {
    title: 'Monitoring',
    body: 'The Monitoring score is influenced by the open monitoring alerts for the network. The total number of open alerts influence the score, a higher priority is reflected by a increased weight in the calculation. A lower score means that issues are seen but have not yet been resolved.',
  },
  {
    title: 'Patch Management',
    body: 'Regularly installing Microsoft Updates is essential for keeping the network secure. The Patch Management score represents the current state of Microsoft Updates in the network.',
  },
  {
    title: 'Software Management',
    body: 'Keeping commonly used 3rd party software applications updated significantly helps keeping the network secure. Attackers often try to exploit security vulnerabilities in these applications. This score indicates the compliance level of the managed devices.',
  },
  {
    title: 'Antivirus',
    body: 'An Antivirus product on all devices is essential for keeping the network protected against malware and other threats. The Antivirus Score represents if the Antivirus solution is installed, running and up to date on all devices.',
  },
  {
    title: 'Proactive Maintenance',
    body: 'Any network requires proactive maintenance to ensure its availability, security and performance. The report contains a list of regularly scheduled automated activities. No score is calculated based on these activities.',
  },
];

function drawScoreExplanations(doc, y) {
  y = drawSectionHeading(doc, y, 'Understanding Your Scores');
  const w = contentWidth(doc);
  SCORE_EXPLANATIONS.forEach((item) => {
    doc.font('Helvetica').fontSize(8.5);
    const bodyHeight = doc.heightOfString(item.body, { width: w });
    y = ensureSpace(doc, y, 14 + bodyHeight + 10);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(BRAND_PURPLE).text(item.title, MARGIN, y);
    y += 14;
    doc.font('Helvetica').fontSize(8.5).fillColor(INK).text(item.body, MARGIN, y, { width: w });
    y += bodyHeight + 10;
  });
  return y;
}

// Proactive Maintenance note -- items now come from the report itself
// (report.proactiveMaintenance, server.js's own getProactiveMaintenanceItems(),
// configurable via PROACTIVE_MAINTENANCE_ITEMS in .env), not hardcoded
// here, so the PDF and the on-screen page can't drift out of sync with
// each other. Moved to the top of the Devices page, by request (used to
// sit at the bottom of the Cybersecurity Layers page) -- see
// buildReportPdf() below for where it's actually called now.
// Boxed, by request ("have the Proactive Maintenance list in a box matching
// the format of the Executive Summary") -- same soft-purple rounded card
// drawCommentaryCards() draws for its own Executive Summary callout
// (roundedRect, #f3f1fb fill, bold purple title at +10, body content
// starting at +24, 12px side padding), not the plain on-white heading this
// used before.
function drawProactiveMaintenanceNote(doc, y, items) {
  if (!items || items.length === 0) return y;
  const w = contentWidth(doc);
  const pad = 12;
  // 2 columns, by request -- first half left, second half right (not
  // interleaved), same even split the on-screen page's own CSS
  // column-count: 2 produces by default.
  const gap = 20;
  const colW = (w - pad * 2 - gap) / 2;
  const half = Math.ceil(items.length / 2);
  const leftItems = items.slice(0, half);
  const rightItems = items.slice(half);

  doc.font('Helvetica').fontSize(8);
  const measureCol = (colItems) => colItems.reduce((sum, item) => sum + doc.heightOfString(`-  ${item}`, { width: colW - 10 }) + 2, 0);
  const colHeight = Math.max(measureCol(leftItems), measureCol(rightItems));

  const captionText = 'Standard activities performed across all managed devices -- not scored.';
  doc.font('Helvetica-Oblique').fontSize(7);
  const captionHeight = doc.heightOfString(captionText, { width: w - pad * 2 });

  const boxHeight = 24 + colHeight + 6 + captionHeight + 10;
  y = ensureSpace(doc, y, boxHeight);

  doc.roundedRect(MARGIN, y, w, boxHeight, 4).fill('#f3f1fb');
  doc.fillColor(BRAND_PURPLE).font('Helvetica-Bold').fontSize(10).text('Proactive Maintenance', MARGIN + pad, y + 10);
  const colStartY = y + 24;

  doc.font('Helvetica').fontSize(8).fillColor(INK);
  let ly = colStartY;
  leftItems.forEach((item) => {
    doc.text(`-  ${item}`, MARGIN + pad, ly, { width: colW - 10 });
    ly = doc.y + 2;
  });
  let ry = colStartY;
  rightItems.forEach((item) => {
    doc.text(`-  ${item}`, MARGIN + pad + colW + gap, ry, { width: colW - 10 });
    ry = doc.y + 2;
  });

  const captionY = colStartY + colHeight + 6;
  doc.font('Helvetica-Oblique').fontSize(7).fillColor(MUTED).text(captionText, MARGIN + pad, captionY, { width: w - pad * 2 });
  return y + boxHeight + 14;
}

function drawRecommendations(doc, y, commentary) {
  // No longer guaranteed to start at the top of a fresh page (the forced
  // addPage() before this call was removed, by request -- this section
  // now continues straight on from Understanding Your Scores) -- guards
  // against an orphaned heading alone at the very bottom of a page with
  // the real table pushed onto the next one.
  y = ensureSpace(doc, y, 80);
  y = drawSectionHeading(doc, y, 'Our Recommendations');
  const w = contentWidth(doc);
  const columns = [
    {
      key: 'priority',
      label: 'PRIORITY',
      width: w * 0.16,
      // "Action needed" displays as "In Progress", by request -- same
      // relabel as the Scorecard's own scorecardStatus(), kept colour-coded
      // off the real underlying priority value (unchanged).
      render: (doc, x, y, width, row) => drawPill(doc, x, y, row.priority === 'Action needed' ? 'In Progress' : row.priority, row.priority === 'Action needed' ? RED : AMBER),
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
    // Top margin slightly reduced from the other 3 sides, by request ("a
    // little bit more room on the page if needed") -- left/right/bottom
    // stay at MARGIN (everything else on the page is still positioned off
    // that same constant), only the top -- where every new page's content
    // actually starts (`y = doc.page.margins.top`, used throughout) -- is
    // smaller.
    const doc = new PDFDocument({ size: 'A4', margins: { top: MARGIN - 12, bottom: MARGIN, left: MARGIN, right: MARGIN }, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      let y = drawCoverHeader(doc, report);
      y = drawAtAGlance(doc, y, report);

      // Watch moves to the top of the Device Health page, by request --
      // but ONLY when the full page 1 content (Executive Summary + On
      // Track/Action Needed + Watch + Scorecard) genuinely wouldn't all
      // fit on page 1 anyway; On Track/Action Needed always stay put
      // either way. Decided by measuring everything up front (nothing
      // drawn yet), not by reacting after the fact, so On Track/Action
      // Needed's own position never has to move regardless of which way
      // this goes.
      let pendingWatchCommentary = null;
      if (commentary) {
        y = drawExecutiveSummary(doc, y, commentary);
        const topRowH = measureTopRowHeight(doc, commentary);
        const watchH = measureWatchHeight(doc, commentary);
        const scorecardH = countScorecardRows(report, vendors) * 19 + 28 + 18;
        const pageBottom = doc.page.height - doc.page.margins.bottom;
        const allFitsOnPage1 = y + topRowH + 10 + watchH + 10 + scorecardH <= pageBottom;

        y = drawTopRow(doc, y, commentary);
        y += 10;

        if (allFitsOnPage1) {
          y = drawWatchCard(doc, y, commentary);
          y += 18;
        } else {
          pendingWatchCommentary = commentary;
        }
      }
      y = drawScorecard(doc, y, report, vendors);

      doc.addPage();
      y = doc.page.margins.top;
      // Watch, if it didn't fit on page 1, leads the Device Health page --
      // immediately followed by Asset Management (drawDeviceHealth() below
      // starts with it), not a further page break, by request ("follow it
      // by the Asset Management section without pushing that to page 3").
      if (pendingWatchCommentary) {
        y = drawWatchCard(doc, y, pendingWatchCommentary);
        y += 18;
      }
      y = drawDeviceHealth(doc, y, report);

      // Cybersecurity Layers now always starts on its own fresh page, by
      // request -- drawCybersecurityLayers() calls doc.addPage() itself,
      // so `y` going in here doesn't matter.
      y = drawCybersecurityLayers(doc, y, vendors);

      // A bit more breathing room than the standard inter-section gap, by
      // request -- Cybersecurity Systems' own purple background card ends
      // right at its return value, so the plain gap read as tight next to
      // Microsoft License Counts' heading immediately below it.
      y += 14;

      // Microsoft License Counts, between Cybersecurity Systems and All
      // Devices now, by request (was after All Devices) --
      // drawM365LicensesTable() already starts its own fresh page when it
      // wouldn't otherwise fit, so this doesn't need a forced addPage()
      // here, same as every other section that continues straight on from
      // whatever came before it when there's room.
      y = drawM365LicensesTable(doc, y, vendors.m365Licenses);

      // Device list and the score-explanations glossary both sit right
      // before Recommendations now, by request -- the device-by-device
      // table used to live directly under Device Health's own donuts;
      // moved here instead. Proactive Maintenance now sits at the TOP of
      // this same page, above the table, by request (used to sit at the
      // bottom of the Cybersecurity Layers page). Both skipped (no blank
      // page) when there's genuinely no device list to show, same as the
      // old inline placement did.
      if (report.dattoLive && report.dattoLive.devices && report.dattoLive.devices.length > 0) {
        doc.addPage();
        y = doc.page.margins.top;
        y = drawProactiveMaintenanceNote(doc, y, report.proactiveMaintenance);
        y += 10;
        y = drawDeviceList(doc, y, report);
      }

      doc.addPage();
      y = doc.page.margins.top;
      y = drawScoreExplanations(doc, y);
      // Extra breathing room before Our Recommendations, by request -- the
      // last explanation item's own trailing gap (10px, drawScoreExplanations
      // above) read as too tight between the two sections on the same page.
      y += 16;

      // No forced page break here, by request -- Our Recommendations
      // continues straight on from Understanding Your Scores, same page
      // when it fits (ensureSpace()'s normal per-row page-break logic,
      // inside drawTable() itself, still applies if it doesn't).
      if (commentary && commentary.recommendations && commentary.recommendations.length > 0) {
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
