const express = require('express');
const { getClient, listAll, getPicklistLabels, getCompanyUrl, getCompanyUdfValueToNameMap } = require('@dashboard/autotask-client');
const dattoRmm = require('@dashboard/datto-rmm/lib.js');
// Lives in packages/shell (this dashboard's own "central shell database",
// packages/shell/data.db), not here -- by request. See that file's own
// comment for why.
const exceptionsDb = require('@dashboard/shell/rmm-filter-exceptions-db.js');

// { email, name } for whoever's making this request -- requireAuth (see
// packages/shell/auth.js) already guarantees a signed-in session before any
// route on this router runs, same as every other page's server.js.
function actorFrom(req) {
  return { email: req.session.user.email, name: req.session.user.name };
}

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
// company). Three sources are checked, in priority order:
//   1. Datto RMM's own native PSA Company link for the site (confirmed
//      live this session as real raw fields on `/v2/account/sites` --
//      `autotaskCompanyId`/`autotaskCompanyName`, see getAllSites() in
//      @dashboard/datto-rmm/lib.js) -- the most authoritative source there
//      is, an explicit Autotask company ID someone set directly in Datto
//      RMM's own site settings, by request ("check against the PSA
//      Company Name for the Datto RMM site"). Resolved by that ID, not by
//      Datto's own cached autotaskCompanyName -- confirmed live this
//      session that the cached name can go stale: a real site's PSA link
//      still pointed at company id 1184 ("Sleepy's Caringbah", long since
//      disabled) even though the live, active replacement company
//      ("Sleepy's Caringbah (HO)", id 2156) existed in Autotask -- the id
//      itself doesn't drift the way a cached name can, so resolving by id
//      is strictly more correct even though it can't fix a genuinely stale
//      PSA link on Datto's own side (that needs fixing there, not here).
//   2. This dashboard's own hand-maintained mapping -- Data Matching's own
//      "Datto RMM Sites" UDF, "Name:Datto RMM" -- confirmed live on this
//      account to hold several real semicolon-separated multi-site values
//      (a company with more than one Datto site, same multi-value
//      convention getCompanyUdfValueToNameMap already splits on ";" for).
//   3. An exact site-name == company-name guess, same "assume matches"
//      fallback Check Client's own resolve-client route already documents
//      for this exact UDF.
function resolveCompanyForSite(siteName, siteUid, psaCompanyIdBySiteUid, companyById, udfValueToCompanyName, companyByLowerName) {
  const psaCompanyId = siteUid ? psaCompanyIdBySiteUid.get(siteUid) : null;
  if (psaCompanyId != null) {
    const company = companyById.get(psaCompanyId);
    if (company) return company;
  }
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
  const [allFilters, companies, classificationLabels, udfValueToCompanyName, allDevices, allSites] = await Promise.all([
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
    // Every Datto RMM site, once -- just for its own native PSA Company
    // link (resolveCompanyForSite()'s first, highest-priority source, by
    // request). Not re-fetched per tab, same reasoning as allDevices above.
    dattoRmm.getAllSites(),
  ]);

  const byLowerFilterName = new Map(allFilters.map((f) => [normalizeName(f.name), f]));
  const companyByLowerName = new Map(companies.map((c) => [normalizeName(c.companyName), c]));
  const companyById = new Map(companies.map((c) => [c.id, c]));
  const psaCompanyIdBySiteUid = new Map(allSites.filter((s) => s.autotaskCompanyId != null).map((s) => [s.uid, s.autotaskCompanyId]));

  // Every device-category count this account's devices resolve to, per
  // company -- built once, from the whole account's devices (not just one
  // filter's own matches), so "Missing" can tell a genuine gap from a
  // client with no device of that kind anywhere to ever be captured.
  // A count per category, not just a Set of which categories exist, by
  // request ("show... the Devices column" on Missing too) -- Missing's own
  // Devices column (below) shows how many of THIS filter's relevant
  // categories a company already has ACCOUNT-WIDE even though none of them
  // are captured by this filter yet -- 0 reads as "genuinely no presence
  // yet" (new/pending onboarding), anything higher points at a real
  // site-matching gap (e.g. the stale Datto RMM PSA Company link case
  // confirmed live this session, see resolveCompanyForSite()'s own
  // comment).
  const deviceCategoryCountsByCompanyId = new Map(); // companyId -> Map<category, count>
  for (const d of allDevices) {
    const siteName = (d.site || '').trim();
    if (!siteName) continue;
    const company = resolveCompanyForSite(siteName, d.siteUid, psaCompanyIdBySiteUid, companyById, udfValueToCompanyName, companyByLowerName);
    if (!company) continue;
    if (!deviceCategoryCountsByCompanyId.has(company.id)) deviceCategoryCountsByCompanyId.set(company.id, new Map());
    const counts = deviceCategoryCountsByCompanyId.get(company.id);
    counts.set(d.deviceType, (counts.get(d.deviceType) || 0) + 1);
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
    // siteUid is captured once per group (from whichever device is seen
    // first for that site name) -- every device at one real Datto site
    // shares the same siteUid, needed below for the PSA-Company-by-id
    // resolution (resolveCompanyForSite()'s own first-priority source).
    const bySite = new Map(); // siteName -> { siteName, siteUid, count }
    for (const d of devices) {
      const siteName = (d.site || '').trim();
      if (!siteName) continue;
      if (!bySite.has(siteName)) bySite.set(siteName, { siteName, siteUid: d.siteUid, count: 0 });
      bySite.get(siteName).count += 1;
    }

    const targetCompanies = targetCompaniesByLabel.get(spec.classificationLabel) || [];

    // Resolve every site in this filter to a company ONCE, shared by both
    // the Missing check below (by company id) and the Wrongly
    // Included/Correctly Present split further down.
    const resolvedBySite = new Map(); // siteName -> { siteName, count, company }
    const presentCompanyIds = new Set();
    for (const { siteName, siteUid, count } of bySite.values()) {
      const company = resolveCompanyForSite(siteName, siteUid, psaCompanyIdBySiteUid, companyById, udfValueToCompanyName, companyByLowerName);
      resolvedBySite.set(siteName, { siteName, count, company });
      if (company) presentCompanyIds.add(company.id);
    }

    const missing = [];
    for (const c of targetCompanies) {
      if (presentCompanyIds.has(c.id)) continue;
      // Not "missing" if this client HAS devices in Datto RMM but none of
      // the kind this filter is even about -- e.g. a client with real
      // desktops/laptops but zero real servers can't be missing from a
      // Servers filter; that's a genuine structural fact about them, not a
      // gap. But a client with NO devices in Datto RMM AT ALL (categories
      // undefined -- nothing resolved to them anywhere) is deliberately
      // NOT excluded by that same check, by request ("a site... but has
      // zero devices should still be present in the filter so that
      // devices are included once they get added") -- a brand-new/pending
      // client hasn't been onboarded into Datto RMM yet, and flagging them
      // as Missing now is exactly what prompts adding their site to the
      // filter ahead of their first real device, rather than only
      // noticing once they already have one. This also means a client
      // whose devices are all being mis-attributed elsewhere (e.g. a
      // stale Datto RMM PSA Company link -- confirmed live this session,
      // see resolveCompanyForSite()'s own comment) surfaces here instead
      // of silently vanishing from the whole report, which is exactly the
      // kind of gap this page exists to catch.
      const categoryCounts = deviceCategoryCountsByCompanyId.get(c.id);
      const relevantDeviceCount = categoryCounts ? spec.deviceCategories.reduce((sum, cat) => sum + (categoryCounts.get(cat) || 0), 0) : 0;
      if (categoryCounts && relevantDeviceCount === 0) continue;
      // subjectKey: always "company:<id>" here -- a Missing row is always a
      // real Autotask company (see targetCompanies above), never an
      // unresolved site the way a Wrongly Included row can be.
      // classificationLabel: always spec.classificationLabel here (that's
      // the definition of targetCompanies) -- included anyway, by request,
      // so Missing's own table has the same Client/Classification/Devices
      // columns every other section's table does.
      missing.push({
        companyId: c.id,
        companyName: c.companyName,
        companyUrl: await getCompanyUrl(c.id),
        classificationLabel: spec.classificationLabel,
        deviceCount: relevantDeviceCount,
        subjectKey: `company:${c.id}`,
      });
    }

    const correctlyPresent = [];
    const wronglyIncluded = [];
    for (const { siteName, count, company } of resolvedBySite.values()) {
      const companyClassificationLabel = company ? classificationLabels.get(company.classification) || null : null;
      if (company && companyClassificationLabel === spec.classificationLabel) {
        // classificationLabel: always spec.classificationLabel here (that's
        // the definition of correctlyPresent) -- included anyway, by
        // request, so Correct's own table has the same Client/
        // Classification/Devices columns every other section's table does.
        correctlyPresent.push({
          companyId: company.id,
          companyName: company.companyName,
          companyUrl: await getCompanyUrl(company.id),
          classificationLabel: companyClassificationLabel,
          deviceCount: count,
        });
      } else {
        // subjectKey: keyed by the resolved company when there is one (so
        // the SAME company showing up under a different Datto site name
        // later still matches an existing exception), falling back to the
        // raw, un-resolved site name only when there's genuinely no company
        // to key it by instead (see db.js's own comment on this).
        wronglyIncluded.push({
          siteName,
          companyId: company ? company.id : null,
          companyName: company ? company.companyName : null,
          companyUrl: company ? await getCompanyUrl(company.id) : null,
          classificationLabel: companyClassificationLabel,
          deviceCount: count,
          subjectKey: company ? `company:${company.id}` : `site:${siteName}`,
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

// The expensive Datto RMM/Autotask build, cached as above -- Allowed
// Exceptions are deliberately NOT part of this cached blob (see
// splitByExceptions()/getRmmFilters() below), so marking/unmarking one
// takes effect on the very next request regardless of how long is left on
// this cache.
async function getCachedRawFilters(force) {
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

// Splits one tab's own missing/wronglyIncluded rows into { items,
// exceptions }, by request -- a cheap, un-cached local SQLite read applied
// fresh on EVERY call (unlike the expensive raw build above), so marking a
// row an exception stops it cluttering the main list immediately rather
// than waiting out whatever's left of the 15-minute cache. `exceptionId`
// rides along on each excepted row -- client.js's own "remove from
// Exceptions" icon needs it for the DELETE route below.
function splitByExceptions(filterName, subTab, rows) {
  const exceptionsByKey = exceptionsDb.getExceptionsMap(filterName, subTab);
  const items = [];
  const exceptions = [];
  for (const row of rows) {
    const exception = exceptionsByKey.get(row.subjectKey);
    if (exception) exceptions.push({ ...row, exceptionId: exception.id });
    else items.push(row);
  }
  return { items, exceptions };
}

async function getRmmFilters(force) {
  const raw = await getCachedRawFilters(force);
  if (raw.status !== 'ok') return raw;
  return {
    ...raw,
    tabs: raw.tabs.map((tab) => ({
      ...tab,
      missing: splitByExceptions(tab.name, 'missing', tab.missing),
      wronglyIncluded: splitByExceptions(tab.name, 'wrongly_included', tab.wronglyIncluded),
    })),
  };
}

const router = express.Router();
router.use(express.json());

router.get('/', async (req, res) => {
  try {
    const data = await getRmmFilters(req.query.force === 'true');
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Marks one Missing/Wrongly Included row an Allowed Exception, by request
// -- the small icon on each row in client.js. subTab is the wire-format
// 'missing'/'wrongly_included' (matches db.js's own CHECK constraint and
// splitByExceptions()'s own call above) -- client.js sends it directly, no
// translation needed either side.
router.post('/exceptions', (req, res) => {
  try {
    const { filterName, subTab, subjectKey, clientName } = req.body || {};
    if (!filterName || !subTab || !subjectKey || !clientName) {
      return res.status(400).json({ error: 'filterName, subTab, subjectKey, and clientName are all required.' });
    }
    if (!['missing', 'wrongly_included'].includes(subTab)) {
      return res.status(400).json({ error: `Invalid subTab "${subTab}".` });
    }
    const { email, name } = actorFrom(req);
    exceptionsDb.addException({ filterName, subTab, subjectKey, clientName, email, name });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Removes one Allowed Exception, by request -- the small icon on each row
// in the Allowed Exceptions list, client.js. The row then simply reappears
// in the main list on the very next GET / (no separate "undo" state to
// track -- splitByExceptions() above just won't find a matching exception
// for it anymore).
router.delete('/exceptions/:id', (req, res) => {
  try {
    exceptionsDb.removeException(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// getRmmFilters is also exported directly (not just mounted as this
// router's own GET /), by request -- What's On's "Today's Brief
// (Kaseya-MCP Morning Pulse)" box reuses this page's own already-cached
// Missing counts for its "Found N Clients Missing from DRMM Filters" line,
// same cross-page server-side reuse convention @dashboard/whats-on already
// follows elsewhere in this file for @dashboard/strety-autotask-sync's
// status.js/metrics.js/client.js -- calling this directly (in-process,
// same server) rather than an HTTP round trip to this page's own /api/
// route. Attached as a property on the exported router function (an
// Express Router IS a function) -- it still mounts exactly as before
// everywhere that just does `require(...)`.
module.exports = router;
module.exports.getRmmFilters = getRmmFilters;
