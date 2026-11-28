const express = require('express');
const { getClient, listAll, fetchByFieldIn, getCompanyUrl, getContractUrl, mapWithConcurrency, getCompanyUdfValueToNameMap } = require('@dashboard/autotask-client');
// Reused rather than re-queried -- same "who counts as a Tech Cover
// Essentials client" membership test (Companies.classification = "Tech
// Cover Essentials") @dashboard/tc-elite-services's own Essentials tab
// already resolves (see that package's own resolveCompaniesByClassification(),
// exported there for this exact reuse).
const tcEliteServices = require('@dashboard/tc-elite-services/server.js');
const dattoRmm = require('@dashboard/datto-rmm/lib.js');
// Reused for the same company<->Datto-site resolution (native PSA link ->
// Name:Datto RMM UDF -> exact name match) RMM Filters already uses --
// see resolveCompanyForSite()'s own header comment there for the full
// 3-source priority order and the real stale-PSA-link bug it was built to
// survive.
const rmmFilters = require('@dashboard/rmm-filters/server.js');
const saasAlerts = require('@dashboard/saasalerts-client');

// TC Essentials Seat Check, by request: every current "Tech Cover
// Essentials" client, with its 3 real Kaseya 365 contract lines' CONTRACTED
// units checked against two independent, live counts -- workstations from
// Datto RMM, licensed users from SaaS Alerts -- rather than against each
// other or against a manually-typed tag the way Check Client's own TC Calc
// column works for one client at a time.
//
// Deliberately NOT the same comparison Check Client's own
// ESSENTIALS_DEFAULT_TAGS makes (there, Endpoint -> D* [ALL Datto device
// categories], User/Bundle -> U* [M365 Tenancy's own per-license-level user
// count]) -- this page was explicitly requested against two different real
// data sources instead: Datto RMM WORKSTATIONS only (Desktop+Laptop, not
// servers/network gear), and SaaS Alerts' own "Monitored Users"
// (billingUsers.count -- the same number @dashboard/saasalerts-customers
// already shows), confirmed live this session, minus a pattern-matched
// admin/break-glass exclusion (see isExcludedAdminAccount() below). Two
// genuinely different "Essentials" checks now exist on this dashboard by
// design, not by accident.
const CLASSIFICATION_LABEL = 'Tech Cover Essentials';

// Exact real Autotask Service/ServiceBundle names this page checks -- the
// same 3 real catalog items Check Client's own ESSENTIALS_DEFAULT_TAGS
// already recognizes (packages/check-client/client.js), confirmed there
// against real contract data (A Brave Life Ltd, Oct 2026). Matched EXACTLY
// (trimmed, case-insensitive), not a wildcard -- a "... Bundle Credit" line
// (a real, separate Autotask line that exists purely to cancel the paired
// Bundle line 1:1 for invoicing, confirmed in Check Client's own
// ESSENTIALS_BUNDLE_CREDIT_NAME) is deliberately NOT one of these 3 names,
// so it's silently ignored here rather than double-counted or misread as a
// 4th line.
const BUNDLE_NAME = 'kaseya 365 user & endpoint bundle';
const ENDPOINT_NAME = 'kaseya 365 endpoint';
const USER_NAME = 'kaseya 365 user';
const TARGET_NAMES = new Set([BUNDLE_NAME, ENDPOINT_NAME, USER_NAME]);

// The expected per-line seat allocation, exactly as specified by request:
// the Bundle line is the OVERLAP between workstations and licensed users
// (whichever is smaller -- every seat in that overlap is covered once by
// the combined bundle, never double-counted against a stand-alone line
// too); whichever of the two is the LARGER number gets the excess on its
// own stand-alone line (Endpoint if workstations > licensed users, User if
// licensed users > workstations); the smaller side's own stand-alone line
// is expected to be 0, since every one of its seats is already fully
// covered by the bundle. When the two counts are equal, the bundle alone
// covers everything and BOTH stand-alone lines are expected to be 0.
function expectedAllocation(workstations, licensedUsers) {
  if (workstations === null || licensedUsers === null) {
    return { bundle: null, endpoint: null, user: null };
  }
  return {
    bundle: Math.min(workstations, licensedUsers),
    endpoint: Math.max(0, workstations - licensedUsers),
    user: Math.max(0, licensedUsers - workstations),
  };
}

// SaaS Alerts' own GET /reports/users (confirmed live this session,
// customerId-scoped) has NO structured field for "this is an admin/break-
// glass account" -- `role` is always null and `isServiceAccount` is always
// undefined on every real account on this tenant checked (365 real users
// across 3 real customers sampled), not a documentation gap, a field this
// account's own data never populates. So this is a plain NAME/EMAIL text
// match against real confirmed examples on this account -- "AIT Break Glass
// 1"/"AIT  Break Glass 2" (ait-bg1@.../ait-bg2@sleepysptyltd.onmicrosoft.com),
// "O365 Admin" (o365admin@tvto.onmicrosoft.com), "0365 Admin" (a real
// digit-zero typo variant, o365admin@vanlieshoutau.onmicrosoft.com), "Office
// 365 Admin" (fully spelled out), and "m365.admin" (a real DOT-separated
// variant at Eyes @ Narangba, m365.admin@eyesat.onmicrosoft.com) -- by
// request ("leave Break Glass and O365Admin and M365Admin accounts/users
// out of the SaaS Alerts count").
//
// The separator between the product name and "admin" is matched loosely
// ([\s._-]*, i.e. a space, dot, underscore, hyphen, or nothing at all),
// by request ("no matter how much I ask my staff simply refuse to name
// them consistently") -- real confirmed variants already span "no
// separator" (o365admin@...), "space" (O365 Admin), and "dot"
// (m365.admin@...), so this is widened pre-emptively to the realistic
// range of separators a human might type, rather than patching one
// specific character every time a new real example turns up.
//
// Deliberately NOT matching plain "Admin" (e.g. real accounts seen live
// like "Richard | Admin"/"Richard Global Admin"/"Admin @ Sleepy's"/"Ross
// Admin" at Eyes @ Narangba) -- only the 3 specific categories asked for,
// not every account with "admin" somewhere in its name. Every excluded
// account is returned back to the caller (buildLicensedUserCounts()
// below), never silently subtracted -- a naming convention this doesn't
// recognize stays visible to review instead of invisibly wrong.
// Returns which of the 2 excluded categories an account matches ('breakGlass'
// or 'admin' -- O365Admin/M365Admin collapsed into one category, since
// they're the same real-world role just under 2 different product names),
// or null when it isn't excluded at all. Split out from a single boolean so
// buildLicensedUserCounts() below can separately count how many of each
// category a client actually has (see excludedCountUnusual's own comment).
function classifyExcludedAccount(u) {
  const hay = `${u.name || ''} ${u.email || ''}`.toLowerCase();
  if (/break[\s._-]*glass/.test(hay)) return 'breakGlass';
  if (/(?:[o0]365|office[\s._-]*365)[\s._-]*admin/.test(hay) || /m365[\s._-]*admin/.test(hay)) return 'admin';
  return null;
}
function isExcludedAdminAccount(u) {
  return classifyExcludedAccount(u) !== null;
}

// TODAY's current contract lines for the 3 target services/bundles,
// scoped from the start to just this report's own Essentials companies.
//
// Deliberately NOT built via @dashboard/contract-services' own
// buildReport() -- confirmed LIVE this session that calling it with no
// client filter (needed here, since that function only accepts a single
// company name/wildcard, not an arbitrary company-ID set) takes its slow,
// system-wide path: Contracts.companyID is only ever folded into the query
// when a client filter is given, so with none it fetches EVERY active
// contract system-wide (confirmed ~1,900 of them) regardless of the
// 'Kaseya 365' search term (that param only narrows the Services/
// ServiceBundles catalog query, not Contracts itself) -- a real call timed
// out past 120s. Scoping the Contracts fetch by companyID from the start
// (the same fetchByFieldIn() pattern @dashboard/tc-elite-services' own
// buildContractPills() already uses for this exact "N known companies'
// contracts in one batched call" shape) keeps this fast -- confirmed live,
// well under 5s for all 183 real Essentials companies.
async function buildContractedUnits(client, essentialsCompanyIds) {
  const result = new Map(); // companyId -> { bundle: line|null, endpoint: line|null, user: line|null }
  if (essentialsCompanyIds.size === 0) return result;
  const companyIds = [...essentialsCompanyIds];

  // The 3 target catalog entries, resolved once by exact name -- a cheap,
  // catalog-sized query (not scoped to any company), not 3 separate
  // per-company lookups. 2 are plain Services; the Bundle is Autotask's
  // parallel ServiceBundle catalog (same real split Check Client's own
  // isBundle already documents).
  const [services, serviceBundles] = await Promise.all([
    listAll(client.services, [{ op: 'contains', field: 'name', value: 'Kaseya 365' }]),
    listAll(client.serviceBundles, [{ op: 'contains', field: 'name', value: 'Kaseya 365' }]),
  ]);
  const endpointServiceId = services.find((s) => (s.name || '').trim().toLowerCase() === ENDPOINT_NAME)?.id ?? null;
  const userServiceId = services.find((s) => (s.name || '').trim().toLowerCase() === USER_NAME)?.id ?? null;
  const bundleServiceBundleId = serviceBundles.find((s) => (s.name || '').trim().toLowerCase() === BUNDLE_NAME)?.id ?? null;

  // Active contracts for just this report's own Essentials companies.
  const contracts = await fetchByFieldIn(client.contracts, 'companyID', companyIds, [{ op: 'eq', field: 'status', value: 1 }]);
  if (contracts.length === 0) return result;
  const contractById = new Map(contracts.map((c) => [c.id, c]));
  const contractIds = [...contractById.keys()];

  // The CURRENT unit period only (covers "right now") -- not the whole
  // period history and no "next period" lookup, unlike Check Client's own
  // Contract column. This page compares a CONTRACTED count against a LIVE
  // count as of right now, so today's own period is the correct one to
  // read, not a future period that hasn't started billing yet.
  const now = new Date().toISOString();
  const currentPeriodFilter = [
    { op: 'lte', field: 'startDate', value: now },
    { op: 'gte', field: 'endDate', value: now },
  ];
  const [serviceUnits, bundleUnits] = await Promise.all([
    endpointServiceId || userServiceId ? fetchByFieldIn(client.contractServiceUnits, 'contractID', contractIds, currentPeriodFilter) : [],
    bundleServiceBundleId ? fetchByFieldIn(client.contractServiceBundleUnits, 'contractID', contractIds, currentPeriodFilter) : [],
  ]);

  async function setLine(companyId, key, unitRow, contract) {
    if (!result.has(companyId)) result.set(companyId, { bundle: null, endpoint: null, user: null });
    result.get(companyId)[key] = { units: unitRow.units, contractName: contract.contractName, contractUrl: await getContractUrl(contract.id) };
  }

  for (const u of serviceUnits) {
    const contract = contractById.get(u.contractID);
    if (!contract) continue;
    if (u.serviceID === endpointServiceId) await setLine(contract.companyID, 'endpoint', u, contract);
    else if (u.serviceID === userServiceId) await setLine(contract.companyID, 'user', u, contract);
  }
  for (const u of bundleUnits) {
    if (u.serviceBundleID !== bundleServiceBundleId) continue;
    const contract = contractById.get(u.contractID);
    if (!contract) continue;
    await setLine(contract.companyID, 'bundle', u, contract);
  }
  return result;
}

// Workstation (Desktop + Laptop only -- NOT servers/network gear, unlike
// Check Client's own D* which sums all 4 Datto device categories) counts
// per Essentials company, via the real company<->Datto-site resolution RMM
// Filters already proved out live (native PSA link by site UID, then the
// "Name:Datto RMM" UDF, then an exact name match -- see
// rmmFilters.resolveCompanyForSite()'s own header comment).
async function buildWorkstationCounts(client, essentialsCompanyIds) {
  if (!dattoRmm.hasDattoCredentials()) return { connected: false, byCompanyId: new Map() };

  const [allDevices, allSites, allCompanies, udfValueToCompanyName] = await Promise.all([
    dattoRmm.getAllDevices(),
    dattoRmm.getAllSites(),
    // Every company, any status/type -- resolveCompanyForSite() needs the
    // FULL set to resolve a native PSA link or UDF value correctly, same
    // reasoning RMM Filters' own identical fetch already documents (a
    // narrower, Essentials-only set would silently fail to resolve a site
    // whose PSA link or UDF points at a company outside that narrower set).
    listAll(client.companies, [{ op: 'gte', field: 'id', value: 0 }]),
    getCompanyUdfValueToNameMap(client, 'Name:Datto RMM'),
  ]);

  const companyById = new Map(allCompanies.map((c) => [c.id, c]));
  const companyByLowerName = new Map(allCompanies.map((c) => [rmmFilters.normalizeName(c.companyName), c]));
  const psaCompanyIdBySiteUid = new Map(allSites.filter((s) => s.autotaskCompanyId != null).map((s) => [s.uid, s.autotaskCompanyId]));

  // devices: hostname/lastUser/lastSeen/online for each matched device, by
  // request (hover detail on the Workstations column) -- purely additive
  // bookkeeping over data getAllDevices() already pulled for the count
  // above, no extra Datto RMM calls.
  const byCompanyId = new Map(); // companyId -> { count, sites: Set<string>, devices: [] }
  for (const d of allDevices) {
    if (d.deviceType !== 'Desktop' && d.deviceType !== 'Laptop') continue;
    const siteName = (d.site || '').trim();
    if (!siteName) continue;
    const company = rmmFilters.resolveCompanyForSite(siteName, d.siteUid, psaCompanyIdBySiteUid, companyById, udfValueToCompanyName, companyByLowerName);
    if (!company || !essentialsCompanyIds.has(company.id)) continue;
    if (!byCompanyId.has(company.id)) byCompanyId.set(company.id, { count: 0, sites: new Set(), devices: [] });
    const entry = byCompanyId.get(company.id);
    entry.count += 1;
    entry.sites.add(siteName);
    entry.devices.push({ hostname: d.hostname, lastUser: d.lastUser, lastSeen: d.lastSeen, online: d.online });
  }
  for (const entry of byCompanyId.values()) {
    entry.sites = [...entry.sites].sort((a, b) => a.localeCompare(b));
    entry.devices.sort((a, b) => (a.hostname || '').localeCompare(b.hostname || ''));
  }
  return { connected: true, byCompanyId };
}

// Licensed user counts per Essentials company, via SaaS Alerts' own
// GET /reports/users?customerId=... (confirmed live this session) --
// "licensed users" here means exactly SaaS Alerts' own "Monitored Users"
// figure (billingUsers.count, the same number @dashboard/saasalerts-
// customers already shows -- confirmed live this session that it equals
// COUNT(isBillable === true) on this exact per-user endpoint), with the
// admin/break-glass exclusion above subtracted out of that same billable
// set, not out of some separately-defined count.
//
// Company<->SaaS-Alerts-customer matching uses the vendor's own `mappedToPSA`
// link (confirmed real, already used by @dashboard/saasalerts-customers) --
// an authoritative id-based match, not a name guess, so no fuzzy-matching
// fallback is needed here the way Datto RMM's own site-name matching needs
// one.
async function buildLicensedUserCounts(essentialsCompanyIds) {
  const customers = await saasAlerts.get('/reports/customers');

  const customerByCompanyId = new Map();
  for (const c of customers) {
    const mapping = (c.mappedToPSA || []).find((m) => m.product === 'autotaskpsa');
    if (!mapping) continue;
    const companyId = Number(mapping.mappedTo);
    if (essentialsCompanyIds.has(companyId)) customerByCompanyId.set(companyId, c);
  }

  const result = new Map(); // companyId -> { customerName, licensedUsers, includedNames, excludedCount, excludedNames }
  const nameOf = (u) => u.name || u.email || 'Unknown account';
  await mapWithConcurrency([...customerByCompanyId.entries()], 5, async ([companyId, customer]) => {
    try {
      const users = await saasAlerts.get('/reports/users', { customerId: customer.id });
      const billable = (Array.isArray(users) ? users : []).filter((u) => u.isBillable === true);
      const excluded = billable.filter(isExcludedAdminAccount);
      // The actual real NAMES of the included (non-excluded, billable)
      // users, by request (hover detail on the Licensed Users column) --
      // purely additive over data already fetched for the count above, no
      // extra SaaS Alerts call.
      const included = billable.filter((u) => !isExcludedAdminAccount(u));
      // "Unusual" exclusions -- by request, flagged (orange) when a client
      // has MORE excluded accounts than the normal, expected baseline: up
      // to 2 Break Glass accounts (the confirmed real "AIT Break Glass
      // 1"/"2" pair) and up to 1 admin account (O365Admin/M365Admin
      // collapsed into one category -- see classifyExcludedAccount()).
      // More than that isn't necessarily wrong, but it's a real deviation
      // from the normal pattern worth a second look (an extra admin
      // account nobody mentioned, a 3rd break-glass account, etc).
      const breakGlassCount = excluded.filter((u) => classifyExcludedAccount(u) === 'breakGlass').length;
      const adminCount = excluded.filter((u) => classifyExcludedAccount(u) === 'admin').length;
      result.set(companyId, {
        customerName: customer.name,
        licensedUsers: included.length,
        includedNames: included.map(nameOf).sort((a, b) => a.localeCompare(b)),
        excludedCount: excluded.length,
        excludedNames: excluded.map(nameOf).sort((a, b) => a.localeCompare(b)),
        excludedCountUnusual: breakGlassCount > 2 || adminCount > 1,
      });
    } catch (err) {
      // Left unresolved (no entry -> null licensedUsers downstream) rather
      // than guessing at a count -- same "never guess" convention Check
      // Client's own TC Calc column follows for a formula it can't resolve.
      console.error(`tc-essentials-seat-check: failed to fetch SaaS Alerts users for customer ${customer.id} (${customer.name}):`, err.message);
    }
  });
  return result;
}

async function buildReport() {
  const client = await getClient();

  const companies = await tcEliteServices.resolveCompaniesByClassification(client, CLASSIFICATION_LABEL);
  const essentialsCompanyIds = new Set(companies.map((c) => c.id));

  const [contractedByCompanyId, workstationResult, licensedUserByCompanyId] = await Promise.all([
    buildContractedUnits(client, essentialsCompanyIds),
    buildWorkstationCounts(client, essentialsCompanyIds),
    buildLicensedUserCounts(essentialsCompanyIds),
  ]);

  // One combined cell per line: the real contracted units (null when this
  // company has no such line at all -- but still compared against 0 for
  // mismatch purposes, since "should have a line and doesn't" is as real a
  // gap as "has the wrong count on one it does have"), the expected count,
  // and whether they disagree. `reconciled` starts false -- see
  // reconcileBundleExcess() below, applied once all 3 of a row's cells
  // exist.
  function cell(line, expected) {
    const contractedForCompare = line ? line.units : 0;
    return {
      contracted: line ? line.units : null,
      contractName: line ? line.contractName : null,
      contractUrl: line ? line.contractUrl : null,
      expected,
      mismatch: expected !== null && contractedForCompare !== expected,
      reconciled: false,
    };
  }

  // By request: a Bundle billed HIGHER than its own expected count isn't
  // necessarily wrong -- it's a real, legitimate alternative to splitting
  // the excess onto a separate stand-alone line, as long as the excess
  // lands exactly where that stand-alone line's own Expected says it
  // should (and that line has no contracted units of its own at all, i.e.
  // "None"). Example: Workstations=15, Licensed Users=10 -> Bundle expects
  // 10, Endpoint expects 5. A client billed Bundle=15/Endpoint=None instead
  // of Bundle=10/Endpoint=5 is billing the exact same real total, just
  // entirely through the Bundle line -- not a genuine discrepancy. Marks
  // BOTH the Bundle cell and the matching stand-alone cell `reconciled`
  // (rendered green, not red -- see client.js's lineCell()) rather than
  // silently clearing `mismatch`, so the raw "the numbers don't literally
  // match" fact stays in the data even though the combined total is fine.
  function reconcileBundleExcess(bundleCell, otherCell) {
    if (!bundleCell.mismatch || !otherCell.mismatch) return;
    if (bundleCell.expected === null || otherCell.expected === null) return;
    if (otherCell.contracted !== null) return; // otherCell must be "None" -- no contracted line of its own
    const excess = (bundleCell.contracted ?? 0) - bundleCell.expected;
    if (excess <= 0 || excess !== otherCell.expected) return;
    bundleCell.reconciled = true;
    otherCell.reconciled = true;
  }

  const rows = [];
  for (const company of companies) {
    const lines = contractedByCompanyId.get(company.id) || { bundle: null, endpoint: null, user: null };
    const workstationInfo = workstationResult.connected ? workstationResult.byCompanyId.get(company.id) || null : null;
    const licensedInfo = licensedUserByCompanyId.get(company.id) || null;

    const workstations = workstationInfo ? workstationInfo.count : null;
    const licensedUsers = licensedInfo ? licensedInfo.licensedUsers : null;
    const expected = expectedAllocation(workstations, licensedUsers);

    const bundleCell = cell(lines.bundle, expected.bundle);
    const endpointCell = cell(lines.endpoint, expected.endpoint);
    const userCell = cell(lines.user, expected.user);
    // At most one of Endpoint/User is ever the "excess" side (expectedAllocation()
    // never gives both a non-zero Expected at once), so only one of these
    // two calls can ever actually match.
    reconcileBundleExcess(bundleCell, endpointCell);
    reconcileBundleExcess(bundleCell, userCell);

    rows.push({
      companyId: company.id,
      companyName: company.companyName,
      companyUrl: await getCompanyUrl(company.id),
      hasParent: !!company.parentCompanyID,
      workstations,
      workstationSites: workstationInfo ? workstationInfo.sites : [],
      workstationDevices: workstationInfo ? workstationInfo.devices : [],
      licensedUsers,
      saasAlertsCustomerName: licensedInfo ? licensedInfo.customerName : null,
      includedAccountNames: licensedInfo ? licensedInfo.includedNames : [],
      excludedAccountCount: licensedInfo ? licensedInfo.excludedCount : 0,
      excludedAccountNames: licensedInfo ? licensedInfo.excludedNames : [],
      excludedAccountCountUnusual: licensedInfo ? licensedInfo.excludedCountUnusual : false,
      bundle: bundleCell,
      endpoint: endpointCell,
      user: userCell,
      // By request -- a Tech Cover Essentials client with NONE of the 3
      // Kaseya 365 lines on its contract at all (not just one missing, or
      // one with the wrong count) is a structural gap worth flagging at a
      // glance, regardless of what Expected says -- shaded at the whole
      // ROW level client-side (see client.js's own renderRow()), not just
      // the 3 individual cells.
      hasNoContractAtAll: bundleCell.contracted === null && endpointCell.contracted === null && userCell.contracted === null,
    });
  }
  rows.sort((a, b) => a.companyName.localeCompare(b.companyName));

  // A reconciled cell is deliberately excluded here -- it's a real,
  // legitimate billing structure once reconciled, not a gap left to fix.
  const isRealMismatch = (c) => c.mismatch && !c.reconciled;
  return {
    asOf: new Date().toISOString(),
    dattoConnected: workstationResult.connected,
    totalCount: rows.length,
    mismatchCount: rows.filter((r) => isRealMismatch(r.bundle) || isRealMismatch(r.endpoint) || isRealMismatch(r.user)).length,
    rows,
  };
}

// Same reasoning TC Services' own 10-minute cache gives -- a contract/
// device/license change should stop showing stale within the hour, not
// linger this dashboard's more usual 20-minute default, but this report is
// expensive enough (contracts/services + the whole Datto RMM device/site
// list + a per-matched-client SaaS Alerts users fetch, confirmed live at
// ~42s cold-cache for all 183 real Essentials companies) that it shouldn't
// re-run on every single page view either.
const CACHE_TTL_MS = 10 * 60 * 1000;
let cached = null; // { data, expiresAt }
let inFlight = null;

async function getReport(force) {
  if (!force && cached && Date.now() < cached.expiresAt) return cached.data;
  if (!inFlight) {
    inFlight = buildReport()
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
    const data = await getReport(req.query.force === 'true');
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Exposed for direct in-process reuse/testing, same convention
// @dashboard/contract-services' own router.buildReport already follows.
router.buildReport = buildReport;
router.buildContractedUnits = buildContractedUnits;

module.exports = router;
