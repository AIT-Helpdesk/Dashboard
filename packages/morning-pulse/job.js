// Morning Pulse -- a scheduled, Datto-RMM-only overnight briefing, modelled
// directly on a real manual run done in chat on 2026-11-23 (403 sites, 1577
// devices) before this package existed. That run is the test oracle this
// was built against: a real run of this file should find the same things
// (Sleepy's Gepps Cross (HO) down, the RSC-TS01/GWP-AZ-TS1/MO-AZ-TS01 daily
// pattern, CKDC03's disk usage) -- see this package's README.
//
// Deliberately NOT a port of every nuance that manual run used (Datto RMM's
// MCP connector's own per-call token limits, which drove a lot of that
// run's pagination/budget caution, don't apply to a plain axios call here).
// What WAS kept: the tiering (site down > disk/backup/AD risk > everything
// else), "offline reporting is infrastructure-only, never listed by name
// as a raw count", and the capacity-based plan-filling. What was CUT:
// Datto's activity log (added nothing on the night this was modelled on,
// and @dashboard/datto-rmm has no wrapper for it) and the account-wide
// open-alert page-budget dance (irrelevant once this isn't token-metered).
const datto = require('@dashboard/datto-rmm/lib.js');
const { writeLastRunStatus } = require('./status');

const HOURS = 3;
const TECHNICIANS = 1;
const CAPACITY_MINUTES = HOURS * TECHNICIANS * 60;
const DORMANT_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const AEST_OFFSET_MS = 10 * 60 * 60 * 1000; // Queensland/most of this account's clients -- no DST, confirmed by this dashboard's own existing AEST-anchoring convention (see What's On's README)
const RESOLVED_LOOKBACK_MS = 9 * 24 * 60 * 60 * 1000; // wide enough to catch a pattern recurring daily across the last several days, not just last night
const RESOLVED_ALERT_PAGE_CAP = 40; // 10,000 resolved alerts -- comfortable margin above what a 9-day lookback has ever needed on this account
const SCHEDULE_SPREAD_MINUTES = 20; // how tight a recurring drop/resolve time has to be, across different days, to call it "scheduled" rather than "flapping"

function aestDate(ms) {
  return new Date(ms + AEST_OFFSET_MS);
}

function aestMinuteOfDay(ms) {
  const d = aestDate(ms);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function aestDayKey(ms) {
  return aestDate(ms).toISOString().slice(0, 10);
}

// "18:00 the previous working day; a Monday run covers the weekend" -- same
// rule the drmm-morning-pulse skill this was modelled on uses. AEST day of
// week (0=Sun..6=Sat) of NOW decides how many days back Friday 18:00 is.
function computeOvernightWindowStartMs(nowMs) {
  const nowAest = aestDate(nowMs);
  const dow = nowAest.getUTCDay();
  const daysBack = dow === 1 ? 3 : dow === 0 ? 2 : 1; // Monday -> Friday, Sunday -> Friday, else -> yesterday
  const todayMidnightAestUtcMs = Date.UTC(nowAest.getUTCFullYear(), nowAest.getUTCMonth(), nowAest.getUTCDate()) - AEST_OFFSET_MS;
  return todayMidnightAestUtcMs - daysBack * 24 * 60 * 60 * 1000 + 18 * 60 * 60 * 1000;
}

// Confirmed live (2026-11-23): real deviceType.category values on this
// account are Desktop/Laptop/Server/Printer/Datto Continuity and several
// "Network Device (...)" variants (Router/Firewall/NAS/IP Phone/Other) --
// no separate ESXi category exists on this account. Infrastructure =
// Server + any Network Device variant, matching the drmm-morning-pulse
// skill's own "Server, ESXi host and Network" definition for whichever of
// those this account actually has.
function isInfra(device) {
  const t = device.deviceType || '';
  return t === 'Server' || t.startsWith('Network Device');
}

function effortMinutes(effort) {
  return effort === 'quick' ? 30 : effort === 'session' ? 120 : 60; // needs-scoping
}
function effortLabel(effort) {
  return effort === 'quick' ? 'Quick, 30 min' : effort === 'session' ? 'Session, 2 h' : 'Needs scoping, 1 h';
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

// A device "fires at the same time every day" when its drop times AND its
// resolve times each cluster within SCHEDULE_SPREAD_MINUTES across the
// occurrences seen, over 2+ distinct calendar days -- the real, confirmed
// signature of a scheduled Azure VM shutdown/start, not an incident
// (RSC-TS01 dropped/resolved within a few minutes of 04:03/07:05 AEST five
// days running on the real account this was modelled against). Anything
// that repeats but ISN'T this tight is flagged as real flapping instead.
function classifyRecurrence(events) {
  const days = new Set(events.map((e) => aestDayKey(e.timestamp)));
  if (days.size < 2) return { pattern: 'single', days: days.size };
  const dropMinutes = events.map((e) => aestMinuteOfDay(e.timestamp));
  const resolveMinutes = events.filter((e) => e.resolvedOn).map((e) => aestMinuteOfDay(e.resolvedOn));
  const spread = (arr) => (arr.length ? Math.max(...arr) - Math.min(...arr) : 0);
  const scheduled = spread(dropMinutes) <= SCHEDULE_SPREAD_MINUTES && (resolveMinutes.length === 0 || spread(resolveMinutes) <= SCHEDULE_SPREAD_MINUTES);
  return { pattern: scheduled ? 'scheduled' : 'flapping', days: days.size };
}

function minutesToClock(aestMinutes) {
  const h = Math.floor(aestMinutes / 60) % 24;
  const m = aestMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

async function runFullPull() {
  const startedAt = Date.now();
  const [sites, devices] = await Promise.all([datto.getAllSites(), datto.getAllDevices()]);

  const siteByUid = new Map(sites.map((s) => [s.uid, s]));
  const devicesBySite = groupBy(devices, (d) => d.siteUid);

  const windowStartMs = computeOvernightWindowStartMs(startedAt);
  const dormantCutoffMs = startedAt - DORMANT_AFTER_MS;

  const infraOffline = devices.filter((d) => isInfra(d) && !d.online && d.lastSeen);
  for (const d of infraOffline) {
    d._newDrop = d.lastSeen >= windowStartMs;
    d._dormant = d.lastSeen < dormantCutoffMs;
  }

  // --- Open + resolved alerts, once each, shared by every pass below ----
  const [openResult, resolvedResult] = await Promise.all([
    datto.fetchRawOpenAlerts(),
    datto.fetchRawResolvedAlerts(RESOLVED_ALERT_PAGE_CAP),
  ]);
  const openAlerts = openResult.alerts;
  const resolvedAlerts = resolvedResult.alerts.filter((a) => (a.timestamp || 0) >= startedAt - RESOLVED_LOOKBACK_MS);
  const openByDevice = groupBy(openAlerts, (a) => a.deviceUid);
  const offlineOpenByDevice = groupBy(openAlerts.filter((a) => a.monitorType === 'online_offline_status_ctx'), (a) => a.deviceUid);

  // --- Recurring offline pattern (flapping vs. scheduled shutdown) ------
  // Computed BEFORE the site tiers below, deliberately -- a device whose
  // current offline-ness is already explained by a recognized daily
  // schedule (see classifyRecurrence()) shouldn't also surface as a fresh
  // "isolated new drop"/"site outage" candidate just because this run
  // happened to land inside that device's own few-minute nightly window.
  // Confirmed a real case the first time this ran live: MO-AZ-TS01 (Morey
  // Oil) was mid-drop on its own nightly ~19:00 AEST schedule at the exact
  // moment this ran, and showed up as BOTH "scheduled" and a brand new
  // isolated-outage plan item for the same event before this exclusion.
  const offlineEventsByDevice = groupBy(
    resolvedAlerts.filter((a) => a.monitorType === 'online_offline_status_ctx'),
    (a) => a.deviceUid
  );
  const recurrence = [];
  for (const [deviceUid, events] of offlineEventsByDevice) {
    if (events.length < 2) continue;
    const device = devices.find((d) => d.id === deviceUid);
    if (!device) continue;
    const info = classifyRecurrence(events);
    recurrence.push({ device, events: events.sort((a, b) => a.timestamp - b.timestamp), ...info });
  }
  const scheduledDeviceIds = new Set(recurrence.filter((r) => r.pattern === 'scheduled').map((r) => r.device.id));

  // --- Site tiers ----------------------------------------------------------
  const siteDown = [];
  const siteOutage = [];
  const isolated = [];
  const longTermOffline = []; // counts only, by request of the skill this mirrors -- never named devices
  const dormantSites = [];

  for (const [siteUid, siteDevices] of devicesBySite) {
    const site = siteByUid.get(siteUid);
    if (!site || siteDevices.length === 0) continue;
    const infra = siteDevices.filter(isInfra);
    if (infra.length === 0) continue; // workstation-only sites are never ranked or named, per the skill this mirrors
    const offlineInfra = infra.filter((d) => !d.online).filter((d) => !scheduledDeviceIds.has(d.id));
    if (offlineInfra.length === 0) continue;
    const allOffline = siteDevices.every((d) => !d.online);
    const mostRecentLastSeen = Math.max(...offlineInfra.map((d) => d.lastSeen || 0));
    const newDropCount = offlineInfra.filter((d) => d._newDrop).length;

    if (allOffline && mostRecentLastSeen >= dormantCutoffMs) {
      siteDown.push({ site, infraOffline: offlineInfra, totalDevices: siteDevices.length, mostRecentLastSeen });
    } else if (allOffline) {
      dormantSites.push({ site, infraOffline: offlineInfra.length, totalDevices: siteDevices.length });
    } else if (offlineInfra.length >= 2 && newDropCount >= 1) {
      siteOutage.push({ site, infraOffline: offlineInfra, infraTotal: infra.length, newDropCount });
    } else if (offlineInfra.length === 1 && newDropCount === 1) {
      isolated.push({ site, device: offlineInfra[0] });
    } else {
      longTermOffline.push({ site, infraOffline: offlineInfra.length });
    }
  }

  // --- Monitoring gaps -------------------------------------------------
  const monitoringGaps = infraOffline
    .filter((d) => !(offlineOpenByDevice.get(d.id) || []).length)
    .map((d) => ({ hostname: d.hostname, site: d.site, lastSeen: d.lastSeen, newDrop: d._newDrop }));

  // --- Tier 2: disk/backup/filesystem/AD on ONLINE infra devices --------
  const onlineInfra = devices.filter((d) => isInfra(d) && d.online);
  const tier2 = [];
  const diskCandidates = [];
  for (const device of onlineInfra) {
    const alerts = openByDevice.get(device.id) || [];
    const diskAlert = alerts.find((a) => a.monitorType === 'perf_disk_usage_ctx');
    const backupAlert = alerts.find(
      (a) => a.monitorType === 'backup_management_ctx' || (a.monitorType === 'comp_script_ctx' && /backup/i.test(a.message || ''))
    );
    const fsAlert = alerts.find((a) => a.monitorType === 'eventlog_ctx' && /ntfs/i.test(a.source || '') && /\b55\b/.test(a.message || ''));
    const adAlert = alerts.find((a) => a.monitorType === 'comp_script_ctx' && /replicat/i.test(a.message || ''));
    if (diskAlert) diskCandidates.push({ device, alert: diskAlert });
    if (backupAlert || fsAlert || adAlert) {
      const signals = [backupAlert && 'backup not running', fsAlert && 'file system corruption', adAlert && 'AD replication failing'].filter(Boolean);
      tier2.push({ device, signals, mostRecent: Math.max(backupAlert?.timestamp || 0, fsAlert?.timestamp || 0, adAlert?.timestamp || 0) });
    }
  }
  // Disk needs the real free-space number -- only fetched for the (small)
  // set of devices that actually have an open disk alert, same
  // "confirm live, don't guess" reasoning as everything else here.
  for (const { device, alert } of diskCandidates) {
    try {
      const audit = await datto.getDeviceAudit(device.id);
      const freePercent = audit.systemDiskFreePercent;
      const repeatDays = new Set(
        resolvedAlerts.filter((a) => a.deviceUid === device.id && a.monitorType === 'perf_disk_usage_ctx').map((a) => aestDayKey(a.timestamp))
      ).size;
      if (freePercent != null && (freePercent < 5 || (freePercent < 10 && repeatDays >= 3))) {
        tier2.push({ device, signals: [`disk nearly full (${freePercent}% free)`], mostRecent: alert.timestamp });
      } else {
        tier2.push({ device, signals: [], diskOnly: { freePercent, timestamp: alert.timestamp }, mostRecent: alert.timestamp });
      }
    } catch (err) {
      console.error(`morning-pulse: disk audit failed for ${device.hostname}:`, err.message);
    }
  }

  // Cross-site correlation -- two or more DIFFERENT sites' infra resolving
  // (or dropping) within 5 minutes of each other, more than once, is a
  // likely shared dependency (same Azure region/host), not three separate
  // faults. Built off the scheduled/flapping recurrence list above, not
  // every resolved event, so a one-off coincidence doesn't get flagged.
  const correlatedGroups = [];
  const recurringEvents = recurrence.flatMap((r) => r.events.map((e) => ({ ...e, device: r.device, pattern: r.pattern })));
  const byResolveMinuteBucket = groupBy(
    recurringEvents.filter((e) => e.resolvedOn),
    (e) => `${aestDayKey(e.resolvedOn)}|${Math.round(e.resolvedOn / (5 * 60 * 1000))}`
  );
  for (const [, group] of byResolveMinuteBucket) {
    const distinctSites = new Set(group.map((e) => e.device.siteUid));
    if (distinctSites.size >= 2) correlatedGroups.push(group);
  }

  // --- Open critical security-threat alerts (out of this skill's own
  // scope, but too sharp a signal to bury -- see README) -----------------
  // Datto never auto-expires these -- confirmed live the first real run
  // turned up open Critical security-threat alerts almost a YEAR old,
  // which is a stale-alert-hygiene problem, not "what happened last
  // night". Bounded to a recent window and a sane display cap for the
  // same reason getOpenAlerts() elsewhere in this dashboard caps its own
  // popup list -- totalCount stays honest about how many more exist.
  const SECURITY_THREAT_LOOKBACK_MS = 21 * 24 * 60 * 60 * 1000;
  const SECURITY_THREAT_DISPLAY_CAP = 15;
  const recentSecurityThreats = openAlerts
    .filter((a) => a.monitorType === 'endpoint_security_threat_ctx' && a.priority === 'Critical' && (a.timestamp || 0) >= startedAt - SECURITY_THREAT_LOOKBACK_MS)
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const securityThreats = recentSecurityThreats.slice(0, SECURITY_THREAT_DISPLAY_CAP);
  const securityThreatsTotalCount = recentSecurityThreats.length;

  // --- Muted critical alerts jump the queue -----------------------------
  const mutedCritical = openAlerts.filter((a) => a.muted && a.priority === 'Critical');

  // --- Build the ranked plan, then fill capacity greedily ----------------
  const candidates = [];
  for (const s of siteDown) {
    candidates.push({
      tier: 1,
      effort: 'quick',
      title: `Check why ${s.site.name} is fully offline`,
      why: `${s.totalDevices} of ${s.totalDevices} devices offline, including infrastructure (${s.infraOffline.map((d) => d.hostname).join(', ')}), last seen ${new Date(s.mostRecentLastSeen).toISOString()}.${monitoringGapNote(s.infraOffline, monitoringGaps)}`,
      site: s.site.name,
      rank: [0, 0],
    });
  }
  for (const m of mutedCritical) {
    candidates.push({
      tier: 1,
      effort: 'quick',
      title: `Un-mute and check: ${m.deviceName} (${m.siteName})`,
      why: `Muted Critical alert (${m.monitorType}) -- muted alerts are skipped by everyone, by design, so this jumps the queue.`,
      site: m.siteName,
      rank: [0, 1],
    });
  }
  for (const o of siteOutage) {
    candidates.push({
      tier: 3,
      effort: 'session',
      title: `Investigate outage at ${o.site.name}`,
      why: `${o.infraOffline.length} of ${o.infraTotal} infrastructure devices offline, ${o.newDropCount} newly dropped overnight.`,
      site: o.site.name,
      rank: [3, 0],
    });
  }
  for (const i of isolated) {
    candidates.push({
      tier: 3,
      effort: 'quick',
      title: `Check ${i.device.hostname} (${i.site.name})`,
      why: `Isolated new drop overnight, last seen ${new Date(i.device.lastSeen).toISOString()}.`,
      site: i.site.name,
      rank: [3, 1],
    });
  }
  for (const t of tier2.filter((t) => t.signals.length)) {
    candidates.push({
      tier: 2,
      effort: 'session',
      title: `${t.signals.join(' + ')} on ${t.device.hostname}`,
      why: `${t.device.hostname} (${t.device.site}): ${t.signals.join('; ')}.`,
      site: t.device.site,
      rank: [2, -t.signals.length, -(t.mostRecent || 0)],
    });
  }
  for (const r of recurrence.filter((r) => r.pattern === 'flapping')) {
    candidates.push({
      tier: 3,
      effort: 'quick',
      title: `Repeated overnight drops: ${r.device.hostname} (${r.device.site})`,
      why: `Dropped and recovered ${r.events.length} times across ${r.days} different days -- not on a consistent schedule, worth a real look.`,
      site: r.device.site,
      rank: [3, 2],
    });
  }
  const scheduledGroups = recurrence.filter((r) => r.pattern === 'scheduled');
  if (scheduledGroups.length) {
    const sitesInvolved = [...new Set(scheduledGroups.map((r) => r.device.site))];
    const sampleDrop = minutesToClock(aestMinuteOfDay(scheduledGroups[0].events[0].timestamp));
    candidates.push({
      tier: 3,
      effort: 'quick',
      title: `Confirm "offline" alerts at ${sitesInvolved.join(', ')} are a scheduled shutdown, not a fault`,
      why: `${scheduledGroups.map((r) => r.device.hostname).join(', ')} drop and auto-resolve at the same time most days (around ${sampleDrop} AEST) -- looks like a scheduled Azure shutdown firing a Critical alert every night. No ticket on file.`,
      site: sitesInvolved.join(', '),
      rank: [3, 3],
    });
  }
  for (const { device, diskOnly } of tier2.filter((t) => t.diskOnly)) {
    candidates.push({
      tier: 3,
      effort: 'quick',
      title: `Check disk space on ${device.hostname}`,
      why: `${diskOnly.freePercent != null ? `${diskOnly.freePercent}% free` : 'disk alert, level unknown'} on ${device.site} -- not yet at the 3-day-repeat or <5% threshold, worth a look before it is.`,
      site: device.site,
      rank: [3, 4],
    });
  }

  candidates.sort((a, b) => {
    for (let i = 0; i < Math.max(a.rank.length, b.rank.length); i++) {
      const diff = (a.rank[i] || 0) - (b.rank[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  });

  const plan = [];
  const skippedForCapacity = [];
  let used = 0;
  for (const c of candidates) {
    const minutes = effortMinutes(c.effort);
    if (used + minutes <= CAPACITY_MINUTES) {
      plan.push({ ...c, effortLabel: effortLabel(c.effort) });
      used += minutes;
    } else {
      skippedForCapacity.push(c);
    }
  }

  // RED/WARNING/GREEN, not the more conventional RAG "AMBER" -- by
  // request, to avoid the badge's own displayed text reading as a
  // (coincidental) reference to a real person on this team named Amber.
  const verdict = siteDown.length > 0 || tier2.some((t) => t.signals.length) ? 'RED' : siteOutage.length || isolated.length || recurrence.some((r) => r.pattern === 'flapping') ? 'WARNING' : 'GREEN';

  const report = {
    generatedAt: new Date(startedAt).toISOString(),
    windowStart: new Date(windowStartMs).toISOString(),
    totals: { sites: sites.length, devices: devices.length, infraDevices: devices.filter(isInfra).length, infraOnline: devices.filter((d) => isInfra(d) && d.online).length },
    verdict,
    capacityMinutes: CAPACITY_MINUTES,
    plan,
    skippedForCapacity: skippedForCapacity.map((c) => ({ title: c.title, site: c.site })),
    outages: siteDown.map((s) => ({ site: s.site.name, infraOffline: s.infraOffline.length, totalDevices: s.totalDevices, lastSeen: new Date(s.mostRecentLastSeen).toISOString() })),
    siteOutages: siteOutage.map((o) => ({ site: o.site.name, infraOffline: o.infraOffline.length, infraTotal: o.infraTotal, newDropCount: o.newDropCount })),
    recurrence: recurrence.map((r) => ({ hostname: r.device.hostname, site: r.device.site, pattern: r.pattern, days: r.days, occurrences: r.events.length })),
    correlatedGroups: correlatedGroups.map((g) => ({
      resolvedAround: new Date(g[0].resolvedOn).toISOString(),
      devices: g.map((e) => `${e.device.hostname} (${e.device.site})`),
    })),
    securityThreats: securityThreats.map((a) => ({ deviceName: a.deviceName, siteName: a.siteName, timestamp: a.timestamp, ticketNumber: a.ticketNumber })),
    securityThreatsTotalCount,
    longTermOffline: { count: longTermOffline.reduce((sum, l) => sum + l.infraOffline, 0), siteCount: longTermOffline.length },
    dormantSites: dormantSites.map((d) => d.site.name),
    monitoringGaps: monitoringGaps.map((g) => ({ hostname: g.hostname, site: g.site, lastSeen: g.lastSeen ? new Date(g.lastSeen).toISOString() : null, newDrop: g.newDrop })),
    durationMs: Date.now() - startedAt,
  };

  writeLastRunStatus({ ranAt: report.generatedAt, success: true, report });
  return report;
}

function monitoringGapNote(infraOffline, monitoringGaps) {
  const gapHostnames = new Set(monitoringGaps.map((g) => g.hostname));
  const anyGap = infraOffline.some((d) => gapHostnames.has(d.hostname));
  return anyGap ? ' No monitoring alert exists for this device -- a genuine monitoring gap, not just a quiet one.' : '';
}

module.exports = { runFullPull, computeOvernightWindowStartMs, isInfra, classifyRecurrence };
