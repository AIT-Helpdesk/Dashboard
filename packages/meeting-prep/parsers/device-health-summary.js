// Parses a Datto RMM "Device Health Summary Report" PDF's extracted text
// into the shape server.js's buildReportComponent('device-health-summary',
// ...) expects. Only the SUMMARY block (checksPassed/checksFailed/
// byDeviceType) is reliably text-derived -- validated against this live
// "Device Health Summary - Blake Sign Co.pdf" sample, and confirmed to
// include 2 categories (Network Devices, ESXi Hosts) that an earlier,
// hand-built pass at this data was missing entirely (that gap was reported
// as a known limitation earlier this session; it turns out those 2 numbers
// were always sitting in the report as plain text, just never captured).
//
// The per-device PASS/FAIL grid (Disk Space, RAM Quantity, Software
// Compliant, Fully Patched, Antivirus Up to Date, Under Warranty, Online
// Within Last 30 Days, No Open Alerts) is rendered as coloured icons, not
// text -- data/README.md already documents this needs a pixel-colour
// classification step this parser doesn't attempt (Phase 2, deferred, same
// as this whole codebase's own plan for this report). deviceHealth-
// SummaryWidgetsHtml() in client.js only ever reads summary.checksPassed/
// checksFailed/byDeviceType -- confirmed NOT the per-device checks -- so
// the widget itself renders fully correct from this parser alone; only the
// full per-device table stays incomplete (device/description/OS only, no
// checks) until Phase 2.
const SUMMARY_LABELS = {
  'Devices with Check Passed': 'checksPassed',
  'Devices with Checks Failed': 'checksFailed',
};
const DEVICE_TYPE_LABELS = ['Servers', 'Workstations', 'Network Devices', 'ESXi Hosts', 'Printers', 'Mobiles'];

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

  let checksPassed = 0;
  let checksFailed = 0;
  const byDeviceType = {};
  for (const label of DEVICE_TYPE_LABELS) byDeviceType[label] = 0;
  for (const line of lines) {
    for (const [label, key] of Object.entries(SUMMARY_LABELS)) {
      const m = new RegExp(`^${label}:\\s*(\\d+)$`).exec(line);
      if (m) {
        if (key === 'checksPassed') checksPassed = Number(m[1]);
        else checksFailed = Number(m[1]);
      }
    }
    for (const label of DEVICE_TYPE_LABELS) {
      const m = new RegExp(`^${label}:\\s*(\\d+)$`).exec(line);
      if (m) byDeviceType[label] = Number(m[1]);
    }
  }

  // Device names/OS -- best-effort only (see this file's own top comment;
  // not used by the widget, only the full per-device table). Read line-by-
  // line rather than from one big collapsed block -- the column headers
  // above this table wrap across MANY short lines of their own ("Online" /
  // "Within Last" / "30 Days" / "RAM" / "Quantity" / ...) with no reliable
  // single end marker, so collapsing everything from "Device Name" onward
  // pulled that header noise into the first device's own name. Each real
  // device row instead starts on its OWN line as "<name-ish text>
  // Microsoft Windows ..." (confirmed live), so only lines actually
  // matching that shape are used -- a device name split mid-word by the
  // PDF's own line wrap (confirmed real case: "DESKTOP-" / "QA7322R
  // DESKTOP-QA7322R Microsoft Windows 11") loses its leading fragment
  // here, a cosmetic gap only, not a value anything downstream reads.
  const rowRe = /^(.+?)\s+(Microsoft Windows.*)$/;
  const osCompleteRe = /Microsoft Windows \d+ \w+ [\d.]+/;
  const osContinuationRe = /^[\w. ]+$/;
  const devices = [];
  for (let i = 0; i < lines.length; i++) {
    const m = rowRe.exec(lines[i]);
    if (!m) continue;
    let os = m[2];
    if (!osCompleteRe.test(os) && i + 1 < lines.length && osContinuationRe.test(lines[i + 1])) os = `${os} ${lines[i + 1]}`;
    const spaceIndex = m[1].indexOf(' ');
    devices.push({
      device: spaceIndex === -1 ? m[1] : m[1].slice(0, spaceIndex),
      description: spaceIndex === -1 ? m[1] : m[1].slice(spaceIndex + 1).trim(),
      operatingSystem: os.trim(),
      // Real check RESULTS are icon-only (Phase 2, see this file's own top
      // comment) -- an empty object here, not an absent field, since
      // client.js's deviceHealthSummaryHtml() unconditionally reads
      // d.checks[column] for every device; checkIconSvg() already renders
      // "no value" cleanly for a missing key, but `d.checks` itself being
      // undefined throws instead, which took down the whole Selected
      // Overview render (any one component's own table failing to build
      // aborts that entire pass) -- confirmed the actual cause, by request.
      checks: {},
    });
  }

  return { site, createDate, deviceCount, summary: { checksPassed, checksFailed, byDeviceType }, devices };
}

module.exports = { parse };
