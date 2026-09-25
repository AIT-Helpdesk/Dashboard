// Parses a Datto RMM "Patch Management Activity Report" PDF's extracted
// text into the shape server.js's buildReportComponent('patch-management-
// activity', ...) expects and patchManagementActivityWidgetsHtml()'s own
// per-device/severity charts read -- validated against this same session's
// already-hand-verified data/fairway-capital/2026-09-25/patch-management-
// activity.json (same file the earlier "Patch Management Activity Report
// ... see if there's something you can summarise there" request produced).
//
// Each patch-install event (confirmed live) ends its own multi-line block
// with "Software <Severity>" (e.g. "Software Important", "Software
// Unspecified") -- a reliable anchor regardless of how the patch's own
// title/date fields wrap. A device with nothing installed in the selected
// range renders literally "No data" instead of any event rows (confirmed
// live: BSCO-01's own block) -- counted as 0 events for that device and
// tallied into devicesWithNoData, not skipped.
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

  let currentDevice = null;
  const deviceOrder = [];
  const byDeviceCount = new Map();
  const bySeverity = {};
  let totalPatchInstallEvents = 0;
  let devicesWithNoData = 0;

  for (const line of lines) {
    const deviceMatch = /^Device Name:\s*(.+)$/.exec(line);
    if (deviceMatch) {
      currentDevice = deviceMatch[1].trim();
      if (!byDeviceCount.has(currentDevice)) {
        byDeviceCount.set(currentDevice, 0);
        deviceOrder.push(currentDevice);
      }
      continue;
    }
    if (!currentDevice) continue;
    if (line === 'No data') {
      devicesWithNoData++;
      continue;
    }
    const eventMatch = /^Software\s+(\S+)$/.exec(line);
    if (eventMatch) {
      totalPatchInstallEvents++;
      byDeviceCount.set(currentDevice, byDeviceCount.get(currentDevice) + 1);
      bySeverity[eventMatch[1]] = (bySeverity[eventMatch[1]] || 0) + 1;
    }
  }
  if (deviceOrder.length === 0) throw new Error('Parsed zero devices from the patch management activity report');

  const byDevice = deviceOrder.map((device) => ({ device, count: byDeviceCount.get(device) }));

  return { site, createDate, deviceCount, summary: { totalPatchInstallEvents, devicesWithNoData, bySeverity, byDevice } };
}

module.exports = { parse };
