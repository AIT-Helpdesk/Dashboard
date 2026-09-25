// Parses a Datto RMM "Device Activity Report" PDF's extracted text into the
// shape server.js's buildReportComponent('device-activity', ...) expects --
// validated against the real, hand-verified data/fairway-capital/
// 2026-09-25/device-activity.json.
//
// This report is a raw per-device EVENT LOG (every scheduled job/patch/
// takeover event, one row each -- confirmed live, 900+ lines across 16
// pages for a 3-device site), not a report with its own pre-computed
// summary anywhere in the text. Only `summary: {failedEvents,
// devicesWithFailures}` is stored here (by design -- see server.js's own
// REPORT_ORDER comment: this kind is deliberately summary-only, the full
// per-event detail is too much to carry into the dashboard), so this
// parser's only job is counting how many event rows end in the Status
// column value "Failed" and how many distinct devices have at least one.
// Every event row -- regardless of how many lines its own Activity name or
// timing wraps across -- ends with "<time> (AEST) <StatusWord>" on its own
// line (confirmed live: "20:31:01 (AEST) Failed"), which is a reliable,
// unambiguous anchor even though the row's own activity text can
// coincidentally contain the word "failed" too (real case: an activity
// literally named "...Server execution failed" whose STATUS column, on
// the following line, is separately "Failed" -- this only ever counts the
// Status column value, never matches on the activity text itself).
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
  let failedEvents = 0;
  const devicesWithFailures = new Set();
  for (const line of lines) {
    const deviceMatch = /^Device Name:\s*(.+)$/.exec(line);
    if (deviceMatch) {
      currentDevice = deviceMatch[1].trim();
      continue;
    }
    const statusMatch = /\(AEST\)\s+(Failed)$/.exec(line);
    if (statusMatch) {
      failedEvents++;
      if (currentDevice) devicesWithFailures.add(currentDevice);
    }
  }

  return { site, createDate, deviceCount, summary: { failedEvents, devicesWithFailures: devicesWithFailures.size } };
}

module.exports = { parse };
