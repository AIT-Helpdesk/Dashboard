const express = require('express');
const fs = require('fs');
const path = require('path');
const { getClient, mapWithConcurrency, resolveCompanyName, listAll, getContractUrl, parseWildcard, fetchByFieldIn, aestToUtcIso } = require('@dashboard/autotask-client');
const { isContractManager } = require('@dashboard/shell/contract-manager-permissions.js');


// Pulled out of GET / below into its own function, by request -- so the new
// Check Client page (packages/check-client) can call this exact same
// month-scoped contract-services fetch in-process (via router.buildReport,
// attached below) instead of duplicating it. Behavior/return shape is
// unchanged from when this lived inline in the route.
//
// `exactClient` (default false, not exposed on this page's own route --
// only Check Client's own /services route ever passes true, by request)
// forces an exact companyName match instead of the dashboard-wide
// wildcard/contains convention parseWildcard() applies by default.
async function buildReport(month, search, clientSearch, exactClient = false) {
  // AEST calendar month, not UTC -- see aestToUtcIso() in @dashboard/autotask-client.
  const [monthY, monthM] = month.split('-').map(Number);
  const monthStart = aestToUtcIso(monthY, monthM, 1);
  const monthEnd = aestToUtcIso(monthY, monthM + 1, 1);

  const client = await getClient();

  // Every lookup below that's scoped to a specific contract-ID set goes through
  // this (thin wrapper around the shared `fetchByFieldIn` chunker).
  async function fetchByContractIds(entity, contractIds, extraFilter = []) {
    return fetchByFieldIn(entity, 'contractID', contractIds, extraFilter);
  }

  const contractDateFilter = [
    { op: 'lt', field: 'startDate', value: monthEnd },
    { op: 'gte', field: 'endDate', value: monthStart },
  ];
  const clientWildcard = exactClient && clientSearch ? { op: 'eq', value: clientSearch } : parseWildcard(clientSearch);
  const wildcard = parseWildcard(search);

  // Contracts, Services, and Service Bundles don't depend on each other's
  // results, so they're fetched in parallel rather than one-after-another --
  // each Autotask API round trip carries its own latency regardless of how
  // small the result is, so 3 sequential calls cost roughly 3x one call even
  // when none of them return much data.
  async function resolveContracts() {
    if (clientWildcard) {
      // Resolve matching company IDs FIRST, then fold them into the Contracts
      // query itself (companyID `in` filter) rather than fetching every
      // contract in the business overlapping the month and filtering in JS
      // afterward -- with ~1,900 contracts overlapping a typical month
      // system-wide, that unscoped fetch dominated request time regardless of
      // how narrow the client filter was.
      const matchingCompanies = await listAll(client.companies, [
        { op: clientWildcard.op, field: 'companyName', value: clientWildcard.value },
      ]);
      const matchingCompanyIds = [...new Set(matchingCompanies.map((c) => c.id))];
      if (matchingCompanyIds.length === 0) return [];
      return fetchByFieldIn(client.contracts, 'companyID', matchingCompanyIds, contractDateFilter);
    }
    // Contracts whose date range covers the selected month -- NOT filtered by
    // status. A contract that's since been cancelled/terminated (status 0) but
    // was genuinely active during the selected month must still show for that
    // month; status reflects the contract's CURRENT state, not whether it was
    // valid back then. A truly void/never-billed contract is harmless to
    // include here anyway -- it only produces rows if real
    // ContractServiceUnits/BundleUnits exist for it, which they won't if
    // nothing was ever actually billed.
    return listAll(client.contracts, contractDateFilter);
  }

  // Active services/bundles, optionally narrowed by the wildcard search.
  // Service Bundles are a parallel catalog to Services -- a contract line can
  // be either a plain Service or a bundle of several. Autotask models them as
  // an entirely separate set of entities (ServiceBundles / ContractServiceBundles
  // / ContractServiceBundleUnits) that otherwise mirror Services / ContractServices
  // / ContractServiceUnits field-for-field, so both have to be queried and merged
  // -- a contract using bundles has ZERO rows in the plain Services entities.
  const serviceFilter = [{ op: 'eq', field: 'isActive', value: true }];
  if (wildcard) serviceFilter.push({ op: wildcard.op, field: 'name', value: wildcard.value });
  const bundleFilter = [{ op: 'eq', field: 'isActive', value: true }];
  if (wildcard) bundleFilter.push({ op: wildcard.op, field: 'name', value: wildcard.value });

  const [contracts, services, serviceBundles] = await Promise.all([
    resolveContracts(),
    listAll(client.services, serviceFilter),
    listAll(client.serviceBundles, bundleFilter),
  ]);

  const contractsById = new Map(contracts.map((c) => [c.id, c]));
  if (contractsById.size === 0) {
    return { month, search, client: clientSearch, totalCount: 0, byCompany: [] };
  }
  const candidateContractIds = [...contractsById.keys()];

  const servicesById = new Map(services.map((s) => [s.id, s]));
  const serviceBundlesById = new Map(serviceBundles.map((s) => [s.id, s]));
  if (servicesById.size === 0 && serviceBundlesById.size === 0) {
    return { month, search, client: clientSearch, totalCount: 0, byCompany: [] };
  }

  // Contract service units are Autotask's per-period record (start/end date + unit
  // count) for a service on a contract -- this is what "active for a billing period"
  // maps to. Fetch the full overlap superset (anything touching the selected month
  // at all), then narrow in JS to:
  //   - units whose period starts in the selected month (monthly services, and any
  //     longer-period service that happens to kick off this month), OR
  //   - units that started before the month and are still running (endDate >=
  //     monthStart), but ONLY if the period is longer than a month -- this is what
  //     picks up quarterly/semi-annual/annual contracts without also pulling in
  //     short monthly periods that merely spill over a day or two from last month.
  const MONTHLY_PERIOD_MAX_DAYS = 35; // comfortably above any single calendar month (28-31 days)
  function startsInMonth(u) {
    return u.startDate >= monthStart && u.startDate < monthEnd;
  }
  function isLongerThanAMonth(u) {
    const days = (new Date(u.endDate) - new Date(u.startDate)) / 86400000;
    return days > MONTHLY_PERIOD_MAX_DAYS;
  }

  // Scoped to the candidate contracts (already narrowed by the client filter, if
  // any) rather than fetched system-wide and filtered down in JS -- this is what
  // makes a client-filtered search fast instead of scanning every contract's
  // units in the whole Autotask instance regardless of the filter. The two
  // queries don't depend on each other, so they run in parallel.
  const unitDateFilter = [
    { op: 'lt', field: 'startDate', value: monthEnd },
    { op: 'gte', field: 'endDate', value: monthStart },
  ];
  const [candidateUnits, candidateBundleUnits] = await Promise.all([
    fetchByContractIds(client.contractServiceUnits, candidateContractIds, unitDateFilter),
    fetchByContractIds(client.contractServiceBundleUnits, candidateContractIds, unitDateFilter),
  ]);

  const units = candidateUnits.filter(
    (u) => startsInMonth(u) || (u.startDate < monthStart && isLongerThanAMonth(u))
  );
  const matchedUnits = units.filter(
    (u) => u.units > 0 && contractsById.has(u.contractID) && servicesById.has(u.serviceID)
  );

  const bundleUnits = candidateBundleUnits.filter(
    (u) => startsInMonth(u) || (u.startDate < monthStart && isLongerThanAMonth(u))
  );
  const matchedBundleUnits = bundleUnits.filter(
    (u) => u.units > 0 && contractsById.has(u.contractID) && serviceBundlesById.has(u.serviceBundleID)
  );

  const matchedContractIds = [...new Set(matchedUnits.map((u) => u.contractID))];
  const matchedBundleContractIds = [...new Set(matchedBundleUnits.map((u) => u.contractID))];

  function addOneDayISO(dateStr) {
    const d = new Date(dateStr);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString();
  }

  // Next-period units: the count as at one day after THIS LINE's own period end
  // (its renewal date), not a fixed calendar month -- a monthly service's period
  // ends a day before next month starts so this happens to line up with "next
  // month" for those, but an annual/quarterly line (e.g. a period of
  // 01/07/2026-30/06/2027) renews a year later, not next calendar month.
  //
  // Fetched by the exact contractServiceID / contractServiceBundleID (the units'
  // own foreign key) rather than contractID+serviceID -- a contract can carry
  // more than one line against the same underlying Service (e.g. a full-price
  // line and a separate "50% discount" credit line), which would otherwise
  // collide and mismatch one line's current units against a different line's
  // next-period units. Fetches each line's full period history (there are only
  // ever a handful of periods per line), then picks whichever period covers that
  // line's own renewal date in JS.
  //
  // ContractServices/ContractServiceBundles are the per-contract override of a
  // service's invoice text. Neither is uniquely keyed by (contractID, serviceID)
  // -- Autotask can carry multiple rows for the same pair (e.g. a leftover
  // one-time proration row alongside the ongoing recurring row), so join on the
  // units' own contractServiceID / contractServiceBundleID foreign key rather
  // than guessing which one is current.
  //
  // These four fetches only depend on matchedUnits/matchedBundleUnits, not on
  // each other, so they run in parallel.
  const matchedContractServiceIds = [...new Set(matchedUnits.map((u) => u.contractServiceID).filter((id) => id != null))];
  const matchedContractServiceBundleIds = [...new Set(matchedBundleUnits.map((u) => u.contractServiceBundleID).filter((id) => id != null))];

  const [allPeriods, allBundlePeriods, contractServices, contractServiceBundles] = await Promise.all([
    matchedContractServiceIds.length > 0
      ? fetchByFieldIn(client.contractServiceUnits, 'contractServiceID', matchedContractServiceIds)
      : [],
    matchedContractServiceBundleIds.length > 0
      ? fetchByFieldIn(client.contractServiceBundleUnits, 'contractServiceBundleID', matchedContractServiceBundleIds)
      : [],
    fetchByContractIds(client.contractServices, matchedContractIds),
    fetchByContractIds(client.contractServiceBundles, matchedBundleContractIds),
  ]);

  const nextPeriodUnitLookup = new Map(); // contractServiceID -> [{startDate, endDate, units}]
  for (const u of allPeriods) {
    if (!nextPeriodUnitLookup.has(u.contractServiceID)) nextPeriodUnitLookup.set(u.contractServiceID, []);
    nextPeriodUnitLookup.get(u.contractServiceID).push(u);
  }
  function findNextPeriodUnits(contractServiceID, currentEndDate) {
    if (contractServiceID == null) return null;
    const periods = nextPeriodUnitLookup.get(contractServiceID);
    if (!periods) return null;
    const target = addOneDayISO(currentEndDate);
    const period = periods.find((p) => p.startDate <= target && p.endDate >= target);
    return period ? period.units : null;
  }

  const nextPeriodBundleUnitLookup = new Map(); // contractServiceBundleID -> [{startDate, endDate, units}]
  for (const u of allBundlePeriods) {
    if (!nextPeriodBundleUnitLookup.has(u.contractServiceBundleID)) nextPeriodBundleUnitLookup.set(u.contractServiceBundleID, []);
    nextPeriodBundleUnitLookup.get(u.contractServiceBundleID).push(u);
  }
  function findNextPeriodBundleUnits(contractServiceBundleID, currentEndDate) {
    if (contractServiceBundleID == null) return null;
    const periods = nextPeriodBundleUnitLookup.get(contractServiceBundleID);
    if (!periods) return null;
    const target = addOneDayISO(currentEndDate);
    const period = periods.find((p) => p.startDate <= target && p.endDate >= target);
    return period ? period.units : null;
  }

  const contractServiceById = new Map(contractServices.map((cs) => [cs.id, cs]));
  const contractServiceBundleById = new Map(contractServiceBundles.map((cs) => [cs.id, cs]));

  const rows = [];
  for (const u of matchedUnits) {
    const contract = contractsById.get(u.contractID);
    const service = servicesById.get(u.serviceID);
    const contractService = contractServiceById.get(u.contractServiceID);
    rows.push({
      id: u.id,
      contractId: contract.id,
      contractName: contract.contractName,
      contractUrl: await getContractUrl(contract.id),
      companyId: contract.companyID,
      serviceId: service.id,
      // The per-contract invoice description override, if set, otherwise the
      // service's own standard invoice description.
      serviceName: contractService?.invoiceDescription || service.invoiceDescription || service.name,
      // The actual Autotask Service's own name -- NOT an invoice
      // description, which can be generic/shared across different services
      // billed the same way. Check Client's "adjust units" popup uses this
      // one (see adjustModalHeadingHtml() in check-client/client.js) so the
      // confirmation names the real item being changed, by request.
      serviceItemName: service.name,
      internalDescription: contractService?.internalDescription || null,
      units: u.units,
      nextPeriodUnits: findNextPeriodUnits(u.contractServiceID, u.endDate),
      price: u.price,
      cost: u.cost,
      startDate: u.startDate,
      endDate: u.endDate,
      // ContractServiceUnits has no modification timestamp of its own; this is
      // the closest thing Autotask exposes -- when the parent contract record
      // was last changed, not the line item itself.
      contractLastModified: contract.lastModifiedDateTime || null,
      // Exposed for Check Client's own "adjust units" feature (see
      // adjustUnits() below) -- this is the unit's own real FK, already read
      // internally above but not previously returned to any caller. isBundle
      // tells a caller which of contractServiceID/contractServiceBundleID
      // (this row's own vs. the sibling block below's) actually applies,
      // since both blocks feed the same flat `rows` array.
      contractServiceID: u.contractServiceID ?? null,
      contractServiceBundleID: null,
      isBundle: false,
    });
  }
  for (const u of matchedBundleUnits) {
    const contract = contractsById.get(u.contractID);
    const bundle = serviceBundlesById.get(u.serviceBundleID);
    const contractServiceBundle = contractServiceBundleById.get(u.contractServiceBundleID);
    rows.push({
      id: u.id,
      contractId: contract.id,
      contractName: contract.contractName,
      contractUrl: await getContractUrl(contract.id),
      companyId: contract.companyID,
      serviceId: bundle.id,
      serviceName: contractServiceBundle?.invoiceDescription || bundle.invoiceDescription || bundle.name,
      serviceItemName: bundle.name,
      internalDescription: contractServiceBundle?.internalDescription || null,
      units: u.units,
      nextPeriodUnits: findNextPeriodBundleUnits(u.contractServiceBundleID, u.endDate),
      price: u.price,
      cost: u.cost,
      startDate: u.startDate,
      endDate: u.endDate,
      contractLastModified: contract.lastModifiedDateTime || null,
      contractServiceID: null,
      contractServiceBundleID: u.contractServiceBundleID ?? null,
      isBundle: true,
    });
  }

  const uniqueCompanyIDs = [...new Set(rows.map((r) => r.companyId).filter((id) => id !== null && id !== undefined))];
  await mapWithConcurrency(uniqueCompanyIDs, 3, (id) => resolveCompanyName(client, id));
  for (const r of rows) {
    r.companyName = await resolveCompanyName(client, r.companyId);
  }

  const byCompanyMap = new Map();
  for (const r of rows) {
    const key = r.companyId ?? 'unknown';
    if (!byCompanyMap.has(key)) {
      byCompanyMap.set(key, { companyId: r.companyId, companyName: r.companyName, rows: [] });
    }
    byCompanyMap.get(key).rows.push(r);
  }
  const byCompany = [...byCompanyMap.values()]
    .map((g) => ({
      ...g,
      count: g.rows.length,
      rows: [...g.rows].sort((a, b) => a.contractName.localeCompare(b.contractName)),
    }))
    .sort((a, b) => a.companyName.localeCompare(b.companyName));

  return {
    month,
    search,
    client: clientSearch,
    totalCount: rows.length,
    byCompany,
  };
}

// Append-only audit trail, one JSON line per attempt (success AND
// failure) -- the ONLY durable record of what happened here, since
// Autotask's own ContractServiceAdjustments entity can never be queried
// back once created (confirmed against Autotask's own REST API docs: "It
// can only be created; it CANNOT be queried or updated."). logs/ matches
// this dashboard's existing gitignore convention for per-package runtime
// logs (see root .gitignore's own `*.log`/`logs/` lines).
const ADJUSTMENTS_LOG_PATH = path.join(__dirname, 'logs', 'adjustments.log');
function appendAdjustmentLog(entry) {
  try {
    fs.mkdirSync(path.dirname(ADJUSTMENTS_LOG_PATH), { recursive: true });
    fs.appendFileSync(ADJUSTMENTS_LOG_PATH, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch (err) {
    // Never let a logging failure block the real response -- the caller
    // already has the real outcome regardless of whether this write worked.
    console.error('contract-services: failed to write adjustments.log:', err.message);
  }
}

// Writes a real Autotask ContractServiceAdjustment (ContractServiceBundleAdjustment
// for a bundle line) -- Autotask's own dedicated entity for exactly this
// ("adjust a contract line's billed units, effective on a date"), confirmed
// against Autotask's own REST API docs: POST-only, `unitChange` is a
// SIGNED delta (not a new absolute total) -- Autotask itself creates/splits
// the underlying ContractServiceUnits period rows on the given
// effectiveDate, this function never touches those directly. No existing
// package in this codebase wrote to any Contract-family entity before this
// -- see this package's own README for the fuller "why" and the research
// this was built against. `adjustedUnitPrice`/`adjustedUnitCost` are
// deliberately never sent -- leaving them unset prices the adjustment at
// the line's own existing per-unit rate, which is what every real caller
// of this function wants (Check Client's own popup shows that computed
// rate to the user beforehand, it never invents a different one here).
async function adjustUnits({ contractId, serviceId, contractServiceID, contractServiceBundleID, isBundle, effectiveDate, unitChange }, actor) {
  const delta = Number(unitChange);
  if (!Number.isInteger(delta) || delta === 0) {
    throw { status: 400, message: 'unitChange must be a non-zero whole number.' };
  }
  if (!effectiveDate || Number.isNaN(new Date(effectiveDate).getTime())) {
    throw { status: 400, message: 'effectiveDate must be a valid date.' };
  }

  const client = await getClient();
  const logBase = {
    actorEmail: actor.email,
    actorName: actor.name,
    contractId,
    serviceId,
    contractServiceID,
    contractServiceBundleID,
    isBundle: !!isBundle,
    effectiveDate,
    unitChange: delta,
  };

  // contractServiceID/contractServiceBundleID (the unit's own FK) is
  // preferred when available -- the contractID+serviceID pair is Autotask's
  // own documented fallback, for the rare row where that FK came back null
  // (see contract-services/server.js's own buildReport(), which already
  // guards the same way when looking up next-period units).
  const idFields = isBundle
    ? contractServiceBundleID ? { contractServiceBundleID } : { contractID: contractId, serviceID: serviceId }
    : contractServiceID ? { contractServiceID } : { contractID: contractId, serviceID: serviceId };
  const body = { effectiveDate, unitChange: delta, ...idFields };

  try {
    const result = isBundle
      ? await client.contractServiceBundleAdjustments.create(body)
      : await client.contractServiceAdjustments.create(body);
    // Autotask's own real POST response shape is {itemId: <newId>} -- the
    // SDK's generic {item: ...} unwrapping (base.js) only applies when the
    // raw response itself carries an `item` key, which a create response
    // doesn't, so result.data here is Autotask's own raw body. Logged in
    // full either way so nothing is lost if this guess is ever wrong.
    const newId = result?.data?.itemId ?? result?.data?.item?.id ?? null;
    appendAdjustmentLog({ ...logBase, outcome: 'success', adjustmentId: newId, rawResponse: result?.data ?? null });
    return { id: newId };
  } catch (err) {
    const message = err.response ? `Autotask HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    appendAdjustmentLog({ ...logBase, outcome: 'failed', error: message });
    throw { status: 502, message: `Autotask rejected the adjustment: ${message}` };
  }
}

const router = express.Router();

router.get('/', async (req, res) => {
  const month = req.query.month;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'Query param "month" is required in YYYY-MM format.' });
  }
  const search = (req.query.search || '').trim();
  const clientSearch = (req.query.client || '').trim();

  try {
    const data = await buildReport(month, search, clientSearch);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Gated by Contract Manager (a SEPARATE, narrower list from the dashboard-
// wide admin gate -- see packages/shell/contract-manager-permissions.js's
// own comment for why), checked here too even though Check Client's own
// route already checks it before ever calling this in-process -- never
// trust a caller's own gate alone for a write this consequential.
router.post('/adjust-units', async (req, res) => {
  if (!isContractManager(req)) {
    return res.status(403).json({ error: 'Only a Contract Manager can adjust contract units.' });
  }
  try {
    const actor = { email: req.session.user.email, name: req.session.user.name };
    const result = await adjustUnits(req.body || {}, actor);
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Attached to the router (a function, so it can carry extra named
// properties) rather than changed on module.exports itself -- the shell
// still needs `require('./server.js')` to BE the router it mounts. Lets the
// new Check Client page (packages/check-client) call this exact same
// month-scoped report-building function in-process, instead of duplicating
// it. adjustUnits is exposed the same way, for that same page's own
// POST /services/adjust-units to delegate to in-process.
router.buildReport = buildReport;
router.adjustUnits = adjustUnits;

module.exports = router;
