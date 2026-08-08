const express = require('express');
const axios = require('axios');

// Microsoft Graph's /contracts endpoint -- a different, modern API from the
// legacy Partner Center REST API (api.partnercenter.microsoft.com), which
// this page deliberately does NOT use. Confirmed against the real account:
// Partner Center's own REST API returns a bare 403 on every call for an
// Indirect Reseller (Microsoft's own docs: "API access to Partner Center for
// indirect resellers isn't supported"), regardless of app registration,
// auth pattern (App+User or App-only), or permissions -- that's a hard
// platform restriction, not a config gap. Graph's /contracts, requiring only
// the Contract.Read.All application permission, works fine for this same
// account and returns exactly what's needed: each customer's display name
// and their Microsoft tenant ID (`customerId`).
const {
  CSP_CLIENT_ID: CLIENT_ID,
  CSP_CLIENT_SECRET: CLIENT_SECRET,
  CSP_TENANT_ID: TENANT_ID,
} = process.env;

// App-only Graph token, cached in-process -- v2.0 token endpoint,
// client_credentials grant, scope https://graph.microsoft.com/.default.
// Refreshed 60s before actual expiry so a request that starts just before
// the cutoff doesn't get handed a token that dies mid-flight.
let tokenCache = null; // { token, expiresAt }
async function getToken() {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const res = await axios.post(
    `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  tokenCache = { token: res.data.access_token, expiresAt: Date.now() + (res.data.expires_in - 60) * 1000 };
  return tokenCache.token;
}

// Graph paginates via a full @odata.nextLink URL in the response body (not
// offset/limit like Ingram's API) -- walk it until there isn't one.
// Confirmed against the real account: 374 contracts across 2 pages at
// $top=200.
async function fetchAllContracts(token) {
  let url = 'https://graph.microsoft.com/v1.0/contracts?$top=200';
  const all = [];
  while (url) {
    const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
    all.push(...res.data.value);
    url = res.data['@odata.nextLink'] || null;
  }
  return all;
}

// Whole list is cheap (2 Graph requests for the full ~374-customer set, no
// per-customer detail calls needed -- unlike Ingram's license counts), so
// unlike Ingram Subscriptions this auto-loads and doesn't need an on-demand
// per-row pattern. Still cached briefly since there's no reason to re-hit
// Graph on every page visit within a short window.
const CACHE_TTL_MS = 20 * 60 * 1000; // 20 min -- same convention as the other external-API pages on this dashboard
let cache = null; // { data, expiresAt }
let inFlight = null; // shared promise so concurrent cold-cache requests don't each kick off their own fetch

async function getCustomers(force) {
  if (!force && cache && Date.now() < cache.expiresAt) return cache.data;
  if (!inFlight) {
    inFlight = (async () => {
      const token = await getToken();
      const contracts = await fetchAllContracts(token);
      const data = {
        asOf: new Date().toISOString(),
        totalCount: contracts.length,
        // displayName has been seen with a leading space in real data (a
        // genuine Partner Center data quirk, not a parsing bug) -- trimmed
        // here rather than left for every consumer to notice and re-fix.
        customers: contracts
          .map((c) => ({ tenantId: c.customerId, name: (c.displayName || '').trim(), domain: c.defaultDomainName }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
      cache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
      return data;
    })().finally(() => {
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
    const detail = err.response ? `Graph API returned HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    res.status(500).json({ error: detail });
  }
});

module.exports = router;
