// Parses a Datto RMM "Patch Management Summary Report" PDF's extracted
// text into the shape server.js's buildReportComponent('patch-management-
// summary', ...) expects -- validated against the real, hand-verified
// data/fairway-capital/2026-09-25/patch-management-summary.json and the
// live "Patch Management Summary - Blake Sign Co.pdf" sample.
//
// Real per-device row (confirmed live) wraps across 3 lines, e.g.
// "BSCO-01 BSCO-01 24 SEP 2026\n19:41 (AEST) 5 3 16 Approved\nPending" --
// collapsed to one line per device, this locates each device's own "Last
// Reboot" timestamp (an unambiguous fixed-shape date/time/timezone string)
// and its own Patch Status phrase (one of 6 known fixed values Datto
// always uses) as the two reliable anchors, then reads device/description
// from the text BEFORE the timestamp and installed/approvedPending/
// notApproved from the text BETWEEN the timestamp and the status phrase.
const REBOOT_RE = /\d{1,2}\s+[A-Z]{3}\s+\d{4}\s+\d{2}:\d{2}\s+\([A-Z]+\)/g;
const STATUS_PHRASES = ['Fully Patched', 'Approved Pending', 'Install Error', 'Reboot Required', 'No Data', 'No Policy'];
const STATUS_RE = new RegExp(`(${STATUS_PHRASES.join('|')})`, 'g');

function collapse(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function parseDevices(body) {
  const rebootMatches = [...body.matchAll(REBOOT_RE)];
  const statusMatches = [...body.matchAll(STATUS_RE)];
  const devices = [];
  let cursor = 0;

  for (let i = 0; i < rebootMatches.length; i++) {
    const reboot = rebootMatches[i];
    const status = statusMatches[i];
    if (!status) break; // fewer status matches than reboot matches -- malformed, stop rather than misassign

    const beforeText = collapse(body.slice(cursor, reboot.index));
    const spaceIndex = beforeText.indexOf(' ');
    const device = spaceIndex === -1 ? beforeText : beforeText.slice(0, spaceIndex);
    const description = spaceIndex === -1 ? beforeText : beforeText.slice(spaceIndex + 1).trim();

    const numbersText = collapse(body.slice(reboot.index + reboot[0].length, status.index));
    const numbersMatch = /^(\d+)\s+(\d+)\s+(\d+)$/.exec(numbersText);

    devices.push({
      device,
      description,
      lastReboot: collapse(reboot[0]),
      installed: numbersMatch ? Number(numbersMatch[1]) : null,
      approvedPending: numbersMatch ? Number(numbersMatch[2]) : null,
      notApproved: numbersMatch ? Number(numbersMatch[3]) : null,
      patchStatus: status[1],
    });
    cursor = status.index + status[0].length;
  }
  return devices;
}

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

  const summary = {};
  for (const status of STATUS_PHRASES) {
    const line = lines.find((l) => l.startsWith(`${status}:`));
    // The status count line can carry a trailing "| N" (a device-count
    // total, coincidental leftover from the same layout, not part of this
    // value) -- only the first number after the colon is the real count.
    const m = line ? /^[^:]+:\s*(\d+)/.exec(line) : null;
    summary[status] = m ? Number(m[1]) : 0;
  }

  const tableStart = lines.findIndex((l) => l === 'Status' || l.endsWith(' Status'));
  const body = lines.slice(tableStart + 1).join(' ');
  const devices = parseDevices(body);
  if (devices.length === 0) throw new Error('Parsed zero devices from the patch management summary table');

  return { site, createDate, deviceCount, summary, devices };
}

module.exports = { parse };
