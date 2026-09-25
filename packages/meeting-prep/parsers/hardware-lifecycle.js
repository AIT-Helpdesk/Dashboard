// Parses a Datto RMM "Hardware Lifecycle Report" PDF's extracted text into
// the shape server.js's buildReportComponent('hardware-lifecycle', ...)
// expects. Only the SUMMARY block (replacementRecommendation/osSupport) is
// reliably text-derived -- validated against this live "Hardware Lifecycle
// - Blake Sign Co.pdf" sample -- hardwareLifecycleWidgetsHtml() in
// client.js only ever reads those two, confirmed NOT the per-device
// `bands[].devices[]` detail, so the widget itself renders fully correct
// from this parser alone.
//
// `bands` is returned with the correct 3 band ids/labels but EMPTY device
// lists for now, by design, not an oversight -- a real per-device row here
// (confirmed live) wraps in genuinely awkward ways a single sample isn't
// enough to generalise safely from (a domain username backslash-wrapping
// mid-word: "AzureAD\Ada" / "mBlake_lpjfq3" / "a", and a serial number
// split the same way: "5CD1470R" / "7N") -- on top of which the health
// CHECKS themselves are icon-grid data needing the same Phase 2 pixel-
// classification device-health-summary.js's own top comment describes.
// Shipping a guessed per-device reconstruction here risks wrong serial
// numbers/usernames on the dashboard for no widget benefit; left empty and
// documented rather than guessed, same principle this whole file family
// follows for genuinely uncertain data.
const REPLACEMENT_LABELS = [
  'Replacement recommended within 12 months',
  'Replacement recommended within 12-24 months',
  'Suitable for 24 months+',
  'Unknown',
];
const OS_SUPPORT_LABELS = ['Operating system is supported', 'Operating system is unsupported unless manufacturer extended support has been arranged', 'Operating system is unsupported'];

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

  const replacementRecommendation = {};
  for (const label of REPLACEMENT_LABELS) {
    const line = lines.find((l) => l.startsWith(`${label}:`));
    const m = line ? /:\s*(\d+)$/.exec(line) : null;
    replacementRecommendation[label] = m ? Number(m[1]) : 0;
  }

  // The short-form "Operating system is supported: N" list earlier on the
  // same page uses DIFFERENT wording for the middle category ("...may be
  // unsupported") than this schema's own established key ("...unless
  // manufacturer extended support has been arranged") -- read from the
  // fuller legend-label list instead (each label on its own line,
  // immediately followed by "Total Devices", with the matching values
  // immediately after that in the SAME order) so the stored key matches
  // every other client's own data.
  const osSupport = {};
  const labelStart = lines.findIndex((l) => l === OS_SUPPORT_LABELS[0]);
  if (labelStart !== -1 && lines[labelStart + 3] === 'Total Devices') {
    for (let i = 0; i < OS_SUPPORT_LABELS.length; i++) {
      const value = Number(lines[labelStart + 4 + i]);
      osSupport[OS_SUPPORT_LABELS[i]] = Number.isFinite(value) ? value : 0;
    }
  } else {
    for (const label of OS_SUPPORT_LABELS) osSupport[label] = 0;
  }

  const bands = [
    { id: 'within-12-months', label: 'Replacement advised within 12 months', devices: [] },
    { id: '12-24-months', label: 'Replacement advised within 12-24 months', devices: [] },
    { id: '24-plus-months', label: 'Suitable for 24+ months', devices: [] },
  ];

  return { site, createDate, deviceCount, summary: { replacementRecommendation, osSupport }, bands };
}

module.exports = { parse };
