const express = require('express');
const { getClient, listAll, getCompanyUrl, parseWildcard, matchesWildcard, getPicklistLabels, fetchByFieldIn } = require('@dashboard/autotask-client');

const CONTACT_TYPES = new Set(['primary', 'billing', 'both', 'all']);

const router = express.Router();

router.get('/', async (req, res) => {
  const contactType = req.query.contactType;
  if (!CONTACT_TYPES.has(contactType)) {
    return res.status(400).json({ error: `Query param "contactType" must be one of: ${[...CONTACT_TYPES].join(', ')}.` });
  }
  const clientSearch = (req.query.client || '').trim();
  const companyTypeSearch = (req.query.companyType || '').trim();
  const classificationSearch = (req.query.classification || '').trim();

  function emptyResponse() {
    return { contactType, client: clientSearch, companyType: companyTypeSearch, classification: classificationSearch, totalCount: 0, contacts: [] };
  }

  try {
    const client = await getClient();

    // companyType / classification are picklist fields storing an integer code,
    // not the label typed into the search box -- resolve the field's label map
    // first, then match the wildcard against labels in JS (matchesWildcard()),
    // and fold the resulting set of matching codes into the Companies query as an
    // `in` filter. Both label maps are fetched regardless of whether a search
    // term was given, since they're cached after the first request anyway.
    const [companyTypeLabels, classificationLabels] = await Promise.all([
      getPicklistLabels(client.companies, 'companyType'),
      getPicklistLabels(client.companies, 'classification'),
    ]);

    function matchingCodes(labels, term) {
      if (!term) return null; // null = no restriction on this field
      const codes = [];
      for (const [code, label] of labels) {
        if (matchesWildcard(label, term)) codes.push(code);
      }
      return codes;
    }

    const companyTypeCodes = matchingCodes(companyTypeLabels, companyTypeSearch);
    const classificationCodes = matchingCodes(classificationLabels, classificationSearch);
    // A search term that matched zero labels (e.g. a typo) means zero companies
    // can possibly qualify -- short-circuit rather than sending a `companyType in
    // []` filter, which some Autotask entities reject as invalid.
    if (companyTypeSearch && companyTypeCodes.length === 0) return res.json(emptyResponse());
    if (classificationSearch && classificationCodes.length === 0) return res.json(emptyResponse());

    // Active clients only, per request.
    const companyFilter = [{ op: 'eq', field: 'isActive', value: true }];
    if (companyTypeCodes) companyFilter.push({ op: 'in', field: 'companyType', value: companyTypeCodes });
    if (classificationCodes) companyFilter.push({ op: 'in', field: 'classification', value: classificationCodes });
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
        firstName: c.firstName,
        lastName: c.lastName,
        email: c.emailAddress || null,
      });
    }
    rows.sort((a, b) => a.companyName.localeCompare(b.companyName) || a.lastName.localeCompare(b.lastName));

    res.json({
      contactType,
      client: clientSearch,
      companyType: companyTypeSearch,
      classification: classificationSearch,
      totalCount: rows.length,
      contacts: rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
