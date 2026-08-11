const express = require('express');
// The one piece of @dashboard/autotask-client this page does use -- not for
// Autotask data (it has none), but to reuse the dashboard-wide wildcard
// convention (`*` prefix/suffix -> beginsWith/endsWith/contains) so "search
// for a client" behaves identically here as on every other page, rather than
// this page inventing its own slightly-different matching rules.
const { matchesWildcard } = require('@dashboard/autotask-client');

// Ingram Micro Cloud Marketplace API (api.cloud.im) -- a wholly separate
// system from Autotask. Auth + pagination plumbing lives in
// @dashboard/ingram-client, shared with the Subscriptions Expiring page (the
// point at which this got promoted out of being this page's own private
// client, per the note that used to live here).
const { getToken, fetchAllPages, getSubscriptionDetail } = require('@dashboard/ingram-client');

// Subscription NAME patterns excluded from this page entirely, by request --
// wildcard convention same as the client-name filter (matchesWildcard()).
const EXCLUDED_NAME_PATTERNS = ['Windows 11 Home to Pro Upgrade *'];

// Confirmed against the real API: the list endpoint's rows don't carry
// license quantity, and there's no fields/include/expand param that adds it
// -- it only shows up in `products[].quantity` on the single-subscription
// detail endpoint (GET /subscriptions/{id}). So getting a license count per
// row means one detail request per subscription. Bounded concurrency (not
// unbounded, not fully sequential) -- 30-at-once was confirmed clean with
// zero failures against the real API, so 20 is a deliberately more
// conservative default rather than pushing that exact ceiling.
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

// Sums `products[].quantity` on a subscription's detail -- almost always one
// product per subscription in Ingram's NCE licensing model, but summed
// rather than assumed-single, in case a subscription line ever bundles more
// than one product. Falls back to null (rendered as blank, not 0) if every
// retry is exhausted or the subscription genuinely has no products, rather
// than silently reporting a wrong count.
//
// Retries on 429 with backoff -- confirmed against the real API that this
// endpoint's rate limit is a time-window budget, not a pure concurrency cap:
// a full run of 556 detail requests at concurrency 20 got 429'd on 362 of
// them, while an isolated 60-request burst run shortly after succeeded
// 60/60. So lowering concurrency alone doesn't fix it (a low-concurrency run
// long enough still exhausts the same time-window budget) -- what actually
// gets a complete, correct dataset is backing off and retrying the ones that
// get throttled, using the API's own Retry-After header when it sends one,
// exponential backoff with jitter otherwise.
async function fetchLicenseCount(id, token, attempt = 1) {
  const MAX_ATTEMPTS = 6;
  try {
    const detail = await getSubscriptionDetail(id, token);
    const products = detail.products || [];
    if (products.length === 0) return null;
    return products.reduce((sum, p) => sum + (p.quantity || 0), 0);
  } catch (err) {
    if (err.response?.status === 429 && attempt < MAX_ATTEMPTS) {
      const retryAfterHeader = err.response.headers['retry-after'];
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;
      const backoffMs = retryAfterMs ?? Math.min(1000 * 2 ** (attempt - 1), 15000) + Math.random() * 500;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      return fetchLicenseCount(id, token, attempt + 1);
    }
    console.error(`Failed to fetch license count for subscription ${id}:`, err.message);
    return null;
  }
}

// Builds the client/subscription list WITHOUT license counts -- by request,
// license count is no longer part of the base report at all. It's fetched
// per-client, on demand, only when that client's name is clicked (see the
// /licenses route below) -- so the base report only ever needs the two cheap
// list calls (+ the bulk customer list), never the slow one-detail-call-per-
// subscription work, regardless of how many clients/subscriptions match.
// `licenseCount` is deliberately omitted from each subscription here (not
// set to null) so the client can tell "not fetched yet" apart from "fetched,
// turned out to be null" (a real result from the /licenses endpoint).
// "Active and pending" (the default) needs two requests -- Ingram's `status`
// filter takes exactly one value per request (a comma-separated list 400s --
// confirmed against the real API). "All" is the opposite case: confirmed
// that OMITTING `status` entirely returns every subscription regardless of
// status (active, pending, hold, terminated, removed) in one paginated set
// -- cheaper than the default case, not more expensive, since it's one
// list-endpoint pass instead of two.
async function fetchSubscriptions(token, allStatuses) {
  if (allStatuses) return fetchAllPages('/subscriptions', token, {});
  const [activeSubs, pendingSubs] = await Promise.all([
    fetchAllPages('/subscriptions', token, { status: 'active' }),
    fetchAllPages('/subscriptions', token, { status: 'pending' }),
  ]);
  return [...activeSubs, ...pendingSubs];
}

async function buildReport(filterTerm, allStatuses) {
  const token = await getToken();

  const [subscriptions, customers] = await Promise.all([
    fetchSubscriptions(token, allStatuses),
    // Bulk customer list, not one GET /customers/{id} per subscription --
    // 2 requests for ~900 customers vs. one per subscription (500+).
    fetchAllPages('/customers', token),
  ]);
  const customerNameById = new Map(customers.map((c) => [c.id, c.name]));

  const byClientMap = new Map();
  for (const s of subscriptions) {
    // Subscription line items excluded from this page entirely, by request
    // -- not meaningful recurring subscriptions to track (one-off upgrade
    // SKUs, not licensing), so they're dropped here, before grouping, rather
    // than just hidden client-side -- a client whose only subscription is an
    // excluded one doesn't show up as an empty group, and totals stay honest.
    if (EXCLUDED_NAME_PATTERNS.some((pattern) => matchesWildcard(s.name, pattern))) continue;
    const clientName = customerNameById.get(s.customerId) || `Customer #${s.customerId}`;
    if (filterTerm && !matchesWildcard(clientName, filterTerm)) continue;
    if (!byClientMap.has(s.customerId)) {
      byClientMap.set(s.customerId, { customerId: s.customerId, clientName, subscriptions: [] });
    }
    byClientMap.get(s.customerId).subscriptions.push(s);
  }

  const matched = [...byClientMap.values()].flatMap((g) => g.subscriptions);

  const byClient = [...byClientMap.values()]
    .map((g) => {
      const enrichedSubs = g.subscriptions
        .map((s) => ({
          id: s.id,
          name: s.name,
          status: s.status,
          // Both already present on the list-endpoint row -- no extra
          // request needed, unlike license count. `term` is how long the
          // subscription commitment runs (Ingram's `subscriptionPeriod`);
          // `billingPeriod` is how often it's actually invoiced -- these can
          // differ, e.g. a 1-year term billed monthly rather than prepaid.
          term: s.subscriptionPeriod || null,
          billingPeriod: s.billingPeriod || null,
          creationDate: s.creationDate || null,
          renewalDate: s.renewalDate || null,
          expirationDate: s.expirationDate || null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        customerId: g.customerId,
        clientName: g.clientName,
        count: enrichedSubs.length,
        subscriptions: enrichedSubs,
      };
    })
    .sort((a, b) => a.clientName.localeCompare(b.clientName));

  // Generic per-status breakdown rather than hardcoded active/pending counts
  // -- covers the "all statuses" case (hold, terminated, removed can all
  // show up) as well as the default one, with the same shape either way.
  const statusCounts = {};
  for (const s of matched) {
    statusCounts[s.status] = (statusCounts[s.status] || 0) + 1;
  }

  return {
    asOf: new Date().toISOString(),
    filterTerm: filterTerm || null,
    allStatuses: !!allStatuses,
    totalCount: matched.length,
    statusCounts,
    byClient,
  };
}

// Per-subscription license count, fetched on demand when a client's name is
// clicked -- cached per subscription ID (not per client) so re-clicking the
// same client, or a subscription that happens to reappear under a different
// search, doesn't redo work already done. Same 20-min TTL as the base report
// for consistency, though at this scale (a handful of subscriptions per
// click) it matters far less than it did when license counts were fetched
// for everyone up front.
const LICENSE_CACHE_TTL_MS = 20 * 60 * 1000;
const licenseCache = new Map(); // subscriptionId -> { count, expiresAt }

async function getLicenseCount(id, token) {
  const cached = licenseCache.get(id);
  if (cached && Date.now() < cached.expiresAt) return cached.count;
  const count = await fetchLicenseCount(id, token);
  licenseCache.set(id, { count, expiresAt: Date.now() + LICENSE_CACHE_TTL_MS });
  return count;
}

// Cached per filter term (an empty/no filter is its own key -- "every
// client", but no longer the expensive case now that license counts aren't
// part of this at all) rather than one single cache slot -- a repeated
// search for the same client is instant, while a different search does its
// own build. Refresh always sends `force=true`, which bypasses the cache for
// that key and rebuilds -- a button literally labeled "Refresh" should
// always get current data.
const REPORT_CACHE_TTL_MS = 20 * 60 * 1000; // 20 min -- long enough repeat searches within a session are cheap, short enough a workday doesn't go stale
const reportCacheByKey = new Map(); // key -> { data, expiresAt }
// Two requests landing for the SAME key while it's cold (e.g. two browser
// tabs both searching the same client) share ONE in-flight build rather than
// each kicking off their own fetch against Ingram.
const inFlightByKey = new Map(); // key -> Promise

function cacheKeyFor(filterTerm, allStatuses) {
  return `${(filterTerm || '').trim().toLowerCase()}|${allStatuses ? 'all' : 'default'}`;
}

async function getReport(filterTerm, allStatuses, force) {
  const key = cacheKeyFor(filterTerm, allStatuses);
  const cached = reportCacheByKey.get(key);
  if (!force && cached && Date.now() < cached.expiresAt) return cached.data;
  if (!inFlightByKey.has(key)) {
    const build = buildReport(filterTerm, allStatuses)
      .then((data) => {
        reportCacheByKey.set(key, { data, expiresAt: Date.now() + REPORT_CACHE_TTL_MS });
        return data;
      })
      .finally(() => {
        inFlightByKey.delete(key);
      });
    inFlightByKey.set(key, build);
  }
  return inFlightByKey.get(key);
}

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const data = await getReport(req.query.client, req.query.allStatuses === 'true', req.query.force === 'true');
    res.json(data);
  } catch (err) {
    console.error(err);
    const detail = err.response ? `Ingram API returned HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    res.status(500).json({ error: detail });
  }
});

// On-demand license counts for one client's subscriptions -- called when
// that client's name is clicked, not as part of the base report. The client
// already has the subscription IDs (from the base report's `subscriptions`
// arrays), so this just takes a comma-separated id list rather than
// re-deriving them server-side from a customerId, which would mean either
// re-fetching Ingram's subscription list (redundant -- the client already
// has this) or trusting a customerId Ingram's own filter support for hasn't
// been confirmed to handle.
router.get('/licenses', async (req, res) => {
  try {
    const ids = (req.query.ids || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    if (ids.length === 0) return res.json({ licenseCounts: {} });

    const token = await getToken();
    const counts = await mapWithConcurrency(ids, 20, (id) => getLicenseCount(id, token));
    res.json({ licenseCounts: Object.fromEntries(ids.map((id, i) => [id, counts[i]])) });
  } catch (err) {
    console.error(err);
    const detail = err.response ? `Ingram API returned HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    res.status(500).json({ error: detail });
  }
});

module.exports = router;
