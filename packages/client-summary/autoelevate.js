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
  return companies
    .map((c) => ({ company: c, norm: normalize(c[field]) }))
    .filter(({ norm }) => norm && (norm === normCompany || norm.includes(normCompany) || normCompany.includes(norm)));
}

// Confirmed live this session: Sleepy's (a real multi-site account) has BOTH
// a generic parent company ("Sleepy's") AND ~15 separate per-location
// companies ("Sleepy's Caringbah", "Sleepy's Auburn", ...) in AutoElevate's
// own list -- and since "Sleepy's" is a literal prefix of every one of
// those, the bidirectional-contains check above pulled the parent into the
// match pool alongside the real per-location entry for almost every Sleepy's
// site, making it "ambiguous" (2+ matches) and silently returning null --
// reported as "not installed" even though the real per-location company
// existed and should have matched. Resolved in two tiers instead of a flat
// "exactly one match or bust":
//   1. An exact match (the company's normalized name equals the site's,
//      not just contains/contained) always wins outright, even if a
//      broader parent also happens to match via contains -- the real
//      per-location entry ("Sleepy's Caringbah") must never lose to its own
//      parent ("Sleepy's") just because the parent is a substring.
//   2. With no exact match (e.g. a site name has an extra " (HO)" or
//      "- On Demand" suffix Autotask/Datto added that AutoElevate's own
//      name doesn't have), the MOST SPECIFIC -- i.e. longest normalized --
//      match wins, since a longer match narrows the real company down more
//      than a shorter one (a specific "Sleepy's Auburn" entry is a better
//      answer than the generic "Sleepy's" parent for a site literally named
//      "Sleepy's Auburn (HO)"). A genuine tie (two equally-specific
//      candidates, or 2+ exact matches) still returns null -- true
//      ambiguity, not guessed away.
async function findCompanyMatch(companyName, force) {
  const companies = await getCompanies(force);
  const normCompany = normalize(companyName);
  if (!normCompany) return null;
  const byMgmt = matchPool(companies, 'managementSystemCompanyId', normCompany);
  const pool = byMgmt.length > 0 ? byMgmt : matchPool(companies, 'name', normCompany);
  if (pool.length === 0) return null;

  const exact = pool.filter((m) => m.norm === normCompany);
  if (exact.length === 1) return exact[0].company;
  if (exact.length > 1) return null;

  const maxLen = Math.max(...pool.map((m) => m.norm.length));
  const longest = pool.filter((m) => m.norm.length === maxLen);
  return longest.length === 1 ? longest[0].company : null;
}

// Elevation requests/events -- confirmed live this session against the real
// account (the OLD comment above findCompanyMatch()'s own caller in
// server.js claiming "nothing else usable" only ever checked
// /api/v1/companies; these two resources genuinely exist and carry real
// per-client data). GET /api/v1/elevation-requests (one row per elevation
// that needed a human-facing decision -- fields confirmed live:
// approvalState: PENDING/APPROVED/DENIED/WITHDRAWN, requestedBy, file:
// {fileName, productName, ...}, eventId, createdAt) and GET
// /api/v1/elevation-events (one row per elevation TRIGGER, whether or not it
// became a request -- fields confirmed live: data.ruleThatApplied, non-null
// when an explicit admin-configured rule matched this trigger; null for
// EITHER a technician-decided request OR some other undocumented auto-allow
// path -- see live-reports/server.js's own comment on buildAutoElevateSummary()
// for how that ambiguity is handled). Both take the same take/skip paging
// plus companyId/start/end (epoch ms) filters; walked the same way
// fetchAllCompanies() above does. No cache here (unlike getCompanies()) --
// these are period-scoped (start/end vary per call), so a plain TTL cache
// keyed on nothing but the company wouldn't be safe to reuse across calls
// with different windows.
async function fetchAllPaged(path, params) {
  const items = [];
  let skip = 0;
  while (true) {
    const page = await aeGet(path, { ...params, take: PAGE_SIZE, skip });
    items.push(...(page.items || []));
    if (items.length >= (page.totalCount ?? items.length) || !page.items || page.items.length === 0) break;
    skip += PAGE_SIZE;
  }
  return items;
}

async function getElevationRequests(companyId, startMs, endMs) {
  return fetchAllPaged('/api/v1/elevation-requests', { companyId, start: startMs, end: endMs });
}

async function getElevationEvents(companyId, startMs, endMs) {
  return fetchAllPaged('/api/v1/elevation-events', { companyId, start: startMs, end: endMs });
}

module.exports = { hasAutoElevateCredentials, getCompanies, findCompanyMatch, getElevationRequests, getElevationEvents };
