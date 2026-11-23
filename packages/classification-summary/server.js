const express = require('express');
const { getClient, listAll, getCompanyUrl, getPicklistLabels, fetchByFieldIn, matchesWildcard } = require('@dashboard/autotask-client');

// companyType picklist codes (Autotask-wide, not org-specific config): 1 =
// Customer, 3 = Prospect -- same "clients" definition Client Details uses.
const CUSTOMER_OR_PROSPECT_TYPES = [1, 3];

// Contracts.status -- confirmed live (@dashboard/contract-services' own
// buildActiveContracts() comment): 1 = "In Effect", 3 = "Terminated". Only
// in-effect contracts count for the Contract Name/Service tabs -- a client's
// historical/cancelled contract isn't something they currently HAVE.
const CONTRACT_STATUS_IN_EFFECT = 1;

// "Referrer Organisation" -- a real Companies UDF, confirmed live with
// actual data (468 of 1029 active companies have it set) -- read the same
// way every other Companies UDF on this dashboard is (c.userDefinedFields,
// included by default on every bulk list/query result, no special
// include-param needed -- see @dashboard/autotask-client's own
// getCompanyUdfValueToNameMap() comment for that same confirmed behaviour).
// NOT a field on Opportunities -- that was checked first and was a dead
// end (zero real usage across 2852 opportunities); this is the real one.
const REFERRER_UDF_NAME = 'Referrer Organisation';
function referrerOrganisation(company) {
  const udf = (company.userDefinedFields || []).find((u) => u.name === REFERRER_UDF_NAME);
  return udf?.value?.trim() || null;
}

const DIMENSIONS = new Set(['classification', 'marketSegment', 'referrer', 'contractName', 'service']);

function contactName(contact) {
  if (!contact) return null;
  return [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim() || null;
}

// Groups a plain value (classification/marketSegment/referrer) straight off
// each enriched row -- one group per distinct value, a company can only
// ever land in exactly one.
function groupByValue(rows, valueFn, noValueLabel) {
  const map = new Map();
  for (const row of rows) {
    const key = valueFn(row) || noValueLabel;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return [...map.entries()].map(([name, companies]) => ({ name, companies }));
}

// Groups by a MEMBERSHIP relation (a company can belong to several groups at
// once, e.g. holding 3 differently-named active contracts) -- `memberships`
// is a flat `{ companyId, key }[]`, deduplicated per group via a Set so a
// company with the same key from two different contracts/services only
// shows once in that group's own list.
function groupByMembership(enrichedByCompanyId, memberships) {
  const map = new Map(); // key -> Set<companyId>
  for (const { companyId, key } of memberships) {
    if (companyId == null || !key) continue;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(companyId);
  }
  return [...map.entries()].map(([name, companyIdSet]) => ({
    name,
    companies: [...companyIdSet].map((id) => enrichedByCompanyId.get(id)).filter(Boolean),
  }));
}

const router = express.Router();

router.get('/', async (req, res) => {
  const dimension = req.query.dimension || 'classification';
  if (!DIMENSIONS.has(dimension)) {
    return res.status(400).json({ error: `Query param "dimension" must be one of: ${[...DIMENSIONS].join(', ')}.` });
  }
  // Wildcard applied to the GROUP NAME, by request ("allow wildcard entry to
  // limit search or retrieve all") -- an empty q matches every group
  // (matchesWildcard()'s own "no term = always true" behaviour), so leaving
  // it blank is how "retrieve all" works, not a separate code path.
  const q = (req.query.q || '').trim();
  // "Show Inactive Clients" checkbox (default unticked) -- same query param
  // name and same "no isActive filter at all when ticked" convention
  // @dashboard/client-contacts' own server.js already uses.
  const showInactive = req.query.showInactive === 'true';
  // "No Contracts" checkbox (default unticked) -- by request, a flip
  // between the two, not a three-way "show everyone" state: unticked shows
  // only clients WITH an active contract (the page's own original
  // behaviour before this flag existed), ticked flips to clients with
  // ZERO active contracts (a data-hygiene/sales-opportunity view).
  const noContracts = req.query.noContracts === 'true';

  try {
    const client = await getClient();

    const companies = await listAll(client.companies, [
      ...(showInactive ? [] : [{ op: 'eq', field: 'isActive', value: true }]),
      { op: 'in', field: 'companyType', value: CUSTOMER_OR_PROSPECT_TYPES },
    ]);
    const companyIds = companies.map((c) => c.id);

    // Active (status 1, "In Effect") Contracts -- needed on EVERY dimension
    // now, by request, for the Contracts/Seats columns every tab's client
    // list shows, not just Contract Name/Service (which also GROUP by
    // these same contracts, see below).
    const contracts = await fetchByFieldIn(client.contracts, 'companyID', companyIds, [
      { op: 'eq', field: 'status', value: CONTRACT_STATUS_IN_EFFECT },
    ]);
    const contractCountByCompanyId = new Map();
    for (const ct of contracts) {
      contractCountByCompanyId.set(ct.companyID, (contractCountByCompanyId.get(ct.companyID) || 0) + 1);
    }

    // Apply the No Contracts flip BEFORE everything downstream (contacts,
    // enrichment, grouping) -- a filtered-out company never shows up
    // anywhere on the page, same "fetch the narrower set, not everyone"
    // reasoning Show Inactive's own companies query already follows.
    const filteredCompanies = companies.filter((c) => {
      const count = contractCountByCompanyId.get(c.id) || 0;
      return noContracts ? count === 0 : count > 0;
    });
    const filteredCompanyIds = filteredCompanies.map((c) => c.id);

    const [classificationLabels, marketSegmentLabels, primaryContacts] = await Promise.all([
      getPicklistLabels(client.companies, 'classification'),
      getPicklistLabels(client.companies, 'marketSegmentID'),
      // Scoped to just the filtered companies (chunked `in` filter), same
      // "no need to fetch every contact account-wide" convention Client
      // Details' own server.js already uses for this exact lookup.
      fetchByFieldIn(client.contacts, 'companyID', filteredCompanyIds, [{ op: 'eq', field: 'primaryContact', value: true }]),
    ]);
    // A company could in theory have more than one contact flagged primary
    // (Autotask doesn't enforce uniqueness) -- first one found wins, same
    // convention Client Details already follows.
    const primaryContactByCompanyId = new Map();
    for (const c of primaryContacts) {
      if (!primaryContactByCompanyId.has(c.companyID)) primaryContactByCompanyId.set(c.companyID, c);
    }

    // One shared, enriched row per active company -- the SAME 5 display
    // columns every tab's own client list shows (Client Name,
    // Classification, Market Segment, Primary Contact, Contracts), by
    // request, regardless of which dimension that tab is actually grouped
    // by.
    const enrichedByCompanyId = new Map();
    for (const c of filteredCompanies) {
      enrichedByCompanyId.set(c.id, {
        id: c.id,
        companyName: c.companyName,
        isActive: c.isActive !== false,
        companyUrl: await getCompanyUrl(c.id),
        classification: c.classification != null ? classificationLabels.get(c.classification) || `#${c.classification}` : null,
        marketSegment: c.marketSegmentID != null ? marketSegmentLabels.get(c.marketSegmentID) || `#${c.marketSegmentID}` : null,
        primaryContactName: contactName(primaryContactByCompanyId.get(c.id)),
        referrer: referrerOrganisation(c),
        contractCount: contractCountByCompanyId.get(c.id) || 0,
      });
    }
    const enrichedRows = [...enrichedByCompanyId.values()];

    let groups;
    if (dimension === 'classification') {
      groups = groupByValue(enrichedRows, (r) => r.classification, 'Unclassified');
    } else if (dimension === 'marketSegment') {
      groups = groupByValue(enrichedRows, (r) => r.marketSegment, 'No Market Segment');
    } else if (dimension === 'referrer') {
      groups = groupByValue(enrichedRows, (r) => r.referrer, 'No Referrer');
    } else if (dimension === 'contractName') {
      // When "No Contracts" is ticked, every remaining company has ZERO
      // active contracts by definition -- skip straight to an empty result
      // rather than doing the membership join just to produce nothing.
      groups = noContracts
        ? []
        : groupByMembership(
            enrichedByCompanyId,
            contracts.map((ct) => ({ companyId: ct.companyID, key: (ct.contractName || '').trim() || 'Unnamed Contract' }))
          );
    } else if (noContracts) {
      // Same reasoning as Contract Name above -- Service is also a
      // contract-membership dimension, so skip the ContractServices/
      // Services fetch entirely rather than doing it for a guaranteed-empty
      // result.
      groups = [];
    } else {
      const contractIds = [...new Set(contracts.map((ct) => ct.id))];
      const companyIdByContractId = new Map(contracts.map((ct) => [ct.id, ct.companyID]));
      const [contractServices, services] = await Promise.all([
        fetchByFieldIn(client.contractServices, 'contractID', contractIds),
        // Active services only, by request -- same convention @dashboard/
        // contract-services' own server.js already uses: a retired
        // service definition isn't something a client "currently has".
        listAll(client.services, [{ op: 'eq', field: 'isActive', value: true }]),
      ]);
      const serviceNameById = new Map(services.map((s) => [s.id, s.name]));
      const memberships = contractServices.map((cs) => ({
        companyId: companyIdByContractId.get(cs.contractID),
        key: serviceNameById.get(cs.serviceID),
      }));
      groups = groupByMembership(enrichedByCompanyId, memberships);
    }

    groups = groups.filter((g) => matchesWildcard(g.name, q));
    for (const g of groups) g.companies.sort((a, b) => a.companyName.localeCompare(b.companyName));
    groups.sort((a, b) => b.companies.length - a.companies.length || a.name.localeCompare(b.name));

    res.json({
      dimension,
      q,
      showInactive,
      noContracts,
      totalCompanies: filteredCompanies.length,
      groups: groups.map((g) => ({
        name: g.name,
        count: g.companies.length,
        companies: g.companies.map((c) => ({
          id: c.id,
          companyName: c.companyName,
          isActive: c.isActive,
          companyUrl: c.companyUrl,
          classification: c.classification,
          marketSegment: c.marketSegment,
          primaryContactName: c.primaryContactName,
          contractCount: c.contractCount,
        })),
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
