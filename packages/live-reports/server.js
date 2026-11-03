const express = require('express');
const { matchesWildcard } = require('@dashboard/autotask-client');
const dattoRmm = require('@dashboard/datto-rmm/lib.js');
// Datto RMM (Live) section, by request -- reuses Meeting Prep's own
// buildDattoLiveDevicesComponent() in-process (same "reuse the sibling's
// own function, don't duplicate it" convention Check Client already
// established) rather than re-deriving the same check-in-freshness/
// device-type breakdown here a second time.
const meetingPrep = require('@dashboard/meeting-prep/server.js');

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
// Two figures from the real PDF are NOT reproduced here -- Asset
// Management % and Monitoring % (the gauge's own top two figures) are
// Datto's own composite scores from its canned report engine; no v2 REST
// endpoint returns them (confirmed -- nothing in lib.js's own account/
// device/filter endpoints carries anything like them). The gauge here
// instead uses a defined "Device Health Score Formula" (by request):
// each of Workstations/Servers gets its own Group Health Score (Patch*0.4
// + Antivirus*0.4 + Software*0.2, each a weighted-average point value per
// device status, see PATCH_POINTS/ANTIVIRUS_POINTS/SOFTWARE_POINTS and
// groupSummary() below), then Overall = Server*0.6 + Workstation*0.4 when
// both groups have devices (or just whichever one does).
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

// Workstation/Server split + Overall Health Score for an already
// site-filtered device list -- split out from the route below so Live
// Health Scores can reuse the exact same formula per TC Elite client
// (same "reuse the sibling's own function, don't duplicate it"
// convention this page itself followed for Meeting Prep's
// buildDattoLiveDevicesComponent()) instead of re-deriving it a second
// way.
function computeOverallHealth(devices) {
  const workstations = devices.filter((d) => WORKSTATION_TYPES.has(d.deviceType));
  const servers = devices.filter((d) => SERVER_TYPES.has(d.deviceType));
  const workstation = groupSummary(workstations);
  // Antivirus-only for Servers' own Health Score (weight 1.0) -- Patch/
  // Software Management aren't done through Datto for servers at all
  // right now, by request. Workstations keep the full Patch 0.40/
  // Antivirus 0.40/Software 0.20 formula unchanged.
  const server = groupSummary(servers, { patch: 0, antivirus: 1, software: 0 });

  // Overall Health Score, by request -- Server weighted 60/Workstation
  // 40 when both exist (servers carry more business risk per device, so
  // they're NOT just averaged in equally with however many workstations
  // a client happens to have); falls back to whichever single group
  // actually has devices.
  let overallScore = null;
  if (server && workstation) overallScore = Math.round(server.healthScore * 0.6 + workstation.healthScore * 0.4);
  else if (server) overallScore = Math.round(server.healthScore);
  else if (workstation) overallScore = Math.round(workstation.healthScore);

  return { workstation, server, overallScore };
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
    const { workstation, server, overallScore } = computeOverallHealth(devices);

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

    res.json({
      connected: true,
      asOf,
      siteTerm,
      siteName: devices[0].site,
      found: true,
      dattoLive,
      totalDevices: devices.length,
      onlineCount: devices.filter((d) => d.online).length,
      offlineCount: devices.filter((d) => !d.online).length,
      overallScore,
      workstation,
      server,
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
