// Cross-references three separately-billed systems for every client with an
// active or pending Microsoft subscription through Ingram Micro:
//   - Ingram Micro's own customer/subscription IDs (source of truth for
//     licensing/billing)
//   - The real Microsoft 365 tenant ID for that client
//   - Rewst's own client record + Organisation ID (needed to pass into other
//     Rewst webhooks -- see the Rewst Webhook Test page's own comments for
//     why Organisation ID, not the top-level customer `id` or `csp_tenant_id`,
//     is the field that's actually useful here)
//
// The tenant ID is the one genuinely non-obvious part: Ingram's API never
// names a field "tenant" anywhere (list endpoint, subscription detail,
// customer endpoint -- confirmed live against all three), but the
// subscription DETAIL endpoint's `fulfillmentParameters` array carries one
// named `ms_customer_id`, which IS the real Microsoft tenant ID -- confirmed
// by cross-checking it against Rewst's own `tenant_id` field for two real
// clients and getting an identical GUID both times. Unlike Rewst's tenant_id
// (only known for clients Rewst also has a record for), this is available
// straight from Ingram for every client, matched or not.
const express = require('express');
const axios = require('axios');
const { getToken, fetchAllPages, getSubscriptionDetail } = require('@dashboard/ingram-client');

// Literal "Microsoft" in the subscription name -- same reading of "Microsoft
// subscription" the published Ingram x Rewst Matchup artifact's own subtitle
// uses, kept consistent here rather than widening to Windows 365/Teams-style
// names that don't literally say "Microsoft".
const MICROSOFT_NAME_RE = /microsoft/i;

// Same bounded-concurrency worker pool @dashboard/ingram-subscriptions uses
// for its own per-subscription detail calls.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Same retry-on-429-with-backoff shape as @dashboard/ingram-subscriptions'
// own fetchLicenseCount -- confirmed against the real API that this
// endpoint's rate limit is a time-window budget, not a concurrency cap, so
// backing off and retrying the throttled ones is what actually completes a
// full run cleanly.
async function fetchTenantId(subscriptionId, token, attempt = 1) {
  const MAX_ATTEMPTS = 6;
  try {
    const detail = await getSubscriptionDetail(subscriptionId, token);
    const param = (detail.fulfillmentParameters || []).find((p) => p.name === 'ms_customer_id');
    return param && param.value ? param.value : null;
  } catch (err) {
    if (err.response?.status === 429 && attempt < MAX_ATTEMPTS) {
      const retryAfterHeader = err.response.headers['retry-after'];
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;
      const backoffMs = retryAfterMs ?? Math.min(1000 * 2 ** (attempt - 1), 15000) + Math.random() * 500;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      return fetchTenantId(subscriptionId, token, attempt + 1);
    }
    console.error(`Match IDs: failed to fetch tenant id for subscription ${subscriptionId}:`, err.message);
    return null;
  }
}

// Same .env-driven Rewst webhook convention the Rewst Webhook Test page
// uses (REWST_WEBHOOK_<Name>_URL) -- called directly here (this page needs
// exactly one fixed webhook, not a dynamic dropdown of whatever's in .env),
// with no input fields (Get CSP Customers takes none).
async function fetchRewstCustomers() {
  const url = process.env.REWST_WEBHOOK_Get_CSP_Customers_URL;
  if (!url) throw new Error('REWST_WEBHOOK_Get_CSP_Customers_URL is not configured in .env.');
  const res = await axios.post(url, {}, { headers: { 'Content-Type': 'application/json' } });
  return res.data.Customers || res.data.customers || [];
}

function normalizeName(s) {
  return (s || '')
    .toLowerCase()
    // Stripped outright (not collapsed to a space like other punctuation
    // below) -- confirmed live: Ingram's "Sleepys" and "Lawyerd" only match
    // Rewst's own "Sleepy's Pty Ltd" and "Lawyer'd" once the apostrophe is
    // gone entirely ("sleepys" vs "sleepys"), not turned into a space
    // ("sleepys" vs "sleepy s", which never matches).
    .replace(/['’]/g, '')
    .replace(/\b(pty ltd|pty|ltd|inc|llc|co)\b/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Four-stage cascade matching an Ingram client name against Rewst's own
// customer records -- confirmed against real data while building the
// original one-off Ingram x Rewst Matchup artifact: exact company_name,
// exact linked_organizations[].name, then fuzzy substring (either
// direction) on each, in that order, first stage with exactly one candidate
// wins. Multiple simultaneous candidates at any stage are flagged
// "ambiguous" (with each candidate's own name/tenantId/orgId returned) so a
// human picks, rather than guessing.
function matchRewstCustomer(ingramName, rewstCustomers) {
  const norm = normalizeName(ingramName);
  if (!norm) return { bucket: 'none', qualityLabel: 'NO MATCH', rewstClientName: null, organisationId: null, candidates: null };

  function firstOrgId(r) {
    return (r.linked_organizations || [])[0]?.id || null;
  }
  function candidatesFor(pick) {
    const results = [];
    for (const r of rewstCustomers) {
      const picked = pick(r);
      if (picked) results.push({ rewstClientName: r.company_name, tenantId: r.tenant_id || null, organisationId: picked.id });
    }
    return results;
  }

  const stages = [
    { pick: (r) => (normalizeName(r.company_name) === norm ? { id: firstOrgId(r) } : null), bucket: 'exact', label: 'exact' },
    {
      pick: (r) => {
        const org = (r.linked_organizations || []).find((o) => normalizeName(o.name) === norm);
        return org ? { id: org.id } : null;
      },
      bucket: 'exact',
      label: 'exact (matched via linked org name)',
    },
    {
      pick: (r) => {
        const cn = normalizeName(r.company_name);
        return cn && (cn.includes(norm) || norm.includes(cn)) ? { id: firstOrgId(r) } : null;
      },
      bucket: 'fuzzy',
      label: 'fuzzy (name substring match)',
    },
    {
      pick: (r) => {
        const org = (r.linked_organizations || []).find((o) => {
          const on = normalizeName(o.name);
          return on && (on.includes(norm) || norm.includes(on));
        });
        return org ? { id: org.id } : null;
      },
      bucket: 'fuzzy',
      label: 'fuzzy (matched via linked org name)',
    },
  ];

  for (const stage of stages) {
    const candidates = candidatesFor(stage.pick);
    if (candidates.length === 1) {
      const c = candidates[0];
      return { bucket: stage.bucket, qualityLabel: stage.label, rewstClientName: c.rewstClientName, organisationId: c.organisationId, candidates: null };
    }
    if (candidates.length > 1) {
      return { bucket: 'ambiguous', qualityLabel: 'AMBIGUOUS', rewstClientName: null, organisationId: null, candidates };
    }
  }
  return { bucket: 'none', qualityLabel: 'NO MATCH', rewstClientName: null, organisationId: null, candidates: null };
}

async function buildReport() {
  const token = await getToken();

  const [activeSubs, pendingSubs, customers, rewstCustomers] = await Promise.all([
    fetchAllPages('/subscriptions', token, { status: 'active' }),
    fetchAllPages('/subscriptions', token, { status: 'pending' }),
    fetchAllPages('/customers', token),
    fetchRewstCustomers(),
  ]);
  const subscriptions = [...activeSubs, ...pendingSubs];
  const customerNameById = new Map(customers.map((c) => [c.id, c.name]));

  const msSubsByCustomer = new Map();
  for (const s of subscriptions) {
    if (!MICROSOFT_NAME_RE.test(s.name)) continue;
    if (!msSubsByCustomer.has(s.customerId)) msSubsByCustomer.set(s.customerId, []);
    msSubsByCustomer.get(s.customerId).push(s);
  }

  // One detail call per CLIENT, not per subscription -- ms_customer_id is
  // the same tenant regardless of which of that client's Microsoft
  // subscriptions it's read off, confirmed against real data (the trial
  // subscription checked earlier this session carried the same populated
  // ms_customer_id a non-trial one would).
  const customerIds = [...msSubsByCustomer.keys()];
  const tenantIds = await mapWithConcurrency(customerIds, 20, (customerId) => {
    const firstSub = msSubsByCustomer.get(customerId)[0];
    return fetchTenantId(firstSub.id, token);
  });

  const rows = customerIds
    .map((customerId, i) => {
      const clientName = customerNameById.get(customerId) || `Customer #${customerId}`;
      const match = matchRewstCustomer(clientName, rewstCustomers);
      return {
        ingramCustomerId: customerId,
        ingramClientName: clientName,
        subscriptionCount: msSubsByCustomer.get(customerId).length,
        tenantId: tenantIds[i],
        rewstClientName: match.rewstClientName,
        rewstOrganisationId: match.organisationId,
        matchBucket: match.bucket,
        matchQualityLabel: match.qualityLabel,
        matchCandidates: match.candidates,
      };
    })
    .sort((a, b) => a.ingramClientName.localeCompare(b.ingramClientName));

  const matchCounts = {};
  for (const r of rows) matchCounts[r.matchBucket] = (matchCounts[r.matchBucket] || 0) + 1;

  return { asOf: new Date().toISOString(), totalCount: rows.length, matchCounts, rows };
}

// Long TTL -- these ids rarely change, and a full build costs one Ingram
// detail call per client (150-250+ of them) plus one Rewst webhook call, not
// something to redo on every page visit. Same cache + in-flight-dedupe shape
// as @dashboard/ingram-subscriptions' own getReport().
const REPORT_CACHE_TTL_MS = 60 * 60 * 1000;
let cache = null;
let inFlight = null;

async function getReport(force) {
  if (!force && cache && Date.now() < cache.expiresAt) return cache.data;
  if (!inFlight) {
    inFlight = buildReport()
      .then((data) => {
        cache = { data, expiresAt: Date.now() + REPORT_CACHE_TTL_MS };
        return data;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

const router = express.Router();

// Same in-process-reuse convention @dashboard/ingram-subscriptions' own
// router.getReport already uses -- lets another page (or a diagnostic
// script) call this exact cached report-building function directly.
router.getReport = getReport;

router.get('/', async (req, res) => {
  try {
    const data = await getReport(req.query.force === 'true');
    res.json(data);
  } catch (err) {
    console.error(err);
    const detail = err.response ? `Request failed: HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    res.status(500).json({ error: detail });
  }
});

module.exports = router;
