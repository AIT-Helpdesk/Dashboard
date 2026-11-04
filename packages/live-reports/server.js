const express = require('express');
const { matchesWildcard, mapWithConcurrency } = require('@dashboard/autotask-client');
const dattoRmm = require('@dashboard/datto-rmm/lib.js');
// Datto RMM (Live) section, by request -- reuses Meeting Prep's own
// buildDattoLiveDevicesComponent() in-process (same "reuse the sibling's
// own function, don't duplicate it" convention Check Client already
// established) rather than re-deriving the same check-in-freshness/
// device-type breakdown here a second time.
const meetingPrep = require('@dashboard/meeting-prep/server.js');
// "Other Systems" section, by request ("summary data from other systems...
// SaaS Alerts, SaaS Protection, EDR, AutoElevate, Huntress") -- every one of
// these is a cross-vendor NAME match (this page has no Autotask company to
// resolve from, only a Datto RMM site name -- confirmed against the real
// device data, every match below is keyed off `siteName`, the real matched
// Datto site, not the user's own search term), reusing each vendor's own
// already-confirmed-live module rather than re-deriving any of them a
// second way. See each buildXSummary() below for what's actually available
// from each one.
const { get: saasAlertsGet } = require('@dashboard/saasalerts-client');
const { getSaasAlertsCustomers } = require('@dashboard/client-summary/installed-services.js');
const saasProtection = require('@dashboard/saas-protection/server.js');
const dattoEdr = require('@dashboard/client-summary/datto-edr.js');
const autoElevate = require('@dashboard/client-summary/autoelevate.js');
const huntress = require('@dashboard/client-summary/huntress.js');
// Branded PDF export, by request ("add a button to create a pdf in
// Ambient iT colours and logo with all the info we have... add some AI
// recommendations and commentary") -- drawn directly with pdfkit (see
// pdf-template.js's own header), NOT a Puppeteer/Chrome HTML-to-PDF
// render as this first shipped -- confirmed live on production that
// launching a real browser from the AmbientDashboard Windows SERVICE
// (Local System, Session 0) fails every time, a well-documented and
// largely unfixable-from-code limitation of that execution context.
// pdfkit draws the PDF in-process, no second process launched at all.
const { buildReportPdf } = require('./pdf-template.js');
const { hasAnthropicCredentials, buildCommentary } = require('./ai-commentary.js');

// Live Reports -- "Present to Client" -- by request: a live-pulled
// equivalent of Datto RMM's own canned "Executive Summary Report" (the
// scheduled-email PDF ZIP a TAM currently has to download by hand -- see
// Claude outputs/fetch_datto_report.py's own header for that flow). This
// reads straight off Datto's live device list on every search instead,
// via @dashboard/datto-rmm/lib.js's own getAllDevices()/getOpenAlerts() --
// the same functions Datto RMM's own account-wide overview page and Check
// Client's per-client Datto RMM section already use, not a new
// integration. First version, by request ("we will add more parts to
// this page as we go if I like what you create") -- Patch Management,
// Software Management, Antivirus, and Open Alerts only.
//
// Two figures from the real PDF -- Asset Management % and Monitoring %
// (the gauge's own top two figures in Datto's canned report) -- are
// Datto's own composite scores from its canned report engine; no v2 REST
// endpoint returns either one directly as a ready-made number. CONFIRMED
// this session, replacing an earlier narrower approximation: Datto's own
// real 4-factor Asset Management formula (Warranty Status/Disk Capacity/
// Memory Capacity/OS Support, straight-averaged -- see Datto's own glossary
// text in pdf-template.js's SCORE_EXPLANATIONS) CAN be rebuilt live --
// warrantyDate is a free field already on the bulk device list (no extra
// call), and disk-free%/memory come from the per-device
// /v2/audit/device/{deviceUid} endpoint (confirmed no bulk/list variant
// exists -- one extra API call PER DEVICE, bounded concurrency + a
// long-lived per-device cache below, so this cost is paid once per device
// per cache window, not on every page view). Monitoring's real formula is
// resolution-ratio per alert-priority tier (Score = (Raised-Unresolved)/
// Raised*100, averaged across Critical/High/Moderate/Low/Information),
// confirmed live via the site-scoped /v2/site/{siteUid}/alerts/open|
// resolved endpoints (see datto-rmm/lib.js's own getSiteAlertsBreakdown()).
// See assetManagementScore()/monitoringScore() below for the exact
// implementation of each. The gauge/Scorecard's own Overall Health Score blends these two
// in alongside the existing "Device Health Score Formula" (by request,
// "use them in the Health calculation... bring it up to what Datto RMM
// has"): each of Workstations/Servers gets its own Group Health Score
// (Patch*0.4 + Antivirus*0.4 + Software*0.2, each a weighted-average point
// value per device status, see PATCH_POINTS/ANTIVIRUS_POINTS/
// SOFTWARE_POINTS and groupSummary() below), combined Server*0.6 +
// Workstation*0.4 when both groups have devices (or just whichever one
// does) into one Device Health component, then Overall = Device Health*0.6
// + Asset Management*0.2 + Monitoring*0.2 (see computeOverallHealth()).
//
// Open Alerts by Priority is Critical/High only, same scope every other
// Datto RMM page on this dashboard already has (see lib.js's own
// getOpenAlerts() comment on why Moderate/Low/Information are excluded
// account-wide) -- not the real report's full 5-tier breakdown.

const router = express.Router();

// Own independent 20-minute cache, same convention Check Client's own
// Datto RMM section already uses for the exact same two underlying calls
// (getAllDevices()/getOpenAlerts() are both real multi-request pulls, the
// alerts one in particular ~14-20s cold) -- deliberately NOT shared with
// Check Client's cache instance, since each page's own cache is scoped to
// its own module, same as every other page-level cache on this dashboard.
const DATTO_CACHE_TTL_MS = 20 * 60 * 1000;
let devicesCache = null; // { data, expiresAt }
let devicesInFlight = null;
async function getCachedDevices(force) {
  if (!force && devicesCache && Date.now() < devicesCache.expiresAt) return devicesCache.data;
  if (!devicesInFlight) {
    devicesInFlight = dattoRmm
      .getAllDevices()
      .then((data) => {
        devicesCache = { data, expiresAt: Date.now() + DATTO_CACHE_TTL_MS };
        return data;
      })
      .finally(() => {
        devicesInFlight = null;
      });
  }
  return devicesInFlight;
}

let alertsCache = null; // { data, expiresAt }
let alertsInFlight = null;
async function getCachedAlerts(force) {
  if (!force && alertsCache && Date.now() < alertsCache.expiresAt) return alertsCache.data;
  if (!alertsInFlight) {
    alertsInFlight = dattoRmm
      .getOpenAlerts()
      .then((data) => {
        alertsCache = { data, expiresAt: Date.now() + DATTO_CACHE_TTL_MS };
        return data;
      })
      .finally(() => {
        alertsInFlight = null;
      });
  }
  return alertsInFlight;
}

// Per-device audit cache (disk free%/memory for Asset Management), keyed by
// deviceUid -- deliberately a SEPARATE, much longer-lived cache from
// devicesCache above: that one call is one full device-list fetch regardless
// of how many clients get viewed; this one is one API call PER DEVICE (no
// bulk variant exists -- see getDeviceAudit() in datto-rmm/lib.js), so a
// client with 60 devices costs 60 real calls on a cold cache. A 6-hour TTL
// (vs the other caches' 20 minutes) because disk-free%/memory genuinely
// don't change meaningfully within a day, and because re-warming all of
// them on every 20-minute window for every client viewed would add up fast.
// A single device's audit failing is caught and cached as null (one device
// dropping out of these 2 checks, not the whole report failing) -- same
// "degrade quietly" convention as this file's other per-item fetches.
const DEVICE_AUDIT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const deviceAuditCache = new Map(); // deviceUid -> { data, expiresAt }
async function getCachedDeviceAudit(deviceUid, force) {
  const cached = deviceAuditCache.get(deviceUid);
  if (!force && cached && Date.now() < cached.expiresAt) return cached.data;
  const data = await dattoRmm.getDeviceAudit(deviceUid).catch((err) => {
    console.error(`Live Reports: device audit failed (${deviceUid}):`, err.message);
    return null;
  });
  deviceAuditCache.set(deviceUid, { data, expiresAt: Date.now() + DEVICE_AUDIT_CACHE_TTL_MS });
  return data;
}

// Site-scoped alert Raised/Unresolved-by-priority breakdown (for Monitoring),
// keyed by siteUid -- its own cache, same 20-minute TTL as devicesCache/
// alertsCache above (cheap: bounded to one site's own alert volume, not the
// whole account).
const SITE_ALERTS_BREAKDOWN_CACHE_TTL_MS = DATTO_CACHE_TTL_MS;
const siteAlertsBreakdownCache = new Map(); // siteUid -> { data, expiresAt }
async function getCachedSiteAlertsBreakdown(siteUid, force) {
  const cached = siteAlertsBreakdownCache.get(siteUid);
  if (!force && cached && Date.now() < cached.expiresAt) return cached.data;
  const data = await dattoRmm.getSiteAlertsBreakdown(siteUid).catch((err) => {
    console.error(`Live Reports: site alerts breakdown failed (${siteUid}):`, err.message);
    return null;
  });
  siteAlertsBreakdownCache.set(siteUid, { data, expiresAt: Date.now() + SITE_ALERTS_BREAKDOWN_CACHE_TTL_MS });
  return data;
}

// "Workstation" = Desktop + Laptop, "Server" = Server -- matches the real
// PDF report's own "(Workstation, N%)"/"(Server, N%)" split (confirmed
// live this session against lib.js's deviceType values). Everything else
// (Printer, Network Device variants, Datto Continuity, Unknown) isn't a
// patch/software/AV-managed endpoint in Datto's own report either, so it's
// counted in totalDevices but left out of both breakdown groups.
const WORKSTATION_TYPES = new Set(['Desktop', 'Laptop']);
const SERVER_TYPES = new Set(['Server']);

// Raw Datto enum -> display label, confirmed live this session (see
// datto-rmm/lib.js's own mapDeviceSummary() comment) -- kept as plain
// label strings here (not colours; that's client.js's job) so this stays
// reusable if a second consumer of groupSummary() ever needs it.
function patchLabel(v) {
  const map = { FullyPatched: 'Fully Patched', RebootRequired: 'Reboot Required', NoPolicy: 'No Policy', ApprovedPending: 'Approved Pending', InstallError: 'Install Error', NoData: 'No Data' };
  return map[v] || 'No Data'; // null/undefined (device never audited) reads the same as Datto's own explicit "NoData"
}
function antivirusLabel(v) {
  const map = { RunningAndUpToDate: 'Running and Up to Date', RunningAndNotUpToDate: 'Not up to date', NotRunning: 'Not Running', NotDetected: 'Not Detected' };
  return map[v] || 'Not Detected'; // null/undefined (no AV product reporting at all) is the same real-world state as Datto's own "NotDetected"
}
function softwareLabel(v) {
  return v || 'Unmanaged';
}

function bucketCounts(devices, pick) {
  const counts = {};
  for (const d of devices) {
    const label = pick(d);
    counts[label] = (counts[label] || 0) + 1;
  }
  return counts;
}

// Point values per status, by request ("Device Health Score Formula") --
// a status's average point value across the group IS that category's
// score (not "% in the single best bucket", the old binary approach).
// Datto's own "Approved Pending / Assigned in SLA" vs "...past SLA" split
// isn't exposed anywhere in the v2 REST API (patchStatusRaw is a single
// flat ApprovedPending enum, no SLA-due-date field) -- treated as "in
// SLA" (90) throughout, the more common real-world case and the one that
// doesn't silently understate a client's score for data we don't have.
// Same reasoning for Software's "Assigned / Pending in SLA" tier: this
// account's softwareStatus only ever returns Unmanaged/Not Compliant/
// Compliant (confirmed live), so that tier never actually occurs here.
const PATCH_POINTS = {
  'Fully Patched': 100,
  'Reboot Required': 90,
  'Approved Pending': 90,
  'Install Error': 25,
  'No Policy': 0,
  'No Data': 0,
};
const ANTIVIRUS_POINTS = {
  'Running and Up to Date': 100,
  'Not up to date': 40,
  'Not Running': 0,
  'Not Detected': 0,
};
const SOFTWARE_POINTS = {
  Compliant: 100,
  'Not Compliant': 25,
  Unmanaged: 0,
};

function avgPoints(legend, points, total) {
  const sum = Object.entries(legend).reduce((s, [label, count]) => s + (points[label] ?? 0) * count, 0);
  return total ? sum / total : 0;
}

// One group's (Workstations' or Servers') own patch/software/antivirus
// breakdown + its own Group Health Score, by request:
//   Group Health Score = Patch*0.40 + Antivirus*0.40 + Software*0.20
// where each component is the group's own average point value (above),
// not a binary "% fully healthy" -- a group half Reboot Required/half
// Fully Patched now scores ~95 on Patch, not 50.
//
// `weights` lets a caller drop a component out of the HEALTH SCORE
// calc entirely without hiding its donut -- by request: Servers aren't
// patched/software-managed through Datto at all right now, so every
// server reads No Policy/Unmanaged (0 pts) on those two no matter how
// healthy it actually is, which was dragging Servers' score down for a
// reason that has nothing to do with real server health. Patch/
// Software legends and their own per-category % still render on the
// page either way (still useful info) -- only the weight going into
// healthScore changes.
function groupSummary(devices, weights = { patch: 0.4, antivirus: 0.4, software: 0.2 }) {
  const total = devices.length;
  if (total === 0) return null;
  const patch = bucketCounts(devices, (d) => patchLabel(d.patchStatusRaw));
  const antivirus = bucketCounts(devices, (d) => antivirusLabel(d.antivirusStatus));
  const software = bucketCounts(devices, (d) => softwareLabel(d.softwareStatus));
  const patchScore = avgPoints(patch, PATCH_POINTS, total);
  const antivirusScore = avgPoints(antivirus, ANTIVIRUS_POINTS, total);
  const softwareScore = avgPoints(software, SOFTWARE_POINTS, total);
  const healthScore = patchScore * weights.patch + antivirusScore * weights.antivirus + softwareScore * weights.software;
  return {
    total,
    patch: { legend: patch, score: Math.round(patchScore) },
    antivirus: { legend: antivirus, score: Math.round(antivirusScore) },
    software: { legend: software, score: Math.round(softwareScore) },
    healthScore,
  };
}

// Asset Management, Datto's own real 4-factor formula, by request ("I
// found the Asset Management and Monitoring info in Datto's Executive
// Summary Report... can you see if you can do something getting this info
// from Datto RMM") -- CONFIRMED live this session, replacing the earlier
// OS-support-only approximation. Datto's own canned report shows 4
// equally-weighted Passed/Failed checks, straight-averaged for the section
// score (confirmed off real screenshots of that report):
//   1. Device must have at least 15% free space on its System Drive
//   2. Device must have at least 7.8 GB of memory installed
//   3. Windows OS must still be supported by Microsoft
//   4. Device must be within warranty
// Each check scores independently as (% of devices with data on that check
// that PASS it) -- a device/client with no data at all for one check (e.g.
// warrantyDate never populated in Datto RMM for this client) drops that
// check out of the average entirely rather than counting it as a 0%, same
// "missing data isn't evidence of failure" reasoning isOsSupported() below
// already used before this rewrite.
//
// Disk-free%/memory need one /v2/audit/device/{deviceUid} call PER DEVICE
// (confirmed no bulk/list variant exists) -- fetched with bounded
// concurrency and a long-lived per-device cache (getCachedDeviceAudit()
// above) so this cost lands once per device per 6-hour window, not on
// every report view. Warranty uses the free `warrantyDate` field already on
// the bulk device list (no extra call).
//
// Datto's own real "unsupported OS" definition, confirmed off its own
// canned report: Windows 8.1 and under, or Windows Server 2012/2012 R2 and
// under -- Windows 10 is explicitly NOT included (unlike this list's own
// earlier version, which wrongly flagged it as EOL).
const OS_EOL_PATTERNS = [
  /windows\s*xp/i,
  /windows\s*vista/i,
  /windows\s*7\b/i,
  /windows\s*8(\.1)?\b/i,
  /windows\s*server\s*2003/i,
  /windows\s*server\s*2008/i,
  /windows\s*server\s*2012\b/i, // matches both plain 2012 and "2012 R2"
];
function isOsSupported(osString) {
  if (!osString) return true; // no OS data at all is a gap in what we can see, not evidence the device is unsupported -- doesn't penalize the score
  return !OS_EOL_PATTERNS.some((re) => re.test(osString));
}

const DISK_FREE_PERCENT_THRESHOLD = 15;
const MEMORY_GB_THRESHOLD = 7.8;

function passRateOf(items, predicate) {
  if (items.length === 0) return null; // no data at all for this check -- drop it from the average, don't score it 0%
  return Math.round((items.filter(predicate).length / items.length) * 100);
}

// Returns the FULL per-check breakdown now, not just the rolled-up number --
// by request ("I thought you were going to give me some widgets and device
// info"), same reasoning this page already follows for every other section
// (the Scorecard shows a rolled-up % too, but Workstations/Servers below it
// show the real per-category breakdown, not just their own score). `audits`
// is the already-fetched (and cached) /v2/audit/device/{deviceUid} result
// per device -- fetched once by the route below (mapWithConcurrency +
// getCachedDeviceAudit()), passed in here rather than re-fetched, so this
// function itself is synchronous. Each check that genuinely has no data at
// all (`total: 0`) still appears in `checks` (so the on-screen/PDF table can
// show "no data" for it) but its `score` is null and it's excluded from the
// section average, same "missing data isn't evidence of failure" reasoning
// as before this rewrite.
function computeAssetManagementDetail(devices, audits) {
  if (devices.length === 0) return null;

  const withDisk = audits.filter((a) => a?.systemDiskFreePercent != null);
  const withMemory = audits.filter((a) => a?.memoryGB != null);
  const withWarranty = devices.filter((d) => d.warrantyDate);

  const checks = [
    { key: 'os', label: 'OS still supported by Microsoft', total: devices.length, passed: devices.filter((d) => isOsSupported(d.os)).length },
    { key: 'disk', label: `At least ${DISK_FREE_PERCENT_THRESHOLD}% free space on System Drive`, total: withDisk.length, passed: withDisk.filter((a) => a.systemDiskFreePercent >= DISK_FREE_PERCENT_THRESHOLD).length },
    { key: 'memory', label: `At least ${MEMORY_GB_THRESHOLD} GB of memory installed`, total: withMemory.length, passed: withMemory.filter((a) => a.memoryGB >= MEMORY_GB_THRESHOLD).length },
    { key: 'warranty', label: 'Device is within warranty', total: withWarranty.length, passed: withWarranty.filter((d) => new Date(d.warrantyDate).getTime() > Date.now()).length },
  ].map((c) => ({ ...c, score: c.total > 0 ? Math.round((c.passed / c.total) * 100) : null }));

  const scored = checks.filter((c) => c.score !== null);
  const score = scored.length > 0 ? Math.round(scored.reduce((sum, c) => sum + c.score, 0) / scored.length) : null;
  return { score, checks };
}

// Monitoring, Datto's own real resolution-ratio-per-priority-tier formula,
// confirmed off its own canned report's "Total Alerts by Priority" table --
// replaces the earlier weighted-open-alert-count-penalty approximation.
// Per tier: Score = (Raised - Unresolved) / Raised * 100 (100% when nothing
// was ever raised at that tier -- nothing to resolve reads as perfect,
// matching every real example row on Datto's own report). Section score is
// the straight average across all 5 tiers, same as Datto's own report.
// Returns the full per-tier breakdown (Raised/Resolved/Unresolved/Score),
// same "give the real widget, not just the rolled-up %" reasoning as
// computeAssetManagementDetail() above. `breakdown` comes from
// getCachedSiteAlertsBreakdown() -- see datto-rmm/lib.js's own
// getSiteAlertsBreakdown() for exactly what it fetches.
const MONITORING_PRIORITIES = ['Critical', 'High', 'Moderate', 'Low', 'Information'];
function computeMonitoringDetail(breakdown) {
  if (!breakdown) return null;
  const byPriority = MONITORING_PRIORITIES.map((priority) => {
    const { raised = 0, unresolved = 0 } = breakdown[priority] || {};
    const resolved = raised - unresolved;
    const score = raised > 0 ? Math.round((resolved / raised) * 100) : 100;
    return { priority, raised, resolved, unresolved, score };
  });
  const score = Math.round(byPriority.reduce((sum, p) => sum + p.score, 0) / byPriority.length);
  return { score, byPriority };
}

// Workstation/Server split + Overall Health Score for an already
// site-filtered device list -- split out from the route below so Live
// Health Scores can reuse the exact same formula per TC Elite client
// (same "reuse the sibling's own function, don't duplicate it"
// convention this page itself followed for Meeting Prep's
// buildDattoLiveDevicesComponent()) instead of re-deriving it a second
// way. `assetManagement`/`monitoring` are OPTIONAL and OPT-IN, by design --
// Live Health Scores' own bulk per-TC-Elite-client pass calls this with
// just `devices` (unchanged from before this session), so it keeps
// getting the exact same 2-component formula it always has. Only a caller
// that's already computed these two live scores itself (Live Reports --
// both now need real async API calls of their own, see
// assetManagementScore()/monitoringScore() above, so they're resolved by
// the caller BEFORE calling this, not inside it) passes them in, and this
// function stays fully synchronous either way.
function computeOverallHealth(devices, { assetManagement = null, monitoring = null } = {}) {
  const workstations = devices.filter((d) => WORKSTATION_TYPES.has(d.deviceType));
  const servers = devices.filter((d) => SERVER_TYPES.has(d.deviceType));
  const workstation = groupSummary(workstations);
  // Antivirus-only for Servers' own Health Score (weight 1.0) -- Patch/
  // Software Management aren't done through Datto for servers at all
  // right now, by request. Workstations keep the full Patch 0.40/
  // Antivirus 0.40/Software 0.20 formula unchanged.
  const server = groupSummary(servers, { patch: 0, antivirus: 1, software: 0 });

  // Server Score broadened, by request -- Antivirus alone (the only thing
  // groupSummary() above could score it on, Patch/Software not being
  // Datto-managed for servers) was judged too narrow a signal on its own,
  // so Asset Management/Monitoring are blended in here too, ALONGSIDE
  // Antivirus (not replacing it), each only when actually available (same
  // re-normalizing weight filter as the top-level blend below, not a
  // silent 0 for a missing component).
  if (server) {
    const serverComponents = [{ score: server.healthScore, weight: 0.6 }];
    if (assetManagement !== null) serverComponents.push({ score: assetManagement, weight: 0.2 });
    if (monitoring !== null) serverComponents.push({ score: monitoring, weight: 0.2 });
    const serverWeight = serverComponents.reduce((sum, c) => sum + c.weight, 0);
    server.healthScore = serverComponents.reduce((sum, c) => sum + c.score * c.weight, 0) / serverWeight;
  }

  // Server weighted 60/Workstation 40 when both exist (servers carry more
  // business risk per device, so they're NOT just averaged in equally with
  // however many workstations a client happens to have); falls back to
  // whichever single group actually has devices. This blended figure is
  // itself just ONE component of the Overall Health Score below when
  // Asset Management/Monitoring are also in play.
  let deviceHealthScore = null;
  if (server && workstation) deviceHealthScore = server.healthScore * 0.6 + workstation.healthScore * 0.4;
  else if (server) deviceHealthScore = server.healthScore;
  else if (workstation) deviceHealthScore = workstation.healthScore;

  // Device Health 60 / Asset Management 20 / Monitoring 20, by request --
  // the existing patch/antivirus/software blend still carries the most
  // weight (it's the most data-rich of the three), with these two newer,
  // live-computed scores each contributing a meaningful but smaller share.
  // Any component with no data (e.g. a client with no devices of EITHER
  // matched type, so deviceHealthScore is null, or no assetManagement/
  // monitoring passed in at all -- the Live Health Scores caller) drops
  // out of the blend and the remaining weights re-normalize, rather than
  // silently treating a missing score as a 0.
  const components = [
    { score: deviceHealthScore, weight: 0.6 },
    { score: assetManagement, weight: 0.2 },
    { score: monitoring, weight: 0.2 },
  ].filter((c) => c.score !== null);
  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
  const overallScore = totalWeight > 0 ? Math.round(components.reduce((sum, c) => sum + c.score * c.weight, 0) / totalWeight) : null;

  return { workstation, server, overallScore, assetManagement, monitoring };
}

// Same loose normalize-then-either-contains-the-other matching every other
// cross-vendor name lookup on this dashboard already uses (see
// @dashboard/saas-protection's own findDomainMatch() for the full
// reasoning) -- kept as an independent copy here rather than imported,
// same "small literal copy, don't reach into another module's private
// helper" convention those other vendor files already each follow for
// each other.
function normalizeVendorName(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function vendorNameMatches(candidate, siteName) {
  const n = normalizeVendorName(candidate);
  const normSite = normalizeVendorName(siteName);
  return Boolean(n && normSite && (n === normSite || n.includes(normSite) || normSite.includes(n)));
}

// --- SaaS Alerts (last 30 days) ---------------------------------------
// By request, a literal 30-day window (not the calendar-month-back window
// Client Summary's own buildSecurityAlertsSummary() uses for its "1-month"
// label). No hasSaasAlertsCredentials() exists anywhere on this dashboard
// today (every existing caller just attempts the call) -- checked directly
// here instead so a missing SAASALERTS_API_KEY reads as "not-configured",
// not a thrown error.
function hasSaasAlertsCredentials() {
  return Boolean((process.env.SAASALERTS_API_KEY || '').trim());
}
const SAAS_ALERTS_WINDOW_DAYS = 30;
const SAAS_ALERTS_SIZE_CAP = 10000; // same undocumented ~10k-row /reports/events ceiling every other SaaS Alerts page's own SIZE_CAP already guards against

// CONFIRMED live this session: /reports/events/count and /reports/events
// BOTH respect a `customerId` param server-side (narrowing the real total,
// not silently ignored the way `customer_id`/`customer`/`customerIds` all
// were when tried) -- despite every OTHER SaaS Alerts page on this
// dashboard (Security Alerts, Client Summary) fetching the whole account
// and filtering client-side, there genuinely is a per-customer query
// available. Once this page has resolved which SaaS Alerts customer
// matches (by name, same as every other vendor below -- Live Reports has
// no stored id mapping, only a Datto RMM site name), every call here is
// scoped directly to that one customerId -- small, fast, and exact, not
// an account-wide fetch-then-filter-by-name the way the first version of
// this function worked (confirmed slow AND confirmed to occasionally miss
// a real match entirely when a client's two systems spell its name just
// differently enough that normalize-and-contains doesn't line up).
async function buildSaasAlertsSummary(siteName, force) {
  if (!hasSaasAlertsCredentials()) return { status: 'not-configured' };
  const customers = await getSaasAlertsCustomers(force);
  const match = customers.find((c) => vendorNameMatches(c.name, siteName));
  if (!match) return { status: 'ok', monitored: false };

  const endISO = new Date().toISOString();
  const startISO = new Date(Date.now() - SAAS_ALERTS_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const customerId = match.id;

  // Critical/Medium/Low tiles, by request -- each its own cheap count-only
  // call (no row download), scoped to this one customerId.
  const [criticalCount, mediumCount, lowCount] = await Promise.all(
    ['critical', 'medium', 'low'].map(async (alertStatus) => {
      const { total } = await saasAlertsGet('/reports/events/count', { start: startISO, end: endISO, alertStatus, customerId });
      return total;
    })
  );

  // Top Events is still Critical+Medium only -- Low is ~99.8% of all
  // events account-wide (confirmed live elsewhere, see
  // saasalerts-alerts/server.js's own comment), so a "top events" list
  // drawn from it would just be routine-sign-in-shaped noise, not
  // genuine alerts worth naming. Each row-fetch below is now scoped to
  // this one customerId too (not account-wide), so it's small regardless
  // of how large that severity's real account-wide total is.
  // Each row tagged with the severity it was fetched under (`_severity`,
  // stripped back off below) -- by request, so the Top Events list can
  // show which of its entries are Critical and colour just those red,
  // rather than the two severities being indistinguishable once merged
  // by event name.
  const eventLists = await Promise.all(
    [
      ['critical', criticalCount],
      ['medium', mediumCount],
    ].map(async ([alertStatus, total]) => {
      if (total === 0) return [];
      const size = Math.min(total, SAAS_ALERTS_SIZE_CAP);
      const rows = await saasAlertsGet('/reports/events', { start: startISO, end: endISO, alertStatus, customerId, size, timeSort: 'desc' });
      return rows.map((e) => ({ ...e, _severity: alertStatus }));
    })
  );

  // CONFIRMED live this session (real data, Back 2 Basics): the FIRST cut
  // of this merged critical+medium occurrences of the same event name into
  // one combined `count`, coloured red whenever ANY occurrence was
  // critical -- so a name with 2 critical + 3 medium occurrences showed as
  // a single red "(5)", even though only 2 of those 5 were actually
  // critical. Summing every red-coloured number on screen then came out
  // HIGHER than the real Critical tile (9 vs. the real 6) -- a genuine
  // client-facing accuracy bug, not just a display quirk, since the
  // numbers no longer added up to anything real. Fixed by tracking
  // criticalCount/mediumCount SEPARATELY per name, so the number shown for
  // each severity is always that severity's own real count -- summing just
  // the critical figures across every row now always equals the Critical
  // tile above, by construction.
  const byEventName = new Map(); // name -> { criticalCount, mediumCount }
  for (const e of eventLists.flat()) {
    const name = e.jointDesc || e.jointType || 'Event';
    const entry = byEventName.get(name) || { criticalCount: 0, mediumCount: 0 };
    if (e._severity === 'critical') entry.criticalCount += 1;
    else entry.mediumCount += 1;
    byEventName.set(name, entry);
  }
  const topEvents = [...byEventName.entries()]
    .map(([name, v]) => ({ name, criticalCount: v.criticalCount, mediumCount: v.mediumCount }))
    .sort((a, b) => b.criticalCount + b.mediumCount - (a.criticalCount + a.mediumCount))
    .slice(0, 5);

  return { status: 'ok', monitored: true, windowDays: SAAS_ALERTS_WINDOW_DAYS, criticalCount, mediumCount, lowCount, topEvents };
}

// --- SaaS Protection (Datto backup) ------------------------------------
// findDomainMatch()/getApplicationsHistory()/getBillableSeatCount() are all
// already-exported, already-cached functions from @dashboard/saas-protection
// itself (the SAME ones Client Summary's own Installed Services section and
// per-client popup already use) -- no new Datto call added here beyond
// what that page already makes for any other client. getApplicationsHistory()
// specifically is the 30-day-history variant (HISTORY_DAYS there), matching
// Datto's own "Backup Status" chart window -- its own per-app `healthy`
// flag is what's summarized into counts below, the detail list is just
// which app types are NOT currently healthy.
// Per-app-type seat counts, by request ("a seat count or backup count for
// each of Email, OneDrive, SharePoint & Teams") -- Datto's own /seats rows
// carry a seatType (SharedMailbox/User/Site/TeamSite/Team, confirmed
// against real data), not an appType directly, so this maps each seat to
// the application type it's actually backed up under. Same mapping
// saas-protection/client.js's own SEAT_TYPE_TO_APP_TYPE already
// established for its per-client popup, copied here rather than imported
// (that one's a browser ES module, this is a Node CJS file) -- small
// literal, same "copy, don't reach into another module's private helper"
// convention this file already follows elsewhere. OneDrive gets no seat
// type of its own on the real API (confirmed -- that same comment notes
// "No OneDrive-typed seat was observed"): a Datto SaaS Protection seat is
// licensed per M365 USER, and that one licence covers both the user's
// mailbox (Exchange) AND their OneDrive, so OneDrive's own seat count is
// the same "User" count as Exchange's, not a separate, smaller number.
const SEAT_TYPE_TO_APP_TYPES = {
  SharedMailbox: ['Office365Exchange'],
  User: ['Office365Exchange', 'Office365OneDrive'],
  Site: ['Office365SharePoint'],
  TeamSite: ['Office365SharePoint'],
  Team: ['Office365Teams'],
};
const APP_TYPE_LABELS = {
  Office365Exchange: 'Email',
  Office365OneDrive: 'OneDrive',
  Office365SharePoint: 'SharePoint',
  Office365Teams: 'Teams',
};
const APP_TYPE_ORDER = ['Office365Exchange', 'Office365OneDrive', 'Office365SharePoint', 'Office365Teams'];

async function buildSaasProtectionSummary(siteName, force) {
  const match = await saasProtection.findDomainMatch(siteName);
  if (!match) return { status: 'ok', installed: false };
  const [billableSeatCount, applications, seats] = await Promise.all([
    saasProtection.getBillableSeatCount(match.customerId, force),
    saasProtection.getApplicationsHistory(match.customerId, force),
    saasProtection.getSeats(match.customerId, force),
  ]);
  const unhealthy = applications.filter((a) => !a.healthy);

  const seatCountByAppType = {};
  for (const s of seats) {
    for (const appType of SEAT_TYPE_TO_APP_TYPES[s.seatType] || []) {
      seatCountByAppType[appType] = (seatCountByAppType[appType] || 0) + 1;
    }
  }
  const appBreakdown = APP_TYPE_ORDER.map((appType) => {
    const app = applications.find((a) => a.appType === appType);
    if (!app) return null; // this app type isn't present for this client at all -- not a real row, not a zero
    return { appType, label: APP_TYPE_LABELS[appType], healthy: app.healthy, status: app.status, seatCount: seatCountByAppType[appType] ?? null };
  }).filter(Boolean);

  return {
    status: 'ok',
    installed: true,
    domain: match.domain,
    backupPercentage: match.backupPercentage,
    billableSeatCount,
    appTypesHealthy: applications.length - unhealthy.length,
    appTypesTotal: applications.length,
    appBreakdown,
  };
}

// --- Datto EDR ----------------------------------------------------------
// findLocationMatches() can legitimately return SEVERAL Locations for one
// client (one per branch/site -- confirmed live elsewhere, e.g. Sleepy's 34
// real rows), so every count below is summed across every matched Location,
// not just the first. agentCount/activeAgentCount/alertCount/lastScannedOn
// are real fields on Datto EDR's own Location object (confirmed live this
// session -- see this file's own diagnostic run), not previously read by
// buildInstalledServices() (which only read locationCount) -- genuinely new
// data, not a re-derivation of something already shown elsewhere.
// alertCount comes back as a STRING on the real API ("0"), not a number.
// alertCount30d, by request ("a count of total alerts in the last 30
// days") -- Datto EDR's own /api/Alerts endpoint has NO working server-side
// filter or pagination (confirmed live this session: every `filter[...]`/
// `locationId`/`offset`/`page` param tried came back byte-identical,
// always the same flat batch, hard-capped at exactly 1000 rows regardless
// of `limit`), so this filters that one fixed batch client-side by each
// matched Location's own `data.rmmUid` (== an alert's own
// `hostInfo.rmmSiteId`) and a 30-day cutoff instead of asking the API to
// scope it. That fixed batch is NOT a true "last 1000 alerts" window in
// the way it'd need to be for this to under-count silently -- confirmed
// live the account's own alert volume is low enough that the oldest row
// already returned (unfiltered) lands right around the 30-day mark on its
// own, i.e. the 1000-row cap isn't actually binding at this tenant's real
// volume, so filtering it is a reliable 30-day count in practice, not
// merely an approximation of one. Cached tenant-wide (getAlerts()'s own
// 20-min TTL), not re-fetched per client -- same reasoning as every other
// cached list this page reads from.
async function buildDattoEdrSummary(siteName, force) {
  if (!dattoEdr.hasDattoEdrCredentials()) return { status: 'not-configured' };
  const matches = await dattoEdr.findLocationMatches(siteName, force);
  if (matches.length === 0) return { status: 'ok', installed: false };
  const agentCount = matches.reduce((sum, l) => sum + (l.agentCount || 0), 0);
  const activeAgentCount = matches.reduce((sum, l) => sum + (l.activeAgentCount || 0), 0);
  const alertCount = matches.reduce((sum, l) => sum + (Number(l.alertCount) || 0), 0);
  const lastScannedOn = matches.map((l) => l.lastScannedOn).filter(Boolean).sort().pop() || null;

  const rmmUids = new Set(matches.map((l) => l.data && l.data.rmmUid).filter(Boolean));
  const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const alerts = await dattoEdr.getAlerts(force);
  const alertCount30d = alerts.filter((a) => rmmUids.has(a.hostInfo && a.hostInfo.rmmSiteId) && new Date(a.createdOn).getTime() >= since).length;

  return { status: 'ok', installed: true, agentCount, activeAgentCount, alertCount, alertCount30d, lastScannedOn };
}

// --- AutoElevate (CyberFOX) ---------------------------------------------
// Confirmed live this session: AutoElevate's own /api/v1/companies row has
// almost nothing on it beyond id/name/managementSystemCompanyId/createdAt/
// updatedAt -- no elevation-request count, no endpoint count, nothing else
// usable. "Something to report" here honestly means just a match + since-
// date, the same scope buildInstalledServices() already has -- not
// under-building this, there's genuinely nothing more the API returns.
async function buildAutoElevateSummary(siteName, force) {
  if (!autoElevate.hasAutoElevateCredentials()) return { status: 'not-configured' };
  const match = await autoElevate.findCompanyMatch(siteName, force);
  if (!match) return { status: 'ok', installed: false };
  return { status: 'ok', installed: true, deployedSince: match.createdAt ? new Date(match.createdAt).toISOString() : null };
}

// --- Huntress -------------------------------------------------------------
// Confirmed live this session: Huntress's own /organizations row carries
// real counts beyond the agents_count buildInstalledServices() already
// reads -- incident_reports_count and microsoft_365_users_count, both
// genuinely new data here. incidentReportsCount is a LIFETIME total (no
// date-range param on this endpoint), not a 30-day figure -- labelled as
// such on the page rather than implied to be windowed like SaaS Alerts.
async function buildHuntressSummary(siteName, force) {
  if (!huntress.hasHuntressCredentials()) return { status: 'not-configured' };
  const match = await huntress.findOrganizationMatch(siteName, force);
  if (!match) return { status: 'ok', installed: false };
  return {
    status: 'ok',
    installed: true,
    agentsCount: match.agents_count ?? null,
    incidentReportsCount: match.incident_reports_count ?? null,
    microsoft365UsersCount: match.microsoft_365_users_count || null,
  };
}

// Proactive Maintenance list, by request -- a standard, account-wide list
// of regularly scheduled automated activities (NOT pulled live: confirmed
// against Datto RMM's own real API surface this session -- its only
// job-related endpoints are GET /v2/job/{uid} and its 3 result
// sub-routes, plus PUT .../quickjob to CREATE one; there is no list/
// search endpoint, so a specific client's own scheduled jobs genuinely
// can't be enumerated via the API at all). Configured via one env var,
// PROACTIVE_MAINTENANCE_ITEMS, items separated by `|` (a single .env line
// can't hold real newlines) -- e.g.
// PROACTIVE_MAINTENANCE_ITEMS=Automated patch deployment|AV engine updates|Scheduled reboots
// -- falls back to a drafted default list when that's not set, so the
// report never ships with an empty section. Single source of truth for
// BOTH surfaces (the on-screen page and the PDF both read this same
// report.proactiveMaintenance field) -- neither hardcodes its own copy.
// Pulled from the real "Proactive Maintenance Jobs" table on the Tech
// Handbook's own "PC Security Settings Applied" SharePoint page (read via
// the Microsoft 365 connector, by request -- one-time manual transcription
// for now, not a live sync; direct SharePoint/Graph API access for this
// server itself is a separate future step). Each line is that row's own
// bracketed client-facing description, schedule appended -- only rows
// marked "Y" in that table's own "Show on Client Executive Reports"
// column belong here (honour that Y/N split on every re-sync; there are
// no N rows as of this transcription, so all 10 are currently included).
const DEFAULT_PROACTIVE_MAINTENANCE_ITEMS = [
  'Backup of drive encryption recovery keys (Weekly)',
  'Check that threat detection monitoring is active (Daily)',
  'Check that least-privilege access controls are in place (Daily)',
  'Verify the dedicated remote support account (Monthly)',
  'Disable the Windows Fast Startup option (Monthly)',
  'Run Windows system image scan and repair (Monthly)',
  'Run a scan and repair of core Windows system files (Monthly)',
  'Run Disk Cleanup to free up available space (Monthly)',
  'Check System Restore is enabled (Monthly)',
  'Verify and enforce endpoint security hardening (Daily)',
];
function getProactiveMaintenanceItems() {
  const raw = (process.env.PROACTIVE_MAINTENANCE_ITEMS || '').trim();
  if (!raw) return DEFAULT_PROACTIVE_MAINTENANCE_ITEMS;
  const items = raw.split('|').map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : DEFAULT_PROACTIVE_MAINTENANCE_ITEMS;
}

async function buildVendorSummaries(siteName, force) {
  const [saasAlerts, saasProtectionSummary, dattoEdrSummary, autoElevateSummary, huntressSummary] = await Promise.all([
    buildSaasAlertsSummary(siteName, force),
    buildSaasProtectionSummary(siteName, force),
    buildDattoEdrSummary(siteName, force),
    buildAutoElevateSummary(siteName, force),
    buildHuntressSummary(siteName, force),
  ]);
  return { saasAlerts, saasProtection: saasProtectionSummary, dattoEdr: dattoEdrSummary, autoElevate: autoElevateSummary, huntress: huntressSummary };
}

router.get('/', async (req, res) => {
  if (!dattoRmm.hasDattoCredentials()) return res.json({ connected: false });
  const siteTerm = (req.query.site || '').trim();
  if (!siteTerm) return res.status(400).json({ error: 'Query param "site" is required.' });
  // exactSite, same convention/reasoning Check Client's own Datto RMM
  // section already established -- Datto's siteName is a separate naming
  // system from Autotask's/Ingram's own client names, so a plain wildcard
  // search can collide (one client's site name being a substring of an
  // unrelated client's).
  const exactSite = req.query.exactSite === 'true';
  const matchesSite = (value) => (exactSite ? (value || '').trim().toLowerCase() === siteTerm.toLowerCase() : matchesWildcard(value, siteTerm));
  try {
    const force = req.query.force === 'true';
    const [allDevices, alertsResult] = await Promise.all([getCachedDevices(force), getCachedAlerts(force)]);
    const devices = allDevices.filter((d) => matchesSite(d.site));
    if (devices.length === 0) {
      return res.json({ connected: true, siteTerm, found: false });
    }

    const alerts = alertsResult.alerts.filter((a) => matchesSite(a.siteName));
    // alertsByPriority/alertsTotalCount below stay Critical/High only,
    // unchanged -- Monitoring's own real per-priority breakdown (ALL 5
    // tiers, Raised/Unresolved, not just Critical/High open counts) comes
    // from the site-scoped fetch below instead, keyed by siteUid (every
    // matched device shares the same one). Device audits (disk/memory, one
    // call per device) and the site's alert breakdown are fetched here,
    // once, and handed to both the rolled-up score AND the full breakdown
    // the on-screen/PDF widgets show -- neither re-fetches what the other
    // already has.
    const siteUid = devices[0].siteUid;
    const [audits, siteAlertsBreakdown] = await Promise.all([
      mapWithConcurrency(devices, 5, (d) => getCachedDeviceAudit(d.id, force)),
      siteUid ? getCachedSiteAlertsBreakdown(siteUid, force) : Promise.resolve(null),
    ]);
    const assetManagementDetail = computeAssetManagementDetail(devices, audits);
    const monitoringDetail = computeMonitoringDetail(siteAlertsBreakdown);
    const assetManagement = assetManagementDetail?.score ?? null;
    const monitoring = monitoringDetail?.score ?? null;
    const { workstation, server, overallScore } = computeOverallHealth(devices, { assetManagement, monitoring });

    const alertsByPriority = ['Critical', 'High'].map((priority) => ({ priority, count: alerts.filter((a) => a.priority === priority).length }));

    const asOf = new Date().toISOString();
    // First section on the page, by request -- same component shape
    // Meeting Prep's own card and Make Report's own section both already
    // render via dattoLiveDevicesWidgetsHtml()/deviceListTableHtml()
    // (/meeting-prep-report-render.js), so client.js can reuse those
    // functions directly rather than re-rendering this data a third way.
    // Passed the UNFILTERED allDevices (not this route's own `devices`
    // above) -- buildDattoLiveDevicesComponent() does its own site
    // matching (siteMatches(), &/and-normalized), same as Meeting Prep's
    // own call site. allowedNames (classification filter) is always null
    // here -- Live Reports has no classification selector of its own.
    const dattoLive = meetingPrep.buildDattoLiveDevicesComponent(siteTerm, allDevices, asOf, exactSite, null);

    const siteName = devices[0].site;

    res.json({
      connected: true,
      asOf,
      siteTerm,
      siteName,
      found: true,
      dattoLive,
      totalDevices: devices.length,
      onlineCount: devices.filter((d) => d.online).length,
      offlineCount: devices.filter((d) => !d.online).length,
      overallScore,
      workstation,
      server,
      assetManagement,
      monitoring,
      assetManagementDetail,
      monitoringDetail,
      proactiveMaintenance: getProactiveMaintenanceItems(),
      alertsByPriority,
      alertsTotalCount: alerts.length,
      // Real total (alertsResult.totalCount, account-wide High/Critical)
      // can exceed this client's own matched count without truncation --
      // only a genuine hit of the account-wide safety cap (see lib.js's
      // own MAX_ALERT_PAGES) makes even THIS client's count potentially
      // incomplete, worth flagging rather than silently inheriting.
      alertsTruncated: alertsResult.truncated,
    });
  } catch (err) {
    console.error(err);
    const detail = err.response ? `Datto API returned HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    res.status(500).json({ error: detail });
  }
});

// "Other Systems" (SaaS Alerts/SaaS Protection/Datto EDR/AutoElevate/
// Huntress) -- its OWN route, fetched separately by client.js AFTER the
// main report above has already rendered, not inline in that route.
// Confirmed live this session: folding these 5 vendor calls into the main
// route's own response made the whole page take 60-70+ seconds on a cold
// per-client cache (several of these -- SaaS Protection's own per-customer
// /applications+/seats detail in particular -- have no account-wide warm
// path the way Datto RMM's own getCachedDevices()/getCachedAlerts() do),
// which read as "the page isn't returning anything" rather than "slow".
// Splitting it out means the fast Datto RMM report (unchanged from before
// this section existed) shows immediately, with this section filling in
// underneath once it's ready -- same siteName the main route already
// resolved (the real matched Datto site, not the raw search term), so this
// route does no Datto RMM device/site matching of its own.
router.get('/vendors', async (req, res) => {
  const siteName = (req.query.siteName || '').trim();
  if (!siteName) return res.status(400).json({ error: 'Query param "siteName" is required.' });
  try {
    const force = req.query.force === 'true';
    const vendors = await buildVendorSummaries(siteName, force);
    res.json({ vendors });
  } catch (err) {
    console.error(err);
    const detail = err.response ? `Vendor API returned HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    res.status(500).json({ error: detail });
  }
});

// Branded PDF export -- by request. Takes the EXACT report/vendors JSON
// the browser already fetched and rendered on screen (not re-fetched
// here), so the PDF always matches what's actually showing, and this
// route does no Datto RMM/vendor calls of its own -- only PDF rendering
// (+ an optional AI-commentary call) happens here. express.json() is
// scoped to just this router (not every Datto RMM GET route above needs
// it) -- Express only parses a body when a request actually sends one,
// same convention Contract Checks/Check Client/SaaS Protection's own
// single write route each already use, so this is a no-op for every GET
// route above. limit raised from Express's 100kb default -- a client
// with a long device list genuinely exceeds that.
router.use(express.json({ limit: '5mb' }));

router.post('/pdf', async (req, res) => {
  const { report, vendors } = req.body || {};
  if (!report || !vendors) return res.status(400).json({ error: 'Both "report" and "vendors" are required in the request body.' });
  try {
    // AI commentary is optional -- a missing ANTHROPIC_API_KEY or a
    // failed Claude call both just mean the PDF ships without the
    // Executive Summary/On Track-Watch-Action Needed/Recommendations
    // sections (pdf-template.js already renders fine with commentary ==
    // null), never block the rest of the (real, live) report from
    // generating.
    let commentary = null;
    if (hasAnthropicCredentials()) {
      try {
        commentary = await buildCommentary(report, vendors);
      } catch (err) {
        console.error('live-reports: AI commentary call failed, shipping the PDF without it:', err.message);
      }
    }
    const pdf = await buildReportPdf({ report, vendors, commentary });
    // Windows-illegal filename characters stripped, same reasoning every
    // other generated-filename helper on this dashboard already follows.
    const filename = `${report.siteName} - Managed Services Report - ${new Date().toISOString().slice(0, 10)}.pdf`.replace(/[\\/:*?"<>|]/g, '');
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Reused by Live Health Scores, by request -- same "reuse the sibling's
// own function, don't duplicate it" convention this page itself already
// follows for Meeting Prep's buildDattoLiveDevicesComponent(). Own
// Datto-devices cache is NOT exported/shared here, by the same
// "independent per-page cache" convention every Datto RMM page on this
// dashboard already follows (Check Client/Meeting Prep/this page's own
// getCachedDevices() are each scoped to their own module) -- Live Health
// Scores fetches and caches getAllDevices() itself.
router.computeOverallHealth = computeOverallHealth;

module.exports = router;
