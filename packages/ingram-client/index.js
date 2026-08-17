const axios = require('axios');

// Ingram Micro Cloud Marketplace API (api.cloud.im) -- a wholly separate
// system from Autotask. Split out here (mirroring @dashboard/autotask-client)
// once a second page (Subscriptions Expiring, alongside Ingram Subscriptions)
// needed this same auth + pagination plumbing, rather than duplicating it.
const {
  INGRAM_CLOUD_API_BASE: BASE,
  INGRAM_CLOUD_USERNAME: USERNAME,
  INGRAM_CLOUD_PASSWORD: PASSWORD,
  INGRAM_CLOUD_SUBSCRIPTION_KEY: SUB_KEY,
  INGRAM_MARKETPLACE: MARKETPLACE,
} = process.env;

// Bearer token, cached in-process -- Ingram issues these valid for 1500s
// (25 min) and expects the caller to reuse one rather than re-authenticating
// per request. Refreshed 60s before actual expiry so a request that starts
// just before the cutoff doesn't get handed a token that dies mid-flight.
// Module-level (shared across every page that imports this package, not
// per-caller) since it's all the same Ingram account regardless of which
// dashboard page is asking.
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

// Single-subscription detail -- the one endpoint whose response isn't a
// paginated list (fetchAllPages doesn't apply), used for the per-subscription
// license/product lookups that only show up on this detail endpoint.
async function getSubscriptionDetail(id, token) {
  const res = await axios.get(`${BASE}/subscriptions/${id}`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Subscription-Key': SUB_KEY },
  });
  return res.data;
}

// Single-order detail -- same shape of "one detail endpoint beyond the list
// view" as getSubscriptionDetail above, used for the per-order product/PO
// number lookups (Ingram Orders) that only show up here, not on the list
// endpoint.
async function getOrderDetail(id, token) {
  const res = await axios.get(`${BASE}/orders/${id}`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Subscription-Key': SUB_KEY },
  });
  return res.data;
}

// One page (not walked to completion, unlike fetchAllPages) -- returns the
// raw { data, pagination } body so a caller can implement its own pagination
// logic, e.g. Ingram Orders' "stop once past the date threshold" early exit,
// which fetchAllPages' walk-everything behavior doesn't support.
async function getPage(path, token, extraParams = {}) {
  const headers = { Authorization: `Bearer ${token}`, 'X-Subscription-Key': SUB_KEY };
  const limit = 500;
  const res = await axios.get(`${BASE}${path}`, { headers, params: { ...extraParams, limit } });
  return res.data;
}

module.exports = { getToken, fetchAllPages, getSubscriptionDetail, getOrderDetail, getPage };
