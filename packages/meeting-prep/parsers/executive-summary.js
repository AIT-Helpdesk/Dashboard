// Parses a Datto RMM "Executive Summary Report" PDF's extracted text into
// the shape server.js's buildReportComponent('executive-summary', ...)
// expects -- validated against the real, hand-verified data/fairway-
// capital/2026-09-25/executive-summary.json and against the live "Executive
// Summary - Blake Sign Co.pdf" sample this session.
//
// This is the hardest report to parse -- it's rendered as gauges/icon
// widgets, not a clean table, so pdf-parse's own line reconstruction
// produces a genuinely scrambled reading order in places (see each
// section's own comment below for the specific real quirk it works around).
// Two things are DELIBERATELY left unparsed rather than guessed at:
//   - The page-1 "Summary" gauge's per-service mini-scores are NOT read
//     from that jumbled page -- every one of them is available cleanly and
//     unambiguously from each service's own "SECTIONNAME (NN%)" header
//     later in the document instead, so this never touches page 1's own
//     scrambled icon layout at all.
//   - Monitoring's topServersByAlerts/topOtherDevicesByAlerts per-device
//     breakdown: the real row data interleaves two side-by-side mini-tables
//     in a way that does NOT reliably decode against the numbers this
//     session could independently verify (see parseMonitoringSection()'s
//     own comment) -- left as empty arrays rather than shipping numbers
//     that might be wrong. alertsByPriority/alertsByDeviceType (used by the
//     actual widget) are NOT affected by this -- both parse cleanly.

function collapseLine(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function parseHeaderFields(lines) {
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
    if (createDate && site && deviceCount !== null) break;
  }
  return { createDate, site, deviceCount };
}

// The 4 Asset Management health checks are a FIXED, standard checklist --
// confirmed identical wording in both the Fairway Capital reference data
// and this live Blake Sign Co sample. A check whose own explanatory
// sub-text got glued onto it during line-wrapping (real case: "Windows
// Devices OS must be supported by Microsoft" followed by a 2-line
// "Unsupported devices are those running..." explanation, both ending up
// in the same text run before its score) is trimmed back to just the known
// short name -- otherwise that sub-text would leak into the stored check
// name.
const KNOWN_ASSET_CHECKS = [
  'Devices must have at least 15% free space on System Drive',
  'Devices must have at least 3.8 GB of memory installed',
  'Windows Devices OS must be supported by Microsoft',
  'Device must be within warranty',
];

function parseAssetManagementSection(lines, startIdx, endIdx) {
  const scoped = lines.slice(startIdx, endIdx);

  const deviceTypes = [];
  for (const line of scoped) {
    const m = /^(\S+)\s+(\d+)\s*\|\s*(\d+)$/.exec(line);
    if (m) deviceTypes.push({ type: m[1], addedLast30Days: Number(m[2]), totalManaged: Number(m[3]) });
  }

  const checkTableStart = scoped.findIndex((l) => l.startsWith('Device Health Check'));
  const averageIdx = scoped.findIndex((l, i) => i > checkTableStart && l.startsWith('Average'));
  const checkLines = scoped.slice(checkTableStart + 1, averageIdx === -1 ? undefined : averageIdx);
  const joined = collapseLine(checkLines.join(' '));

  const healthChecks = [];
  const rowRe = /(\d+)%\s*\|\s*(\d+)\s+(\d+)/g;
  let cursor = 0;
  let m;
  while ((m = rowRe.exec(joined))) {
    const rawCheckText = joined.slice(cursor, m.index).trim();
    const known = KNOWN_ASSET_CHECKS.find((c) => rawCheckText.startsWith(c));
    // The header reads "Score | Failed | Passed", but the real trailing
    // numbers are [Passed, Failed] in THAT order -- confirmed against real
    // data: a 100%-score row's own two numbers only make sense read this
    // way (e.g. "100% | 3 0" for a check all 3 devices passed), and the
    // reference data's own "Device must be within warranty" 0/0 case
    // matches passed=m[2]/failed=m[3] exactly. Same header/data-order
    // mismatch this whole report shows elsewhere (see
    // parseServerWorkstationSection's own comment).
    healthChecks.push({ check: known || rawCheckText, passed: Number(m[2]), failed: Number(m[3]), score: Number(m[1]) });
    cursor = m.index + m[0].length;
  }

  return { deviceTypes, healthChecks };
}

function parseMonitoringSection(lines, startIdx, endIdx) {
  const scoped = lines.slice(startIdx, endIdx);

  const alertsByPriority = [];
  const priorityRe = /^(Critical|High|Moderate|Low|Information)\s+(\d+)%\s*\|\s*(\d+)\s*\|\s*(\d+)\s+(\d+)$/;
  for (const line of scoped) {
    const m = priorityRe.exec(line);
    if (m) alertsByPriority.push({ priority: m[1], score: Number(m[2]), unresolved: Number(m[3]), raised: Number(m[4]), resolved: Number(m[5]) });
  }

  const alertsByDeviceType = [];
  const deviceTypeRe = /^(\S+)\s+(\d+)\s*\|\s*(\d+)\s+(\d+)$/;
  for (const line of scoped) {
    const m = deviceTypeRe.exec(line);
    if (m && !alertsByPriority.some((p) => p.priority === m[1])) alertsByDeviceType.push({ type: m[1], unresolved: Number(m[2]), raised: Number(m[3]), resolved: Number(m[4]) });
  }

  // NOT parsed -- see this file's own top comment. The real per-device row
  // shape (confirmed live: "DESKTOP-QA7322R 0 | 0 0 | DESKTOP-QA7322R 590 |
  // 0") interleaves two side-by-side mini-tables in a way that produced
  // numbers contradicting the independently-known totals (591 alerts, 590
  // High) under every column-order this session tried -- shipping a wrong
  // per-device breakdown to the dashboard is worse than an empty table
  // here, and neither list feeds the actual widget (only alertsByPriority
  // does).
  const topServersByAlerts = [];
  const topOtherDevicesByAlerts = [];

  const score = alertsByPriority.length > 0 ? Math.round(alertsByPriority.reduce((s, p) => s + p.score, 0) / alertsByPriority.length) : null;

  return { score, alertsByPriority, alertsByDeviceType, topServersByAlerts, topOtherDevicesByAlerts };
}

// Patch Management / Software Management / Antivirus all share the exact
// same real template (confirmed against this live sample): a "<total>
// <n> <score>%[...]" summary row for Server, then this section's own
// "SECTIONNAME (NN%)" header, then the same shape again for Workstation,
// then "Server <X> Status" / "Workstation <X> Status" label lines with
// every "<Label>: <count>" legend line for Server appearing BEFORE both
// labels and Workstation's own legend lines appearing AFTER both -- not
// interleaved with the labels the way the section title might suggest.
function parseServerWorkstationSection(lines, startIdx, endIdx) {
  const scoped = lines.slice(startIdx, endIdx);
  const scoreRowRe = /^(\d+)\s+(\d+)\s+(\d+)%/;
  const scoreRows = scoped.filter((l) => scoreRowRe.test(l)).map((l) => Number(scoreRowRe.exec(l)[3]));
  const serverScore = scoreRows[0] ?? null;
  const workstationScore = scoreRows[1] ?? null;

  const serverLabelIdx = scoped.findIndex((l) => /^Server .+ Status$/.test(l));
  const workstationLabelIdx = scoped.findIndex((l) => /^Workstation .+ Status$/.test(l));

  function parseLegendBlock(blockLines) {
    const legend = {};
    let total = null;
    for (const line of blockLines) {
      const totalOnly = /^(\d+)$/.exec(line);
      if (totalOnly && total === null) {
        total = Number(totalOnly[1]);
        continue;
      }
      // The leading total count sometimes lands on its own line (e.g.
      // Antivirus's "3") and sometimes glued onto the FIRST legend line of
      // the block instead (confirmed real case, Software Management:
      // "0 Not Compliant: 0", not "0" then "Not Compliant: 0" separately)
      // -- stripped off here so it's never mistaken for part of the label.
      const glued = /^(\d+)\s+(.+):\s*(\d+)$/.exec(line);
      if (glued) {
        if (total === null) total = Number(glued[1]);
        legend[glued[2].trim()] = Number(glued[3]);
        continue;
      }
      const legendMatch = /^(.+):\s*(\d+)$/.exec(line);
      if (legendMatch) legend[legendMatch[1].trim()] = Number(legendMatch[2]);
    }
    if (total === null) total = Object.values(legend).reduce((s, v) => s + v, 0);
    return { legend, total };
  }

  const serverBlockLines = serverLabelIdx === -1 ? [] : scoped.slice(0, serverLabelIdx);
  const workstationBlockLines = workstationLabelIdx === -1 ? [] : scoped.slice(workstationLabelIdx + 1);

  const serverParsed = parseLegendBlock(serverBlockLines);
  const workstationParsed = parseLegendBlock(workstationBlockLines);

  // `breakdown` is carried over from this schema's original hand-built
  // shape for continuity, but confirmed unused by any current rendering
  // code (client.js reads legend/total/score only) -- a simple derived
  // top-3 values, not worth deriving a "correct" semantic grouping for
  // data nothing actually reads.
  const topValues = (legend) => Object.values(legend).sort((a, b) => b - a).slice(0, 3);

  return {
    server: { legend: serverParsed.legend, total: serverParsed.total, score: serverScore, breakdown: topValues(serverParsed.legend) },
    workstation: { legend: workstationParsed.legend, total: workstationParsed.total, score: workstationScore, breakdown: topValues(workstationParsed.legend) },
  };
}

function parseProactiveMaintenanceSection(lines, startIdx, endIdx) {
  const scoped = lines.slice(startIdx, endIdx);
  const scheduledJobs = [];
  const rowRe = /^(.+?)\s+(\d+)\s*\|\s*(\w+)$/;
  for (const line of scoped) {
    const m = rowRe.exec(line);
    if (m) scheduledJobs.push({ job: m[1].trim(), components: Number(m[2]), schedule: m[3] });
  }
  return { scheduledJobs };
}

function parse(text) {
  const rawLines = text.split('\n').map((l) => l.trim());
  const { createDate, site, deviceCount } = parseHeaderFields(rawLines);
  if (!createDate || !site || deviceCount === null) {
    throw new Error(`Could not find header fields (createDate=${createDate}, site=${site}, deviceCount=${deviceCount})`);
  }

  // Noise lines that repeat on every page -- stripped up front so every
  // section-scoping search below only ever sees real content.
  const lines = rawLines.filter((l) => l && !/^-- \d+ of \d+ --$/.test(l) && l !== 'Executive Summary Report');

  // The overall gauge's own value -- the one reliable anchor on the
  // otherwise-scrambled page-1 gauge layout (confirmed live: "0% 100% |
  // 80%", the gauge's min/max/value triple, rendered as one line by
  // pdf-parse's own cell-gap detection).
  const overallMatch = lines.map((l) => /^0%\s+100%\s*\|\s*(\d+)%$/.exec(l)).find(Boolean);
  const overallScore = overallMatch ? Number(overallMatch[1]) : null;

  // Each "NAME (NN%)" header line sits somewhere in the MIDDLE of that
  // section's own content, not at its start (confirmed against the real
  // sample -- e.g. Asset Management's device-type table comes before its
  // own header, its health-check table comes after). So this is only used
  // to read each section's score, via a direct search over the WHOLE
  // document (each header text is unique, so no scoping needed for this
  // part at all) -- section CONTENT is scoped separately below, off each
  // section's own distinct starting table-header line instead.
  const scoreHeaders = {
    'asset-management': /^ASSET MANAGEMENT \((\d+)%\)$/,
    monitoring: /^MONITORING \((\d+)%\)$/,
    'patch-management': /^PATCH MANAGEMENT \((\d+)%\)$/,
    'software-management': /^SOFTWARE MANAGEMENT \((\d+)%\)$/,
    antivirus: /^ANTIVIRUS \((\d+)%\)$/,
  };
  const scoreOf = (key) => {
    const line = lines.find((l) => scoreHeaders[key].test(l));
    if (!line) throw new Error(`Could not find the "${key}" section header in the executive summary`);
    return Number(scoreHeaders[key].exec(line)[1]);
  };

  // Each section's own FIRST table-header line -- unambiguous and unique to
  // that section (different metric column names per section), found in
  // document order so a later section's own scope search never walks back
  // into an earlier one. Content for section i then runs from its own
  // start marker up to (not including) the NEXT section's start marker --
  // the true section boundary, unlike the "(NN%)" headers above.
  const startMarkers = [
    { key: 'asset-management', test: (l) => l === 'Device Type Added Last 30 Days | Total Managed' },
    { key: 'monitoring', test: (l) => l === 'Alert Priority Score | Unresolved | Raised Resolved' },
    { key: 'patch-management', test: (l) => l === 'Score | Fully Patched | Total' },
    { key: 'software-management', test: (l) => l === 'Score | Compliant | Total' },
    { key: 'antivirus', test: (l) => l.startsWith('Score | Not Running | Total') },
    { key: 'proactive-maintenance', test: (l) => l.startsWith('Scheduled Recurring Jobs') },
  ];
  let searchFrom = 0;
  const starts = startMarkers.map((marker) => {
    const idx = lines.findIndex((l, i) => i >= searchFrom && marker.test(l));
    if (idx === -1) throw new Error(`Could not find the "${marker.key}" section's own start marker in the executive summary`);
    searchFrom = idx + 1;
    return { key: marker.key, idx };
  });
  function scopeFor(key) {
    const i = starts.findIndex((s) => s.key === key);
    const start = starts[i].idx;
    const end = i + 1 < starts.length ? starts[i + 1].idx : lines.length;
    return [start, end];
  }

  const assetScope = scopeFor('asset-management');
  const monitoringScope = scopeFor('monitoring');
  const patchScope = scopeFor('patch-management');
  const softwareScope = scopeFor('software-management');
  const antivirusScope = scopeFor('antivirus');
  const proactiveScope = scopeFor('proactive-maintenance');

  const assetManagement = parseAssetManagementSection(lines, ...assetScope);
  const monitoring = parseMonitoringSection(lines, ...monitoringScope);
  const patchManagement = parseServerWorkstationSection(lines, ...patchScope);
  const softwareManagement = parseServerWorkstationSection(lines, ...softwareScope);
  const antivirus = parseServerWorkstationSection(lines, ...antivirusScope);
  const proactiveMaintenance = parseProactiveMaintenanceSection(lines, ...proactiveScope);

  const sections = [
    {
      id: 'summary',
      title: 'Summary',
      kind: 'summary',
      overallScore,
      services: {
        'Asset Management': scoreOf('asset-management'),
        Monitoring: scoreOf('monitoring'),
        'Patch Management': scoreOf('patch-management'),
        'Software Management': scoreOf('software-management'),
        Antivirus: scoreOf('antivirus'),
      },
    },
    { id: 'asset-management', title: 'Asset Management', kind: 'asset-management', score: scoreOf('asset-management'), ...assetManagement },
    { id: 'monitoring', title: 'Monitoring', kind: 'monitoring', score: scoreOf('monitoring'), alertsByPriority: monitoring.alertsByPriority, alertsByDeviceType: monitoring.alertsByDeviceType, topServersByAlerts: monitoring.topServersByAlerts, topOtherDevicesByAlerts: monitoring.topOtherDevicesByAlerts },
    { id: 'patch-management', title: 'Patch Management', kind: 'patch-management', score: scoreOf('patch-management'), server: patchManagement.server, workstation: patchManagement.workstation },
    { id: 'software-management', title: 'Software Management', kind: 'software-management', score: scoreOf('software-management'), server: softwareManagement.server, workstation: softwareManagement.workstation },
    { id: 'antivirus', title: 'Antivirus', kind: 'antivirus', score: scoreOf('antivirus'), server: antivirus.server, workstation: antivirus.workstation },
    { id: 'proactive-maintenance', title: 'Proactive Maintenance', kind: 'proactive-maintenance', scheduledJobs: proactiveMaintenance.scheduledJobs },
  ];

  return { site, createDate, deviceCount, sections };
}

module.exports = { parse };
