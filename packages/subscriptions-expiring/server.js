const express = require('express');
const { getToken, fetchAllPages } = require('@dashboard/ingram-client');
const { matchesWildcard, todayAestKey } = require('@dashboard/autotask-client');

// Subscription NAME patterns excluded from this page entirely -- same
// convention (and same list) as Ingram Subscriptions: one-off upgrade SKUs,
// not meaningful recurring licensing to watch expiration on.
const EXCLUDED_NAME_PATTERNS = ['Windows 11 Home to Pro Upgrade *'];

// Each dropdown option's day window, evaluated against daysUntilExpiry
// (0 = expires today, positive = N days in the future, negative = N days in
// the past). minDays/maxDays are both inclusive. "Expired Recently" is the
// one fixed, non-day-count option, by request: the last 7 days, not
// adjustable from the dropdown the way the forward-looking windows are.
const WINDOWS = {
  '2': { label: 'Next 2 days', minDays: 0, maxDays: 2 },
  '7': { label: 'Next 7 days', minDays: 0, maxDays: 7 },
  '14': { label: 'Next 14 days', minDays: 0, maxDays: 14 },
  '30': { label: 'Next 30 days', minDays: 0, maxDays: 30 },
  '60': { label: 'Next 60 days', minDays: 0, maxDays: 60 },
  '90': { label: 'Next 90 days', minDays: 0, maxDays: 90 },
  'expired-recently': { label: 'Expired in the last 7 days', minDays: -7, maxDays: -1 },
};

// Ingram's expirationDate is a plain YYYY-MM-DD calendar date with no
// time-of-day component (confirmed against real data -- see README), so this
// is pure calendar-day arithmetic via UTC midnight math. Unlike the
// timestamped fields elsewhere on this dashboard, it does NOT need AEST
// offset conversion -- there's no time-of-day to convert.
function daysBetween(fromDateStr, toDateStr) {
  const [fy, fm, fd] = fromDateStr.split('-').map(Number);
  const [ty, tm, td] = toDateStr.split('-').map(Number);
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / msPerDay);
}

async function buildReport(windowKey, filterTerm) {
  const token = await getToken();
  const win = WINDOWS[windowKey];

  // Every subscription regardless of status -- this is a watch-list keyed on
  // expirationDate, not a "currently active" report, so a subscription that's
  // pending, on hold, or already terminated/removed can still be relevant
  // here. Same cheap single-pass approach as Ingram Subscriptions' "All
  // statuses" mode (omitting `status` entirely, one paginated pass, no
  // per-subscription detail calls).
  const [subscriptions, customers] = await Promise.all([
    fetchAllPages('/subscriptions', token, {}),
    fetchAllPages('/customers', token),
  ]);
  const customerNameById = new Map(customers.map((c) => [c.id, c.name]));

  const today = todayAestKey();

  const rows = [];
  for (const s of subscriptions) {
    if (!s.expirationDate) continue; // hasn't started yet (e.g. still pending) -- no known expiry to compare
    if (EXCLUDED_NAME_PATTERNS.some((pattern) => matchesWildcard(s.name, pattern))) continue;
    const daysUntilExpiry = daysBetween(today, s.expirationDate);
    if (daysUntilExpiry < win.minDays || daysUntilExpiry > win.maxDays) continue;
    const clientName = customerNameById.get(s.customerId) || `Customer #${s.customerId}`;
    if (filterTerm && !matchesWildcard(clientName, filterTerm)) continue;
    rows.push({
      customerId: s.customerId,
      clientName,
      id: s.id,
      name: s.name,
      status: s.status,
      // Whether Ingram will actually renew this subscription at expiration,
      // vs. let it lapse -- the single most actionable fact on this page (a
      // subscription "expiring soon" that auto-renews needs no action; one
      // that doesn't is the one worth following up on).
      autoRenews: !!s.renewalStatus,
      term: s.subscriptionPeriod || null,
      billingPeriod: s.billingPeriod || null,
      expirationDate: s.expirationDate,
      daysUntilExpiry,
    });
  }
  // Chronological by expiration date -- soonest-to-expire first for the
  // forward-looking windows. For "Expired Recently" this puts the OLDEST
  // lapse first rather than the most recent; kept this way for one
  // consistent, predictable sort rule across every window rather than a
  // special-cased reverse order for one option.
  rows.sort((a, b) => a.expirationDate.localeCompare(b.expirationDate) || a.clientName.localeCompare(b.clientName));

  return {
    asOf: new Date().toISOString(),
    window: windowKey,
    windowLabel: win.label,
    filterTerm: filterTerm || null,
    today,
    totalCount: rows.length,
    rows,
  };
}

// Cached per window+filter combination (an empty filter is its own key, same
// convention as Ingram Subscriptions) -- repeat views of the same window are
// instant, a different window or search does its own build. Refresh always
// sends `force=true`, bypassing the cache for that exact key.
const REPORT_CACHE_TTL_MS = 20 * 60 * 1000; // 20 min -- same convention as every other Ingram-backed page
const reportCacheByKey = new Map(); // key -> { data, expiresAt }
const inFlightByKey = new Map(); // key -> Promise, so concurrent cold-cache requests for the same key share one build

function cacheKeyFor(windowKey, filterTerm) {
  return `${windowKey}|${(filterTerm || '').trim().toLowerCase()}`;
}

async function getReport(windowKey, filterTerm, force) {
  const key = cacheKeyFor(windowKey, filterTerm);
  const cached = reportCacheByKey.get(key);
  if (!force && cached && Date.now() < cached.expiresAt) return cached.data;
  if (!inFlightByKey.has(key)) {
    const build = buildReport(windowKey, filterTerm)
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
  const windowKey = req.query.window || '7';
  if (!WINDOWS[windowKey]) {
    return res.status(400).json({ error: `Query param "window" must be one of: ${Object.keys(WINDOWS).join(', ')}.` });
  }
  try {
    const data = await getReport(windowKey, req.query.client, req.query.force === 'true');
    res.json(data);
  } catch (err) {
    console.error(err);
    const detail = err.response ? `Ingram API returned HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    res.status(500).json({ error: detail });
  }
});

module.exports = router;
