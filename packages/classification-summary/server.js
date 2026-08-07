const express = require('express');
const { getClient, listAll, getCompanyUrl, getPicklistLabels } = require('@dashboard/autotask-client');

// companyType picklist codes (Autotask-wide, not org-specific config): 1 =
// Customer, 3 = Prospect -- same "clients" definition Client Details uses.
const CUSTOMER_OR_PROSPECT_TYPES = [1, 3];

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const client = await getClient();

    const [companies, classificationLabels] = await Promise.all([
      listAll(client.companies, [
        { op: 'eq', field: 'isActive', value: true },
        { op: 'in', field: 'companyType', value: CUSTOMER_OR_PROSPECT_TYPES },
      ]),
      getPicklistLabels(client.companies, 'classification'),
    ]);

    // Grouped by classification, WITH each group's company list attached -- the
    // whole point is that clicking a bar shows that group's clients with no
    // further request, so the list has to already be in this payload.
    const companiesByClassification = new Map(); // code (or null) -> Company[]
    for (const c of companies) {
      const key = c.classification ?? null;
      if (!companiesByClassification.has(key)) companiesByClassification.set(key, []);
      companiesByClassification.get(key).push(c);
    }

    const groups = [];
    for (const [code, group] of companiesByClassification) {
      const rows = [];
      for (const c of group) {
        rows.push({
          id: c.id,
          companyName: c.companyName,
          companyUrl: await getCompanyUrl(c.id),
          state: c.state || null,
          phone: c.phone || null,
        });
      }
      rows.sort((a, b) => a.companyName.localeCompare(b.companyName));
      groups.push({
        classification: code === null ? 'Unclassified' : classificationLabels.get(code) || `#${code}`,
        count: rows.length,
        companies: rows,
      });
    }
    groups.sort((a, b) => b.count - a.count || a.classification.localeCompare(b.classification));

    res.json({
      totalCount: companies.length,
      groups,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
