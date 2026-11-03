const express = require('express');
const { getClient, listAll, fetchByFieldIn, getPicklistLabels, getCompanyUrl, getContractUrl, mapWithConcurrency, resolveCompanyName } = require('@dashboard/autotask-client');
const { buildInstalledServices } = require('@dashboard/client-summary/installed-services.js');

// Every CURRENT "Tech Cover Elite" client (Companies.classification label
// -- the same real string Client Summary's own Active Contracts warning
// already matches against), by request, each with its own 2 blue
// "contract pills" (Default Contract / "Tech Cover Elite*" contract --
// same wildcard-prefix rule as that warning) plus the SAME green/red
// Installed Services pills Client Summary shows for one client at a time
// -- reused via @dashboard/client-summary's own installed-services.js,
// not duplicated here.
const CLASSIFICATION_LABEL = 'Tech Cover Elite';

function normalizeContractName(s) {
  return (s || '').trim().toUpperCase();
}

// One BATCHED fetchByFieldIn() across every TC Elite company's active
// (status 1) contracts, not one contracts query per company -- same
// "batch it" reasoning as Client Summary's own buildNextBillingDates().
async function buildContractPills(client, companyIds) {
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
    const eliteContract = companyContracts.find((c) => normalizeContractName(c.contractName).startsWith('TECH COVER ELITE')) || null;
    pillsByCompany.set(companyId, {
      defaultContractName: defaultContract ? defaultContract.contractName : null,
      // Both pills click through to the matched contract in Autotask, by
      // request -- same getContractUrl()/popup-window convention every
      // other contract link on this dashboard already uses.
      defaultContractUrl: defaultContract ? await getContractUrl(defaultContract.id) : null,
      eliteContractName: eliteContract ? eliteContract.contractName : null,
      eliteContractUrl: eliteContract ? await getContractUrl(eliteContract.id) : null,
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

async function buildTcEliteServices() {
  const client = await getClient();
  const classificationLabels = await getPicklistLabels(client.companies, 'classification');
  const tcEliteCode = [...classificationLabels.entries()].find(([, label]) => label === CLASSIFICATION_LABEL)?.[0] ?? null;
  if (tcEliteCode === null) return { asOf: new Date().toISOString(), rows: [] };

  const companies = await listAll(client.companies, [
    { op: 'eq', field: 'classification', value: tcEliteCode },
    { op: 'eq', field: 'isActive', value: true },
  ]);
  companies.sort((a, b) => a.companyName.localeCompare(b.companyName));

  const companyIds = companies.map((c) => c.id);
  // Parent company name, by request ("put the clients with a parent in a
  // separate list at the bottom") -- same real parentCompanyID field
  // Classification Summary already resolves for its own identical
  // drilldown column. Resolved for every distinct parent id up front
  // (bounded concurrency, same convention as that page's own pass), not
  // one lookup per row -- resolveCompanyName() also caches per id for the
  // life of this server process, so a repeat id here is instant either
  // way.
  const distinctParentIds = [...new Set(companies.map((c) => c.parentCompanyID).filter(Boolean))];
  const parentNameById = new Map();
  await mapWithConcurrency(distinctParentIds, 5, async (id) => {
    parentNameById.set(id, await resolveCompanyName(client, id));
  });

  const [pillsByCompany, installedServicesPairs] = await Promise.all([
    buildContractPills(client, companyIds),
    mapWithConcurrency(companies, FAN_OUT_CONCURRENCY, async (c) => [c.id, await buildInstalledServices(c)]),
  ]);
  const installedServicesByCompany = new Map(installedServicesPairs);

  const rows = [];
  for (const company of companies) {
    const pills = pillsByCompany.get(company.id) || { defaultContractName: null, defaultContractUrl: null, eliteContractName: null, eliteContractUrl: null };
    rows.push({
      companyId: company.id,
      companyName: company.companyName,
      companyUrl: await getCompanyUrl(company.id),
      defaultContractName: pills.defaultContractName,
      defaultContractUrl: pills.defaultContractUrl,
      eliteContractName: pills.eliteContractName,
      eliteContractUrl: pills.eliteContractUrl,
      installedServices: installedServicesByCompany.get(company.id),
      hasParent: !!company.parentCompanyID,
      parentCompanyName: company.parentCompanyID ? parentNameById.get(company.parentCompanyID) || null : null,
    });
  }
  return { asOf: new Date().toISOString(), rows };
}

// Same reasoning TC Elite's own getTcEliteSeats() cache gives -- a contract
// or installed-service change should stop showing stale within the hour,
// not linger for this dashboard's more usual 20-minute default, but this
// whole-list report is expensive enough (a per-company fan-out across six
// vendor APIs) that it shouldn't re-run on every single page view either.
const CACHE_TTL_MS = 10 * 60 * 1000;
let cached = null; // { data, expiresAt }
let inFlight = null;

async function getTcEliteServices(force) {
  if (!force && cached && Date.now() < cached.expiresAt) return cached.data;
  if (!inFlight) {
    inFlight = buildTcEliteServices()
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
    const data = await getTcEliteServices(req.query.force === 'true');
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
