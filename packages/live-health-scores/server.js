const express = require('express');
const { getClient, getCompanyUrl } = require('@dashboard/autotask-client');
const dattoRmm = require('@dashboard/datto-rmm/lib.js');
// Reused rather than re-queried -- same "who counts as a TC Elite client"
// membership test (Companies.classification = "Tech Cover Elite")
// tc-elite-services/server.js already resolves for its own page.
const tcEliteServices = require('@dashboard/tc-elite-services/server.js');
// Reused rather than re-derived -- the exact same Device Health 60% /
// Asset Management 20% / Monitoring 20% Overall Health Score formula Live
// Reports computes for one client at a time, run here for every TC Elite
// client at once (by request, so this page matches Live Reports exactly
// instead of its own older devices-only approximation).
const liveReports = require('@dashboard/live-reports/server.js');

// Live Health Scores -- by request: every current TC Elite client, each
// with its own live Overall Health Score, so a TAM can see at a glance
// which clients need attention without opening Live Reports one at a
// time.
//
// Datto RMM has no stored mapping from an Autotask company to its own
// site name anywhere in this account (confirmed -- see check-client/
// server.js's own comment: Datto's siteName is a THIRD naming system
// alongside Autotask's and Ingram's own client names, with no real
// mapping data to calibrate a bespoke matcher against). Live Reports
// sidesteps this by having a human type the Datto site name in; this
// page has no human in the loop per row, so it auto-matches each TC
// Elite company's name against every distinct Datto site name using the
// same normalize-and-match-both-directions convention Client Summary's
// own Datto EDR location matching already uses (client-summary/
// datto-edr.js's findLocationMatches()) -- not a new fuzzy-matching
// approach, the one already in production here. A client with no
// matching site shows as unmatched rather than a misleading 0% score.
const router = express.Router();

function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Distinct real Datto site names, normalized -> one real spelling (first
// one seen) -- built once per request from the already-fetched device
// list, not re-derived per company.
function buildSiteIndex(allDevices) {
  const sites = new Map();
  for (const d of allDevices) {
    if (!d.site) continue;
    const norm = normalize(d.site);
    if (norm && !sites.has(norm)) sites.set(norm, d.site);
  }
  return sites;
}

// Same both-directions includes() match datto-edr.js's findLocationMatches()
// already uses in production, EXCEPT a normalized company name under 3
// characters is restricted to an exact match only -- a company literally
// named "IT" or "GH" would otherwise .includes()-match almost any site
// name, a false-positive risk the real (usually much longer) company
// names this runs against don't have.
function matchSitesForCompany(companyName, siteIndex) {
  const normCompany = normalize(companyName);
  if (!normCompany) return [];
  const matches = [];
  for (const [normSite, realSite] of siteIndex.entries()) {
    const isMatch = normCompany.length < 3 ? normSite === normCompany : normSite === normCompany || normSite.includes(normCompany) || normCompany.includes(normSite);
    if (isMatch) matches.push(realSite);
  }
  return matches;
}

// Own independent 20-minute caches, same convention every other Datto RMM
// page on this dashboard uses -- deliberately NOT shared with Live
// Reports'/Check Client's/Meeting Prep's own cache instances.
const CACHE_TTL_MS = 20 * 60 * 1000;

let devicesCache = null; // { data, expiresAt }
let devicesInFlight = null;
async function getCachedDevices(force) {
  if (!force && devicesCache && Date.now() < devicesCache.expiresAt) return devicesCache.data;
  if (!devicesInFlight) {
    devicesInFlight = dattoRmm
      .getAllDevices()
      .then((data) => {
        devicesCache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
        return data;
      })
      .finally(() => {
        devicesInFlight = null;
      });
  }
  return devicesInFlight;
}

let companiesCache = null; // { data, expiresAt }
let companiesInFlight = null;
async function getCachedCompanies(force) {
  if (!force && companiesCache && Date.now() < companiesCache.expiresAt) return companiesCache.data;
  if (!companiesInFlight) {
    companiesInFlight = getClient()
      .then((client) => tcEliteServices.resolveTcEliteCompanies(client))
      .then((data) => {
        companiesCache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
        return data;
      })
      .finally(() => {
        companiesInFlight = null;
      });
  }
  return companiesInFlight;
}

async function buildRows(force) {
  const [companies, allDevices] = await Promise.all([getCachedCompanies(force), getCachedDevices(force)]);
  const siteIndex = buildSiteIndex(allDevices);

  const rows = [];
  for (const company of companies) {
    const matchedSites = matchSitesForCompany(company.companyName, siteIndex);
    const companyUrl = await getCompanyUrl(company.id);

    if (matchedSites.length === 0) {
      rows.push({
        companyId: company.id,
        companyName: company.companyName,
        companyUrl,
        matched: false,
        matchedSites,
        totalDevices: 0,
        workstationScore: null,
        serverScore: null,
        overallScore: null,
      });
      continue;
    }

    const matchedSiteSet = new Set(matchedSites);
    const devices = allDevices.filter((d) => matchedSiteSet.has(d.site));
    // Asset Management/Monitoring resolved first (their own live Datto
    // calls -- device audits + site alert breakdown, same as Live Reports'
    // own route), then blended into Overall Health Score exactly the way
    // Live Reports does for one client, by request.
    const { assetManagement, monitoring } = await liveReports.computeAssetManagementAndMonitoringScores(devices, force);
    const { workstation, server, overallScore } = liveReports.computeOverallHealth(devices, { assetManagement, monitoring });

    rows.push({
      companyId: company.id,
      companyName: company.companyName,
      companyUrl,
      hasParent: !!company.parentCompanyID,
      matched: true,
      matchedSites,
      totalDevices: devices.length,
      workstationScore: workstation ? Math.round(workstation.healthScore) : null,
      serverScore: server ? Math.round(server.healthScore) : null,
      overallScore,
    });
  }
  return groupBySharedSite(rows);
}

// Some TC Elite clients share a single Datto RMM site between SEVERAL
// Autotask companies because Datto itself has no per-location site set
// up for them -- confirmed live (by request, after Lenard's Chicken's 13
// separate franchise-store companies all showed up with identical scores):
// Datto only has one real "Lenard's Chicken" site account-wide, not one
// per store. Showing N rows with an identical score in that case reads as
// N separate assessments when there's really only one set of real data
// behind all of them, so those rows collapse into one here, by request.
// A company whose own matched site SET exactly matches another's is the
// only thing collapsed -- two different clients that happen to each
// score e.g. 68% on their own distinct sites are untouched.
function groupBySharedSite(rows) {
  const matched = rows.filter((r) => r.matched);
  const unmatched = rows.filter((r) => !r.matched);

  const groups = new Map(); // matchedSites signature -> rows sharing it
  for (const r of matched) {
    const key = [...r.matchedSites].sort().join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const collapsed = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      collapsed.push(group[0]);
      continue;
    }
    group.sort((a, b) => a.companyName.localeCompare(b.companyName));
    // Prefer a group member with no parent company as the representative
    // (usually the franchise's own head-office/umbrella record) -- falls
    // back to alphabetically first when none of them has one.
    const representative = group.find((r) => !r.hasParent) || group[0];
    collapsed.push({
      ...representative,
      companyName: `${representative.companyName} (${group.length} locations)`,
      groupedCompanyNames: group.map((r) => r.companyName),
    });
  }
  return [...collapsed, ...unmatched];
}

router.get('/', async (req, res) => {
  if (!dattoRmm.hasDattoCredentials()) return res.json({ connected: false });
  try {
    const force = req.query.force === 'true';
    const rows = await buildRows(force);
    res.json({ connected: true, asOf: new Date().toISOString(), rows });
  } catch (err) {
    console.error(err);
    const detail = err.response ? `Datto API returned HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    res.status(500).json({ error: detail });
  }
});

module.exports = router;
