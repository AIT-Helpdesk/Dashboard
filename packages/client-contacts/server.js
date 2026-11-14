const express = require('express');
const { getClient, listAll, getCompanyUrl, parseWildcard, matchesWildcard, getPicklistLabels, fetchByFieldIn } = require('@dashboard/autotask-client');

// Companies.isActive is a boolean, but Contracts has no such flag -- a
// contract-name match is used exactly as typed, with no implicit
// status/active restriction, matching the plain "a contract matching
// that name" wording of the request (not "an active contract").

const CONTACT_TYPES = new Set(['primary', 'billing', 'both', 'all']);

const router = express.Router();

router.get('/', async (req, res) => {
  const contactType = req.query.contactType;
  if (!CONTACT_TYPES.has(contactType)) {
    return res.status(400).json({ error: `Query param "contactType" must be one of: ${[...CONTACT_TYPES].join(', ')}.` });
  }
  const clientSearch = (req.query.client || '').trim();
  const contractSearch = (req.query.contract || '').trim();
  const classificationSearch = (req.query.classification || '').trim();
  const showInactive = req.query.showInactive === 'true';

  function emptyResponse() {
    return { contactType, client: clientSearch, contract: contractSearch, classification: classificationSearch, showInactive, totalCount: 0, contacts: [] };
  }

  try {
    const client = await getClient();

    // classification is a picklist field storing an integer code, not the
    // label typed into the search box -- resolve the field's label map
    // first, then match the wildcard against labels in JS (matchesWildcard()),
    // and fold the resulting set of matching codes into the Companies query as an
    // `in` filter.
    const classificationLabels = await getPicklistLabels(client.companies, 'classification');

    function matchingCodes(labels, term) {
      if (!term) return null; // null = no restriction on this field
      const codes = [];
      for (const [code, label] of labels) {
        if (matchesWildcard(label, term)) codes.push(code);
      }
      return codes;
    }

    const classificationCodes = matchingCodes(classificationLabels, classificationSearch);
    // A search term that matched zero labels (e.g. a typo) means zero companies
    // can possibly qualify -- short-circuit rather than sending a `classification in
    // []` filter, which some Autotask entities reject as invalid.
    if (classificationSearch && classificationCodes.length === 0) return res.json(emptyResponse());

    // Contracts.contractName is plain text (not a picklist) -- matched
    // directly against Contracts via the standard wildcard convention,
    // then narrowed down to the set of companies holding at least one
    // matching contract. A search term matching zero contracts means zero
    // companies can possibly qualify, same short-circuit as above.
    let contractCompanyIds = null; // null = no restriction on this field
    if (contractSearch) {
      const contractWildcard = parseWildcard(contractSearch);
      const matchingContracts = await listAll(client.contracts, [{ op: contractWildcard.op, field: 'contractName', value: contractWildcard.value }]);
      contractCompanyIds = [...new Set(matchingContracts.map((c) => c.companyID).filter((v) => v !== null && v !== undefined))];
      if (contractCompanyIds.length === 0) return res.json(emptyResponse());
    }

    // Active clients only, unless "Show Inactive Clients" is ticked -- Autotask's
    // query API requires at least one filter condition, so a true no-op filter
    // (same `id gte 0` convention used dashboard-wide, e.g. client-details/server.js's
    // own "Any Client" case) substitutes for `isActive` instead of an empty array.
    const companyFilter = showInactive ? [{ op: 'gte', field: 'id', value: 0 }] : [{ op: 'eq', field: 'isActive', value: true }];
    if (classificationCodes) companyFilter.push({ op: 'in', field: 'classification', value: classificationCodes });
    if (contractCompanyIds) companyFilter.push({ op: 'in', field: 'id', value: contractCompanyIds });
    const clientWildcard = parseWildcard(clientSearch);
    if (clientWildcard) companyFilter.push({ op: clientWildcard.op, field: 'companyName', value: clientWildcard.value });
    const companies = await listAll(client.companies, companyFilter);
    const companiesById = new Map(companies.map((c) => [c.id, c]));
    const companyIds = [...companiesById.keys()];
    if (companyIds.length === 0) return res.json(emptyResponse());

    // Contacts.isActive is an integer field (1/0), not a boolean, unlike
    // Companies.isActive.
    const activeFilter = { op: 'eq', field: 'isActive', value: 1 };

    // "All" means every active contact at a matching company, no flag filter at
    // all. "Both" means the union of primary-flagged and billing-flagged
    // contacts, not a contact that must be BOTH -- a contact appearing under
    // either flag is included once, not twice, even if it happens to carry both
    // flags for the same company.
    const contactSets = await Promise.all(
      contactType === 'all'
        ? [fetchByFieldIn(client.contacts, 'companyID', companyIds, [activeFilter])]
        : (contactType === 'both' ? ['primaryContact', 'billingContact'] : [contactType === 'primary' ? 'primaryContact' : 'billingContact']).map(
            (flag) => fetchByFieldIn(client.contacts, 'companyID', companyIds, [{ op: 'eq', field: flag, value: true }, activeFilter])
          )
    );
    const contactsById = new Map();
    for (const set of contactSets) {
      for (const c of set) {
        if (!contactsById.has(c.id)) contactsById.set(c.id, c);
      }
    }

    const rows = [];
    for (const c of contactsById.values()) {
      const company = companiesById.get(c.companyID);
      if (!company) continue; // scoped to companyIds above, so this shouldn't happen
      rows.push({
        companyId: company.id,
        companyName: company.companyName,
        companyUrl: await getCompanyUrl(company.id),
        contactId: c.id,
        firstName: c.firstName,
        lastName: c.lastName,
        email: c.emailAddress || null,
        phone: c.phone || null,
        mobilePhone: c.mobilePhone || null,
      });
    }
    rows.sort((a, b) => a.companyName.localeCompare(b.companyName) || a.lastName.localeCompare(b.lastName));

    res.json({
      contactType,
      client: clientSearch,
      contract: contractSearch,
      classification: classificationSearch,
      showInactive,
      totalCount: rows.length,
      contacts: rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// "Mark Inactive" (setting a contact's real Contacts.isActive to 0 from
// the Resolve Duplicates modal) was tried and removed -- confirmed live,
// with real HTTP responses from Autotask (not guesses), that this
// tenant's API rejects every conventional update shape for Contacts:
// PATCH/PUT at the standard /Contacts/{id} URL both 405 ("does not
// support http method"), and PATCH/PUT at the bare /Contacts collection
// with id in the body (the workaround that DOES work for Companies/
// Tickets/ServiceCalls elsewhere on this dashboard -- see data-matching/
// server.js's own Companies UDF write) both 404 (not a recognized route
// at all for this entity). A side-by-side control test in the same
// request/auth session confirmed PATCH to bare /Companies succeeds while
// the identical call to bare /Contacts fails, ruling out anything
// environmental -- this is a genuine, Contacts-specific gap in this
// tenant's REST API, despite Autotask's own entity documentation listing
// "Can Update: true". By request, removed rather than left broken; if
// Autotask API access/permissions are revisited later, this is the place
// to re-add it.

module.exports = router;
