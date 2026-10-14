const express = require('express');
const axios = require('axios');
// The one piece of @dashboard/autotask-client this page uses -- not for
// Autotask data (it has none), but to reuse the dashboard-wide wildcard
// convention (`*` prefix/suffix -> beginsWith/endsWith/contains), same as
// every other page's client-name filter.
const { matchesWildcard } = require('@dashboard/autotask-client');

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
  const allFailedCount = rows.filter((c) => c.backupPercentage === 0).length;
  const someFailedCount = rows.filter((c) => c.backupPercentage !== null && c.backupPercentage > 0 && c.backupPercentage < 100).length;
  const succeededCount = rows.filter((c) => c.backupPercentage === 100).length;

  return {
    asOf: new Date().toISOString(),
    filterTerm: filterTerm || null,
    totalClients: rows.length,
    totalSeats,
    allFailedCount,
    someFailedCount,
    succeededCount,
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

// The four Datto-RMM-style donut widgets, by request -- allFailed/
// someFailed/succeeded are drawn straight off the already-cached /domains
// report's own `backupPercentage` (same field the main table sorts by), so
// counting them costs nothing extra; only clicking into allFailed/
// someFailed triggers a live per-client applications fetch (bounded
// concurrency, capped), since 'succeeded' has no error detail to show --
// its popup is just the plain client list already in hand. 'all' ("All
// Backups") is handled entirely separately, see getServiceAggregate()
// below -- it's a whole-account application-level aggregate, not a
// backupPercentage bucket at all.
const WIDGET_FETCH_CONCURRENCY = 10;
const WIDGET_FETCH_CAP = 150; // defensive -- a genuinely pathological day shouldn't fire 150+ concurrent-ish Datto requests from one click

async function getWidgetBucket(bucket, force) {
  // 'all' ("All Backups") is handled separately -- by request, clicking it
  // shows the failure breakdown behind that widget's own red arc (which
  // clients, and which of their application types, aren't currently
  // backing up), not a plain client list. That's the exact same
  // per-client-per-application data the service-aggregate computation
  // already builds for the donut's own success/failure counts, so this
  // reuses it (same cache, same in-flight de-dupe) rather than fetching
  // ~230+ clients' /applications a second time.
  if (bucket === 'all') {
    const aggregate = await getServiceAggregate(force);
    return { bucket, clients: aggregate.failingClients };
  }

  const domains = await getDomains(false);
  const { byClient } = buildReport(domains, null);

  let clients;
  let needsApps;
  if (bucket === 'allFailed') {
    clients = byClient.filter((c) => c.backupPercentage === 0);
    needsApps = true;
  } else if (bucket === 'someFailed') {
    clients = byClient.filter((c) => c.backupPercentage !== null && c.backupPercentage > 0 && c.backupPercentage < 100);
    needsApps = true;
  } else if (bucket === 'succeeded') {
    clients = byClient.filter((c) => c.backupPercentage === 100);
    needsApps = false;
  } else {
    throw Object.assign(new Error('Unknown bucket -- expected all, allFailed, someFailed, or succeeded.'), { status: 400 });
  }

  if (!needsApps) {
    return { bucket, clients: clients.map((c) => ({ ...c, apps: null })) };
  }

  const toFetch = clients.slice(0, WIDGET_FETCH_CAP);
  const appsByClient = await mapWithConcurrency(toFetch, WIDGET_FETCH_CONCURRENCY, (c) =>
    getApplications(c.customerId, force).catch((err) => {
      console.error(`Failed to fetch applications for customer ${c.customerId}:`, err.message);
      return null;
    })
  );
  const enriched = toFetch.map((c, i) => ({ ...c, apps: appsByClient[i] }));
  return { bucket, clients: enriched, truncated: clients.length > toFetch.length, totalMatching: clients.length };
}

// "All Backups" widget -- by request, this counts APPLICATION TYPES
// (Exchange/SharePoint/OneDrive/Teams, one row per client from each
// client's own /applications fetch) summed across every client, not the
// /domains endpoint's own activeServicesCount/activeServicesWithRecentBackupCount
// (those turned out to be a seat-equivalent count, same unit as `seatsUsed`,
// not what "services" meant here) -- AND, by a follow-up request, clicking
// the widget shows exactly which clients/application types make up its
// failure count. Both come out of the same single pass (`failingClients`
// alongside the totals), not two separate fetches. Unlike the allFailed/
// someFailed widget buckets, this is NOT capped -- it's a whole-account
// aggregate (and the failure list behind it), not a list to page through,
// so under-counting it to stay cheap would just be wrong. Always over the
// FULL unfiltered client list (a client-name search narrows the table, but
// this widget is a whole-account KPI, not a per-search one). Cached as one
// aggregate (20-min TTL) so even a cold cache only pays for the ~230+ live
// /applications calls once per window, for BOTH the donut and the popup --
// every individual call still goes through getApplications()'s own cache
// too, so a later click into a specific client (or an allFailed/someFailed
// popup) never re-fetches what this already pulled.
const SERVICE_AGGREGATE_CACHE_TTL_MS = 20 * 60 * 1000;
let serviceAggregateCache = null; // { data, expiresAt }
let serviceAggregateInFlight = null;

// Confirmed against the real API: a handful of customer ids (~14 of 234 at
// last check) consistently 500 on their own /applications endpoint --
// Datto's own `error.internal`, reproduced in isolation (not a side effect
// of this file's own concurrency), so retrying wouldn't help the way the
// 429 retry in dattoGet() does. Those clients just contribute nothing to
// the totals/failure list below rather than failing the whole aggregate --
// a known, Datto-side undercount, not a bug here.
async function computeServiceAggregate(force) {
  const domains = await getDomains(false);
  const { byClient } = buildReport(domains, null);
  const appsByClient = await mapWithConcurrency(byClient, WIDGET_FETCH_CONCURRENCY, (c) =>
    getApplications(c.customerId, force).catch((err) => {
      console.error(`Failed to fetch applications for customer ${c.customerId} (Datto-side error, excluded from totals):`, err.message);
      return [];
    })
  );
  let success = 0;
  let failure = 0;
  const failingClients = [];
  byClient.forEach((c, i) => {
    const apps = appsByClient[i];
    const unhealthy = [];
    for (const a of apps) {
      if (a.healthy) success++;
      else {
        failure++;
        unhealthy.push(a);
      }
    }
    if (unhealthy.length > 0) failingClients.push({ ...c, apps: unhealthy });
  });
  return { success, failure, total: success + failure, failingClients };
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

router.get('/service-totals', async (req, res) => {
  try {
    const { success, failure, total } = await getServiceAggregate(req.query.force === 'true');
    res.json({ success, failure, total });
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

// Attached to the router (a function, so it can carry extra named
// properties) rather than changed on module.exports itself -- same
// convention Ingram Subscriptions' own router.getReport export uses, in
// case another page ever wants this cached report in-process (e.g. a
// future Check Client section) without a second HTTP round trip.
router.getWidgetBucket = getWidgetBucket;
router.getServiceAggregate = getServiceAggregate;

module.exports = router;
