// Parses a Datto RMM "Software Report" PDF's extracted text (via
// pdf-parse's getText(), see ingest.js) into the exact shape server.js's
// buildReportComponent('software', ...) already expects -- validated
// against the real, hand-verified data/fairway-capital/2026-09-25/
// software.json (only sourceUrl is added afterward, by ingest.js itself).
//
// Real page layout (confirmed against the live "Software - Blake Sign
// Co.pdf" sample this session): a header block, then a SUMMARY section
// (one "<name> <count>" row per distinct title, wrapped across several
// pages, "Instances Found | Software"/"Software Report" column headers and
// "-- N of M --" page markers repeating throughout -- both skipped, not
// data), then a per-device breakdown (device name/OS/description, each
// followed by its own installed-software-with-version list). Only the
// SUMMARY section is parsed -- the per-device list is intentionally NOT
// carried into the JSON (same "too much per-device detail" reasoning
// data/README.md already documents for this kind), so the summary block's
// own end (the per-device section's own start) is all this needs to find.

const HEADER_RE = /^Create Date:\s*(.+)$/;
const SITES_RE = /^Sites:\s*(.+)$/;
const DEVICES_RE = /^Devices:\s*(\d+)$/;
// A software title followed by its instance count, non-greedy so a title
// that itself ends in digits (e.g. "GoToMeeting 10.20.0.19992") still only
// has the FINAL, separately-spaced count stripped off -- confirmed against
// that exact real title in the Fairway Capital reference data.
const SUMMARY_ROW_RE = /^(.+?)\s+(\d+)$/;
const NOISE_LINES = new Set(['Software Report', 'SUMMARY', 'Instances Found | Software']);

function parse(text) {
  const lines = text.split('\n').map((l) => l.trim());

  let createDate = null;
  let site = null;
  let deviceCount = null;
  for (const line of lines) {
    if (!createDate) {
      const m = HEADER_RE.exec(line);
      if (m) createDate = m[1].trim();
    }
    if (!site) {
      const m = SITES_RE.exec(line);
      if (m) site = m[1].trim();
    }
    if (deviceCount === null) {
      const m = DEVICES_RE.exec(line);
      if (m) deviceCount = Number(m[1]);
    }
    if (createDate && site && deviceCount !== null) break;
  }
  if (!createDate || !site || deviceCount === null) {
    throw new Error(`Could not find header fields (createDate=${createDate}, site=${site}, deviceCount=${deviceCount})`);
  }

  const summaryStart = lines.indexOf('Instances Found | Software');
  if (summaryStart === -1) throw new Error('Could not find the SUMMARY section header');
  // The per-device section starts at the first "Device Name:" line -- the
  // summary block's own end, wherever that falls across however many pages.
  const deviceSectionStart = lines.findIndex((l, i) => i > summaryStart && l.startsWith('Device Name:'));
  const summaryLines = deviceSectionStart === -1 ? lines.slice(summaryStart + 1) : lines.slice(summaryStart + 1, deviceSectionStart);

  const titlesByName = new Map();
  for (const line of summaryLines) {
    if (!line || NOISE_LINES.has(line) || /^-- \d+ of \d+ --$/.test(line)) continue;
    const m = SUMMARY_ROW_RE.exec(line);
    if (!m) continue; // a stray header/label line that slipped through -- not a real title row
    const [, name, countStr] = m;
    // A title can legitimately repeat across page breaks if the PDF ever
    // wraps mid-row (not observed in the real sample, but cheap to guard);
    // sums rather than overwrites so that can never silently under-count.
    titlesByName.set(name, (titlesByName.get(name) || 0) + Number(countStr));
  }
  const titles = [...titlesByName.entries()].map(([name, instances]) => ({ name, instances })).sort((a, b) => a.name.localeCompare(b.name));
  if (titles.length === 0) throw new Error('Parsed zero software titles from the SUMMARY section');

  return {
    site,
    createDate,
    deviceCount,
    summary: { distinctTitles: titles.length, titles },
  };
}

module.exports = { parse };
