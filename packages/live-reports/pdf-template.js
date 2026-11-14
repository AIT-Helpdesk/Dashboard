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
// Cover header's decorative wave graphic, by request -- copied into the
// repo (same shared-assets location logo.png already uses) rather than
// read from the user's own OneDrive path, which wouldn't exist on the
// production server.
const WAVE_PATH = path.join(__dirname, '..', 'shell', 'public', 'cover-wave.png');

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
// Cover header's own date format, by request ("use the 3 char month") --
// a separate formatter rather than changing formatDate() itself, which is
// also used for Datto EDR's "Last scanned" line elsewhere in this file and
// wasn't asked to change.
function formatDateCover(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
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

// Mail Domain Protection -- DMARC/SPF/DKIM status for the client's own
// mail domain, by request (EasyDMARC's own per-domain dashboard is the
// visual model). There's no EasyDMARC API connected to this dashboard
// yet, so these values are looked up manually and typed into client.js's
// own editable widget -- never fabricated server-side (see server.js's own
// parseMailDomainProtection(), which returns null rather than a guessed
// default on anything malformed/missing). The overall score and each of
// the 3 dot levels are picked by hand there too, by request ("I want to
// choose the X of 10, light green, medium green, dark green dots ...
// these aren't related to the Pass Rates") -- spfPassRate/dkimPassRate are
// shown here purely as their own display numbers, with no effect on the
// score or dots. Same 3 named levels/colours as client.js's own
// MDP_LEVELS -- kept in sync by hand (small enough, and one's browser JS/
// the other's Node, so there's no single module both could import from
// without a bigger refactor than this feature needs).
const MDP_LEVELS = {
  light: { dots: 1, color: '#86efac' },
  medium: { dots: 2, color: '#4ade80' },
  dark: { dots: 3, color: '#16a34a' },
};
function mdpLevel(key) {
  return MDP_LEVELS[key] || MDP_LEVELS.dark;
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
  // Legend vertically centred next to the ring now, by request -- it used
  // to start flush with the ring's own top edge (ly = y), which read as
  // misaligned whenever the ring (64px tall) was noticeably taller than a
  // short legend (e.g. AutoElevate's 4 rows).
  doc.font('Helvetica').fontSize(8);
  const rowHeights = entries.map(([label, val]) => doc.heightOfString(`${label}: ${val}`, { width: legendW - 11 }) + 3);
  const legendBlockH = rowHeights.reduce((sum, h) => sum + h, 0);
  let ly = y + Math.max(0, (diameter - legendBlockH) / 2);
  entries.forEach(([label, val], i) => {
    doc.circle(legendX + 3, ly + 5, 3).fillColor(colors[label] || '#9aa3af').fill();
    doc.fillColor(INK).text(`${label}: ${val}`, legendX + 11, ly, { width: legendW - 11 });
    ly += rowHeights[i];
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

// Same ring geometry as drawDonut() above (diameter 64, strokeW 13) -- by
// request ("use the same circle widget type as the AutoElevate one, size,
// width, etc"), AutoElevate's own card uses that exact ring via
// spec.donut/drawDonut(). Just the ring + centred number here, no
// title/legend (there's nothing to break out by category for a single
// score). `score`/10 is the filled fraction, reusing drawDonutArcSegment()
// (the same primitive drawDonut() itself draws its arcs with).
function drawScoreDonut(doc, x, y, score, color) {
  const diameter = 64;
  const strokeW = 13;
  const cx = x + diameter / 2;
  const cy = y + diameter / 2;
  const r = diameter / 2 - strokeW / 2;
  doc.lineWidth(strokeW).strokeColor(BORDER);
  doc.circle(cx, cy, r).stroke();
  if (score > 0) {
    drawDonutArcSegment(doc, cx, cy, r, 0, Math.min(1, score / 10), strokeW, color);
  }
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(11).text(String(score), x, cy - 5, { width: diameter, align: 'center' });
  doc.fillColor(INK).lineWidth(1);
  return diameter;
}

// 3 small dots, left-to-right, the first `tier.dots` of them filled in
// `tier.color` -- the same "how many lit" shorthand EasyDMARC's own
// DMARC/SPF/DKIM cards use for their status at a glance.
function drawMdpDots(doc, x, y, level) {
  const shades = [MDP_LEVELS.light.color, MDP_LEVELS.medium.color, MDP_LEVELS.dark.color];
  for (let i = 0; i < 3; i++) {
    doc.circle(x + i * 11, y, 4).fillColor(i < level.dots ? shades[i] : '#e5e7eb').fill();
  }
  doc.fillColor(INK);
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
// Small caps, by request ("the client name in Smallcaps") -- pdfkit has no
// font-variant: small-caps support, so this fakes it the standard way: the
// text is split into runs of "stays as-is" characters (already uppercase,
// digits, spaces, punctuation) vs "was lowercase" characters (drawn
// uppercased, at a smaller size).
//
// Each run is positioned by hand (own x via accumulated widthOfString(),
// own y via the ASCENT_RATIO math below) rather than pdfkit's own
// continued-text chaining -- confirmed live that chaining 2 different
// font SIZES on one line top-aligns them (every run starts from the same
// y), which reads as the small letters hanging off the top of the caps;
// what's wanted is real small-caps, where every run shares the same
// BASELINE instead (by request, "lined up with the bottom of the
// capitals, not the top"). Helvetica/Helvetica-Bold's own AFM ascender
// metric is 718/1000 em -- same ratio for any size of the same font, so
// solving "both runs' own (topY + size*ASCENT_RATIO) are equal" gives
// each run's top y from one shared baseline.
const SMALL_CAPS_ASCENT_RATIO = 0.718;
function drawSmallCapsText(doc, text, x, y, { font, capSize, smallSize, color }) {
  const runs = [];
  for (const ch of text) {
    const isLower = ch >= 'a' && ch <= 'z';
    const kind = isLower ? 'small' : 'cap';
    const chText = isLower ? ch.toUpperCase() : ch;
    const last = runs[runs.length - 1];
    if (last && last.kind === kind) last.text += chText;
    else runs.push({ kind, text: chText });
  }
  const baseline = y + capSize * SMALL_CAPS_ASCENT_RATIO;
  doc.fillColor(color);
  let cx = x;
  runs.forEach((run) => {
    const size = run.kind === 'cap' ? capSize : smallSize;
    doc.font(font).fontSize(size);
    doc.text(run.text, cx, baseline - size * SMALL_CAPS_ASCENT_RATIO, { lineBreak: false });
    cx += doc.widthOfString(run.text);
  });
  doc.fillColor(INK);
}

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
  // ~20% bigger, by request -- scaled independently of rightColW (the date
  // TEXT column's own width, unchanged) so the logo just grows, anchored to
  // the same right edge as before (boxX + boxW - pad), rather than also
  // widening the date's own text column.
  const logoBoxW = rightColW * 1.2;
  const logoH = 26 * 1.2;
  // Flush against the box's own top-left corner, by request -- a literal
  // 0 now (was a small 1pt dodge of the border stroke, no longer needed --
  // see the draw-order comment below).
  const flushInset = 0;
  const waveGap = 0; // no gap, by request -- image reaches all the way down to the client name

  // Client name/subtitle are bottom-anchored, by request -- back to the
  // ORIGINAL pre-wave-image layout (boxH driven by the text + the normal
  // pad, same as the right column's logo/date), not grown to also fit the
  // image. The wave image instead fills whatever space is left ABOVE that
  // bottom-anchored text -- "make the corner image fit in that bigger
  // space" -- bound by BOTH the leftover height above the title and the
  // leftColW width (the same width the client name itself wraps to),
  // whichever is the tighter constraint, so it's always exactly as big as
  // it can be without ever touching the text.
  // A little smaller than before (20 -> 18), by request, plus the small
  // caps treatment below -- measured off the CAP size against the
  // all-uppercase form of the name, a safe upper-bound height estimate
  // since small-caps' own lowercase-origin runs are always drawn smaller,
  // never taller, than that.
  const titleCapSize = 18;
  const titleSmallSize = 13;
  doc.font('Helvetica-Bold').fontSize(titleCapSize);
  const titleH = doc.heightOfString(report.siteName.toUpperCase(), { width: leftColW });
  const leftTextH = titleH + 6 + 14; // title + gap + subtitle line
  const rightContentH = logoH + 8 + 12; // logo height + gap + date line
  const boxH = Math.max(leftTextH, rightContentH, 70) + pad * 2;

  // Fill only here -- the green border is stroked LAST, after everything
  // else (logo, text, and especially the wave image), by request ("sit it
  // behind the green border so that the border is straight"). The wave
  // image is a plain rectangle sitting right in the box's own rounded
  // corner; drawing the border stroke UNDER it (the original single
  // fillAndStroke() call) let the image's square corner visually square
  // off the border's own rounded curve. Stroking on top instead always
  // paints a clean curved border line over whatever is beneath it.
  doc.roundedRect(boxX, boxY, boxW, boxH, 6).fill('#ffffff');

  const rightX = boxX + boxW - pad - rightColW;
  const logoX = boxX + boxW - pad - logoBoxW;
  try {
    doc.image(fs.readFileSync(LOGO_PATH), logoX, boxY + pad, { fit: [logoBoxW, logoH], align: 'right' });
  } catch (err) {
    console.error('live-reports: could not embed logo.png in PDF:', err.message);
  }
  // Not bold, and the 3-char month (formatDateCover()), both by request.
  doc.fillColor(MUTED).font('Helvetica').fontSize(9.5).text(formatDateCover(report.asOf), rightX, boxY + pad + logoH + 8, { width: rightColW, align: 'right' });

  // Single line, no wrapping -- drawSmallCapsText() positions each run by
  // hand (see its own comment) rather than through pdfkit's width-wrapped
  // text flow, so an unusually long name runs past leftColW rather than
  // wrapping; every real client name seen on this dashboard so far fits
  // comfortably on one line at this width.
  const leftStartY = boxY + boxH - pad - leftTextH;
  drawSmallCapsText(doc, report.siteName, boxX + pad, leftStartY, {
    font: 'Helvetica-Bold',
    capSize: titleCapSize,
    smallSize: titleSmallSize,
    color: BRAND_PURPLE,
  });
  doc.fillColor(MUTED).font('Helvetica').fontSize(12).text('Managed Services Report', boxX + pad, leftStartY + titleH + 6, { width: leftColW });

  // Decorative wave graphic, real file 1501x283 (confirmed via
  // System.Drawing before copying it in -- "AIT-Pattern-Graphic-2026.png",
  // the 2026 refresh of this same graphic), ratio ~5.30:1. Sized to fill the
  // space between the box's own flush top-left corner and the client name
  // above -- height-bound by whatever room is actually left there (varies
  // per client -- a short name leaves more room above it than a 2-line
  // one), and growing the image taller also grows it WIDER (fixed aspect
  // ratio), by request ("make the image bigger... reach all the way to
  // the client name and therefore consume more width"). Width-capped by
  // actual clearance from the logo (not leftColW, the narrower TEXT
  // column width -- the image sits in a different vertical band than the
  // text and so isn't bound by the text's own wrap width at all, only by
  // not visually running under the logo).
  const availableImgH = Math.max(0, leftStartY - waveGap - (boxY + flushInset));
  const maxWaveWByLogo = logoX - boxX - 8; // 8pt breathing room before the logo
  const waveW = Math.min(maxWaveWByLogo, availableImgH * (1501 / 283));
  const waveH = waveW / (1501 / 283);
  // Clipped to the box's own rounded-rect shape, by request ("remove the
  // overlap outside the box border") -- doc.image() draws a plain sharp-
  // cornered rectangle, which otherwise pokes past the rounded corner's
  // curve into the page margin outside the box entirely (confirmed on a
  // real screenshot -- the border stroke drawn on top, above, only
  // crisps up the BORDER LINE itself, it doesn't stop the image bleeding
  // past the curve beyond that thin line). save()/clip()/restore() scopes
  // the clip to just this one draw call.
  doc.save();
  doc.roundedRect(boxX, boxY, boxW, boxH, 6).clip();
  try {
    doc.image(fs.readFileSync(WAVE_PATH), boxX + flushInset, boxY + flushInset, { fit: [waveW, waveH] });
  } catch (err) {
    console.error('live-reports: could not embed cover-wave.png in PDF:', err.message);
  }
  doc.restore();

  // Border stroke drawn LAST -- see the fill() comment above.
  doc.roundedRect(boxX, boxY, boxW, boxH, 6).lineWidth(3).stroke(BRAND_GREEN);

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

// Devices by Type / Check-in Freshness, moved onto page 1 (right after
// Overall Health View, above Executive Summary) by request -- previously
// shown on-screen only (deviceTypeBarWidget()/checkinFreshnessWidget(),
// meeting-prep-report-render.js) as a coloured bar and a segmented bar; drawn
// here as a donut row instead to match every other paired-widget row this
// PDF already uses (drawDonutRow()/drawDonutCard()), not a second chart
// style. Same on-screen color conventions: the 6-color rotating palette
// deviceTypeBarWidget() cycles through for device types (assigned by the
// same count-descending order server.js's own byType array is already
// sorted in, so colors line up with the on-screen widget for the same
// client), and the same green/amber/red/grey freshness colors
// checkinFreshnessWidget() uses.
const DEVICE_TYPE_COLOR_PALETTE = ['#2563eb', '#7c3aed', '#0891b2', '#ca8a04', '#be185d', '#4d7c0f'];
function drawDeviceOverviewRow(doc, y, dattoLive) {
  if (!dattoLive) return y;

  const byType = dattoLive.byType || [];
  const typeLegend = {};
  const typeColors = {};
  byType.forEach((t, i) => {
    typeLegend[t.type] = t.count;
    typeColors[t.type] = DEVICE_TYPE_COLOR_PALETTE[i % DEVICE_TYPE_COLOR_PALETTE.length];
  });
  const left = byType.length > 0 ? { title: 'Devices by Type', legend: typeLegend, colors: typeColors } : null;

  const s = dattoLive.summary || {};
  const right = {
    title: 'Check-in Freshness',
    legend: { 'Seen <7 days': s.seenRecent || 0, 'Seen 7-30 days': s.seenAgeing || 0, 'Not seen 30+ days': s.notSeenStale || 0, 'Never reported': s.unknown || 0 },
    colors: { 'Seen <7 days': BRAND_GREEN, 'Seen 7-30 days': AMBER, 'Not seen 30+ days': RED, 'Never reported': MUTED },
  };

  const w = contentWidth(doc);
  y = ensureSpace(doc, y, measureDonutRowHeight(doc, w, left, right));
  y = drawDonutRow(doc, y, w, left, right);
  return y + 14;
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
// row / Watch) so buildReportPdf() below can place Executive Summary on
// page 1 and On Track/Action Needed/Watch on page 2, rather than one
// monolithic draw-everything function.
function drawExecutiveSummary(doc, y, commentary) {
  const w = contentWidth(doc);
  // null when Generate Summary was never run (by request, the PDF never
  // triggers that AI call itself any more -- see server.js's own /pdf
  // route) -- a placeholder line keeps this box, and the page flow below
  // it, the same shape as a report that does have a real summary, rather
  // than this section just vanishing.
  const text = (commentary && commentary.executiveSummary) || 'Summary to be discussed.';
  doc.font('Helvetica').fontSize(9);
  // A bit of extra breathing room between wrapped lines within the
  // paragraph itself, by request -- pdfkit's own `lineGap` option (added to
  // BOTH the measurement and the real draw call below, so the box's own
  // height stays correctly sized for the taller text).
  const textOpts = { width: w - 24, lineGap: 2.5 };
  const summaryHeight = doc.heightOfString(text, textOpts) + 34;
  y = ensureSpace(doc, y, summaryHeight);
  doc.roundedRect(MARGIN, y, w, summaryHeight, 4).fill('#f3f1fb');
  doc.fillColor(BRAND_PURPLE).font('Helvetica-Bold').fontSize(10).text('Executive Summary', MARGIN + 12, y + 10);
  if (commentary) {
    doc.fillColor(INK).font('Helvetica').fontSize(9).text(text, MARGIN + 12, y + 24, textOpts);
  } else {
    doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(9).text(text, MARGIN + 12, y + 24, textOpts);
  }
  return y + summaryHeight + 14;
}

// On Track + Action Needed share a row, by request -- replaces the old
// 3-equal-column layout, which forced these two up to whatever Watch's own
// height happened to be (usually the longest list), wasting space in the
// shorter two. Watch itself is now a separate full-width card (see
// measureWatchHeight()/drawWatchCard() below), drawn right after this row --
// both now always lead page 2 (right after the page break following
// Scorecard), by request, not conditionally placed depending on whether
// page 1 had room.
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

function drawDeviceHealth(doc, y, report, deviceHealthItems) {
  // Per-widget "include in PDF" tick boxes within Device Health, by
  // request -- Asset Management/Monitoring tables and each of the
  // Workstations donuts (Patch/Software/Antivirus) can each be left out
  // individually, same missing/undefined-still-shows convention every
  // other toggle in this file uses. Nested under deviceHealthItems (not
  // flat top-level section keys) for the same reason cyberCards is nested
  // under drawCybersecurityLayers() -- these are sub-items of the
  // deviceHealth section toggle, not sections of their own.
  const t = deviceHealthItems || {};
  if (t.assetManagement !== false) y = drawAssetManagementTable(doc, y, report.assetManagementDetail);
  if (t.monitoring !== false) y = drawMonitoringTable(doc, y, report.monitoringDetail);
  // Extra breathing room before Device Health, by request -- the Monitoring
  // table's own trailing gap (14px, drawMonitoringTable above) read as too
  // tight, same "bigger gap for visibility" fix as the Understanding Your
  // Scores -> Our Recommendations gap elsewhere in this file.
  y += 16;
  const w = contentWidth(doc);
  // Rows of bordered cards now (drawDonutRow()/drawDonutCard() above), not
  // bare donuts floating on the page, by request ("put nice boxes around
  // the Device Health widgets... line them up symmetrically") -- each row's
  // 2 cards share one height (the taller of the two) so their borders
  // align, same card look the Cybersecurity Systems section already uses.
  const rowGap = 14; // was 6 -- more breathing room between rows, by request
  const bgPad = 10;

  // Replacement Recommendation / Operating System -- back here, below
  // Monitoring and above the "Device Health" heading, by request ("lets
  // put these back in asset management and monitoring section below the
  // monitoring") -- briefly folded into the Device Health box itself
  // (an earlier request), now its own purple-background box again, same
  // "still needs a purple outer box" request, just not merged into the
  // Device Health one this time. Own ensureSpace() check, same reasoning
  // as Device Health's own box below (a box that doesn't fit moves to a
  // fresh page as ONE unit, never split mid-box).
  let hlRow = buildHardwareLifecycleSpecs(report.hardwareLifecycle);
  // Same "include in PDF" sub-toggles as everything else in Device
  // Health, by request. hlRow is [Replacement Recommendation, Operating
  // System] -- drawDonutRow()/measureDonutRowHeight() already tolerate
  // either slot being null (just leaves that side blank), so unticking
  // one doesn't need its own special case here.
  if (hlRow) {
    if (t.replacementRecommendation === false) hlRow[0] = null;
    if (t.operatingSystem === false) hlRow[1] = null;
    if (!hlRow[0] && !hlRow[1]) hlRow = null;
  }
  if (hlRow) {
    const hlH = measureDonutRowHeight(doc, w, hlRow[0], hlRow[1]) + bgPad * 2;
    y = ensureSpace(doc, y, hlH);
    doc.roundedRect(MARGIN - bgPad, y - bgPad, w + bgPad * 2, hlH, 6).fill(BRAND_PURPLE);
    y = drawDonutRow(doc, y, w, hlRow[0], hlRow[1]);
    y += 24; // gap before the "Device Health" heading below, same weight as the 16+10 Monitoring->heading gap used to be
  }

  let row1 = report.workstation
    ? [
        t.workstationPatch !== false ? { title: `Workstations -- Patch Management (${report.workstation.patch.score}%)`, legend: report.workstation.patch.legend, colors: PATCH_COLORS } : null,
        t.workstationSoftware !== false ? { title: `Workstations -- Software (${report.workstation.software.score}%)`, legend: report.workstation.software.legend, colors: SOFTWARE_COLORS } : null,
      ]
    : null;
  if (row1 && !row1[0] && !row1[1]) row1 = null; // both unticked -- no empty row/gap for nothing
  let row2 =
    report.workstation || report.server
      ? [
          report.workstation && t.workstationAntivirus !== false ? { title: `Workstations -- Antivirus (${report.workstation.antivirus.score}%)`, legend: report.workstation.antivirus.legend, colors: ANTIVIRUS_COLORS } : null,
          report.server ? { title: `Servers -- Antivirus (${report.server.antivirus.score}%)`, legend: report.server.antivirus.legend, colors: ANTIVIRUS_COLORS } : null,
        ]
      : null;
  if (row2 && !row2[0] && !row2[1]) row2 = null;

  // Same solid background treatment as Cybersecurity Systems
  // (drawCybersecurityLayers()), by request -- measured up front (pure
  // arithmetic, the same measureDonutRowHeight() drawDonutRow() itself
  // uses, so the two can never drift apart) so it can be drawn FIRST, with
  // the white cards on top of it after.
  const rows = [row1, row2].filter(Boolean);
  const rowHeights = rows.map((r) => measureDonutRowHeight(doc, w, r[0], r[1]));
  const boxH = rows.length > 0 ? rowHeights.reduce((sum, h) => sum + h, 0) + rowGap * (rows.length - 1) + bgPad * 2 : 0;

  // The "Device Health" heading and the box below it are now ensureSpace()'d
  // as ONE unit (heading's own 28px + the 10px gap under it + the box),
  // fixing a real bug found live on a real PDF: drawing the heading here
  // THEN separately ensureSpace()-ing just the box below could legally
  // leave "Device Health" alone at the bottom of one page with every one of
  // its own widgets pushed onto the next ("the device health heading is
  // separated from the widgets below it"). ensureSpace() itself is the same
  // fix CONFIRMED live earlier against a different failure mode on this
  // exact box (G & H Civil Contractors, 62 devices): with no page-break
  // check at all, the purple rect and every donut card were drawn at
  // whatever page they happened to land on regardless of whether they
  // actually fit, and pdfkit's own auto-pagination inside drawDonut()'s
  // .text() calls (title/centre total/each legend line are all separate
  // .text() calls, each capable of triggering its own page break) kept
  // kicking in unaware this was supposed to be one box, scattering the
  // title, the ring's centre number, and the legend across several
  // near-blank trailing pages with no card border or purple background
  // around any of them.
  y = ensureSpace(doc, y, 28 + 10 + boxH);
  y = drawSectionHeading(doc, y, 'Device Health');
  // A bit more room under the heading too, by request ("a little more
  // spacing... top and bottom").
  y += 10;

  if (rows.length > 0) {
    doc.roundedRect(MARGIN - bgPad, y - bgPad, w + bgPad * 2, boxH, 6).fill(BRAND_PURPLE);

    rows.forEach((r, i) => {
      y = drawDonutRow(doc, y, w, r[0], r[1]);
      if (i < rows.length - 1) y += rowGap;
    });
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

// Replacement Recommendation / Operating System specs, by request ("Get
// the info from Datto RMM") -- see computeHardwareLifecycle()'s own comment
// in server.js for how these are derived from live Datto RMM data
// (warrantyDate/os, the same two fields Asset Management's own checks
// already use). Shared by drawDeviceHealth() below (which draws this as an
// extra row inside its own purple-background box, by request -- "move the
// Replacement Recommendations & Operating Systems to the Device
// [Health/management] section") and nothing else now that it's no longer
// its own standalone page section.
function buildHardwareLifecycleSpecs(lifecycle) {
  if (!lifecycle) return null;
  const left = {
    title: 'Replacement Recommendation',
    legend: {
      'Within 12 months': lifecycle.replacementRecommendation.within12,
      '12 to 24 months': lifecycle.replacementRecommendation.from12to24,
      'Suitable 24+ months': lifecycle.replacementRecommendation.suitable24Plus,
      Unknown: lifecycle.replacementRecommendation.unknown,
    },
    colors: { 'Within 12 months': RED, '12 to 24 months': AMBER, 'Suitable 24+ months': BRAND_GREEN, Unknown: '#9aa3af' },
  };
  // "Operating System", not "OS Support", by request. Legend lists the real
  // OS names found (build numbers stripped -- see
  // computeHardwareLifecycle()'s own comment in server.js), each coloured
  // green/red by whether THAT one is supported, rather than 2 generic
  // Supported/Unsupported rows, by request ("List what they are instead of
  // Supported and Unsupported but colour them red and green to match") --
  // the donut ring itself still only ever uses those same 2 colours either
  // way, so it still reads as a plain supported-vs-unsupported split at a
  // glance ("Keep the widget as just supported and unsupported though").
  // Falls back to the old 2-row legend when there's no OS data at all to
  // name individually.
  const byName = lifecycle.osSupport.byName || [];
  const right = {
    title: 'Operating System',
    legend:
      byName.length > 0
        ? Object.fromEntries(byName.map((o) => [o.name, o.count]))
        : { Supported: lifecycle.osSupport.supported, Unsupported: lifecycle.osSupport.unsupported },
    colors:
      byName.length > 0
        ? Object.fromEntries(byName.map((o) => [o.name, o.supported ? BRAND_GREEN : RED]))
        : { Supported: BRAND_GREEN, Unsupported: RED },
  };
  return [left, right];
}

// The full device-by-device table -- its own section now, placed right
// before Recommendations (by request), not folded into Device Health
// above anymore.
function drawDeviceList(doc, y, report) {
  const devices = report.dattoLive && report.dattoLive.devices;
  if (!devices || devices.length === 0) return y;
  const w = contentWidth(doc);

  const freshnessLabel = { stale: 'Not seen 30+ days', ageing: 'Seen 7-30 days', recent: 'Seen <7 days', unknown: 'Unknown' };
  // Already sorted (worst check-in freshness first, then Disk Used %) by
  // server.js, so both this PDF table and the on-screen table show the same
  // order -- not re-sorted here.
  const sorted = devices;

  y = drawSectionHeading(doc, y, `All Devices (${sorted.length})`);
  doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(MUTED).text('Oldest check-in first, then by Disk Used %.', MARGIN, y);
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

  // SaaS Alerts -- critical-severity Top Events shown bold (red removed, by
  // later request), using the same severity data buildSaasAlertsSummary()
  // carries through.
  if (vendors.saasAlerts.status === 'ok' && vendors.saasAlerts.monitored) {
    const sa = vendors.saasAlerts;
    specs.push({
      key: 'saasAlerts',
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
              // Red text removed, by request (still kept bold, the
              // remaining visual distinction for a critical event).
              color: INK,
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
      key: 'saasProtection',
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
      key: 'dattoEdr',
      title: 'Endpoint Detection and Response (EDR)',
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
    specs.push({ key: 'huntress', title: 'Huntress Threat Watch', kpis, lines: [{ text: 'Lifetime total incidents.', color: MUTED, italic: true }] });
  }

  // INKY (email security) -- own bespoke inkyLayout (measureInkyLayoutHeight/
  // drawInkyLayout below), by request ("formatted like the on screen one"):
  // Protected Mailboxes/Messages Processed on their own row on top; Caution/
  // Danger stacked vertically on the left underneath that, Top Threat
  // Reasons beside THOSE two specifically -- the plain kpis/lines fields a
  // generic card normally uses (a uniform grid, then a full-width line list
  // below it) can't produce that shape, same reason AutoElevate's own donut
  // needed its own special-cased spec.donut handling rather than forcing it
  // through kpis/lines too. On a live API failure, the card still shows (by
  // request, same as the on-screen page) with a plain-English note instead
  // of real figures rather than vanishing outright -- this PDF is the
  // actual client-facing deliverable, so the friendly fallback matters here
  // if anything more than on screen. The error-state card has no KPI data
  // to lay out specially, so it just uses the plain lines-only path, same
  // as every other vendor's own "nothing to show" case.
  if (vendors.inky.status === 'ok' && vendors.inky.installed) {
    const ik = vendors.inky;
    specs.push({
      key: 'inky',
      title: 'Email Security',
      titleSuffix: '(30 days)',
      kpis: [],
      lines: [],
      inkyLayout: {
        topKpis: [
          { label: 'Protected Mailboxes', value: ik.protectedMailboxCount ?? '--', tier: 'good' },
          { label: 'Messages Processed', value: ik.messagesProcessed },
        ],
        severityKpis: [
          { label: 'Caution', value: ik.cautionCount, tier: ik.cautionCount > 0 ? 'warn' : 'good' },
          { label: 'Danger', value: ik.dangerCount, tier: ik.dangerCount > 0 ? 'bad' : 'good' },
        ],
        reasons: ik.topReasons.map((r) => ({ text: `${r.label} (${r.count})`, color: INK })),
      },
    });
  } else if (vendors.inky.status === 'error') {
    specs.push({
      key: 'inky',
      title: 'Email Security',
      titleSuffix: '(30 days)',
      kpis: [],
      lines: [
        {
          text: "Email security platform is currently updating how it connects to this report, so live threat data couldn't be pulled in this time. This usually resolves on its own -- no action needed, and the figures will be back next time this report runs.",
          color: MUTED,
          italic: true,
        },
      ],
    });
  }

  // AutoElevate -- elevation requests/events widgets, by request ("Add
  // widgets for the AutoElevate section"). Donut is the headline widget
  // (Approved (Auto)/Approved (Manual)/Denied/Pending -- "Manual" is
  // deliberately not labelled "by a technician", see
  // classifyElevationOutcomes()'s own comment in server.js for why), then
  // the top-apps list. Donut always drawn now, by request, even with zero
  // activity in the window -- drawDonut() already renders a plain empty
  // ring + "0" centre label for an all-zero legend, same as every other
  // zero-count donut in this PDF, so no special-case needed beyond always
  // building spec.donut whenever `el` exists. Requests Handled tile/trend
  // line and the "Deployed since" line both removed, by request -- the
  // window length moved into the title itself instead (grey, via
  // titleSuffix -- see drawCyberCard() above), rather than only showing
  // inside that now-removed tile's own label.
  if (vendors.autoElevate.status === 'ok' && vendors.autoElevate.installed && vendors.autoElevate.deployedSince) {
    const ae = vendors.autoElevate;
    const el = ae.elevation;
    const spec = { key: 'autoElevate', title: 'AutoElevate', titleSuffix: el ? `(${el.windowDays} days)` : null, kpis: [], lines: [] };
    if (el) {
      spec.donut = {
        legend: { 'Approved (Auto)': el.outcomes.autoApproved, 'Approved (Manual)': el.outcomes.manualApproved, Denied: el.outcomes.denied, Pending: el.outcomes.pending },
        colors: { 'Approved (Auto)': BRAND_GREEN, 'Approved (Manual)': '#2563eb', Denied: RED, Pending: AMBER },
      };
      // No "No elevation requests" placeholder line for the empty case, by
      // request -- the donut/legend above already show 0 for every
      // category, so the caption was just repeating what's obvious from
      // the zero.
      if (el.topApps.length > 0) {
        el.topApps.forEach((a) => spec.lines.push({ text: `${a.name} (${a.count})`, color: INK }));
      }
    }
    specs.push(spec);
  }

  return specs;
}

// INKY's own bespoke layout -- top row (full width, 2 KPI tiles), then a
// bottom row with Caution/Danger stacked in a narrow left column (cols: 1,
// same drawKpiTileRow() already supports for any tile count) and Top
// Threat Reasons as plain text beside that column specifically, sized to
// whichever of the two (the severity column, or the reasons text) is
// taller -- same "measure and draw as a matched pair" convention every
// other measure/draw function in this file follows. severityColW (110pt)
// is a fixed width, same "a KPI tile reads fine at a fixed width" reasoning
// drawTile()'s own callers elsewhere already rely on.
const INKY_SEVERITY_COL_W = 110;
const INKY_COL_GAP = 10;

function measureInkyLayoutHeight(doc, w, layout) {
  const topRows = kpiTileGridRows(layout.topKpis.length, 2);
  const topH = topRows * 38 + (topRows - 1) * 6;
  const severityRows = kpiTileGridRows(layout.severityKpis.length, 1);
  const severityH = severityRows * 38 + (severityRows - 1) * 6;
  const reasonsW = w - INKY_SEVERITY_COL_W - INKY_COL_GAP;
  doc.font('Helvetica').fontSize(8);
  const reasonLines = layout.reasons.length > 0 ? layout.reasons : [{ text: 'No threats flagged in this window.' }];
  let reasonsH = 0;
  reasonLines.forEach((line) => {
    reasonsH += doc.heightOfString(line.text, { width: reasonsW }) + 2;
  });
  return topH + 8 + Math.max(severityH, reasonsH);
}

function drawInkyLayout(doc, x, y, w, layout) {
  const reasonsW = w - INKY_SEVERITY_COL_W - INKY_COL_GAP;
  const cy = drawKpiTileRow(doc, x, y, w, layout.topKpis, 2) + 8;
  const severityBottom = drawKpiTileRow(doc, x, cy, INKY_SEVERITY_COL_W, layout.severityKpis, 1);
  const reasonLines = layout.reasons.length > 0 ? layout.reasons : [{ text: 'No threats flagged in this window.', color: MUTED, italic: true }];
  let ty = cy;
  reasonLines.forEach((line) => {
    doc
      .font(line.italic ? 'Helvetica-Oblique' : 'Helvetica')
      .fontSize(8)
      .fillColor(line.color || INK)
      .text(line.text, x + INKY_SEVERITY_COL_W + INKY_COL_GAP, ty, { width: reasonsW });
    ty = doc.y + 2;
  });
  doc.fillColor(INK);
  return Math.max(severityBottom, ty);
}

function measureCyberCardHeight(doc, w, spec) {
  let h = 8 + 16; // top padding + title line
  if (spec.donut) {
    h += measureDonutHeight(doc, w - 20, spec.donut.legend) + 8;
  }
  if (spec.inkyLayout) {
    h += measureInkyLayoutHeight(doc, w - 20, spec.inkyLayout) + 8;
  }
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
  // Optional grey suffix right after the title (AutoElevate's own
  // "(30 days)", by request) -- pdfkit's own continued-text chaining, same
  // mechanism `line.segments` below already uses for a mixed-colour line.
  doc
    .fillColor(BRAND_PURPLE)
    .font('Helvetica-Bold')
    .fontSize(9.5)
    .text(spec.title, x + 10, y + 8, spec.titleSuffix ? { continued: true } : { width: w - 20 });
  if (spec.titleSuffix) {
    doc.fillColor(MUTED).font('Helvetica').fontSize(8.5).text(` ${spec.titleSuffix}`);
  }
  doc.fillColor(INK);
  let cy = y + 24;
  if (spec.donut) {
    // '' title -- this card already drew its own title above; drawDonut()
    // always advances y by 16 for a title line regardless, which
    // measureDonutHeight() already accounts for, so this stays in sync.
    cy = drawDonut(doc, x + 10, cy, w - 20, '', spec.donut.legend, spec.donut.colors) + 8;
    // drawDonut()/drawDonutArcSegment() leave a thick (13px) lineWidth set
    // for the arc strokes -- reset here, same reasoning drawDonutCard()'s
    // own comment gives, or this card's own KPI tiles/border drawn right
    // after would inherit it and render with an absurdly thick outline.
    doc.lineWidth(1);
  }
  if (spec.inkyLayout) {
    cy = drawInkyLayout(doc, x + 10, cy, w - 20, spec.inkyLayout) + 8;
  }
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

// Fixed reference copy explaining each cybersecurity layer, by request --
// same "not derived from report data" convention as SCORE_EXPLANATIONS
// below, but placed right after the Cybersecurity Systems cards rather
// than down with the score-methodology glossary, since these aren't
// scored items -- some (Email Security, Dark Web Monitoring, Security
// Awareness Training) have no live card/data at all yet, and are
// included here anyway, same as every other entry, for client education
// rather than reporting on a live number.
const CYBERSECURITY_EXPLANATIONS = [
  {
    title: 'SaaS/Cloud/Activity Alerts',
    body: 'Spots suspicious sign-ins and risky activity in Microsoft 365 and cloud apps, and locks down compromised accounts.',
  },
  {
    title: 'SaaS Protection',
    body: 'Backs up your Microsoft 365 Email, SharePoint, OneDrive and Teams or Google WorkSpace data so anything lost or deleted can be restored.',
  },
  {
    title: 'Antivirus, Anti-Malware and Anti-Ransomware',
    body: 'Blocks viruses, malware and ransomware before they can disrupt your business or lock up your data.',
  },
  {
    title: 'Endpoint Detection and Response',
    body: 'Monitors every computer around the clock to detect and contain threats that traditional antivirus misses.',
  },
  {
    title: 'Huntress Threat Watch',
    body: 'Human threat hunters find and help remove hidden attacker footholds before they cause damage.',
  },
  {
    title: 'AutoElevate',
    body: 'Lets staff run approved software without permanent admin rights, closing off a common attack route without slowing them down.',
  },
  {
    title: 'Email Security',
    body: 'Stops phishing and impersonation emails before they reach your staff, and flags anything suspicious so it can be spotted at a glance.',
  },
  {
    title: 'Dark Web Monitoring',
    body: 'Watches the dark web for leaked staff passwords and company credentials, so exposure can be fixed before criminals use it.',
  },
  {
    title: 'Security Awareness Training',
    body: 'Teaches staff to recognise phishing through short lessons and simulated attacks, turning your people into a strong line of defence.',
  },
];

// Shared boxed glossary-list renderer -- title on its own line, its
// description on the line directly under it (not inline -- reverted back
// to this, by request, after a brief stint with them run together),
// smaller type (8pt, was 10pt title/8.5pt body), the whole list inside one
// soft-purple card (same #f3f1fb style drawExecutiveSummary() above uses
// for its own callout) rather than plain on-white text. Used for both
// Cybersecurity's own list (no heading above it, by request -- "About
// These Systems" was removed entirely) and Understanding Your Scores
// (which keeps its own drawSectionHeading() above this, only the list
// itself switched to this format) -- one function so the two can't drift
// apart style-wise.
// A real check mark, drawn as 2 stroked line segments -- NOT the U+2713
// text character, by request ("Need to display a tick - check mark not
// ' please"): confirmed live that pdfkit's base-14 Helvetica has no glyph
// for it and silently substitutes something else (an apostrophe-ish
// mark). x,y is the check's own top-left corner, drawn within a size x
// size box.
function drawCheckMark(doc, x, y, size, color) {
  const lw = Math.max(1, size * 0.16);
  doc.lineCap('round').lineJoin('round').lineWidth(lw).strokeColor(color);
  doc
    .moveTo(x + size * 0.06, y + size * 0.52)
    .lineTo(x + size * 0.38, y + size * 0.82)
    .lineTo(x + size * 0.94, y + size * 0.14)
    .stroke();
  doc.lineCap('butt').lineJoin('miter').lineWidth(1);
}

// Same vector-not-text-glyph reasoning as drawCheckMark() above -- a red
// X for Email Domain Protection's own not-found checks.
function drawXMark(doc, x, y, size, color) {
  const lw = Math.max(1, size * 0.16);
  doc.lineCap('round').lineWidth(lw).strokeColor(color);
  doc.moveTo(x + size * 0.12, y + size * 0.12).lineTo(x + size * 0.88, y + size * 0.88).stroke();
  doc.moveTo(x + size * 0.88, y + size * 0.12).lineTo(x + size * 0.12, y + size * 0.88).stroke();
  doc.lineCap('butt').lineWidth(1);
}

// item.implemented === true gets a green check mark drawn right after its
// own title text (not before, by request), via drawCheckMark() above --
// undefined/false (every Understanding Your Scores item, and any
// Cybersecurity Systems item this dashboard has no live status for) draws
// exactly as before, no mark.
// Measures drawExplanationsBox()'s own box height without drawing it, by
// request ("if the Cybersecurity product descriptions doesn't fit...") --
// buildReportPdf() needs to know this UP FRONT, before committing to
// drawing the Cybersecurity Systems one in place, to decide whether to
// defer it to after Understanding Your Scores instead. Duplicates
// drawExplanationsBox()'s own measuring step rather than sharing state
// with it -- cheap, deterministic text measurement, same "measure and
// draw functions each do their own pdfkit calls" convention every other
// measure/draw pair in this file already follows.
function measureExplanationsBoxHeight(doc, items) {
  const w = contentWidth(doc);
  const pad = 12;
  const fontSize = 8;
  const titleGap = 2;
  const itemGap = 8;
  doc.font('Helvetica-Bold').fontSize(fontSize);
  const titleHeights = items.map((item) => doc.heightOfString(item.title, { width: w - pad * 2 }));
  doc.font('Helvetica').fontSize(fontSize);
  const bodyHeights = items.map((item) => doc.heightOfString(item.body, { width: w - pad * 2 }));
  const itemHeights = items.map((item, i) => titleHeights[i] + titleGap + bodyHeights[i]);
  return pad * 2 + itemHeights.reduce((sum, h) => sum + h, 0) + itemGap * (items.length - 1);
}

function drawExplanationsBox(doc, y, items) {
  const w = contentWidth(doc);
  const pad = 12;
  const fontSize = 8;
  const titleGap = 2; // between a title line and its own body
  const itemGap = 8; // between one item and the next

  // Title and body measured separately (own font each) rather than one
  // combined string at a single font -- same reasoning as the bold-font
  // safety margin below: measuring at the wrong weight can under-wrap and
  // overlap the next item (confirmed on a real PDF earlier this session).
  // The check mark is a vector graphic, not part of this string, so it
  // never affects title wrapping/height.
  doc.font('Helvetica-Bold').fontSize(fontSize);
  const titleHeights = items.map((item) => doc.heightOfString(item.title, { width: w - pad * 2 }));
  doc.font('Helvetica').fontSize(fontSize);
  const bodyHeights = items.map((item) => doc.heightOfString(item.body, { width: w - pad * 2 }));
  const itemHeights = items.map((item, i) => titleHeights[i] + titleGap + bodyHeights[i]);
  const boxHeight = pad * 2 + itemHeights.reduce((sum, h) => sum + h, 0) + itemGap * (items.length - 1);

  y = ensureSpace(doc, y, boxHeight);
  doc.roundedRect(MARGIN, y, w, boxHeight, 4).fill('#f3f1fb');

  let iy = y + pad;
  items.forEach((item, i) => {
    doc.font('Helvetica-Bold').fontSize(fontSize).fillColor(BRAND_PURPLE);
    doc.text(item.title, MARGIN + pad, iy, { width: w - pad * 2 });
    // `item.implemented` is a real boolean (never undefined) for every
    // Cybersecurity Module Descriptions item -- buildCyberServiceItems()
    // in server.js always resolves it one way or the other -- so `false`
    // here means "checked, and this client doesn't have it" and earns a
    // red X, by request. Understanding Your Scores' own items (the other
    // caller of this shared box) never set `implemented` at all
    // (undefined), so they still draw neither mark, same as before --
    // `undefined` isn't "checked and missing", it's "not applicable here".
    if (item.implemented === true || item.implemented === false) {
      // widthOfString() measures the title as ONE line -- fine for these
      // (short service names that don't wrap in practice); a title that
      // did wrap would still get a mark, just positioned off the first
      // line's own measured width rather than hunting for the true last
      // line's end.
      const titleWidth = doc.widthOfString(item.title, { width: w - pad * 2 });
      if (item.implemented) drawCheckMark(doc, MARGIN + pad + titleWidth + 6, iy + 1, fontSize, BRAND_GREEN);
      else drawXMark(doc, MARGIN + pad + titleWidth + 6, iy + 1, fontSize, RED);
    }
    iy += titleHeights[i] + titleGap;
    doc.font('Helvetica').fontSize(fontSize).fillColor(INK).text(item.body, MARGIN + pad, iy, { width: w - pad * 2 });
    iy += bodyHeights[i] + itemGap;
  });

  doc.fillColor(INK);
  return y + boxHeight + 14;
}

// `items` comes from server.js's own buildCyberServiceItems() (the live
// SharePoint table, by request -- "Use that table to fill the
// Cybersecurity Systems descriptions panel"), already filtered to
// Show != 'N' rows and marked with `implemented` per this client's real
// vendor data. Falls back to the old hardcoded CYBERSECURITY_EXPLANATIONS
// list when that's missing/empty (SharePoint unreachable, or an older
// caller) -- same "never block the rest of the real report over one
// optional live-data call" reasoning the commentary/vendors fallbacks
// elsewhere in this file already follow.
function resolveCyberExplanationItems(items) {
  return items && items.length > 0 ? items : CYBERSECURITY_EXPLANATIONS;
}
function drawCybersecurityExplanations(doc, y, items) {
  return drawExplanationsBox(doc, y, resolveCyberExplanationItems(items));
}

// Email Domain Protection -- live DNS checks (DMARC/SPF/DKIM), by
// request, a separate card from Mail Domain Protection Monitoring (the
// manual-entry one just below). `data` is server.js's own
// emailDomainProtection.getStatus() result when status === 'ok' (null
// otherwise, which drawCybersecurityLayers() above already skips before
// this is ever called -- see its own gridItems comment).
const EMAIL_DOMAIN_ROW_H = 18;
// Title line + its own domain-name line, by request ("change the
// position of the domain name to under the heading in normal sized text
// with no bold") -- was inline next to the heading before.
const EMAIL_DOMAIN_TITLE_H = 16;
const EMAIL_DOMAIN_NAME_H = 13;
function measureEmailDomainCardHeight() {
  const pad = 10;
  return pad + EMAIL_DOMAIN_TITLE_H + EMAIL_DOMAIN_NAME_H + EMAIL_DOMAIN_ROW_H * 3 + pad;
}
function drawEmailDomainCard(doc, x, y, w, data) {
  const h = measureEmailDomainCardHeight();
  doc.roundedRect(x, y, w, h, 4).lineWidth(1).fillAndStroke('#ffffff', BORDER);

  const pad = 10;
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(BRAND_PURPLE).text('Mail Domain Protection DNS Check', x + pad, y + 8, { width: w - pad * 2 });
  // Normal weight, normal size, plain ink -- not bold, not muted/smaller.
  doc.font('Helvetica').fontSize(8.5).fillColor(INK).text(`Domain: ${data.domain}`, x + pad, y + 8 + EMAIL_DOMAIN_TITLE_H, { width: w - pad * 2 });

  const markSize = 10;
  const labelX = x + pad + markSize + 6;
  let ry = y + pad + EMAIL_DOMAIN_TITLE_H + EMAIL_DOMAIN_NAME_H + 2;

  // Tagged with whichever provider's own record was actually found
  // (Microsoft/Google), by request -- email-domain-protection.js's own
  // checkSpf()/checkDkim() set `provider`; neither found (or not present
  // at all) leaves the row untagged, same as the on-screen card.
  const providerTag = (provider) => (provider === 'microsoft' ? ' (Microsoft)' : provider === 'google' ? ' (Google)' : '');
  const rows = [
    {
      key: 'dmarc',
      label: 'DMARC',
      present: data.dmarc.exists,
      status: data.dmarc.exists
        ? data.dmarc.policy === 'reject'
          ? { text: 'Reject', color: BRAND_GREEN }
          : data.dmarc.policy === 'quarantine'
            ? { text: 'Quarantine', color: AMBER }
            : { text: 'Exists', color: MUTED }
        : null,
    },
    { key: 'spf', label: `SPF${providerTag(data.spf.provider)}`, present: data.spf.exists, status: null },
    { key: 'dkim', label: `DKIM${providerTag(data.dkim.provider)}`, present: data.dkim.exists, status: null },
  ];
  rows.forEach((row) => {
    if (row.present) drawCheckMark(doc, x + pad, ry, markSize, BRAND_GREEN);
    else drawXMark(doc, x + pad, ry, markSize, RED);
    // DMARC's own status, in a solid pill at the row's right edge, by
    // request ("put the Reject, Quarantine, etc in a pill like the Mail
    // Domain Protection Monitoring section has") -- same drawPill()
    // drawMdpCard()'s own DMARC Policy pill uses, just this card's own
    // colour/label logic (Reject/Quarantine/Exists, not MDP_POLICY_LABELS'
    // Reject/Quarantine/None -- "Exists" here means the record's present
    // but p=none, a neutral state, not the "nothing set at all" MDP
    // Monitoring's own None label means).
    let labelW = w - pad * 2 - markSize - 6;
    if (row.status) {
      doc.font('Helvetica-Bold').fontSize(8);
      const pillW = doc.widthOfString(row.status.text) + 16;
      labelW -= pillW + 6;
      drawPill(doc, x + w - pad - pillW, ry - 2, row.status.text, row.status.color);
    }
    doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(row.label, labelX, ry, { width: labelW });
    ry += EMAIL_DOMAIN_ROW_H;
  });

  doc.fillColor(INK);
  return h;
}

// `mdp` is null whenever the 3 values weren't sent (or didn't parse) --
// skips the section entirely rather than ever drawing invented numbers,
// same "null means omit, not guess" reasoning server.js's own
// parseMailDomainProtection() already documents.
// DMARC Policy pill colour -- its own small map, independent of the dot
// levels above (the enforcement policy and the picked dot level are 2
// separate manual fields now, not derived from one another).
const MDP_POLICY_COLORS = { reject: BRAND_GREEN, quarantine: AMBER, none: RED };
const MDP_POLICY_LABELS = { reject: 'Reject', quarantine: 'Quarantine', none: 'None' };

// Card-sized to match the other Cybersecurity Systems cards, by request --
// this joins the SAME 2-column packed grid as vendorCardSpecs()' own cards
// (drawCybersecurityLayers() below), not a separate full-width section, so
// it's the shortest-column-first packing + shared purple background that
// actually makes it "sized like the other items", not just a similar
// width. Score ring on the left, DMARC/SPF/DKIM as 3 rows (dots + name,
// by request -- "put the name of the widget next to the green dots") down
// the right. No "Manual Entry Required" label in the PDF itself, by
// request -- that's only an on-screen cue now (client.js's own
// .live-reports-mdp-cog), not something a client reading the finished
// report needs to see.
function measureMdpCardHeight() {
  const pad = 10;
  const titleH = 16;
  const ringD = 64; // same ring diameter drawDonut() uses (AutoElevate's own card)
  const rowH = 16;
  const bodyH = Math.max(ringD, rowH * 3);
  return pad + titleH + bodyH + pad;
}
function drawMdpCard(doc, x, y, w, mdp) {
  const h = measureMdpCardHeight();
  doc.roundedRect(x, y, w, h, 4).lineWidth(1).fillAndStroke('#ffffff', BORDER);

  doc.fillColor(BRAND_PURPLE).font('Helvetica-Bold').fontSize(9.5).text('Mail Domain Protection Monitoring', x + 10, y + 8, { width: w - 20 });
  doc.fillColor(INK);

  const score = Math.max(0, Math.min(10, Math.round(mdp.score)));
  const scoreColor = score >= 8 ? BRAND_GREEN : score >= 5 ? AMBER : RED;
  const dmarcLevel = mdpLevel(mdp.dmarcLevel);
  const spfLevel = mdpLevel(mdp.spfLevel);
  const dkimLevel = mdpLevel(mdp.dkimLevel);

  const pad = 10;
  const titleH = 16;
  const ringD = 64;
  const rowH = 16;
  const rowsBlockH = rowH * 3;
  const bodyY = y + pad + titleH;

  drawScoreDonut(doc, x + pad, bodyY, score, scoreColor);

  // Rows vertically centred next to the ring, by request ("centre the
  // dmarc, spf & dkim vertically next to the widget") -- the 3-row block
  // (48px) is shorter than the ring (64px), so it's offset down to sit in
  // the middle rather than flush with the ring's own top edge.
  const rowsX = x + pad + ringD + 14;
  const rowsW = w - pad * 2 - ringD - 14;
  const rowsStartY = bodyY + (ringD - rowsBlockH) / 2;

  // DMARC Policy as a pill on the DMARC row itself now, by request ("put
  // the Dmarc policy in a pill next to the Dmarc row") -- no longer its
  // own line underneath.
  const policyLabel = MDP_POLICY_LABELS[mdp.dmarcPolicy] || 'None';
  doc.font('Helvetica-Bold').fontSize(8);
  const pillW = doc.widthOfString(policyLabel) + 16;

  const rows = [
    { level: dmarcLevel, name: 'DMARC', pill: { label: policyLabel, color: MDP_POLICY_COLORS[mdp.dmarcPolicy] || RED, w: pillW } },
    { level: spfLevel, name: 'SPF', suffix: `${mdp.spfPassRate}%` },
    { level: dkimLevel, name: 'DKIM', suffix: `${mdp.dkimPassRate}%` },
  ];
  rows.forEach((r, i) => {
    const ry = rowsStartY + i * rowH + 4;
    drawMdpDots(doc, rowsX, ry, r.level);
    const reserved = r.pill ? r.pill.w + 6 : 30;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(r.name, rowsX + 36, ry - 4, { width: rowsW - 36 - reserved });
    if (r.pill) {
      drawPill(doc, rowsX + rowsW - r.pill.w, ry - 7, r.pill.label, r.pill.color);
    } else if (r.suffix) {
      doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(r.suffix, rowsX + rowsW - 30, ry - 4, { width: 30, align: 'right' });
    }
  });

  doc.fillColor(INK);
  return h;
}

function drawCybersecurityLayers(doc, y, vendors, mailDomainProtection, cyberCards, emailDomainProtectionData) {
  // Always its own fresh page now, by request -- the earlier "continues
  // straight on from Device Health when it fits" behaviour is gone.
  doc.addPage();
  const pageTop = doc.page.margins.top;
  const pageBottom = doc.page.height - doc.page.margins.bottom;
  y = pageTop;
  y = drawSectionHeading(doc, y, 'Cybersecurity Systems');
  // Gap under the heading before the purple box starts, by request (it
  // was overlapping the heading's own underline, erasing it -- same fix
  // drawDeviceHealth()'s own heading->box gap already has).
  y += 10;
  const w = contentWidth(doc);
  const gap = 10;
  const colW = (w - gap) / 2;
  // Per-card "include in PDF" tick boxes, by request -- cyberCards is
  // {key: boolean}, keyed by each spec's own `key` (set where it's
  // pushed, above); explicitly false is the only thing that excludes a
  // card -- missing/undefined (an older client that didn't send this, or
  // a key this file doesn't know about) still shows, same "only an
  // explicit false hides it" convention the section-level toggles in
  // buildReportPdf() below also use.
  const cards = cyberCards || {};
  // Mail Domain Protection joins this SAME grid now, by request ("put it
  // in the Cybersecurity section" / "size more like the other
  // Cybersecurity items") -- one list of {measure, draw} closures rather
  // than two separate per-type arrays, so the shortest-column-first
  // packing below treats every card (vendor or mdp) identically; it's
  // what actually makes mdp's card "sized like the others", not just
  // similar dimensions drawn separately.
  const gridItems = vendorCardSpecs(vendors)
    .filter((spec) => cards[spec.key] !== false)
    .map((spec) => ({
      measure: () => measureCyberCardHeight(doc, colW, spec),
      draw: (x, y_) => drawCyberCard(doc, x, y_, colW, spec),
    }));
  // Email Domain Protection pushed BEFORE Mail Domain Protection
  // Monitoring, by request ("Put it before the ... Monitoring section") --
  // gridItems' own insertion order, same "earlier means it's offered to
  // the packing loop first" convention every card here already follows.
  if (emailDomainProtectionData && cards.emailDomainProtection !== false) {
    gridItems.push({
      measure: () => measureEmailDomainCardHeight(),
      draw: (x, y_) => drawEmailDomainCard(doc, x, y_, colW, emailDomainProtectionData),
    });
  }
  if (mailDomainProtection && cards.mailDomainProtection !== false) {
    gridItems.push({
      measure: () => measureMdpCardHeight(),
      draw: (x, y_) => drawMdpCard(doc, x, y_, colW, mailDomainProtection),
    });
  }

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
  gridItems.forEach((item) => {
    const h = item.measure();
    const col = colY[0] <= colY[1] ? 0 : 1;
    let cy = colY[col];
    if (cy + h > pageBottom) {
      cy = pageTop;
      colY = [cy, cy];
      pages.push([]);
    }
    pages[pages.length - 1].push({ item, x: colX[col], y: cy, h });
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
    items.forEach((it) => it.item.draw(it.x, it.y));
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
  // Heading stays, by request -- only the list below it moved to
  // drawExplanationsBox()'s smaller/boxed format (same one Cybersecurity's
  // own list now uses).
  y = drawSectionHeading(doc, y, 'Understanding Your Scores');
  return drawExplanationsBox(doc, y, SCORE_EXPLANATIONS);
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
// Measured separately from drawProactiveMaintenanceNote() below (same
// measure/draw split this file uses elsewhere -- measureDonutHeight()/
// drawDonut(), etc.) so buildReportPdf() can ALSO use it to decide, up
// front, whether this box and the All Devices table right after it will
// both fit on the current page together (see the call site below) -- not
// just whether this box alone fits, which is all ensureSpace() inside
// drawProactiveMaintenanceNote() itself still separately guards against.
function measureProactiveMaintenanceHeight(doc, items) {
  if (!items || items.length === 0) return 0;
  const w = contentWidth(doc);
  const pad = 12;
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
  return 24 + colHeight + 6 + captionHeight + 10;
}

// Estimates the All Devices table's own height WITHOUT drawing it, same
// reasoning as measureProactiveMaintenanceHeight() above -- lets
// buildReportPdf() below decide up front whether BOTH sections fit
// together. Every device row here is a short, fixed-shape 16px row
// (device name/type/user are real-world short enough not to wrap in
// practice), so rowHeight*count is a safe estimate, not a guess -- same
// "safe estimate" reasoning drawTable()'s own callers elsewhere in this
// file already rely on. drawTable() itself still page-breaks correctly
// mid-table on the rare row that DOES wrap taller than estimated, so a
// slightly-short estimate here is never unsafe, just occasionally
// over-cautious by one row's worth of height.
function estimateDeviceListHeight(report) {
  const devices = report.dattoLive && report.dattoLive.devices;
  if (!devices || devices.length === 0) return 0;
  return 28 + 14 + 18 + devices.length * 16 + 18; // heading + caption/gap + table header + rows + trailing gap
}

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

// Same coloured, full-width box style as Proactive Maintenance above
// (#f3f1fb fill, 12px pad, 4px corners), by request -- used for the "see
// the end of this report" pointer note left behind when the Cybersecurity
// Systems descriptions box itself gets deferred (buildReportPdf() below).
function drawNoteBox(doc, y, text) {
  const w = contentWidth(doc);
  const pad = 12;
  doc.font('Helvetica').fontSize(9);
  const textHeight = doc.heightOfString(text, { width: w - pad * 2 });
  const boxHeight = pad * 2 + textHeight;
  y = ensureSpace(doc, y, boxHeight);
  doc.roundedRect(MARGIN, y, w, boxHeight, 4).fill('#f3f1fb');
  doc.fillColor(INK).text(text, MARGIN + pad, y + pad, { width: w - pad * 2 });
  doc.fillColor(INK);
  return y + boxHeight;
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
  const recommendations = (commentary && commentary.recommendations) || [];
  // null/empty when Generate Summary was never run -- a placeholder note
  // reserves a fixed bit of space here instead of this section just
  // disappearing (same reasoning as drawExecutiveSummary above).
  if (recommendations.length === 0) {
    const noteH = 24;
    y = ensureSpace(doc, y, noteH);
    doc.font('Helvetica-Oblique').fontSize(9).fillColor(MUTED).text('Recommendations to be discussed.', MARGIN, y + 4);
    return y + noteH;
  }
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
  return drawTable(doc, y, columns, recommendations, { rowHeight: 30, headerHeight: 20 }) + 18;
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

function buildReportPdf({ report, vendors, commentary, mailDomainProtection, sections, cyberServiceItems, emailDomainProtectionData }) {
  // Per-section "include in PDF" tick boxes, by request -- explicitly
  // false is the only thing that hides a section; missing/undefined (an
  // older client, or server.js's own parseSections() default) still
  // shows, same convention drawCybersecurityLayers()' own per-card
  // cyberCards filter above uses.
  const s = sections || {};
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

    // Set below if the Cybersecurity Systems descriptions box doesn't fit
    // where it's normally drawn (by request) -- carries the already-
    // resolved item list (real SharePoint data, or the static fallback)
    // across to right after Understanding Your Scores, where it's drawn
    // under its own "Cybersecurity Module Descriptions" heading instead.
    let deferredCyberExplanationItems = null;
    try {
      let y = drawCoverHeader(doc, report);
      if (s.overallHealthView !== false) y = drawAtAGlance(doc, y, report);

      // Devices by Type / Check-in Freshness, on page 1 now, above
      // Executive Summary, by request.
      if (s.deviceOverview !== false) y = drawDeviceOverviewRow(doc, y, report.dattoLive);

      // Drawn regardless of whether commentary exists -- drawExecutiveSummary()
      // itself renders a placeholder when it's null, by request, so the
      // page layout doesn't vary depending on whether Generate Summary was
      // run before Create PDF.
      if (s.executiveSummary !== false) y = drawExecutiveSummary(doc, y, commentary);
      if (s.scorecard !== false) y = drawScorecard(doc, y, report, vendors);

      // On Track/Action Needed/Watch now ALWAYS lead the next page, by
      // request ("Move On track Action needed and watch to always start on
      // the next page. keep scorecard on page 1") -- replaces the old
      // measure-everything-up-front "does it all fit on page 1 anyway"
      // check (and the pendingWatchCommentary deferral it fed), which is no
      // longer needed now that these three never compete with page 1's own
      // content for space in the first place.
      doc.addPage();
      y = doc.page.margins.top;
      if (s.onTrackActionWatch !== false) {
        // Same reasoning as drawExecutiveSummary above -- drawStatusCard()
        // already renders "Nothing to report" for an empty/missing list, so
        // passing commentary || {} here keeps On Track/Action Needed/Watch
        // on the page at their usual size instead of omitting them when
        // Generate Summary hasn't been run.
        y = drawTopRow(doc, y, commentary || {});
        y += 10;
        y = drawWatchCard(doc, y, commentary || {});
        y += 18;
      }
      // Followed straight by Asset Management (drawDeviceHealth() below
      // starts with it), not a further page break, same "don't push this to
      // page 3" reasoning the old deferred-Watch case already established.
      if (s.deviceHealth !== false) y = drawDeviceHealth(doc, y, report, s.deviceHealthItems);

      if (s.cybersecurity !== false) {
        // Cybersecurity Layers now always starts on its own fresh page, by
        // request -- drawCybersecurityLayers() calls doc.addPage() itself,
        // so `y` going in here doesn't matter. Mail Domain Protection is
        // just one more card in this same grid now, by request -- see its
        // own comment above gridItems inside drawCybersecurityLayers().
        y = drawCybersecurityLayers(doc, y, vendors, mailDomainProtection, s.cyberCards, emailDomainProtectionData);

        // A bit more breathing room than the standard inter-section gap, by
        // request -- Cybersecurity Systems' own purple background card ends
        // right at its return value, so the plain gap read as tight next to
        // the heading immediately below it.
        y += 14;

        // Fixed "what each of these systems does" reference copy, directly
        // under Cybersecurity Systems, by request -- UNLESS it wouldn't
        // fit on this page, in which case it's deferred to after
        // Understanding Your Scores instead (by request, "if the
        // Cybersecurity product descriptions doesn't fit and therefore
        // pushes onto the next page..."), with just a short pointer left
        // here so it doesn't silently vanish from this page's flow. Fit is
        // checked directly against the page bottom (not ensureSpace(),
        // which would just start a fresh page and draw it there anyway --
        // exactly the case being avoided here).
        const resolvedCyberItems = resolveCyberExplanationItems(cyberServiceItems);
        const explanationsBoxHeight = measureExplanationsBoxHeight(doc, resolvedCyberItems);
        if (y + explanationsBoxHeight <= doc.page.height - doc.page.margins.bottom) {
          y = drawExplanationsBox(doc, y, resolvedCyberItems);
          y += 14;
        } else {
          deferredCyberExplanationItems = resolvedCyberItems;
          y = drawNoteBox(doc, y, 'See the end of this report for cybersecurity systems and modules descriptions.');
          y += 14;
        }
      }

      // Microsoft License Counts, between Cybersecurity Systems and All
      // Devices now, by request (was after All Devices) --
      // drawM365LicensesTable() already starts its own fresh page when it
      // wouldn't otherwise fit, so this doesn't need a forced addPage()
      // here, same as every other section that continues straight on from
      // whatever came before it when there's room.
      if (s.m365Licenses !== false) y = drawM365LicensesTable(doc, y, vendors.m365Licenses);

      // Device list and the score-explanations glossary both sit right
      // before Recommendations now, by request -- the device-by-device
      // table used to live directly under Device Health's own donuts;
      // moved here instead. Proactive Maintenance sits right above the
      // table, by request (used to sit at the bottom of the Cybersecurity
      // Layers page). Replacement Recommendation/Operating System used to
      // sit here too -- moved back into Device Health itself, by request
      // (drawDeviceHealth() above). Skipped entirely (no blank page) when
      // there's genuinely no device list to show, same as the old inline
      // placement did. Proactive Maintenance and All Devices are 2
      // separate "include in PDF" toggles now, by request, even though
      // they share one combined measure/ensureSpace() call below.
      //
      // Proactive Maintenance no longer forces a fresh page UNconditionally,
      // by request ("Proactive maintenance doesn't need to go to the next
      // page if the whole of it and the All Devices section will fit") --
      // both are measured/estimated up front (measureProactiveMaintenanceHeight()/
      // estimateDeviceListHeight() above) and ensureSpace()'d as ONE
      // combined check, so the decision is "does everything below fit
      // together on THIS page", not just whichever section's own internal
      // ensureSpace() would have reacted to on its own (which could have
      // left Proactive Maintenance fitting alone while orphaning the All
      // Devices heading below it, same class of bug fixed earlier for
      // Device Health's own heading+box). For a client with enough devices
      // that the table alone would already need to continue onto further
      // pages, the combined estimate naturally comes out taller than any
      // single page, so this still pushes to a fresh page exactly like the
      // old unconditional behaviour did -- the forced break is only
      // skipped when everything genuinely fits.
      const showProactiveMaintenance = s.proactiveMaintenance !== false;
      const showDeviceList = s.deviceList !== false;
      if (report.dattoLive && report.dattoLive.devices && report.dattoLive.devices.length > 0 && (showProactiveMaintenance || showDeviceList)) {
        const pmH = showProactiveMaintenance ? measureProactiveMaintenanceHeight(doc, report.proactiveMaintenance) : 0;
        const dlH = showDeviceList ? estimateDeviceListHeight(report) : 0;
        y = ensureSpace(doc, y, pmH + (pmH > 0 && showDeviceList ? 10 : 0) + dlH);
        if (showProactiveMaintenance) {
          y = drawProactiveMaintenanceNote(doc, y, report.proactiveMaintenance);
          y += 10;
        }
        if (showDeviceList) y = drawDeviceList(doc, y, report);
      }

      // Understanding Your Scores has no "include in PDF" toggle, by
      // request ("No need for the tick for 'Understanding your scores'
      // This one can be always included.") -- always drawn, unlike every
      // other section in this file.
      doc.addPage();
      y = doc.page.margins.top;
      y = drawScoreExplanations(doc, y);
      // Extra breathing room before Our Recommendations, by request -- the
      // last explanation item's own trailing gap (10px,
      // drawScoreExplanations above) read as too tight between the two
      // sections on the same page.
      y += 16;

      // Cybersecurity Systems' own descriptions box, deferred here because
      // it didn't fit back where it's normally drawn (see the Cybersecurity
      // Systems block above) -- its own heading, by request ("move it to
      // after Understanding Your Scores with a heading of 'Cybersecurity
      // Module Descriptions'"). Continues straight on from Understanding
      // Your Scores when it fits, same as every other section here;
      // drawExplanationsBox()'s own ensureSpace() still starts a fresh page
      // for it if it doesn't.
      if (deferredCyberExplanationItems) {
        y = drawSectionHeading(doc, y, 'Cybersecurity Module Descriptions');
        y = drawExplanationsBox(doc, y, deferredCyberExplanationItems);
        y += 16;
      }

      // No forced page break here, by request -- Our Recommendations
      // continues straight on from Understanding Your Scores, same page
      // when it fits (ensureSpace()'s normal per-row page-break logic,
      // inside drawTable() itself, still applies if it doesn't).
      // drawRecommendations() itself renders a placeholder note when there
      // are none, by request -- always drawn now, same reasoning as above.
      if (s.recommendations !== false) drawRecommendations(doc, y, commentary);

      addFootersAndPageNumbers(doc, `Ambient iT | Managed Services Report | ${report.siteName}`);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// CYBERSECURITY_EXPLANATIONS/SCORE_EXPLANATIONS also exported -- by
// request, server.js's own new GET /report-explanations route (the
// on-screen "Understanding Your Scores"/"Cybersecurity Module
// Descriptions" sections, previously PDF-only) reuses these exact same
// constants rather than a second, separately-maintained copy of this
// fixed reference text.
module.exports = { buildReportPdf, CYBERSECURITY_EXPLANATIONS, SCORE_EXPLANATIONS };
