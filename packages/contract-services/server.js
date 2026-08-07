const express = require('express');
const { getClient, mapWithConcurrency, resolveCompanyName, listAll, getContractUrl, parseWildcard, fetchByFieldIn } = require('@dashboard/autotask-client');


const router = express.Router();

router.get('/', async (req, res) => {
  const month = req.query.month;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'Query param "month" is required in YYYY-MM format.' });
  }
  const search = (req.query.search || '').trim();
  const clientSearch = (req.query.client || '').trim();

  const monthStart = `${month}-01T00:00:00.000Z`;
  const endDate = new Date(monthStart);
  endDate.setUTCMonth(endDate.getUTCMonth() + 1);
  const monthEnd = endDate.toISOString();

  try {
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
    const clientWildcard = parseWildcard(clientSearch);
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
      return res.json({ month, search, client: clientSearch, totalCount: 0, byCompany: [] });
    }
    const candidateContractIds = [...contractsById.keys()];

    const servicesById = new Map(services.map((s) => [s.id, s]));
    const serviceBundlesById = new Map(serviceBundles.map((s) => [s.id, s]));
    if (servicesById.size === 0 && serviceBundlesById.size === 0) {
      return res.json({ month, search, client: clientSearch, totalCount: 0, byCompany: [] });
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
        internalDescription: contractServiceBundle?.internalDescription || null,
        units: u.units,
        nextPeriodUnits: findNextPeriodBundleUnits(u.contractServiceBundleID, u.endDate),
        price: u.price,
        cost: u.cost,
        startDate: u.startDate,
        endDate: u.endDate,
        contractLastModified: contract.lastModifiedDateTime || null,
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

    res.json({
      month,
      search,
      client: clientSearch,
      totalCount: rows.length,
      byCompany,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;