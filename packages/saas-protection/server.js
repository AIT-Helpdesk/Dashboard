const express = require('express');
const axios = require('axios');
// The one piece of @dashboard/autotask-client this page uses -- not for
// Autotask data (it has none), but to reuse the dashboard-wide wildcard
// convention (`*` prefix/suffix -> beginsWith/endsWith/contains), same as
// every other page's client-name filter.
const { matchesWildcard } = require('@dashboard/autotask-client');
const { upsertAcceptedFailure, getAcceptedFailure, listAllAcceptedFailures, listActiveAcceptedFailures } = require('./db.js');

// AEST (UTC+10, no DST in Queensland) "today" as YYYY-MM-DD -- same
// convention every date-scoped page on this dashboard uses (e.g. Ingram
// Orders' own defaultSinceISO()), so an accepted-failure's end date lines
// up with what "today" means everywhere else here, not the server's own
// local/UTC day.
function todayAestDateString() {
  return new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Datto SaaS Protection's own REST API (api.datto.com) -- a wholly separate
// system from both Autotask and Datto RMM (@dashboard/datto-rmm, a
// different Datto product with its own separate API host/credentials).
// Confirmed against the real API: Basic Auth straight on every request with
// a Partner-Portal-issued public/secret key pair (no token exchange, unlike
// Ingram's bearer-token flow) -- api.eu.datto.com does not resolve, so this
// is the only base URL regardless of region.
const { DATTO_PORTAL_PUBLIC: PUBLIC_KEY, DATTO_PORTAL_SECRET: SECRET_KEY } = process.env;
const BASE = 'https://api.datto.com/v1/saas';
const authHeader = () => `Basic ${Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString('base64')}`;

// Retries on 429 with backoff, same convention @dashboard/ingram-client's
// callers use (Ingram Subscriptions' fetchLicenseCount(), Ingram Orders'
// fetchOrderDetailWithRetry()) -- Datto's own rate limit on this API hasn't
// been separately confirmed, but this is cheap insurance either way, using
// the API's own Retry-After header when it sends one.
async function dattoGet(path, attempt = 1) {
  const MAX_ATTEMPTS = 6;
  try {
    const res = await axios.get(`${BASE}${path}`, { headers: { Authorization: authHeader(), Accept: 'application/json' } });
    return res.data;
  } catch (err) {
    if (err.response?.status === 429 && attempt < MAX_ATTEMPTS) {
      const retryAfterHeader = err.response.headers['retry-after'];
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;
      const backoffMs = retryAfterMs ?? Math.min(1000 * 2 ** (attempt - 1), 15000) + Math.random() * 500;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      return dattoGet(path, attempt + 1);
    }
    throw err;
  }
}

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

// GET /domains returns one row per M365 tenant Datto is backing up, as a
// bare (unpaginated) array -- confirmed against the real API (234 rows for
// this account, no `pagination` envelope on the response, unlike the
// per-customer endpoints below). Each row already carries a ready-made
// backup-health rollup (backupStats.backupPercentage etc.), so the base
// report needs no further request per client, unlike Ingram Subscriptions'
// license counts.
async function fetchDomains() {
  return dattoGet('/domains');
}

function buildReport(domains, filterTerm) {
  const rows = domains
    .map((d) => ({
      customerId: d.saasCustomerId,
      clientName: d.saasCustomerName,
      domain: d.domain,
      productType: d.productType || null,
      seatsUsed: d.seatsUsed ?? null,
      activeServicesCount: d.backupStats?.activeServicesCount ?? null,
      activeServicesWithRecentBackupCount: d.backupStats?.activeServicesWithRecentBackupCount ?? null,
      backupPercentage: d.backupStats?.backupPercentage ?? null,
    }))
    .filter((c) => !filterTerm || matchesWildcard(c.clientName, filterTerm))
    // Worst backup health first, by request's own intent ("see what we can
    // show for SaaS Protection") -- the point of this page is catching a
    // client whose backup has silently stalled, so the client most worth
    // looking at belongs at the top, not buried alphabetically. A null
    // percentage (missing backupStats entirely) sorts as worse than 0 --
    // "unknown" is at least as concerning as "confirmed bad" -- then ties
    // break alphabetically so the order is stable, not just "whatever Datto
    // returned".
    .sort((a, b) => {
      const pa = a.backupPercentage ?? -1;
      const pb = b.backupPercentage ?? -1;
      if (pa !== pb) return pa - pb;
      return a.clientName.localeCompare(b.clientName);
    });

  const totalSeats = rows.reduce((sum, c) => sum + (c.seatsUsed || 0), 0);

  return {
    asOf: new Date().toISOString(),
    filterTerm: filterTerm || null,
    totalClients: rows.length,
    totalSeats,
    byClient: rows,
  };
}

// Cached (20-min TTL, same convention as Ingram Subscriptions/Ingram
// Orders) -- the filter is applied AFTER the cache, not part of the cache
// key, since /domains returns everyone regardless and filtering is free
// once fetched; a different search term is instant without re-hitting
// Datto, unlike Ingram's per-filter cache keys (which exist because ITS
// filtering has to happen server-side, before the detail-fetch step --
// no such step exists here).
const REPORT_CACHE_TTL_MS = 20 * 60 * 1000;
let reportCache = null; // { domains, expiresAt }
let inFlight = null;

async function getDomains(force) {
  if (!force && reportCache && Date.now() < reportCache.expiresAt) return reportCache.domains;
  if (!inFlight) {
    inFlight = fetchDomains()
      .then((domains) => {
        reportCache = { domains, expiresAt: Date.now() + REPORT_CACHE_TTL_MS };
        return domains;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

// Datto's own `lastFullyProtectedTime` is NOT always a timestamp -- confirmed
// against real data: a healthy app type carries an epoch-ms string (e.g.
// "1791975244620"), but one that ISN'T currently protected carries an enum
// string instead (e.g. "OVER_10_DAYS_AGO", "INGESTING_SERVICES"). Naively
// `Number()`-ing it (what this file originally did, before any of this was
// confirmed) silently produced `NaN` -> "Invalid Date" for exactly the rows
// most worth looking at. SCREAMING_SNAKE_CASE -> "Screaming Snake Case" is
// the fallback for an enum value not in the map below, so a value Datto adds
// later still reads as English instead of raw as ALL_CAPS.
const EPOCH_LIKE = /^\d+$/;
const PROTECTED_TIME_LABELS = {
  OVER_10_DAYS_AGO: 'No successful backup in over 10 days',
  INGESTING_SERVICES: 'Still ingesting (newly added, not backed up yet)',
};
function humanizeEnum(raw) {
  return PROTECTED_TIME_LABELS[raw] || raw.toLowerCase().split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

// One app type's CURRENT status, in Datto's own words -- `backupHistory` is
// an array of rolling time-window buckets (confirmed against real data:
// `timeWindow` values like "Between0dAnd1d" through "Between9dAnd10d"),
// each carrying a human-readable `status` ("Perfect", "Backup With Lots Of
// Issues", "Insufficient History", ...). The most recent window
// (Between0dAnd1d) is what "right now" means; a brand-new app type with no
// history yet (confirmed: `backupHistory: []` alongside
// lastFullyProtectedTime: "INGESTING_SERVICES") falls back to the
// humanized enum instead. This is the actual "Backup Type error" signal --
// NOT something `/domains`' own aggregate backupPercentage exposes, which
// is why this needs its own per-client, per-app-type fetch.
function deriveAppStatus(appType) {
  const today = (appType.backupHistory || []).find((h) => h.timeWindow === 'Between0dAnd1d');
  if (today?.status) return today.status;
  if (appType.lastFullyProtectedTime && !EPOCH_LIKE.test(String(appType.lastFullyProtectedTime))) {
    return humanizeEnum(String(appType.lastFullyProtectedTime));
  }
  return 'No recent backup data';
}

async function fetchApplications(customerId) {
  const page = await dattoGet(`/${customerId}/applications`);
  // Paginated envelope ({ pagination, items }), per the API's own
  // convention for every endpoint except /domains and /seats -- one page is
  // enough here (a handful of app types per client, never more than fits on
  // page 1 in practice), so this doesn't walk pagination the way Ingram's
  // fetchAllPages() does.
  return (page.items || []).flatMap((item) =>
    (item.suites || []).flatMap((suite) =>
      (suite.appTypes || []).map((a) => {
        const status = deriveAppStatus(a);
        return {
          appType: a.appType,
          status,
          healthy: status === 'Perfect',
          usedBytes: a.usedBytes ?? null,
          lastFullyProtectedTime: a.lastFullyProtectedTime && EPOCH_LIKE.test(String(a.lastFullyProtectedTime)) ? Number(a.lastFullyProtectedTime) : null,
        };
      })
    )
  );
}

async function fetchSeats(customerId) {
  const seats = await dattoGet(`/${customerId}/seats`);
  return (seats || []).map((s) => ({
    mainId: s.mainId,
    name: s.name,
    seatType: s.seatType,
    seatState: s.seatState,
    dateAdded: s.dateAdded || null,
  }));
}

// Per-client detail, fetched on demand when a client's name is clicked --
// cached per customerId, same 20-min TTL, same rationale as Ingram
// Subscriptions' per-client license cache: a repeat click within a session
// shouldn't redo the work, but this is never fetched for all ~230+ clients
// up front. Applications and seats are cached SEPARATELY (not as one combined
// blob) so the widget buckets below (which only ever need applications, not
// seats) share this exact cache instead of re-fetching.
const DETAIL_CACHE_TTL_MS = 20 * 60 * 1000;
const applicationsCache = new Map(); // customerId -> { data, expiresAt }
const seatsCache = new Map(); // customerId -> { data, expiresAt }

async function getApplications(customerId, force) {
  const cached = applicationsCache.get(customerId);
  if (!force && cached && Date.now() < cached.expiresAt) return cached.data;
  const data = await fetchApplications(customerId);
  applicationsCache.set(customerId, { data, expiresAt: Date.now() + DETAIL_CACHE_TTL_MS });
  return data;
}

async function getSeats(customerId, force) {
  const cached = seatsCache.get(customerId);
  if (!force && cached && Date.now() < cached.expiresAt) return cached.data;
  const data = await fetchSeats(customerId);
  seatsCache.set(customerId, { data, expiresAt: Date.now() + DETAIL_CACHE_TTL_MS });
  return data;
}

async function getDetail(customerId, force) {
  const [applications, seats] = await Promise.all([getApplications(customerId, force), getSeats(customerId, force)]);
  return { applications, seats };
}

// All five widgets, by request, are now application-type-level and
// accepted-failure-aware -- EVERY bucket routes through the one
// getServiceAggregate() computation below, not the cheap /domains-level
// backupPercentage this used to filter on. That earlier version (allFailed
// = backupPercentage === 0, etc.) couldn't honor an accepted failure at
// all: a client's SEAT-level backupPercentage from Datto has no concept of
// "ignore this one application type for now", so a fully-accepted client
// would still show up in "All Backups Failed" even though its one real
// failure had been dealt with. Classification per client, from the same
// per-app pass that builds the "All Backups" ring:
//   - succeeded: zero REAL (non-actively-accepted) failing app types.
//   - allFailed: every app type is a real failing one.
//   - someFailed: some, but not all.
//   - (a client with no application data at all -- a Datto-side 500, see
//     below -- isn't classified into any of the three; we genuinely don't
//     know its state, so it's left out rather than guessed at.)
const WIDGET_FETCH_CONCURRENCY = 10;

async function getWidgetBucket(bucket, force) {
  const aggregate = await getServiceAggregate(force);
  if (bucket === 'all') return { bucket, clients: aggregate.failingClients };
  if (bucket === 'allFailed') return { bucket, clients: aggregate.allFailedClients };
  if (bucket === 'someFailed') return { bucket, clients: aggregate.someFailedClients };
  if (bucket === 'succeeded') return { bucket, clients: aggregate.succeededClients.map((c) => ({ ...c, apps: null })) };
  throw Object.assign(new Error('Unknown bucket -- expected all, allFailed, someFailed, or succeeded.'), { status: 400 });
}

// The single per-client, per-application-type pass behind every widget on
// this page -- by request, this counts APPLICATION TYPES (Exchange/
// SharePoint/OneDrive/Teams, one row per client from each client's own
// /applications fetch) summed across every client, not the /domains
// endpoint's own activeServicesCount/activeServicesWithRecentBackupCount
// (those turned out to be a seat-equivalent count, same unit as
// `seatsUsed`, not what "services" meant here). NOT capped -- it's a
// whole-account aggregate (and the four client lists behind it), not a
// list to page through, so under-counting it to stay cheap would just be
// wrong. Always over the FULL unfiltered client list (a client-name search
// narrows the main table, but this widget set is a whole-account KPI, not
// a per-search one). Cached as one aggregate (20-min TTL) so even a cold
// cache only pays for the ~230+ live /applications calls once per window,
// for every widget at once -- every individual call still goes through
// getApplications()'s own cache too, so a later click into a specific
// client never re-fetches what this already pulled.
const SERVICE_AGGREGATE_CACHE_TTL_MS = 20 * 60 * 1000;
let serviceAggregateCache = null; // { data, expiresAt }
let serviceAggregateInFlight = null;

// Confirmed against the real API: a handful of customer ids (~14 of 234 at
// last check) consistently 500 on their own /applications endpoint --
// Datto's own `error.internal`, reproduced in isolation (not a side effect
// of this file's own concurrency), so retrying wouldn't help the way the
// 429 retry in dattoGet() does. Those clients just contribute nothing to
// the totals/classification below rather than failing the whole aggregate
// -- a known, Datto-side undercount, not a bug here.
//
// Accepted failures, by request: a (customerId, appType) pair with an
// ACTIVE acceptance (end_date >= today) is excluded entirely -- counted
// as neither success nor failure, same as it never happened -- "exclude
// these until the date is reached", and that exclusion now applies to
// every widget that classifies a client by its failures, not just the
// All Backups ring. One that WAS accepted but has since LAPSED (end_date
// < today) is still a failure as normal, just carries its lapsed
// `acceptedFailure` record along so the client can show the "Failure
// accepted for X to Y" note. Looked up from one single query (not one
// SELECT per failing app) into a plain Map.
//
// `failingClients` and `allFailedClients`/`someFailedClients` deliberately
// share the SAME object reference per client (not a copy) -- so
// patchServiceAggregateCache() below only ever has to mutate one object to
// keep both in sync, and `totalApps` rides along on it specifically so
// that patch can tell "no real failures left" (-> succeeded) apart from
// "fewer failures, but not zero" (-> demote All Failed to Some Failed)
// without re-deriving anything.
async function computeServiceAggregate(force) {
  const domains = await getDomains(false);
  const { byClient } = buildReport(domains, null);
  const appsByClient = await mapWithConcurrency(byClient, WIDGET_FETCH_CONCURRENCY, (c) =>
    getApplications(c.customerId, force).catch((err) => {
      console.error(`Failed to fetch applications for customer ${c.customerId} (Datto-side error, excluded):`, err.message);
      return null;
    })
  );

  const today = todayAestDateString();
  const acceptedByKey = new Map(listAllAcceptedFailures().map((r) => [`${r.customer_id}|${r.app_type}`, r]));

  let success = 0;
  let failure = 0;
  const failingClients = [];
  const allFailedClients = [];
  const someFailedClients = [];
  const succeededClients = [];

  byClient.forEach((c, i) => {
    const apps = appsByClient[i];
    if (apps === null || apps.length === 0) return; // no application data at all -- can't classify this client either way

    const unhealthy = [];
    for (const a of apps) {
      if (a.healthy) {
        success++;
        continue;
      }
      const accepted = acceptedByKey.get(`${c.customerId}|${a.appType}`);
      if (accepted && accepted.end_date >= today) continue; // actively accepted -- excluded, not counted either way
      failure++;
      unhealthy.push(accepted ? { ...a, acceptedFailure: { startDate: accepted.start_date, endDate: accepted.end_date } } : a);
    }

    if (unhealthy.length === 0) {
      succeededClients.push(c);
      return;
    }

    const entry = { ...c, apps: unhealthy, totalApps: apps.length };
    failingClients.push(entry);
    if (unhealthy.length === apps.length) allFailedClients.push(entry);
    else someFailedClients.push(entry);
  });

  return { success, failure, total: success + failure, failingClients, allFailedClients, someFailedClients, succeededClients };
}

// Patches an already-cached aggregate in place right after a successful
// accept -- removes that one app from the client's shared failure entry
// and adjusts the totals, WITHOUT forcing the full ~230+-client recompute
// (that's a ~75s round trip, far too slow for "I just accepted this, make
// it disappear"). Also reclassifies that client between the allFailed/
// someFailed/succeeded lists if the accept changes which bucket it belongs
// in (e.g. its last remaining real failure just got accepted -> moves to
// succeeded). The cache's own expiresAt is left untouched, so it still
// naturally recomputes from scratch later (self-healing against any edge
// case here). No-ops silently if the cache is cold or doesn't contain this
// pair -- the next real computeServiceAggregate() run reflects it
// correctly either way; this is purely so an already-warm cache doesn't go
// stale the moment someone accepts something.
function patchServiceAggregateCache(customerId, appType) {
  if (!serviceAggregateCache) return;
  const data = serviceAggregateCache.data;
  const entry = data.failingClients.find((c) => String(c.customerId) === String(customerId));
  if (!entry) return;
  const idx = entry.apps.findIndex((a) => a.appType === appType);
  if (idx === -1) return;
  entry.apps.splice(idx, 1);
  data.failure -= 1;
  data.total -= 1;

  if (entry.apps.length === 0) {
    data.failingClients = data.failingClients.filter((c) => c !== entry);
    data.allFailedClients = data.allFailedClients.filter((c) => c !== entry);
    data.someFailedClients = data.someFailedClients.filter((c) => c !== entry);
    const { apps, totalApps, ...plain } = entry;
    data.succeededClients.push(plain);
  } else if (data.allFailedClients.includes(entry)) {
    // Removing any app while apps.length > 0 means it's no longer EVERY
    // app failing -- demote from All Failed to Some Failed.
    data.allFailedClients = data.allFailedClients.filter((c) => c !== entry);
    data.someFailedClients.push(entry);
  }
}

async function getServiceAggregate(force) {
  if (!force && serviceAggregateCache && Date.now() < serviceAggregateCache.expiresAt) return serviceAggregateCache.data;
  if (!serviceAggregateInFlight) {
    serviceAggregateInFlight = computeServiceAggregate(force)
      .then((data) => {
        serviceAggregateCache = { data, expiresAt: Date.now() + SERVICE_AGGREGATE_CACHE_TTL_MS };
        return data;
      })
      .finally(() => {
        serviceAggregateInFlight = null;
      });
  }
  return serviceAggregateInFlight;
}

const router = express.Router();
// Only POST /accept-failure sends a body -- Express only parses one when a
// request actually has one, so this is a no-op for every GET route here,
// same router.use(express.json()) convention Contract Checks/Check Client
// already use for their own one write route each.
router.use(express.json());

router.get('/', async (req, res) => {
  try {
    const domains = await getDomains(req.query.force === 'true');
    res.json(buildReport(domains, req.query.client));
  } catch (err) {
    console.error(err);
    const detail = err.response ? `Datto API returned HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    res.status(500).json({ error: detail });
  }
});

router.get('/detail', async (req, res) => {
  const customerId = req.query.customerId;
  if (!customerId) return res.status(400).json({ error: 'Query param "customerId" is required.' });
  try {
    const data = await getDetail(customerId, req.query.force === 'true');
    res.json(data);
  } catch (err) {
    console.error(err);
    const detail = err.response ? `Datto API returned HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    res.status(500).json({ error: detail });
  }
});

// Feeds all four client-classifying widgets (All Backups' own ring, plus
// the All Failed/Some Failed/Succeeded counts) from the one aggregate --
// `classifiedTotal` (not the base report's `totalClients`) is the right
// denominator for those three, since a client with no application data at
// all (a Datto-side error) is excluded from classification entirely and
// shouldn't silently deflate their "X of Y" percentage.
router.get('/service-totals', async (req, res) => {
  try {
    const agg = await getServiceAggregate(req.query.force === 'true');
    res.json({
      success: agg.success,
      failure: agg.failure,
      total: agg.total,
      allFailedCount: agg.allFailedClients.length,
      someFailedCount: agg.someFailedClients.length,
      succeededCount: agg.succeededClients.length,
      classifiedTotal: agg.allFailedClients.length + agg.someFailedClients.length + agg.succeededClients.length,
    });
  } catch (err) {
    console.error(err);
    const detail = err.response ? `Datto API returned HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    res.status(500).json({ error: detail });
  }
});

router.get('/widget-detail', async (req, res) => {
  try {
    const data = await getWidgetBucket(req.query.bucket, req.query.force === 'true');
    res.json(data);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error(err);
    const detail = err.response ? `Datto API returned HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    res.status(500).json({ error: detail });
  }
});

// Accept (or re-accept) one failing (client, application type) pair --
// purely a DB write, no live Datto call, so this is instant regardless of
// how long the aggregate itself takes to (re)compute. patchServiceAggregateCache()
// keeps any already-warm cache honest immediately, rather than leaving a
// stale failure sitting in it until the next natural 20-min recompute.
router.post('/accept-failure', (req, res) => {
  const { customerId, appType, clientName, domain, endDate } = req.body || {};
  if (!customerId || !appType) return res.status(400).json({ error: 'customerId and appType are required.' });
  if (!endDate || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return res.status(400).json({ error: 'endDate is required, in YYYY-MM-DD format.' });
  }
  const today = todayAestDateString();
  if (endDate < today) return res.status(400).json({ error: 'endDate cannot be in the past.' });

  try {
    const existing = getAcceptedFailure(customerId, appType);
    const record = upsertAcceptedFailure({
      customerId,
      appType,
      clientName,
      domain,
      startDate: existing ? existing.start_date : today,
      endDate,
      acceptedByName: req.session?.user?.name || null,
      acceptedAt: new Date().toISOString(),
    });
    patchServiceAggregateCache(customerId, appType);
    res.json({ ok: true, record });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// The 5th widget's own data -- active (not yet lapsed) accepted failures
// only, cheap (DB-only, no Datto calls), so this is always fetched fresh,
// no cache needed.
router.get('/accepted-failures', (req, res) => {
  try {
    const today = todayAestDateString();
    const rows = listActiveAcceptedFailures(today).map((r) => ({
      customerId: r.customer_id,
      appType: r.app_type,
      clientName: r.client_name,
      domain: r.domain,
      startDate: r.start_date,
      endDate: r.end_date,
      acceptedByName: r.accepted_by_name,
      acceptedAt: r.accepted_at,
    }));
    res.json({ items: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Attached to the router (a function, so it can carry extra named
// properties) rather than changed on module.exports itself -- same
// convention Ingram Subscriptions' own router.getReport export uses, in
// case another page ever wants this cached report in-process (e.g. a
// future Check Client section) without a second HTTP round trip.
router.getWidgetBucket = getWidgetBucket;
router.getServiceAggregate = getServiceAggregate;

module.exports = router;
