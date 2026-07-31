const express = require('express');
const { getClient, mapWithConcurrency, resolveCompanyName, listAll } = require('@dashboard/autotask-client');

// Turns a search term into an Autotask filter op + value.
// '*' anchors the match: 'Email*' -> beginsWith, '*Email' -> endsWith,
// '*Email*' (or no stars at all) -> contains.
function parseWildcard(term) {
  if (!term) return null;
  const startsWithStar = term.startsWith('*');
  const endsWithStar = term.endsWith('*');
  let value = term;
  if (startsWithStar) value = value.slice(1);
  if (endsWithStar) value = value.slice(0, -1);
  value = value.trim();
  if (!value) return null;
  if (startsWithStar && endsWithStar) return { op: 'contains', value };
  if (endsWithStar) return { op: 'beginsWith', value };
  if (startsWithStar) return { op: 'endsWith', value };
  return { op: 'contains', value };
}


const router = express.Router();

router.get('/', async (req, res) => {
  const month = req.query.month;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'Query param "month" is required in YYYY-MM format.' });
  }
  const search = (req.query.search || '').trim();

  const monthStart = `${month}-01T00:00:00.000Z`;
  const endDate = new Date(monthStart);
  endDate.setUTCMonth(endDate.getUTCMonth() + 1);
  const monthEnd = endDate.toISOString();

  try {
    const client = await getClient();

    // Active contracts only (status 1 = Active).
    const contracts = await listAll(client.contracts, [{ op: 'eq', field: 'status', value: 1 }]);
    const contractsById = new Map(contracts.map((c) => [c.id, c]));
    if (contractsById.size === 0) {
      return res.json({ month, search, totalCount: 0, byCompany: [] });
    }

    // Active services, optionally narrowed by the wildcard search.
    const serviceFilter = [{ op: 'eq', field: 'isActive', value: true }];
    const wildcard = parseWildcard(search);
    if (wildcard) serviceFilter.push({ op: wildcard.op, field: 'name', value: wildcard.value });
    const services = await listAll(client.services, serviceFilter);
    const servicesById = new Map(services.map((s) => [s.id, s]));
    if (servicesById.size === 0) {
      return res.json({ month, search, totalCount: 0, byCompany: [] });
    }

    // Contract service units are Autotask's per-period record (start/end date + unit
    // count) for a service on a contract -- this is what "active for a billing period"
    // maps to. Only units whose period *starts* in the selected month, narrowed to
    // units belonging to an active contract and a matching, active service.
    const units = await listAll(client.contractServiceUnits, [
      { op: 'gte', field: 'startDate', value: monthStart },
      { op: 'lt', field: 'startDate', value: monthEnd },
    ]);

    const rows = units
      .filter((u) => contractsById.has(u.contractID) && servicesById.has(u.serviceID))
      .map((u) => {
        const contract = contractsById.get(u.contractID);
        const service = servicesById.get(u.serviceID);
        return {
          id: u.id,
          contractId: contract.id,
          contractName: contract.contractName,
          companyId: contract.companyID,
          serviceId: service.id,
          serviceName: service.name,
          units: u.units,
          price: u.price,
          startDate: u.startDate,
          endDate: u.endDate,
          // ContractServiceUnits has no modification timestamp of its own; this is
          // the closest thing Autotask exposes -- when the parent contract record
          // was last changed, not the line item itself.
          contractLastModified: contract.lastModifiedDateTime || null,
        };
      });

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
      .map((g) => ({ ...g, count: g.rows.length }))
      .sort((a, b) => a.companyName.localeCompare(b.companyName));

    res.json({
      month,
      search,
      totalCount: rows.length,
      byCompany,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;