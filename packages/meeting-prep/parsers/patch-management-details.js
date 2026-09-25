// Parses a Datto RMM "Patch Management Details Report" PDF's extracted
// text into the shape server.js's buildReportComponent('patch-management-
// details', ...) expects -- validated against the real, hand-verified
// data/fairway-capital/2026-09-25/patch-management-details.json.
// Summary-only, by design (same reasoning as device-activity.js's own top
// comment -- a month of per-patch rows is too much detail to carry into
// the dashboard).
//
// Each patch row (confirmed live) ends "<Status> | <Priority>" (e.g.
// "Installed | Critical", "Approved | Unspecified") on its own line, even
// when the patch's own title wraps across 2 lines first -- a reliable
// anchor regardless of the title text, which this never needs to fully
// reconstruct.
const ROW_RE = /\b(Installed|Approved)\s*\|\s*\S+$/;

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

  const byStatus = {};
  let totalPatchesListed = 0;
  for (const line of lines) {
    const m = ROW_RE.exec(line);
    if (!m) continue;
    byStatus[m[1]] = (byStatus[m[1]] || 0) + 1;
    totalPatchesListed++;
  }
  if (totalPatchesListed === 0) throw new Error('Parsed zero patch rows');

  return { site, createDate, deviceCount, summary: { totalPatchesListed, byStatus } };
}

module.exports = { parse };
