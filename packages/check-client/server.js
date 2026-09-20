// Check Client -- a read-only, single-client rollup of three other pages'
// own data: Contract Checks (Ingram order review), Ingram Subscriptions
// (live Ingram license list), and Contract Services (Autotask billed
// contract lines). No new data of its own, no database -- every route here
// is a thin wrapper calling straight into the source page's own already-
// extracted report-building function (see each sibling package's server.js
// for the `router.<fn> = <fn>` lines this depends on), so results and
// caching behavior are always identical to visiting that page directly.
const express = require('express');
const axios = require('axios');
const { aestDayBoundsIso } = require('@dashboard/autotask-client');
const { getToken: getIngramToken, getSubscriptionDetail } = require('@dashboard/ingram-client');

const contractChecks = require('@dashboard/contract-checks/server.js');
const ingramSubscriptions = require('@dashboard/ingram-subscriptions/server.js');
const contractServices = require('@dashboard/contract-services/server.js');

// The only Contract Process Type that exists today -- same constant value
// Contract Checks' own sync.js exports as PROCESS_TYPE, kept as a plain
// literal here rather than requiring sync.js (which loads its own .env and
// has sync-job side effects this page has no reason to pull in).
const PROCESS_TYPE = 'ingram_subscription';

// Same .env-driven Rewst webhook convention Rewst Webhook Test/Match IDs
// both use (REWST_WEBHOOK_<Name>_URL) -- Get CSP Customers takes no input
// fields. Cached briefly (this page can trigger it on every search, unlike
// Match IDs' own hour-long report cache) so searching a few clients in a
// row within a few minutes doesn't re-hit Rewst for the full ~370-customer
// list every single time.
const REWST_CUSTOMERS_CACHE_TTL_MS = 5 * 60 * 1000;
let rewstCustomersCache = null; // { data, expiresAt }
async function fetchRewstCustomers() {
  if (rewstCustomersCache && Date.now() < rewstCustomersCache.expiresAt) return rewstCustomersCache.data;
  const url = process.env.REWST_WEBHOOK_Get_CSP_Customers_URL;
  if (!url) throw new Error('REWST_WEBHOOK_Get_CSP_Customers_URL is not configured in .env.');
  const res = await axios.post(url, {}, { headers: { 'Content-Type': 'application/json' } });
  const data = res.data.Customers || res.data.customers || [];
  rewstCustomersCache = { data, expiresAt: Date.now() + REWST_CUSTOMERS_CACHE_TTL_MS };
  return data;
}

const router = express.Router();

// Section 1 -- Orders, via Contract Checks' own loadEnrichedItems +
// buildResponse. "Show everything for this client" (by request -- this is
// a full-picture lookup, not a working checklist) is expressed entirely
// through the includeAllRenewals/includeCancelled/showAllDone options
// below, same functions Contract Checks itself uses for its own "Show ALL
// Renewals" + "Show Cancelled" + "Show All Done" checkboxes all ticked at
// once, plus hideRenewalOrProcessingOnly left off.
router.get('/orders', async (req, res) => {
  const sinceDate = req.query.since;
  if (!sinceDate || !/^\d{4}-\d{2}-\d{2}$/.test(sinceDate)) {
    return res.status(400).json({ error: 'Query param "since" is required in YYYY-MM-DD format.' });
  }
  try {
    const startISO = aestDayBoundsIso(sinceDate).startISO;
    const filterTerm = (req.query.client || '').trim();
    const items = await contractChecks.loadEnrichedItems(PROCESS_TYPE, startISO);
    const { totalCount, statusCounts, byClient } = contractChecks.buildResponse(items, {
      filterTerm,
      includeAllRenewals: true,
      includeCancelled: true,
      showAllDone: true,
      hideRenewalOrProcessingOnly: false,
    });
    // Same Rewst - Stage Done icon flag and ticket-details enrichment
    // (createDate -- drives the "?" date-mismatch icon) Contract Checks'
    // own page shows, by request -- this route bypasses that page's own
    // GET / route (where they normally run), so both have to be called
    // here too. Run together, not sequentially -- same reasoning as that
    // route's own Promise.all.
    const visibleOrders = byClient.flatMap((g) => g.orders);
    await Promise.all([contractChecks.attachRewstStageDoneFlags(visibleOrders), contractChecks.attachTicketDetails(visibleOrders)]);
    res.json({ sinceDate, filterTerm: filterTerm || null, totalCount, statusCounts, byClient });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Section 2 -- Subscriptions, via Ingram Subscriptions' own getReport().
// No subscription-name filter, "All Statuses" hardcoded off (active +
// pending only) -- both by request ("No other search criteria" /
// "'All Statuses' off").
router.get('/subscriptions', async (req, res) => {
  try {
    const filterTerm = (req.query.client || '').trim();
    const data = await ingramSubscriptions.getReport(filterTerm, '', false, false);
    res.json(data);
  } catch (err) {
    console.error(err);
    const detail = err.response ? `Ingram API returned HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    res.status(500).json({ error: detail });
  }
});

// Section 3 (between Subscriptions and Contracts on the page, by request) --
// Microsoft 365 Tenancy. PRIMARY path: the client's real Microsoft tenant
// ID (Ingram's own subscription DETAIL endpoint carries it under
// fulfillmentParameters as ms_customer_id -- confirmed elsewhere this
// session, live, to be the actual MS tenant id, not a Rewst-internal one)
// joined against Rewst's OWN tenant_id field for an EXACT match, by request
// ("use the Tenant ID from Ingram Micro... is that a better choice?") --
// an exact GUID join can't misfire the way name matching sometimes does
// (e.g. "Sleepys" vs "Sleepy's Pty Ltd", worked around on Match IDs with an
// apostrophe-stripping fix; simply doesn't come up here). FALLBACK, by
// request ("if not found in Ingram Micro, only then try Rewst"): when
// there's no Microsoft-named Ingram subscription to read a tenant id off
// at all, or that tenant id doesn't match any real Rewst customer, fall
// back to the same name-matching cascade Match IDs' own cross-reference
// uses (matchRewstCustomerByName() below) -- lets this section still work
// for a client whose M365 licensing isn't tracked through Ingram at all.
// Either way, once the right Rewst customer is found, its OWN
// linked_organizations[0].id (Organisation ID -- a different, Rewst-
// internal identifier, not a Microsoft one) is what the Customer M365
// Licenses webhook itself needs.
function normalizeClientName(s) {
  return (s || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/\b(pty ltd|pty|ltd|inc|llc|co)\b/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
// Single best match only -- an ambiguous result (more than one candidate at
// a given stage) returns null rather than guessing, unlike Match IDs' own
// cascade (which surfaces ambiguous candidates for a human to pick from in
// its own list view -- there's no equivalent picker here, so showing the
// WRONG client's licenses by a bad guess would be worse than showing none).
function matchRewstCustomerByName(clientName, rewstCustomers) {
  const norm = normalizeClientName(clientName);
  if (!norm) return null;
  const stages = [
    (r) => normalizeClientName(r.company_name) === norm,
    (r) => (r.linked_organizations || []).some((o) => normalizeClientName(o.name) === norm),
    (r) => {
      const cn = normalizeClientName(r.company_name);
      return cn && (cn.includes(norm) || norm.includes(cn));
    },
    (r) => (r.linked_organizations || []).some((o) => {
      const on = normalizeClientName(o.name);
      return on && (on.includes(norm) || norm.includes(on));
    }),
  ];
  for (const stage of stages) {
    const candidates = rewstCustomers.filter(stage);
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) return null; // ambiguous -- don't guess
  }
  return null;
}

router.get('/m365-tenancy', async (req, res) => {
  const subscriptionId = (req.query.subscriptionId || '').trim();
  const clientName = (req.query.clientName || '').trim();
  if (!subscriptionId && !clientName) {
    return res.status(400).json({ error: 'subscriptionId and/or clientName is required.' });
  }
  try {
    let tenantId = null;
    if (subscriptionId) {
      const token = await getIngramToken();
      const detail = await getSubscriptionDetail(subscriptionId, token);
      const tenantParam = (detail.fulfillmentParameters || []).find((p) => p.name === 'ms_customer_id');
      tenantId = tenantParam && tenantParam.value ? tenantParam.value : null;
    }

    const rewstCustomers = await fetchRewstCustomers();
    let rewstCustomer = tenantId ? rewstCustomers.find((c) => c.tenant_id === tenantId) : null;
    let tenantSource = rewstCustomer ? 'ingram' : null;

    if (!rewstCustomer && clientName) {
      const nameMatch = matchRewstCustomerByName(clientName, rewstCustomers);
      if (nameMatch) {
        rewstCustomer = nameMatch;
        tenantId = nameMatch.tenant_id || tenantId;
        tenantSource = 'rewst-name-match';
      }
    }

    if (!rewstCustomer) {
      return res.json({ matched: false, tenantId, reason: 'no-rewst-customer' });
    }
    const org = (rewstCustomer.linked_organizations || [])[0];
    if (!org || !org.id) {
      return res.json({ matched: false, tenantId, rewstClientName: rewstCustomer.company_name, reason: 'no-organisation-id' });
    }

    const webhookUrl = process.env.REWST_WEBHOOK_Customer_M365_Licenses_URL;
    if (!webhookUrl) throw new Error('REWST_WEBHOOK_Customer_M365_Licenses_URL is not configured in .env.');
    const licensesRes = await axios.post(webhookUrl, { org_id: org.id }, { headers: { 'Content-Type': 'application/json' } });
    // Real confirmed shape (live-checked this session): the Rewst workflow
    // wraps Microsoft Graph's own GET /subscribedSkus response as
    // { subscribed_skus: { status_code, response, request, data: { value: [...] } } }.
    const skuRows = licensesRes.data?.subscribed_skus?.data?.value || [];
    const skus = skuRows
      .map((s) => ({
        // Real data carries a trailing zero-width space on some SKU names
        // (a genuine Graph/Rewst quirk, not a parsing bug) -- stripped here
        // so it doesn't render as an invisible stray character.
        sku: (s.skuPartNumber || '').replace(new RegExp('[\\u200B\\u200C\\u200D\\uFEFF]', 'g'), '').trim(),
        status: s.capabilityStatus || '',
        enabled: s.prepaidUnits?.enabled ?? null,
        consumed: s.consumedUnits ?? null,
        suspended: s.prepaidUnits?.suspended ?? null,
      }))
      .sort((a, b) => a.sku.localeCompare(b.sku));

    res.json({ matched: true, tenantId, tenantSource, rewstClientName: rewstCustomer.company_name, organisationId: org.id, skus });
  } catch (err) {
    console.error(err);
    const detail = err.response ? `Request failed: HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    res.status(500).json({ error: detail });
  }
});

// Section 4 -- Contract Services, via Contract Services' own buildReport().
// No service-name search -- just the client + month, by request. exactClient
// (by request -- the blank-label checkbox right after Autotask Client)
// forces an exact companyName match instead of the dashboard-wide wildcard/
// contains convention -- useful when the Autotask Client search itself
// resolves ambiguously (a name that's a substring of another real client).
router.get('/services', async (req, res) => {
  const month = req.query.month;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'Query param "month" is required in YYYY-MM format.' });
  }
  try {
    const filterTerm = (req.query.client || '').trim();
    const exactClient = req.query.exactClient === 'true';
    const data = await contractServices.buildReport(month, '', filterTerm, exactClient);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
