const express = require('express');
const { getClient, listAll, getPicklistLabels, getCompanyUrl, getCompanyUdfValueToNameMap } = require('@dashboard/autotask-client');
const dattoRmm = require('@dashboard/datto-rmm/lib.js');

// The 3 real Datto RMM filters this page checks, by request -- confirmed
// live this session against the real account's 125 saved filters (custom +
// Datto's own built-in "default" ones). Matched by NAME, not id, same
// not-a-hardcoded-id convention as datto-rmm's own CURATED_FILTER_NAMES --
// a filter renamed/recreated on Datto's side just logs+omits that tab rather
// than breaking the page. Two filters share "Tech Cover Elite" as their
// target classification; the third checks "Tech Cover Essentials" -- both
// real Autotask Companies.classification picklist labels, confirmed live
// (codes 15 and 17 respectively on this account).
// deviceCategories -- real Datto RMM deviceType.category values (confirmed
// live on this account: Desktop, Laptop, Server, Printer, Datto Continuity,
// several "Network Device (...)" variants) -- what kind of device each
// filter is actually about. By request ("a 'Servers' filter should not
// require sites without servers"): a classified client with no device of
// the relevant kind ANYWHERE in Datto RMM has nothing it could ever be
// expected to show up in this filter with, so it's not "missing" -- there's
// a real gap confirmed live this session, 48 of 50 "missing" Servers-filter
// companies turned out to have zero Server-category devices on the whole
// account, not an actual gap in the filter's own setup.
const FILTER_SPECS = [
  { name: 'TC Elite Servers Filter', classificationLabel: 'Tech Cover Elite', deviceCategories: ['Server'] },
  { name: 'TC Elite Workstations Filter', classificationLabel: 'Tech Cover Elite', deviceCategories: ['Desktop', 'Laptop'] },
  { name: 'TC ESS Workstations Filter', classificationLabel: 'Tech Cover Essentials', deviceCategories: ['Desktop', 'Laptop'] },
];

// companyType picklist codes (Autotask-wide, not org-specific config): 1 =
// Customer, 3 = Prospect -- same "clients" definition Classification
// Summary/Client Details already use. A Datto RMM "site" that doesn't match
// one of these (e.g. "Ambient iT" itself, confirmed live as a real site in
// the TC Elite Workstations filter) is reported as Wrongly Included with no
// matching Autotask company, not silently matched against something it
// isn't.
const CUSTOMER_OR_PROSPECT_TYPES = [1, 3];

function normalizeName(s) {
  return (s || '').trim().toLowerCase();
}

// A Datto RMM site's name doesn't always exactly match the Autotask company
// it belongs to (e.g. "Sleepy's Caringbah" has no Autotask company of that
// exact name -- it's one of several real stores under the "Sleepy's"
// company). This dashboard already has a dedicated place that records the
// real site<->company mapping by hand -- Data Matching's own "Datto RMM
// Sites" UDF, "Name:Datto RMM" -- confirmed live on this account to hold
// several real semicolon-separated multi-site values (a company with more
// than one Datto site, same multi-value convention getCompanyUdfValueToNameMap
// already splits on ";" for). This resolves each Datto site to a company via
// that UDF FIRST, falling back to an exact site-name == company-name guess
// only when the UDF has no entry for that site -- same "assume matches"
// fallback Check Client's own resolve-client route already documents for
// this exact UDF.
function resolveCompanyForSite(siteName, udfValueToCompanyName, companyByLowerName) {
  const viaUdfCompanyName = udfValueToCompanyName.get(siteName);
  if (viaUdfCompanyName) {
    const company = companyByLowerName.get(normalizeName(viaUdfCompanyName));
    if (company) return company;
  }
  return companyByLowerName.get(normalizeName(siteName)) || null;
}

async function buildRmmFilters() {
  if (!dattoRmm.hasDattoCredentials()) return { status: 'not-connected' };

  const client = await getClient();
  const [allFilters, companies, classificationLabels, udfValueToCompanyName, allDevices] = await Promise.all([
    dattoRmm.getAllFilters(),
    // ALL companies, not just active customer/prospect ones -- the UDF map
    // below is built the same way (every company, any type/status), and a
    // site resolving to an inactive/non-customer company still needs to
    // show up as Wrongly Included with its real classification, not get
    // silently dropped for not being in a narrower fetch.
    listAll(client.companies, [{ op: 'gte', field: 'id', value: 0 }]),
    getPicklistLabels(client.companies, 'classification'),
    getCompanyUdfValueToNameMap(client, 'Name:Datto RMM'),
    // The WHOLE account's devices, once -- shared by every filter tab below
    // for the "does this client even have a device of the relevant kind"
    // eligibility check (see FILTER_SPECS' deviceCategories comment), not
    // re-fetched per tab.
    dattoRmm.getAllDevices(),
  ]);

  const byLowerFilterName = new Map(allFilters.map((f) => [normalizeName(f.name), f]));
  const companyByLowerName = new Map(companies.map((c) => [normalizeName(c.companyName), c]));

  // Every distinct device-category this account's devices resolve to, per
  // company -- built once, from the whole account's devices (not just one
  // filter's own matches), so "Missing" can tell a genuine gap from a
  // client with no device of that kind anywhere to ever be captured.
  const deviceCategoriesByCompanyId = new Map(); // companyId -> Set<category>
  for (const d of allDevices) {
    const siteName = (d.site || '').trim();
    if (!siteName) continue;
    const company = resolveCompanyForSite(siteName, udfValueToCompanyName, companyByLowerName);
    if (!company) continue;
    if (!deviceCategoriesByCompanyId.has(company.id)) deviceCategoriesByCompanyId.set(company.id, new Set());
    deviceCategoriesByCompanyId.get(company.id).add(d.deviceType);
  }

  // One pre-sorted "should be in a filter targeting this classification"
  // list per distinct classificationLabel across FILTER_SPECS -- the two TC
  // Elite filters share the exact same target list, computed once rather
  // than twice. Restricted to active customer/prospect companies here (not
  // the full list above) -- an inactive or non-client company has nothing
  // to be "missing" from.
  const targetCompaniesByLabel = new Map();
  for (const label of new Set(FILTER_SPECS.map((s) => s.classificationLabel))) {
    const code = [...classificationLabels.entries()].find(([, l]) => l === label)?.[0] ?? null;
    const matched =
      code === null
        ? []
        : companies.filter((c) => c.classification === code && c.isActive && CUSTOMER_OR_PROSPECT_TYPES.includes(c.companyType));
    matched.sort((a, b) => a.companyName.localeCompare(b.companyName));
    targetCompaniesByLabel.set(label, matched);
  }

  const tabs = [];
  for (const spec of FILTER_SPECS) {
    const filter = byLowerFilterName.get(normalizeName(spec.name));
    if (!filter) {
      console.warn(`RMM Filters: "${spec.name}" not found on the real Datto RMM account -- omitted from the page.`);
      continue;
    }

    const devices = await dattoRmm.getAllDevicesForFilter(filter.id);
    // Group by site name (trim) -- same "RMM site stands in for an Autotask
    // Client" convention Check Client's own Datto RMM section already uses.
    const bySite = new Map(); // siteName -> { siteName, count }
    for (const d of devices) {
      const siteName = (d.site || '').trim();
      if (!siteName) continue;
      if (!bySite.has(siteName)) bySite.set(siteName, { siteName, count: 0 });
      bySite.get(siteName).count += 1;
    }

    const targetCompanies = targetCompaniesByLabel.get(spec.classificationLabel) || [];

    // Resolve every site in this filter to a company ONCE, shared by both
    // the Missing check below (by company id) and the Wrongly
    // Included/Correctly Present split further down.
    const resolvedBySite = new Map(); // siteName -> { siteName, count, company }
    const presentCompanyIds = new Set();
    for (const { siteName, count } of bySite.values()) {
      const company = resolveCompanyForSite(siteName, udfValueToCompanyName, companyByLowerName);
      resolvedBySite.set(siteName, { siteName, count, company });
      if (company) presentCompanyIds.add(company.id);
    }

    const missing = [];
    for (const c of targetCompanies) {
      if (presentCompanyIds.has(c.id)) continue;
      // Not "missing" if this client has no device of the kind this filter
      // is even about anywhere in Datto RMM -- e.g. a client with zero real
      // servers can't be missing from a Servers filter.
      const categories = deviceCategoriesByCompanyId.get(c.id);
      if (!categories || !spec.deviceCategories.some((cat) => categories.has(cat))) continue;
      missing.push({ companyId: c.id, companyName: c.companyName, companyUrl: await getCompanyUrl(c.id) });
    }

    const correctlyPresent = [];
    const wronglyIncluded = [];
    for (const { siteName, count, company } of resolvedBySite.values()) {
      const companyClassificationLabel = company ? classificationLabels.get(company.classification) || null : null;
      if (company && companyClassificationLabel === spec.classificationLabel) {
        correctlyPresent.push({ companyId: company.id, companyName: company.companyName, companyUrl: await getCompanyUrl(company.id), deviceCount: count });
      } else {
        wronglyIncluded.push({
          siteName,
          companyId: company ? company.id : null,
          companyName: company ? company.companyName : null,
          companyUrl: company ? await getCompanyUrl(company.id) : null,
          classificationLabel: companyClassificationLabel,
          deviceCount: count,
        });
      }
    }

    correctlyPresent.sort((a, b) => a.companyName.localeCompare(b.companyName));
    wronglyIncluded.sort((a, b) => a.siteName.localeCompare(b.siteName));

    tabs.push({
      id: filter.id,
      name: spec.name,
      classificationLabel: spec.classificationLabel,
      missing,
      wronglyIncluded,
      correctlyPresent,
    });
  }

  return { status: 'ok', asOf: new Date().toISOString(), tabs };
}

// Same 15-minute TTL reasoning as datto-rmm's own overview cache -- this
// page pages through a full per-filter device list (up to ~700+ real
// devices for the biggest filter) plus a full active-company pull, so it
// shouldn't re-run on every page view, but also shouldn't go stale for a
// whole working day either. ?force=true bypass, same convention as every
// other page on this dashboard.
const CACHE_TTL_MS = 15 * 60 * 1000;
let cached = null; // { data, expiresAt }
let inFlight = null;

async function getRmmFilters(force) {
  if (!force && cached && Date.now() < cached.expiresAt) return cached.data;
  if (!inFlight) {
    inFlight = buildRmmFilters()
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
    const data = await getRmmFilters(req.query.force === 'true');
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
