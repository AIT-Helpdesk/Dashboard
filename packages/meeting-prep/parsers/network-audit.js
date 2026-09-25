// Parses a Datto RMM "Network Audit Report" PDF's extracted text into the
// shape server.js's buildReportComponent('network-audit', ...) expects --
// validated against the real, hand-verified data/fairway-capital/
// 2026-09-25/network-audit.json. Only the MANAGED device table is carried
// into `devices[]` (with full device/description/ipAddress/vendor/created
// detail); the UNMANAGED/discovered side of the report only ever needs its
// raw counts (managedCount/unmanagedCount) -- networkAuditWidgetsHtml()'s
// own Managed/Unmanaged donut in client.js is counts-only, and a real
// "Unmanaged: 20" site can have dozens of half-identified discovered
// devices with no stable identity worth tracking per-row.
//
// Real layout (confirmed against the live "Network Audit - Blake Sign
// Co.pdf" sample): each managed row is "<Created date> | <Device>
// <Description> <IP Address> <Vendor>" -- Device is always one token (a
// hostname), Description can be multi-word (confirmed real case: "Tea's
// Computer"), so this locates the always-unambiguous dotted-quad IP
// address first and splits description/vendor around it, rather than
// guessing a fixed token count.
const ROW_RE = /^(\d{1,2}\s+[A-Z]{3}\s+\d{4})\s*\|\s*(\S+)\s+(.*)$/;
const IP_RE = /(\d{1,3}(?:\.\d{1,3}){3})/;

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

  const managedTableStart = lines.findIndex((l) => l.startsWith('Created |'));
  if (managedTableStart === -1) throw new Error('Could not find the managed-device table header ("Created | ...")');
  const managedEnd = lines.findIndex((l, i) => i > managedTableStart && l === 'MANAGED');
  const managedLines = managedEnd === -1 ? lines.slice(managedTableStart + 1) : lines.slice(managedTableStart + 1, managedEnd);

  const devices = [];
  for (const line of managedLines) {
    const m = ROW_RE.exec(line);
    if (!m) continue; // a stray label/page-marker line -- not a real row
    const [, created, device, rest] = m;
    const ipMatch = IP_RE.exec(rest);
    if (!ipMatch) continue; // malformed row -- skip rather than guess
    devices.push({
      device,
      description: rest.slice(0, ipMatch.index).trim() || device,
      ipAddress: ipMatch[1],
      vendor: rest.slice(ipMatch.index + ipMatch[1].length).trim(),
      created,
    });
  }
  if (devices.length === 0) throw new Error('Parsed zero managed devices from the network audit table');

  let managedCount = devices.length;
  let unmanagedCount = 0;
  for (const line of lines) {
    const mm = /^Managed:\s*(\d+)$/.exec(line);
    if (mm) managedCount = Number(mm[1]);
    const um = /^Unmanaged:\s*(\d+)$/.exec(line);
    if (um) unmanagedCount = Number(um[1]);
  }

  return { site, createDate, deviceCount, managedCount, unmanagedCount, devices };
}

module.exports = { parse };
