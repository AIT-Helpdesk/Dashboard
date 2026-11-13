const axios = require('axios');

// INKY (email security, phishing protection) -- a real live External API,
// confirmed working this session: Bearer-style key sent as `X-API-Key`,
// default host https://api.inkyphishfence.com (INKY_API_BASE overrides it,
// for an EU-region key/account -- see docs.inkyphishfence.com's own
// quickstart.md). GET /v1/teams returns every "Team" in the account --
// confirmed live, 216 real rows: one top-level org entry (kind: 'org',
// "$ambient-it-customers") plus 215 real per-client teams (kind: 'team'),
// each with a team_label (display name) and a real domains[] array (the
// client's own DNS domain plus its ...onmicrosoft.com M365 tenant domain).
// Matched below by team_label -- same name-based matching convention every
// other vendor here uses (Datto SaaS Protection/EDR, AutoElevate, Huntress),
// not by domains[] -- there's no existing "get this Autotask company's own
// email domain" lookup on this dashboard to match that against yet, and
// team_label is a real, human-maintained client name same as every other
// vendor's own name field.
const { INKY_API_KEY: KEY, INKY_API_BASE: RAW_BASE } = process.env;
const DEFAULT_BASE = 'https://api.inkyphishfence.com';

function hasInkyCredentials() {
  return Boolean((KEY || '').trim());
}

function baseUrl() {
  return (RAW_BASE || DEFAULT_BASE).replace(/\/+$/, '');
}

async function inkyGet(path, params) {
  const res = await axios.get(`${baseUrl()}${path}`, {
    headers: { 'X-API-Key': KEY, Accept: 'application/json' },
    params,
  });
  return res.data;
}

// Walks the cursor-based pagination to completion (confirmed live: 100/page,
// 3 pages for 216 real rows) -- same "small enough to just fetch whole, 20-
// min TTL cache" shape as every other vendor's own whole-account list on
// this dashboard (datto-edr.js's getLocations(), autoelevate.js's
// getCompanies(), etc). Filtered down to kind === 'team' here -- the one
// kind === 'org' row is the account itself, never a real client.
const CACHE_TTL_MS = 20 * 60 * 1000;
let cache = null; // { teams, expiresAt }
let inFlight = null;

async function fetchAllTeams() {
  const teams = [];
  let cursor = null;
  for (;;) {
    const page = await inkyGet('/v1/teams', { limit: 100, cursor: cursor || undefined });
    teams.push(...(page.teams || []));
    cursor = page.pagination && page.pagination.next_cursor;
    if (!cursor) break;
  }
  return teams.filter((t) => t.kind === 'team');
}

async function getTeams(force) {
  if (!force && cache && Date.now() < cache.expiresAt) return cache.teams;
  if (!inFlight) {
    inFlight = fetchAllTeams()
      .then((teams) => {
        cache = { teams, expiresAt: Date.now() + CACHE_TTL_MS };
        return teams;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

// GET /v1/usage -- the Stable-tier billable-mailbox count per team
// (confirmed live: `{data_as_of, summary:{total_billable_mailboxes},
// teams:[{team_id, team_name, billable_mailbox_count, product_skus}]}`),
// same cursor pagination/20-min cache shape as getTeams() above. Used for
// Live Reports' own "Protected Mailboxes" tile -- a different, genuinely
// billing-relevant number from Datto SaaS Protection's own billableSeatCount
// tile elsewhere on this dashboard (a wholly separate vendor/product).
let usageCache = null; // { teams, expiresAt }
let usageInFlight = null;

async function fetchAllUsage() {
  const teams = [];
  let cursor = null;
  for (;;) {
    const page = await inkyGet('/v1/usage', { limit: 100, cursor: cursor || undefined });
    teams.push(...(page.teams || []));
    cursor = page.pagination && page.pagination.next_cursor;
    if (!cursor) break;
  }
  return teams;
}

async function getUsage(force) {
  if (!force && usageCache && Date.now() < usageCache.expiresAt) return usageCache.teams;
  if (!usageInFlight) {
    usageInFlight = fetchAllUsage()
      .then((teams) => {
        usageCache = { teams, expiresAt: Date.now() + CACHE_TTL_MS };
        return teams;
      })
      .finally(() => {
        usageInFlight = null;
      });
  }
  return usageInFlight;
}

// Same normalize + exact-match-wins/longest-match-tiebreak matching
// autoelevate.js's own findCompanyMatch() uses, for the same reason: a
// generic parent name ("Sleepy's") shouldn't beat a real, more specific
// per-location team if both happen to satisfy a plain contains check.
function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\s*&\s*/g, ' and ')
    // Apostrophes dropped outright (not turned into a space like every
    // other punctuation char below) -- by request, confirmed INKY's own
    // team_label strips these when a client name has one (e.g. Autotask's
    // "Lenard's Chicken" is INKY's "Lenards Chicken"); turning it into a
    // space instead would wrongly split "Lenard" and "s" into two words
    // and miss the match.
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function findTeamMatch(companyName, force) {
  const teams = await getTeams(force);
  const normCompany = normalize(companyName);
  if (!normCompany) return null;
  const pool = teams
    .map((t) => ({ team: t, norm: normalize(t.team_label) }))
    .filter(({ norm }) => norm && (norm === normCompany || norm.includes(normCompany) || normCompany.includes(norm)));
  if (pool.length === 0) return null;

  const exact = pool.filter((m) => m.norm === normCompany);
  if (exact.length === 1) return exact[0].team;
  if (exact.length > 1) return null;

  const maxLen = Math.max(...pool.map((m) => m.norm.length));
  const longest = pool.filter((m) => m.norm.length === maxLen);
  return longest.length === 1 ? longest[0].team : null;
}

// Per-team daily threat counts, for Live Reports' own "Last 30 Days"
// Cybersecurity Systems widget, by request. GET /beta/teams/{team_id}/
// statistics -- confirmed live: with no since/until given, this defaults
// to exactly the last 30 days (yesterday back 29 days, today excluded),
// which is the same window already asked for here, so no date params are
// sent. Response is `{team_id, since, until, days: [{date, neutral,
// caution, danger}]}`, zero-filled per day -- callers sum `days` themselves
// for a window total, same as every other per-day series this dashboard
// already reduces client/server-side rather than trusting a vendor-
// provided running total. Cached per team id (20-min TTL, same convention
// as getTeams() above) since Live Reports can re-render the same client's
// card repeatedly within a session.
const STATS_CACHE_TTL_MS = 20 * 60 * 1000;
const statsCacheByTeamId = new Map(); // teamId -> { data, expiresAt }

async function getTeamStatistics(teamId, force) {
  const cached = statsCacheByTeamId.get(teamId);
  if (!force && cached && Date.now() < cached.expiresAt) return cached.data;
  const data = await inkyGet(`/beta/teams/${encodeURIComponent(teamId)}/statistics`);
  statsCacheByTeamId.set(teamId, { data, expiresAt: Date.now() + STATS_CACHE_TTL_MS });
  return data;
}

// GET /beta/teams/{team_id}/statistics/reasons -- same default last-30-days
// window as getTeamStatistics() above, but broken out by WHY each message
// was flagged (confirmed live: `{team_id, since, until, reasons: [{date,
// reason, label, count}]}`, one row per day per reason, only when count >
// 0). Live Reports' own "Top Threat Reasons" list sums these by reason
// across the whole window -- see server.js's own buildInkySummary().
const reasonsCacheByTeamId = new Map(); // teamId -> { data, expiresAt }

async function getTeamStatisticsReasons(teamId, force) {
  const cached = reasonsCacheByTeamId.get(teamId);
  if (!force && cached && Date.now() < cached.expiresAt) return cached.data;
  const data = await inkyGet(`/beta/teams/${encodeURIComponent(teamId)}/statistics/reasons`);
  reasonsCacheByTeamId.set(teamId, { data, expiresAt: Date.now() + STATS_CACHE_TTL_MS });
  return data;
}

module.exports = { hasInkyCredentials, getTeams, getUsage, findTeamMatch, getTeamStatistics, getTeamStatisticsReasons };
