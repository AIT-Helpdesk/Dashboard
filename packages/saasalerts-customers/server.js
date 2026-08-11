const express = require('express');
const { get } = require('@dashboard/saasalerts-client');
const { getCompanyUrl } = require('@dashboard/autotask-client');

async function buildReport() {
  const customers = await get('/reports/customers');

  const rows = [];
  for (const c of customers) {
    // SaaS Alerts links each customer back to its own PSA record when the
    // Autotask integration is configured -- `mappedToPSA` can carry several
    // entries (only "autotaskpsa" is relevant here). Not every customer has
    // one (a SaaS Alerts customer with no matching Autotask company, or the
    // mapping just never done), so this is optional per row.
    const autotaskMapping = (c.mappedToPSA || []).find((m) => m.product === 'autotaskpsa');
    rows.push({
      id: c.id,
      name: c.name,
      domain: c.customerDomain || null,
      status: c.status,
      products: (c.products || []).map((p) => p.name),
      // The number of users SaaS Alerts is actively monitoring/billing for
      // this customer -- not a license SKU count (that's `products[].licenseDetails`,
      // the M365/Workspace plan names, shown separately).
      monitoredUsers: c.billingUsers?.count ?? null,
      autotaskCompanyId: autotaskMapping ? autotaskMapping.mappedTo : null,
      autotaskUrl: autotaskMapping ? await getCompanyUrl(autotaskMapping.mappedTo) : null,
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));

  return {
    asOf: new Date().toISOString(),
    totalCount: rows.length,
    customers: rows,
  };
}

// Whole list is cheap (one API call, no per-customer detail lookups needed),
// same rationale as CSP Customers -- auto-loads and doesn't need the
// on-demand per-row pattern Ingram Subscriptions uses for its license counts.
const CACHE_TTL_MS = 20 * 60 * 1000;
let cache = null; // { data, expiresAt }
let inFlight = null;

async function getCustomers(force) {
  if (!force && cache && Date.now() < cache.expiresAt) return cache.data;
  if (!inFlight) {
    inFlight = buildReport()
      .then((data) => {
        cache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
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
    const data = await getCustomers(req.query.force === 'true');
    res.json(data);
  } catch (err) {
    console.error(err);
    const detail = err.response ? `SaaS Alerts API returned HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    res.status(500).json({ error: detail });
  }
});

module.exports = router;
