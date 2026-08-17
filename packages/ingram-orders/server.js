const express = require('express');
const { getToken, getPage, getOrderDetail, getSubscriptionDetail } = require('@dashboard/ingram-client');
// Same reasoning as Ingram Subscriptions: the one piece of @dashboard/autotask-client
// this page uses for shared string-matching (not Autotask data), plus the AEST
// day-boundary helper for the "since" date.
const { matchesWildcard, aestDayBoundsIso } = require('@dashboard/autotask-client');

// Confirmed against the real API: /orders returns its ~20,600+ rows sorted
// newest-first by creationDate by default (no documented sort/filter param
// found -- api.cloud.im's own docs site (apidocs.cloud.im) consistently
// refused to load during investigation, and every guessed date-filter query
// param, e.g. startDate/fromDate/creationDateFrom, was silently ignored:
// pagination.total never changed). Verified the descending order holds
// across a page boundary (page 2's first date <= page 1's last), not just
// within one page, so paginating from offset 0 and stopping the moment an
// order's creationDate falls before the threshold is a correct, efficient
// way to get "orders since date X" without fetching the whole history.
async function fetchOrdersSince(token, sinceISO) {
  let offset = 0;
  const all = [];
  for (;;) {
    const page = await getPage('/orders', token, { offset });
    if (page.data.length === 0) break;
    let hitOlder = false;
    for (const o of page.data) {
      if (o.creationDate < sinceISO) {
        hitOlder = true;
        break;
      }
      all.push(o);
    }
    if (hitOlder) break;
    offset += page.data.length;
    if (offset >= page.pagination.total) break;
  }
  return all;
}

async function fetchCustomers(token) {
  let offset = 0;
  const all = [];
  for (;;) {
    const page = await getPage('/customers', token, { offset });
    all.push(...page.data);
    offset += page.data.length;
    if (page.data.length === 0 || offset >= page.pagination.total) break;
  }
  return all;
}

async function buildReport(sinceDate, filterTerm, includeRenewals) {
  const token = await getToken();
  const { startISO } = aestDayBoundsIso(sinceDate); // AEST midnight of the selected date, not UTC

  const [orders, customers] = await Promise.all([fetchOrdersSince(token, startISO), fetchCustomers(token)]);
  const customerNameById = new Map(customers.map((c) => [c.id, c.name]));

  const byClientMap = new Map();
  for (const o of orders) {
    // Off by default, by request -- renewals are typically the highest-volume,
    // least-actionable order type (automatic, no real decision behind them),
    // so they're excluded from both the grouping and the counts unless
    // explicitly asked for, rather than just hidden client-side after the
    // fact (which would still count them in totals/status breakdown).
    if (!includeRenewals && o.type === 'renewal') continue;
    const clientName = customerNameById.get(o.customerId) || `Customer #${o.customerId}`;
    if (filterTerm && !matchesWildcard(clientName, filterTerm)) continue;
    if (!byClientMap.has(o.customerId)) {
      byClientMap.set(o.customerId, { customerId: o.customerId, clientName, orders: [] });
    }
    byClientMap.get(o.customerId).orders.push(o);
  }

  const matched = [...byClientMap.values()].flatMap((g) => g.orders);

  const byClient = [...byClientMap.values()]
    .map((g) => {
      // Most-recent-first within a client -- unlike Ingram Subscriptions'
      // alphabetical-by-name ordering, orders don't have a natural name to
      // sort by, so chronological (matching the API's own default order) is
      // the more useful axis here.
      const enrichedOrders = g.orders
        .map((o) => ({
          id: o.id,
          orderNumber: o.orderNumber,
          type: o.type || null,
          status: o.status || null,
          creationDate: o.creationDate || null,
          provisioningDate: o.provisioningDate || null,
          // poNumber/products deliberately omitted here (not on the list
          // endpoint) -- fetched on demand per client, see the /detail route
          // below, same "expensive detail is opt-in" pattern as Ingram
          // Subscriptions' license counts.
        }))
        .sort((a, b) => (b.creationDate || '').localeCompare(a.creationDate || ''));
      return {
        customerId: g.customerId,
        clientName: g.clientName,
        count: enrichedOrders.length,
        orders: enrichedOrders,
      };
    })
    .sort((a, b) => b.orders[0].creationDate.localeCompare(a.orders[0].creationDate)); // clients with the most recent activity first

  // Generic per-status breakdown (completed/processing/whatever else Ingram
  // uses), same rationale as Subscriptions' statusCounts -- no assumption
  // baked in about which statuses exist, since every order is included
  // regardless of status by request (no filtering by completion state).
  const statusCounts = {};
  for (const o of matched) {
    const key = o.status || 'unknown';
    statusCounts[key] = (statusCounts[key] || 0) + 1;
  }

  return {
    asOf: new Date().toISOString(),
    sinceDate,
    filterTerm: filterTerm || null,
    includeRenewals: !!includeRenewals,
    totalCount: matched.length,
    statusCounts,
    byClient,
  };
}

// Cached per sinceDate+filterTerm+includeRenewals combination (20-min TTL,
// same convention as Ingram Subscriptions/Subscriptions Expiring) -- repeat
// views of the same search are instant, a different date/search/toggle
// state does its own build. Refresh always sends `force=true`, bypassing the
// cache for that exact key.
const REPORT_CACHE_TTL_MS = 20 * 60 * 1000;
const reportCacheByKey = new Map(); // key -> { data, expiresAt }
const inFlightByKey = new Map(); // key -> Promise, so concurrent cold-cache requests for the same key share one build

function cacheKeyFor(sinceDate, filterTerm, includeRenewals) {
  return `${sinceDate}|${(filterTerm || '').trim().toLowerCase()}|${includeRenewals ? 'withRenewals' : 'noRenewals'}`;
}

async function getReport(sinceDate, filterTerm, includeRenewals, force) {
  const key = cacheKeyFor(sinceDate, filterTerm, includeRenewals);
  const cached = reportCacheByKey.get(key);
  if (!force && cached && Date.now() < cached.expiresAt) return cached.data;
  if (!inFlightByKey.has(key)) {
    const build = buildReport(sinceDate, filterTerm, includeRenewals)
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

// Per-order PO number + product detail, fetched on demand when a client's
// name is clicked in the UI -- not part of the base report, same rationale
// as Ingram Subscriptions' license counts: the list endpoint doesn't carry
// this, only the single-order detail endpoint does, so fetching it for
// every order up front would mean one request per order regardless of
// whether anyone ever looks at it.
//
// Retries on 429 with backoff -- Ingram's rate limit on per-item detail
// endpoints is a time-window budget, not a pure concurrency cap (confirmed
// for /subscriptions/{id}; not separately re-confirmed for /orders/{id}, but
// treated the same defensively since it's the same underlying platform).
// Sums a subscription's own product-line quantities -- the subscription's
// CURRENT total seat count, not a delta. `null` (not 0) when the
// subscription carries no product lines at all, so a caller can tell
// "no quantity info" apart from "a real zero".
function totalQuantity(sub) {
  const subProducts = sub.products || [];
  return subProducts.length > 0 ? subProducts.reduce((sum, p) => sum + (typeof p.quantity === 'number' ? p.quantity : 0), 0) : null;
}

async function fetchOrderDetailWithRetry(id, token, attempt = 1) {
  const MAX_ATTEMPTS = 6;
  try {
    const detail = await getOrderDetail(id, token);
    // `quantity` on a `change`-type order's product line is a SIGNED delta,
    // not a total -- confirmed against real data: a "downgrade" (removing a
    // seat) shows quantity -1, while adding seats shows a positive quantity
    // matching how many were added. Carried through as-is (not just the
    // name) so the client can show what the change actually was, e.g. "+1"/
    // "-1", not just which product it touched.
    let products = (detail.products || [])
      .filter((p) => p.name)
      .map((p) => ({ name: p.name, quantity: typeof p.quantity === 'number' ? p.quantity : null }));
    // Confirmed against real data: `renewal` and `cancellation` type orders
    // carry NO `products` (or `details`) array at all on the order itself --
    // `change`/`sales` orders do. Every order type seen still carries a
    // `subscriptionId`, though, and that subscription's own `name` field is
    // exactly the product name -- confirmed this resolves even for a
    // cancelled subscription. Falls back to it rather than leaving the
    // Product column blank for these order types.
    if (products.length === 0 && detail.subscriptionId) {
      try {
        const sub = await getSubscriptionDetail(detail.subscriptionId, token);
        if (sub.name) products = [{ name: sub.name, quantity: totalQuantity(sub) }];
      } catch {
        // Subscription lookup failing isn't fatal to the order detail as a
        // whole -- just leaves the Product column blank for this one order.
      }
    }

    // For a `change` order specifically, also resolve the subscription's
    // CURRENT total quantity -- Ingram's own order detail has no "resulting
    // quantity" field (confirmed against real data), so this is the best
    // available proxy for "the new total after this change": the
    // subscription's live current quantity. Accurate as long as no LATER
    // change has since altered that same subscription further -- there's no
    // way to get an exact-at-the-time snapshot from this API.
    let currentTotal = null;
    if (detail.type === 'change' && detail.subscriptionId && products.some((p) => typeof p.quantity === 'number')) {
      try {
        const sub = await getSubscriptionDetail(detail.subscriptionId, token);
        currentTotal = totalQuantity(sub);
      } catch {
        // Leaves currentTotal null -- the client just shows the delta alone, no "= N".
      }
    }

    return { poNumber: detail.poNumber || null, products, currentTotal };
  } catch (err) {
    if (err.response?.status === 429 && attempt < MAX_ATTEMPTS) {
      const retryAfterHeader = err.response.headers['retry-after'];
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;
      const backoffMs = retryAfterMs ?? Math.min(1000 * 2 ** (attempt - 1), 15000) + Math.random() * 500;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      return fetchOrderDetailWithRetry(id, token, attempt + 1);
    }
    console.error(`Failed to fetch order detail for ${id}:`, err.message);
    return { poNumber: null, products: [], currentTotal: null };
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

const DETAIL_CACHE_TTL_MS = 20 * 60 * 1000;
const detailCache = new Map(); // orderId -> { data, expiresAt }

async function getOrderDetailCached(id, token) {
  const cached = detailCache.get(id);
  if (cached && Date.now() < cached.expiresAt) return cached.data;
  const data = await fetchOrderDetailWithRetry(id, token);
  detailCache.set(id, { data, expiresAt: Date.now() + DETAIL_CACHE_TTL_MS });
  return data;
}

const router = express.Router();

router.get('/', async (req, res) => {
  const sinceDate = req.query.since;
  if (!sinceDate || !/^\d{4}-\d{2}-\d{2}$/.test(sinceDate)) {
    return res.status(400).json({ error: 'Query param "since" is required in YYYY-MM-DD format.' });
  }
  try {
    const data = await getReport(sinceDate, req.query.client, req.query.includeRenewals === 'true', req.query.force === 'true');
    res.json(data);
  } catch (err) {
    console.error(err);
    const detail = err.response ? `Ingram API returned HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    res.status(500).json({ error: detail });
  }
});

// On-demand PO/product detail for one client's orders -- called when that
// client's name is clicked, not as part of the base report. The client
// already has the order IDs (from the base report's `orders` arrays), so
// this just takes a comma-separated id list.
router.get('/detail', async (req, res) => {
  try {
    const ids = (req.query.ids || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    if (ids.length === 0) return res.json({ details: {} });

    const token = await getToken();
    const details = await mapWithConcurrency(ids, 20, (id) => getOrderDetailCached(id, token));
    res.json({ details: Object.fromEntries(ids.map((id, i) => [id, details[i]])) });
  } catch (err) {
    console.error(err);
    const detail = err.response ? `Ingram API returned HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    res.status(500).json({ error: detail });
  }
});

module.exports = router;
