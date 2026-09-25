// Parses a Datto RMM "Open Monitor Alerts Report" PDF's extracted text into
// the shape server.js's buildReportComponent('open-monitor-alerts', ...)
// expects (stats.totalOpen/devicesWithAlerts are computed server-side from
// `devices[]` there, not stored here) -- validated against the real,
// hand-verified data/fairway-capital/2026-09-25/open-monitor-alerts.json.
//
// Real per-device row (confirmed live): "590 | DESKTOP-QA7322R
// DESKTOP-QA7322R 590 0 0 0 0" -- the leading "<N> | " is the row's own
// High-priority count (the column header itself renders as "High | Device
// Name Description Total Critical Moderate Low Information", with "High"
// displaced to the very front the same way this whole report family's
// headers don't match their own data's real column order -- see
// executive-summary.js's own comment on the same quirk). The 5 trailing
// numbers after device+description are, in order, Total/Critical/Moderate/
// Low/Information.
const ROW_RE = /^(\d+)\s*\|\s*(.+)$/;
const TAIL_RE = /^(.+?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/;

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

  const devices = [];
  for (const line of lines) {
    const rowMatch = ROW_RE.exec(line);
    if (!rowMatch) continue;
    const high = Number(rowMatch[1]);
    const tailMatch = TAIL_RE.exec(rowMatch[2]);
    if (!tailMatch) continue; // not a real device row (e.g. the column header line itself never matches TAIL_RE's numeric tail)
    const deviceDesc = tailMatch[1].trim();
    const spaceIndex = deviceDesc.indexOf(' ');
    devices.push({
      device: spaceIndex === -1 ? deviceDesc : deviceDesc.slice(0, spaceIndex),
      description: spaceIndex === -1 ? deviceDesc : deviceDesc.slice(spaceIndex + 1).trim(),
      total: Number(tailMatch[2]),
      critical: Number(tailMatch[3]),
      high,
      moderate: Number(tailMatch[4]),
      low: Number(tailMatch[5]),
      information: Number(tailMatch[6]),
    });
  }
  if (devices.length === 0) throw new Error('Parsed zero devices from the open monitor alerts table');

  return { site, createDate, deviceCount, devices };
}

module.exports = { parse };
