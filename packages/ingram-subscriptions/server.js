const express = require('express');
const axios = require('axios');
// The one piece of @dashboard/autotask-client this page does use -- not for
// Autotask data (it has none), but to reuse the dashboard-wide wildcard
// convention (`*` prefix/suffix -> beginsWith/endsWith/contains) so "search
// for a client" behaves identically here as on every other page, rather than
// this page inventing its own slightly-different matching rules.
const { matchesWildcard } = require('@dashboard/autotask-client');

// Ingram Micro Cloud Marketplace API (api.cloud.im) -- a wholly separate
// system from Autotask, so this page owns its own small client rather than
// reaching into @dashboard/autotask-client for API access. If a second page
// ever needs this API too, this is the point to promote it into a shared
// package the same way @dashboard/autotask-client got split out.
const {
  INGRAM_CLOUD_API_BASE: BASE,
  INGRAM_CLOUD_USERNAME: USERNAME,
  INGRAM_CLOUD_PASSWORD: PASSWORD,
  INGRAM_CLOUD_SUBSCRIPTION_KEY: SUB_KEY,
  INGRAM_MARKETPLACE: MARKETPLACE,
} = process.env;

// Subscription NAME patterns excluded from this page entirely, by request --
// wildcard convention same as the client-name filter (matchesWildcard()).
const EXCLUDED_NAME_PATTERNS = ['Windows 11 Home to Pro Upgrade *'];

// Bearer token, cached in-process -- Ingram issues these valid for 1500s
// (25 min) and expects the caller to reuse one rather than re-authenticating
// per request. Refreshed 60s before actual expiry so a request that starts
// just before the cutoff doesn't get handed a token that dies mid-flight.
let tokenCache = null; // { token, expiresAt }
async function getToken() {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const res = await axios.post(
    `${BASE}/token`,
    { marketplace: MARKETPLACE },
    {
      headers: {
        Authorization: `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}`,
        'X-Subscription-Key': SUB_KEY,
        'Content-Type': 'application/json',
      },
    }
  );
  tokenCache = { token: res.data.token, expiresAt: Date.now() + (res.data.expiresInSeconds - 60) * 1000 };
  return tokenCache.token;
}

// Ingram paginates every list endpoint via offset/limit + a `pagination.total`
// in the response body (not a next-page cursor/URL) -- this walks pages at
// the max page size (500, confirmed against the real API) until `total` is
// covered. `extraParams` carries endpoint-specific filters, e.g. `status`.
async function fetchAllPages(path, token, extraParams = {}) {
  const headers = { Authorization: `Bearer ${token}`, 'X-Subscription-Key': SUB_KEY };
  const limit = 500;
  let offset = 0;
  const all = [];
  for (;;) {
    const res = await axios.get(`${BASE}${path}`, { headers, params: { ...extraParams, limit, offset } });
    all.push(...res.data.data);
    offset += res.data.data.length;
    if (res.data.data.length === 0 || offset >= res.data.pagination.total) break;
  }
  return all;
}

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
    const res = await axios.get(`${BASE}/subscriptions/${id}`, {
      headers: { Authorization: `Bearer ${token}`, 'X-Subscription-Key': SUB_KEY },
    });
    const products = res.data.products || [];
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
async function buildReport(filterTerm) {
  const token = await getToken();

  // "Active and pending" by request. Ingram's `status` filter takes exactly
  // one value per request (a comma-separated list 400s -- confirmed against
  // the real API), so this is two requests, not one.
  const [activeSubs, pendingSubs, customers] = await Promise.all([
    fetchAllPages('/subscriptions', token, { status: 'active' }),
    fetchAllPages('/subscriptions', token, { status: 'pending' }),
    // Bulk customer list, not one GET /customers/{id} per subscription --
    // 2 requests for ~900 customers vs. one per subscription (500+).
    fetchAllPages('/customers', token),
  ]);
  const subscriptions = [...activeSubs, ...pendingSubs];
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
        activeCount: enrichedSubs.filter((s) => s.status === 'active').length,
        pendingCount: enrichedSubs.filter((s) => s.status === 'pending').length,
        subscriptions: enrichedSubs,
      };
    })
    .sort((a, b) => a.clientName.localeCompare(b.clientName));

  return {
    asOf: new Date().toISOString(),
    filterTerm: filterTerm || null,
    totalCount: matched.length,
    activeCount: matched.filter((s) => s.status === 'active').length,
    pendingCount: matched.filter((s) => s.status === 'pending').length,
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

function cacheKeyFor(filterTerm) {
  return (filterTerm || '').trim().toLowerCase();
}

async function getReport(filterTerm, force) {
  const key = cacheKeyFor(filterTerm);
  const cached = reportCacheByKey.get(key);
  if (!force && cached && Date.now() < cached.expiresAt) return cached.data;
  if (!inFlightByKey.has(key)) {
    const build = buildReport(filterTerm)
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
    const data = await getReport(req.query.client, req.query.force === 'true');
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
