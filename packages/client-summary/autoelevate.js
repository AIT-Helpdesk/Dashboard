const axios = require('axios');

// AutoElevate (CyberFOX)'s own Partner API (beta) -- confirmed live against
// the real account: Bearer auth (a key created on a user's own record in
// msp.autoelevate.com -- Users -> that user -> API Keys -> Add New,
// Scheme "Bearer"), base host https://partner-api.autoelevate.com, and
// every request needs the literal `X-Acknowledgment:
// i-understand-this-is-beta-and-may-change` header or it 400s (the API's
// own beta-acknowledgment gate). GET /api/v1/companies?take=&skip= is the
// company list (confirmed live: 44 real rows, one page covers all of
// them at take=200).
const { AUTOELEVATE_API_KEY: KEY } = process.env;
const BASE = 'https://partner-api.autoelevate.com';
const ACK_HEADER = 'i-understand-this-is-beta-and-may-change';

function hasAutoElevateCredentials() {
  return Boolean((KEY || '').trim());
}

async function aeGet(path, params) {
  const res = await axios.get(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${KEY}`, 'X-Acknowledgment': ACK_HEADER, Accept: 'application/json' },
    params,
  });
  return res.data;
}

// Walks the take/skip pagination until every company is collected --
// confirmed live this is a small, whole-account list (44 real rows), same
// "small enough to just fetch whole" shape as every other vendor
// integration on this dashboard. Cached (20-min TTL, same convention as
// the rest of them).
const PAGE_SIZE = 200; // the API's own documented max for `take`
const CACHE_TTL_MS = 20 * 60 * 1000;
let cache = null; // { companies, expiresAt }
let inFlight = null;

async function fetchAllCompanies() {
  const items = [];
  let skip = 0;
  // Loop guarded by totalCount (returned on every page) rather than
  // "page came back empty" alone -- same defensive shape as every other
  // paginated fetch on this dashboard.
  while (true) {
    const page = await aeGet('/api/v1/companies', { take: PAGE_SIZE, skip });
    items.push(...(page.items || []));
    if (items.length >= (page.totalCount ?? items.length) || !page.items || page.items.length === 0) break;
    skip += PAGE_SIZE;
  }
  return items;
}

async function getCompanies(force) {
  if (!force && cache && Date.now() < cache.expiresAt) return cache.companies;
  if (!inFlight) {
    inFlight = fetchAllCompanies()
      .then((companies) => {
        cache = { companies, expiresAt: Date.now() + CACHE_TTL_MS };
        return companies;
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
// reasoning). Tried against `managementSystemCompanyId` FIRST -- confirmed
// live this field is synced straight from the PSA (Autotask) company name
// (e.g. "G & H Civil Contractors" matches exactly), more reliable than
// AutoElevate's own freely-edited `name` (confirmed live: at least one
// real typo there, "Flow FInancial Planning" vs the PSA's correct "Flow
// Financial Planning") -- `name` is only the fallback when nothing matches
// on the PSA-synced field.
function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\s*&\s*/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchPool(companies, field, normCompany) {
  return companies.filter((c) => {
    const n = normalize(c[field]);
    if (!n) return false;
    return n === normCompany || n.includes(normCompany) || normCompany.includes(n);
  });
}

async function findCompanyMatch(companyName, force) {
  const companies = await getCompanies(force);
  const normCompany = normalize(companyName);
  if (!normCompany) return null;
  const byMgmt = matchPool(companies, 'managementSystemCompanyId', normCompany);
  const pool = byMgmt.length > 0 ? byMgmt : matchPool(companies, 'name', normCompany);
  return pool.length === 1 ? pool[0] : null;
}

module.exports = { hasAutoElevateCredentials, getCompanies, findCompanyMatch };
