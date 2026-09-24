// Shared, pure rules engine for Meeting Prep's "recommendations" concept
// -- extracted out of meeting-prep/client.js so a SECOND page (Service
// Actions -- the same rules run across every client at once, as a
// service-team action list rather than a one-client meeting-prep aid)
// can reuse the exact same checks with zero risk of the two drifting
// apart. Deliberately just the RULES (computeFindings below) -- how a
// page presents the resulting findings (grouped how, labelled how,
// attributed to a client or not) stays page-specific, since Meeting Prep
// and Service Actions genuinely want different presentations of the same
// underlying findings.
//
// Every check here only ever reads FILE-BASED report components (kinds:
// executive-summary, device-health-summary, device-storage, hardware-
// lifecycle, patch-management-summary, dark-web-monitoring) -- never the
// two live components (Datto RMM devices, Autotask tickets) Meeting
// Prep's own /components route also returns. That's deliberate, not an
// oversight: it's what lets Service Actions compute findings for every
// client from local data/ files alone (server.js's own /all-file-
// components), with no live API calls at all -- worth keeping true given
// the live Autotask ticket-counts component has already tripped a real
// rate limit once (see meeting-prep/server.js's own comment on that
// incident); a bulk page fanning that same call out across every client
// would be a much worse version of the same problem.

function parseReportDate(str) {
  if (!str) return null;
  const rangeMatch = str.match(/\d{2}-\d{2}-\d{4}\s*to\s*(\d{2})-(\d{2})-(\d{4})/);
  if (rangeMatch) {
    const [, d, m, y] = rangeMatch;
    return new Date(Number(y), Number(m) - 1, Number(d));
  }
  const months = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  const dattoMatch = str.match(/(\d{1,2})\s+([A-Z]{3})\s+(\d{4})/);
  if (dattoMatch && dattoMatch[2] in months) {
    const [, d, mon, y] = dattoMatch;
    return new Date(Number(y), months[mon], Number(d));
  }
  return null;
}

export function formatShortDate(date) {
  return date.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Each report kind exposes its own devices differently (a flat list, a
// list of drives, or bands of devices) -- not all of them carry the raw
// `deviceCount` field from the source JSON through to the client, so this
// counts from whichever device list each kind actually has, per report.
function deviceCountsByReport(byKind) {
  const counts = {};
  if (byKind['device-health-summary']) counts[byKind['device-health-summary'].title] = byKind['device-health-summary'].devices.length;
  if (byKind['device-storage']) counts[byKind['device-storage'].title] = new Set(byKind['device-storage'].drives.map((d) => d.device)).size;
  if (byKind['patch-management-summary']) counts[byKind['patch-management-summary'].title] = byKind['patch-management-summary'].devices.length;
  if (byKind['hardware-lifecycle']) {
    counts[byKind['hardware-lifecycle'].title] = byKind['hardware-lifecycle'].bands.reduce((n, b) => n + b.devices.length, 0);
  }
  if (byKind['executive-summary']) {
    const assetSection = (byKind['executive-summary'].sections || []).find((s) => s.kind === 'asset-management');
    if (assetSection) {
      counts[byKind['executive-summary'].title] = (assetSection.deviceTypes || []).reduce((n, t) => n + (t.totalManaged || 0), 0);
    }
  }
  return counts;
}

function checkDataCurrency(byKind, add) {
  const dated = Object.values(byKind)
    .map((c) => ({ title: c.title, date: parseReportDate(c.createDate) }))
    .filter((d) => d.date);
  if (dated.length >= 2) {
    dated.sort((a, b) => a.date - b.date);
    const oldest = dated[0];
    const newest = dated[dated.length - 1];
    const spreadDays = Math.round((newest.date - oldest.date) / 86400000);
    if (spreadDays > 14) {
      add(
        'action',
        'These reports are not all from the same point in time',
        `${oldest.title} is dated ${formatShortDate(oldest.date)} and ${newest.title} is dated ${formatShortDate(newest.date)} -- a gap of about ${spreadDays} days. Worth refreshing the older reports, or at least flagging the gap to the client, before presenting these together as "current state".`
      );
    }
  }

  const counts = deviceCountsByReport(byKind);
  const distinct = [...new Set(Object.values(counts))];
  if (distinct.length > 1) {
    const detail = Object.entries(counts)
      .map(([title, n]) => `${title}: ${n}`)
      .join('; ');
    add('gather', "Device counts don't agree across reports", `${detail}. Worth confirming whether a device was added or decommissioned between report runs before presenting these as one consistent picture.`);
  }
}

function checkPatchManagement(patch, add) {
  const noPolicy = patch.devices.filter((d) => d.patchStatus === 'No Policy');
  if (noPolicy.length > 0) {
    add(
      'action',
      `${noPolicy.length} device${noPolicy.length === 1 ? ' has' : 's have'} no patch policy assigned at all`,
      `${noPolicy.map((d) => d.device).join(', ')} -- not just behind on patching, not covered by any policy. Worth assigning one and letting a cycle run before presenting this as resolved rather than open.`
    );
  }

  const rebootRequired = patch.devices.filter((d) => d.patchStatus === 'Reboot Required');
  if (rebootRequired.length > 0) {
    const reportDate = parseReportDate(patch.createDate);
    const staleNames = rebootRequired
      .map((d) => ({ device: d.device, lastReboot: parseReportDate(d.lastReboot) }))
      .filter((x) => x.lastReboot && reportDate && (reportDate - x.lastReboot) / 86400000 > 30)
      .map((x) => x.device);
    const names = rebootRequired.map((d) => d.device).join(', ');
    add(
      'action',
      `${rebootRequired.length} device${rebootRequired.length === 1 ? '' : 's'} waiting on a reboot to finish applying patches`,
      staleNames.length > 0
        ? `${names}. ${staleNames.join(', ')} ${staleNames.length === 1 ? "hasn't" : "haven't"} rebooted in over a month, so ${staleNames.length === 1 ? 'its' : 'their'} patches are sitting installed but inactive. Worth scheduling a reboot window before the meeting.`
        : `${names}. Worth scheduling reboots before the meeting so this shows as resolved rather than pending.`
    );
  }

  const heavyBacklog = patch.devices.filter((d) => (d.notApproved || 0) >= 20).sort((a, b) => b.notApproved - a.notApproved);
  if (heavyBacklog.length > 0) {
    add(
      'watch',
      `${heavyBacklog.length} device${heavyBacklog.length === 1 ? ' has' : 's have'} a large backlog of unapproved patches`,
      `${heavyBacklog.map((d) => `${d.device} (${d.notApproved})`).join(', ')}. Worth a patch approval review even on devices that do have a policy assigned.`
    );
  }
}

function checkStorage(storage, add) {
  const critical = storage.drives.filter((d) => (d.usedPercent ?? 0) >= 90);
  const high = storage.drives.filter((d) => (d.usedPercent ?? 0) >= 80 && (d.usedPercent ?? 0) < 90);
  if (critical.length > 0) {
    add(
      'action',
      `${critical.length} device${critical.length === 1 ? ' is' : 's are'} critically low on disk space`,
      `${critical.map((d) => `${d.device} (${d.usedPercent}% used, ${d.free} free)`).join(', ')}. Worth clearing space or expanding storage before the meeting -- a full system drive risks failed updates, not just a slow machine.`
    );
  }
  if (high.length > 0) {
    add('watch', `${high.length} device${high.length === 1 ? ' is' : 's are'} approaching capacity`, `${high.map((d) => `${d.device} (${d.usedPercent}% used)`).join(', ')}. Not urgent yet, but worth keeping an eye on.`);
  }
}

function checkSoftwareCompliance(exec, health, add) {
  const swSection = (exec.sections || []).find((s) => s.kind === 'software-management');
  if (!swSection || typeof swSection.score !== 'number') return;
  const otherScores = (exec.sections || [])
    .filter((s) => s.kind !== 'software-management' && s.kind !== 'summary' && typeof s.score === 'number')
    .map((s) => s.score);
  const isLowest = otherScores.length > 0 && swSection.score < Math.min(...otherScores);
  if (swSection.score >= 90 && !isLowest) return;
  const failingDevices = health ? health.devices.filter((d) => d.checks && d.checks['Software Compliant'] === 'fail').map((d) => d.device) : [];
  add(
    'gather',
    `Software Management is scoring ${swSection.score}%${isLowest ? ', the weakest category on this report' : ''}`,
    failingDevices.length > 0
      ? `${failingDevices.join(', ')} are failing the Software Compliant check, but the report data doesn't say which software or why. Worth pulling up the Software Management module for these devices before the meeting so you can name the actual issue rather than just the score.`
      : `The report data doesn't say which software is driving this down. Worth pulling up the Software Management module before the meeting so you have a specific answer ready.`
  );
}

function checkHardwareLifecycle(lifecycle, health, add) {
  const soonBand = (lifecycle.bands || []).find((b) => b.id === 'within-12-months');
  if (!soonBand || soonBand.devices.length === 0) return;
  const healthFailMap = new Map();
  if (health) {
    for (const d of health.devices) {
      const failedChecks = Object.entries(d.checks || {})
        .filter(([, v]) => v === 'fail')
        .map(([k]) => k);
      if (failedChecks.length > 0) healthFailMap.set(d.device, failedChecks);
    }
  }
  const overlap = soonBand.devices.filter((d) => healthFailMap.has(d.device));
  const names = soonBand.devices.map((d) => d.device).join(', ');
  if (overlap.length > 0) {
    add(
      'watch',
      `${soonBand.devices.length} device${soonBand.devices.length === 1 ? ' is' : 's are'} due for replacement within 12 months, and ${overlap.length === soonBand.devices.length ? 'all of them are' : `${overlap.length} of them ${overlap.length === 1 ? 'is' : 'are'}`} also currently causing trouble`,
      `${names}. ${overlap.map((d) => `${d.device} is also failing ${healthFailMap.get(d.device).join(', ')}`).join('; ')}. Worth framing the replacement recommendation together with the issues it would resolve, rather than as two separate line items.`
    );
  } else {
    add('watch', `${soonBand.devices.length} device${soonBand.devices.length === 1 ? ' is' : 's are'} due for replacement within 12 months`, `${names}. Worth having a budget figure ready in case the client asks.`);
  }
}

function checkWarrantyData(sourceComponents, add) {
  const allDevices = [];
  for (const c of sourceComponents) {
    if (c.devices) allDevices.push(...c.devices);
    if (c.bands) for (const b of c.bands) allDevices.push(...b.devices);
  }
  const withWarrantyField = allDevices.filter((d) => d.checks && 'Under Warranty' in d.checks);
  if (withWarrantyField.length === 0) return;
  const populated = withWarrantyField.filter((d) => d.checks['Under Warranty'] !== null);
  if (populated.length === 0) {
    add(
      'gather',
      "Warranty status isn't tracked for any device",
      `Every device's "Under Warranty" check comes back empty. If hardware replacement comes up in the meeting, you won't have a warranty answer ready from this data -- worth checking serials against the manufacturer beforehand, or populating this field going forward.`
    );
  }
}

function checkStaleDevices(health, add) {
  const stale = health.devices.filter((d) => d.checks && d.checks['Online Within Last 30 Days'] === 'fail');
  if (stale.length > 0) {
    add(
      'watch',
      `${stale.length} device${stale.length === 1 ? " hasn't" : "s haven't"} checked in within the last 30 days`,
      `${stale.map((d) => d.device).join(', ')}. Worth confirming with the client whether these are still active machines (and, if not, whether they should come off monitoring) before presenting them as an open issue.`
    );
  }
}

function checkDarkWebScope(darkWeb, add) {
  const summary = darkWeb.summary || {};
  const total = typeof summary.totalCompromises === 'number' ? summary.totalCompromises : 0;
  const monitored = summary.monitored || {};
  const zeroCategories = Object.entries(monitored)
    .filter(([, v]) => v === 0)
    .map(([k]) => k);
  if (total === 0) {
    add('good', 'No dark web compromises found this period', `Customer average is ${(darkWeb.benchmark || {}).customerAverageCompromises ?? 'n/a'}, so this is a strong result worth leading with.`);
  }
  if (zeroCategories.length > 0) {
    add(
      'gather',
      'Dark web monitoring scope is narrower than it could be',
      `${zeroCategories.join(' and ')} ${zeroCategories.length === 1 ? 'has' : 'have'} nothing being monitored at all. A clean result carries more weight when the monitored scope is reasonable -- worth checking with the client whether it should be widened (e.g. staff personal emails) before presenting a clean result as full coverage.`
    );
  }
}

function checkDeviceTypeCoverage(health, add) {
  const byType = health ? health.summary.byDeviceType : null;
  if (!byType) return;
  const hasNonWorkstation = Object.entries(byType).some(([type, n]) => type !== 'Workstations' && n > 0);
  if (!hasNonWorkstation) {
    add(
      'gather',
      'No servers, printers, or mobiles show up in any report',
      `Every monitored device is a workstation. If that's genuinely the whole environment, no action needed -- but if the client runs any on-prem servers, worth confirming they're actually covered by monitoring before presenting this as the complete picture.`
    );
  }
}

// The one exported entry point -- takes whatever `components` array a
// /components-shaped response returned (live components included is
// fine, every check below only ever looks at file-based `kind`s, so a
// live Datto/Autotask entry mixed into the array is simply never
// touched) and returns `{ tier, title, detail }[]`, unsorted/ungrouped --
// grouping and rendering are each caller's own job.
export function computeFindings(components) {
  const byKind = {};
  for (const c of components) byKind[c.kind] = c;
  const findings = [];
  const add = (tier, title, detail) => findings.push({ tier, title, detail });

  checkDataCurrency(byKind, add);
  if (byKind['patch-management-summary']) checkPatchManagement(byKind['patch-management-summary'], add);
  if (byKind['device-storage']) checkStorage(byKind['device-storage'], add);
  if (byKind['executive-summary']) checkSoftwareCompliance(byKind['executive-summary'], byKind['device-health-summary'], add);
  if (byKind['hardware-lifecycle']) checkHardwareLifecycle(byKind['hardware-lifecycle'], byKind['device-health-summary'], add);
  checkWarrantyData([byKind['device-health-summary'], byKind['hardware-lifecycle']].filter(Boolean), add);
  if (byKind['device-health-summary']) checkStaleDevices(byKind['device-health-summary'], add);
  if (byKind['dark-web-monitoring']) checkDarkWebScope(byKind['dark-web-monitoring'], add);
  checkDeviceTypeCoverage(byKind['device-health-summary'], add);

  return findings;
}
