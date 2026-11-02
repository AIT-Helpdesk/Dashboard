const axios = require('axios');

// Huntress's own REST API -- confirmed live against the real account: HTTP
// Basic Auth with a user-level API key/secret pair (Huntress portal -> the
// signed-in user's own API Credentials section -> create one; the key
// starts "hk_", the secret "hs_" and is shown only once -- the older
// account-level key is deprecated/read-only per Huntress's own docs, so
// this must be a user-level one), base host https://api.huntress.io/v1.
// GET /organizations?page=&limit= is the organization (= client) list --
// confirmed live: 44 real rows, one page at limit=500 covers all of them.
const { HUNTRESS_API_KEY: KEY, HUNTRESS_API_SECRET: SECRET } = process.env;
const BASE = 'https://api.huntress.io/v1';

function hasHuntressCredentials() {
  return Boolean((KEY || '').trim() && (SECRET || '').trim());
}

async function huntressGet(path, params) {
  const res = await axios.get(`${BASE}${path}`, {
    auth: { username: KEY, password: SECRET },
    headers: { Accept: 'application/json' },
    params,
  });
  return res.data;
}

// Walks `page`/`limit` until every organization is collected, guarded by
// the response's own `pagination.total_count` -- confirmed live this is a
// small, whole-account list (44 real rows), same "small enough to just
// fetch whole" shape as every other vendor integration on this dashboard.
// Cached (20-min TTL, same convention as the rest of them).
const PAGE_SIZE = 500; // comfortably above the confirmed real total; still paginates correctly if the account grows past it
const CACHE_TTL_MS = 20 * 60 * 1000;
let cache = null; // { organizations, expiresAt }
let inFlight = null;

async function fetchAllOrganizations() {
  const items = [];
  let page = 1;
  while (true) {
    const data = await huntressGet('/organizations', { page, limit: PAGE_SIZE });
    items.push(...(data.organizations || []));
    const total = data.pagination?.total_count ?? items.length;
    if (items.length >= total || !data.organizations || data.organizations.length === 0) break;
    page += 1;
  }
  return items;
}

async function getOrganizations(force) {
  if (!force && cache && Date.now() < cache.expiresAt) return cache.organizations;
  if (!inFlight) {
    inFlight = fetchAllOrganizations()
      .then((organizations) => {
        cache = { organizations, expiresAt: Date.now() + CACHE_TTL_MS };
        return organizations;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

// Same &/and-normalize + bidirectional-contains matching every other
// cross-vendor name lookup on this dashboard uses (see
// @dashboard/saas-protection's own findDomainMatch() for the full
// reasoning) -- confirmed live against real names ("G & H Civil
// Contractors", "Kraftur Pty Ltd", "Back 2 Basics" all matched cleanly).
function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\s*&\s*/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function findOrganizationMatch(companyName, force) {
  const organizations = await getOrganizations(force);
  const normCompany = normalize(companyName);
  if (!normCompany) return null;
  const pool = organizations.filter((o) => {
    const n = normalize(o.name);
    if (!n) return false;
    return n === normCompany || n.includes(normCompany) || normCompany.includes(n);
  });
  return pool.length === 1 ? pool[0] : null;
}

module.exports = { hasHuntressCredentials, getOrganizations, findOrganizationMatch };
