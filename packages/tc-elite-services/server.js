const express = require('express');
const { getClient, listAll, fetchByFieldIn, getPicklistLabels, getCompanyUrl, getContractUrl, mapWithConcurrency, resolveCompanyName } = require('@dashboard/autotask-client');
const { buildInstalledServices } = require('@dashboard/client-summary/installed-services.js');

// Every CURRENT "Tech Cover Elite"/"Tech Cover Essentials" client
// (Companies.classification label -- the same real strings Client
// Summary's own Active Contracts warning already matches against), as two
// tabs, by request ("TC Elite Services & TC Essentials Services") -- each
// client still gets its own 2 blue "contract pills" (Default Contract /
// "Tech Cover <X>*" contract -- same wildcard-prefix rule as that
// warning) plus the SAME green/red Installed Services pills Client
// Summary shows for one client at a time -- reused via
// @dashboard/client-summary's own installed-services.js, not duplicated
// here. Page renamed "TC Services" (was "TC Elite Services") to reflect
// both tabs -- the page id/route (tc-elite-services) is UNCHANGED, by
// request implication: several nav/tab-pin configs already reference that
// exact id (client-tabs, client-search-tabs, tech-cover-rollouts-tabs,
// nav-layout.json) and this dashboard's own convention is to never rename
// an id those already point at.
const CLASSIFICATION_SPECS = [
  { key: 'elite', label: 'TC Elite Services', classificationLabel: 'Tech Cover Elite' },
  { key: 'essentials', label: 'TC Essentials Services', classificationLabel: 'Tech Cover Essentials' },
];

function normalizeContractName(s) {
  return (s || '').trim().toUpperCase();
}

// One BATCHED fetchByFieldIn() across every one tab's own companies'
// active (status 1) contracts, not one contracts query per company --
// same "batch it" reasoning as Client Summary's own buildNextBillingDates().
// `contractPrefix` is just classificationLabel.toUpperCase() (e.g. "TECH
// COVER ESSENTIALS") -- same real naming convention Tech Cover Elite's own
// contracts already follow, reused rather than a second hardcoded prefix.
async function buildContractPills(client, companyIds, contractPrefix) {
  const pillsByCompany = new Map();
  if (companyIds.length === 0) return pillsByCompany;

  const contracts = await fetchByFieldIn(client.contracts, 'companyID', companyIds, [{ op: 'eq', field: 'status', value: 1 }]);
  const contractsByCompany = new Map();
  for (const c of contracts) {
    if (!contractsByCompany.has(c.companyID)) contractsByCompany.set(c.companyID, []);
    contractsByCompany.get(c.companyID).push(c);
  }
  for (const [companyId, companyContracts] of contractsByCompany.entries()) {
    const defaultContract = companyContracts.find((c) => c.isDefaultContract) || null;
    const targetContract = companyContracts.find((c) => normalizeContractName(c.contractName).startsWith(contractPrefix)) || null;
    pillsByCompany.set(companyId, {
      defaultContractName: defaultContract ? defaultContract.contractName : null,
      // Both pills click through to the matched contract in Autotask, by
      // request -- same getContractUrl()/popup-window convention every
      // other contract link on this dashboard already uses.
      defaultContractUrl: defaultContract ? await getContractUrl(defaultContract.id) : null,
      targetContractName: targetContract ? targetContract.contractName : null,
      targetContractUrl: targetContract ? await getContractUrl(targetContract.id) : null,
    });
  }
  return pillsByCompany;
}

// Bounded fan-out across every TC Elite client's own Installed Services
// check -- same convention every other per-client fan-out on this
// dashboard uses (e.g. Classification Summary's own resolveCompanyName()
// pass). Each individual buildInstalledServices() call still makes several
// vendor calls of its own, but every one of those is cached on its own
// vendor-level TTL (see each vendor's own file), so this mainly just
// bounds how many run at once, not how often the underlying data is
// fetched.
const FAN_OUT_CONCURRENCY = 5;

// The classification lookup + company list, generalized over BOTH tabs'
// own classification labels -- split out from buildServicesForSpec()
// below so Live Health Scores can reuse the exact same "who counts as a TC
// Elite client" membership test (same "reuse the sibling's own function,
// don't duplicate it" convention Check Client/Meeting Prep/Live Reports
// already established) without also paying for the per-company 6-vendor
// Installed Services fan-out, which it has no use for.
async function resolveCompaniesByClassification(client, classificationLabel) {
  const classificationLabels = await getPicklistLabels(client.companies, 'classification');
  const code = [...classificationLabels.entries()].find(([, label]) => label === classificationLabel)?.[0] ?? null;
  if (code === null) return [];

  const companies = await listAll(client.companies, [
    { op: 'eq', field: 'classification', value: code },
    { op: 'eq', field: 'isActive', value: true },
  ]);
  companies.sort((a, b) => a.companyName.localeCompare(b.companyName));
  return companies;
}

// Kept as its own named function (not just inlined as
// resolveCompaniesByClassification(client, 'Tech Cover Elite')) -- Live
// Health Scores' own server.js requires this exact function by name
// (router.resolveTcEliteCompanies below), so its signature/name stay
// unchanged even though the page itself now covers both classifications.
async function resolveTcEliteCompanies(client) {
  return resolveCompaniesByClassification(client, CLASSIFICATION_SPECS[0].classificationLabel);
}

// One tab's own rows -- `companies` is already resolved (by
// buildTcServices() below, shared across both tabs' parent-name lookup),
// not re-fetched here.
async function buildServicesForSpec(client, spec, companies, parentNameById) {
  if (companies.length === 0) return { key: spec.key, label: spec.label, classificationLabel: spec.classificationLabel, rows: [] };

  const companyIds = companies.map((c) => c.id);
  const contractPrefix = spec.classificationLabel.toUpperCase();

  const [pillsByCompany, installedServicesPairs] = await Promise.all([
    buildContractPills(client, companyIds, contractPrefix),
    mapWithConcurrency(companies, FAN_OUT_CONCURRENCY, async (c) => [c.id, await buildInstalledServices(c)]),
  ]);
  const installedServicesByCompany = new Map(installedServicesPairs);

  const rows = [];
  for (const company of companies) {
    const pills = pillsByCompany.get(company.id) || { defaultContractName: null, defaultContractUrl: null, targetContractName: null, targetContractUrl: null };
    rows.push({
      companyId: company.id,
      companyName: company.companyName,
      companyUrl: await getCompanyUrl(company.id),
      defaultContractName: pills.defaultContractName,
      defaultContractUrl: pills.defaultContractUrl,
      targetContractName: pills.targetContractName,
      targetContractUrl: pills.targetContractUrl,
      installedServices: installedServicesByCompany.get(company.id),
      hasParent: !!company.parentCompanyID,
      parentCompanyName: company.parentCompanyID ? parentNameById.get(company.parentCompanyID) || null : null,
    });
  }
  return { key: spec.key, label: spec.label, classificationLabel: spec.classificationLabel, rows };
}

async function buildTcServices() {
  const client = await getClient();

  // Resolved once per tab up front (not inside buildServicesForSpec()) so
  // the parent-name pass below can cover BOTH tabs' companies combined --
  // a parent company shared across an Elite and an Essentials client (or
  // just appearing in both for any reason) is still only resolved once,
  // not once per tab.
  const companiesBySpec = new Map();
  for (const spec of CLASSIFICATION_SPECS) {
    companiesBySpec.set(spec.key, await resolveCompaniesByClassification(client, spec.classificationLabel));
  }
  const allCompanies = [...companiesBySpec.values()].flat();

  // Parent company name, by request ("put the clients with a parent in a
  // separate list at the bottom") -- same real parentCompanyID field
  // Classification Summary already resolves for its own identical
  // drilldown column. Resolved for every distinct parent id up front
  // (bounded concurrency, same convention as that page's own pass), not
  // one lookup per row -- resolveCompanyName() also caches per id for the
  // life of this server process, so a repeat id here is instant either
  // way.
  const distinctParentIds = [...new Set(allCompanies.map((c) => c.parentCompanyID).filter(Boolean))];
  const parentNameById = new Map();
  await mapWithConcurrency(distinctParentIds, 5, async (id) => {
    parentNameById.set(id, await resolveCompanyName(client, id));
  });

  // Sequential across tabs, not Promise.all -- each vendor's own whole-
  // account list (SaaS Alerts/Huntress/etc., see client-summary/
  // installed-services.js) is fetched once and cached module-scope
  // regardless of classification, so running Elite first and Essentials
  // second costs nothing extra in real vendor API calls -- Essentials'
  // own per-company matching just reuses whichever caches Elite's own
  // pass already warmed up. The only genuinely new work per tab is the
  // per-company matching itself (cheap, in-memory) and this tab's own
  // Autotask company/contract queries.
  const tabs = [];
  for (const spec of CLASSIFICATION_SPECS) {
    tabs.push(await buildServicesForSpec(client, spec, companiesBySpec.get(spec.key), parentNameById));
  }
  return { asOf: new Date().toISOString(), tabs };
}

// Same reasoning TC Elite's own getTcEliteSeats() cache gives -- a contract
// or installed-service change should stop showing stale within the hour,
// not linger for this dashboard's more usual 20-minute default, but this
// whole-list report is expensive enough (a per-company fan-out across six
// vendor APIs) that it shouldn't re-run on every single page view either.
const CACHE_TTL_MS = 10 * 60 * 1000;
let cached = null; // { data, expiresAt }
let inFlight = null;

async function getTcServices(force) {
  if (!force && cached && Date.now() < cached.expiresAt) return cached.data;
  if (!inFlight) {
    inFlight = buildTcServices()
      .then((data) => {
        cached = { data, expiresAt: Date.now() + CACHE_TTL_MS };
        return data;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const data = await getTcServices(req.query.force === 'true');
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Reused by Live Health Scores, by request -- see resolveTcEliteCompanies()'s
// own header comment.
router.resolveTcEliteCompanies = resolveTcEliteCompanies;

module.exports = router;
