const express = require('express');
const { getClient, listAll, getCompanyUrl, getPicklistLabels, resolveCompanyName, mapWithConcurrency } = require('@dashboard/autotask-client');

// companyType picklist codes (Autotask-wide, not org-specific config): 1 =
// Customer, 3 = Prospect -- same "clients" definition Client Details uses.
const CUSTOMER_OR_PROSPECT_TYPES = [1, 3];

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const client = await getClient();

    // parentCompanyID -- a real Autotask field (integer, references another
    // Company), confirmed via a live entityInformation/fields lookup. Pulled
    // in for the chart's own no-parent/has-parent split below; the field
    // list here doesn't otherwise restrict what listAll() returns (it
    // returns full company objects regardless), this is just documenting
    // which field this route additionally depends on now.
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
          // By request -- the chart splits each classification's bar into a
          // no-parent/has-parent stack, and the drilldown filters on this
          // same flag when a bar segment (rather than the row's own title)
          // is clicked. See CUSTOMER_OR_PROSPECT_TYPES comment above for why
          // parentCompanyID is queryable on every row here regardless of
          // whether listAll() was asked to select it explicitly.
          hasParent: !!c.parentCompanyID,
          // Resolved to a real name below, once every distinct parent id
          // across every group is known -- kept as the raw id for now.
          parentCompanyID: c.parentCompanyID || null,
        });
      }
      rows.sort((a, b) => a.companyName.localeCompare(b.companyName));
      const noParentCount = rows.filter((r) => !r.hasParent).length;
      groups.push({
        classification: code === null ? 'Unclassified' : classificationLabels.get(code) || `#${code}`,
        count: rows.length,
        noParentCount,
        parentCount: rows.length - noParentCount,
        companies: rows,
      });
    }
    groups.sort((a, b) => b.count - a.count || a.classification.localeCompare(b.classification));

    // Resolve every distinct parent company id (across every group at once,
    // not per-group) to its real name -- by request, shown as its own
    // "Parent Name" column in the drilldown. resolveCompanyName() caches
    // per id for the life of this server process, so most of these come
    // back instantly on a second load; mapWithConcurrency (bounded at 5,
    // same convention already used for per-ticket Autotask lookups
    // elsewhere on this dashboard) keeps a first cold load from bursting
    // Autotask's own rate limit if there are many distinct parents.
    const distinctParentIds = [...new Set(groups.flatMap((g) => g.companies.map((c) => c.parentCompanyID).filter(Boolean)))];
    const parentNamesById = new Map();
    await mapWithConcurrency(distinctParentIds, 5, async (id) => {
      parentNamesById.set(id, await resolveCompanyName(client, id));
    });
    for (const g of groups) {
      for (const c of g.companies) {
        c.parentCompanyName = c.parentCompanyID ? parentNamesById.get(c.parentCompanyID) || null : null;
        delete c.parentCompanyID; // the client only needs the resolved name, not the raw id
      }
    }

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
