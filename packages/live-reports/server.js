const express = require('express');
const { matchesWildcard } = require('@dashboard/autotask-client');
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
// recommendations and commentary") -- see pdf-template.js's own header
// for the full reasoning (reuses the exact gauge/donut/KPI widgets and
// real styles.css this page already renders with, via Puppeteer driving
// a local Chrome/Edge install rather than this dashboard's only existing
// PDF library, pdfkit, which is too low-level to reasonably match a
// polished multi-section report like the one this was modeled on).
const { buildReportHtml } = require('./pdf-template.js');
const { hasPdfBrowser, renderPdf } = require('./pdf-render.js');
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
  const eventLists = await Promise.all(
    [
      ['critical', criticalCount],
      ['medium', mediumCount],
    ].map(async ([alertStatus, total]) => {
      if (total === 0) return [];
      const size = Math.min(total, SAAS_ALERTS_SIZE_CAP);
      return saasAlertsGet('/reports/events', { start: startISO, end: endISO, alertStatus, customerId, size, timeSort: 'desc' });
    })
  );

  const byEventName = new Map();
  for (const e of eventLists.flat()) {
    const name = e.jointDesc || e.jointType || 'Event';
    byEventName.set(name, (byEventName.get(name) || 0) + 1);
  }
  const topEvents = [...byEventName.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
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
async function buildSaasProtectionSummary(siteName, force) {
  const match = await saasProtection.findDomainMatch(siteName);
  if (!match) return { status: 'ok', installed: false };
  const [billableSeatCount, applications] = await Promise.all([
    saasProtection.getBillableSeatCount(match.customerId, force),
    saasProtection.getApplicationsHistory(match.customerId, force),
  ]);
  const unhealthy = applications.filter((a) => !a.healthy);
  return {
    status: 'ok',
    installed: true,
    domain: match.domain,
    backupPercentage: match.backupPercentage,
    billableSeatCount,
    appTypesHealthy: applications.length - unhealthy.length,
    appTypesTotal: applications.length,
    unhealthyAppTypes: unhealthy.map((a) => ({ appType: a.appType, status: a.status })),
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
async function buildDattoEdrSummary(siteName, force) {
  if (!dattoEdr.hasDattoEdrCredentials()) return { status: 'not-configured' };
  const matches = await dattoEdr.findLocationMatches(siteName, force);
  if (matches.length === 0) return { status: 'ok', installed: false };
  const agentCount = matches.reduce((sum, l) => sum + (l.agentCount || 0), 0);
  const activeAgentCount = matches.reduce((sum, l) => sum + (l.activeAgentCount || 0), 0);
  const alertCount = matches.reduce((sum, l) => sum + (Number(l.alertCount) || 0), 0);
  const lastScannedOn = matches.map((l) => l.lastScannedOn).filter(Boolean).sort().pop() || null;
  return { status: 'ok', installed: true, locationCount: matches.length, agentCount, activeAgentCount, alertCount, lastScannedOn };
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
  if (!hasPdfBrowser()) return res.status(500).json({ error: 'No Chrome/Edge install found on this server to render the PDF.' });
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
    const html = await buildReportHtml({ report, vendors, commentary });
    const footerText = `Ambient iT | Managed Services Report | ${report.siteName}`;
    const pdf = await renderPdf(html, { footerText });
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
