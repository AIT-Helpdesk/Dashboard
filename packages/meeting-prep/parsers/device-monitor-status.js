// Parses a Datto RMM "Device Monitor Status Report" PDF's extracted text
// into the shape server.js's buildReportComponent('device-monitor-status',
// ...) expects -- validated against the real, hand-verified data/fairway-
// capital/2026-09-25/device-monitor-status.json. Summary-only, by design
// (same reasoning as device-activity.js's own top comment) -- every
// per-monitor row's own priority (the LAST real field on that row) is a
// reliable, unambiguous anchor even though the surrounding "Service:
// X"/"Monitor: Y" text wraps onto extra lines inconsistently (confirmed
// live: some rows read "Moderate | Disk Space Monitor" on one line, others
// just "Moderate" alone with its own "Service: X" wrapped onto the
// following lines separately) -- every priority word starts its own line
// either way, so counting THOSE lines is what this parses, not trying to
// reconstruct each row's full text.
const PRIORITY_RE = /^(Critical|High|Moderate|Low)\b/;

function parse(text) {
  const lines = text.split('\n').map((l) => l.trim());

  let createDate = null;
  let site = null;
  let deviceCount = null;
  for (const line of lines) {
    if (!createDate) {
      const m = /^Create Date:\s*(.+)$/.exec(line);
      if (m) createDate = m[1].trim();
    }
    if (!site) {
      const m = /^Sites:\s*(.+)$/.exec(line);
      if (m) site = m[1].trim();
    }
    if (deviceCount === null) {
      const m = /^Devices:\s*(\d+)$/.exec(line);
      if (m) deviceCount = Number(m[1]);
    }
  }
  if (!createDate || !site || deviceCount === null) {
    throw new Error(`Could not find header fields (createDate=${createDate}, site=${site}, deviceCount=${deviceCount})`);
  }

  const byPriority = { Critical: 0, High: 0, Moderate: 0, Low: 0 };
  let totalMonitorEntries = 0;
  for (const line of lines) {
    const m = PRIORITY_RE.exec(line);
    if (!m) continue;
    byPriority[m[1]]++;
    totalMonitorEntries++;
  }
  if (totalMonitorEntries === 0) throw new Error('Parsed zero monitor entries');

  return { site, createDate, deviceCount, summary: { totalMonitorEntries, byPriority } };
}

module.exports = { parse };
