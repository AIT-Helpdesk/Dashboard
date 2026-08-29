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

async function buildReport(sinceDate, filterTerm, includeRenewals, includeAllRenewals, includeCancelled, statusTerm, productTerm) {
  const token = await getToken();
  const { startISO } = aestDayBoundsIso(sinceDate); // AEST midnight of the selected date, not UTC

  const [orders, customers] = await Promise.all([fetchOrdersSince(token, startISO), fetchCustomers(token)]);
  const customerNameById = new Map(customers.map((c) => [c.id, c.name]));

  // First pass: which clients have at least one surviving NON-renewal order
  // under the Cancelled/Status/Client filters (deliberately NOT the renewal
  // gate itself, and NOT the Product filter -- Product is resolved later,
  // from detail, and is orthogonal to this question). Answers "would this
  // client be on the page anyway, for a real order" -- used below by the
  // partial "Show Renewals" mode.
  const nonRenewalClientIds = new Set();
  for (const o of orders) {
    if (o.type === 'renewal') continue;
    if (!includeCancelled && o.status === 'cancelled') continue;
    if (statusTerm && !matchesWildcard(o.status || '', statusTerm)) continue;
    const clientName = customerNameById.get(o.customerId) || `Customer #${o.customerId}`;
    if (filterTerm && !matchesWildcard(clientName, filterTerm)) continue;
    nonRenewalClientIds.add(o.customerId);
  }

  const byClientMap = new Map();
  for (const o of orders) {
    if (o.type === 'renewal') {
      // Two independent, off-by-default ways renewals get pulled back in --
      // renewals are typically the highest-volume, least-actionable order
      // type (automatic, no real decision behind them), so excluded unless
      // explicitly asked for, same as before. Now two different asks:
      //  - Show ALL Renewals: every renewal order, unconditionally -- this
      //    page's original/only renewals behavior, unchanged.
      //  - Show Renewals: only a renewal belonging to a client that's
      //    ALREADY going to be listed for a real, non-renewal order (see
      //    nonRenewalClientIds above) -- a client isn't pulled onto the page
      //    SOLELY because of a renewal, but if they're here anyway, their
      //    renewals are shown too for context. If both are checked, Show ALL
      //    Renewals wins -- it's the strict superset.
      if (includeAllRenewals) {
        // include unconditionally
      } else if (includeRenewals && nonRenewalClientIds.has(o.customerId)) {
        // this client has another surviving order -- include the renewal too
      } else {
        continue;
      }
    }
    // Also off by default, same rationale, but keyed on STATUS rather than
    // type -- confirmed against real data these are mostly different orders
    // (a `status: 'cancelled'` order can be a `change`, `sales`, or
    // `cancellation` type -- it's a failed/withdrawn order attempt of any
    // kind, not specifically an order that cancels a subscription, which is
    // what `type: 'cancellation'` means). Applied independently of the Status
    // filter below, same "checkbox is an outer gate" pattern as renewals.
    if (!includeCancelled && o.status === 'cancelled') continue;
    if (statusTerm && !matchesWildcard(o.status || '', statusTerm)) continue;
    const clientName = customerNameById.get(o.customerId) || `Customer #${o.customerId}`;
    if (filterTerm && !matchesWildcard(clientName, filterTerm)) continue;
    if (!byClientMap.has(o.customerId)) {
      byClientMap.set(o.customerId, { customerId: o.customerId, clientName, orders: [] });
    }
    byClientMap.get(o.customerId).orders.push(o);
  }

  let byClient = [...byClientMap.values()]
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
          // Subscriptions' license counts. Overwritten below when a Product
          // filter forces detail to be fetched as part of building the report.
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

  // Product filtering needs detail (the base list endpoint carries no
  // product info at all -- see fetchOrderDetailWithRetry() below), so it's
  // the one filter here that isn't free. Only paid for when actually
  // requested, and only for the ALREADY-narrowed (since/client/status/
  // renewals/cancelled) candidate set, not the full history -- the other filters
  // above run first specifically so this one has as little work to do as
  // possible. Detail fetched this way is attached directly to the surviving
  // rows, so the client doesn't need a further click to see PO#/Product/
  // Licenses for a product-filtered result -- `detailPreloaded: true` in the
  // response tells it so.
  let detailPreloaded = false;
  if (productTerm) {
    detailPreloaded = true;
    const candidateOrders = byClient.flatMap((c) => c.orders);
    const details = await mapWithConcurrency(candidateOrders, 20, (o) => getOrderDetailCached(o.id, token));
    candidateOrders.forEach((o, i) => {
      o.poNumber = details[i].poNumber;
      o.products = details[i].products;
      o.currentTotal = details[i].currentTotal;
      o.effectiveDate = details[i].effectiveDate;
    });
    byClient = byClient
      .map((c) => ({ ...c, orders: c.orders.filter((o) => (o.products || []).some((p) => matchesWildcard(p.name, productTerm))) }))
      .filter((c) => c.orders.length > 0)
      .map((c) => ({ ...c, count: c.orders.length }));
  }

  const matched = byClient.flatMap((g) => g.orders);

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
    statusTerm: statusTerm || null,
    productTerm: productTerm || null,
    includeRenewals: !!includeRenewals,
    includeAllRenewals: !!includeAllRenewals,
    includeCancelled: !!includeCancelled,
    detailPreloaded,
    totalCount: matched.length,
    statusCounts,
    byClient,
  };
}

// Cached per sinceDate+filterTerm+includeRenewals+includeCancelled+status+
// product combination (20-min TTL, same convention as Ingram Subscriptions/
// Subscriptions Expiring) -- repeat views of the same search are instant, a
// different date/search/toggle/filter state does its own build. Refresh
// always sends `force=true`, bypassing the cache for that exact key.
const REPORT_CACHE_TTL_MS = 20 * 60 * 1000;
const reportCacheByKey = new Map(); // key -> { data, expiresAt }
const inFlightByKey = new Map(); // key -> Promise, so concurrent cold-cache requests for the same key share one build

function cacheKeyFor(sinceDate, filterTerm, includeRenewals, includeAllRenewals, includeCancelled, statusTerm, productTerm) {
  const norm = (s) => (s || '').trim().toLowerCase();
  return `${sinceDate}|${norm(filterTerm)}|${includeRenewals ? 'someRenewals' : 'noSomeRenewals'}|${includeAllRenewals ? 'allRenewals' : 'noAllRenewals'}|${includeCancelled ? 'withCancelled' : 'noCancelled'}|${norm(statusTerm)}|${norm(productTerm)}`;
}

async function getReport(sinceDate, filterTerm, includeRenewals, includeAllRenewals, includeCancelled, statusTerm, productTerm, force) {
  const key = cacheKeyFor(sinceDate, filterTerm, includeRenewals, includeAllRenewals, includeCancelled, statusTerm, productTerm);
  const cached = reportCacheByKey.get(key);
  if (!force && cached && Date.now() < cached.expiresAt) return cached.data;
  if (!inFlightByKey.has(key)) {
    const build = buildReport(sinceDate, filterTerm, includeRenewals, includeAllRenewals, includeCancelled, statusTerm, productTerm)
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

    // Subscription detail is fetched at most ONCE per order, lazily, and
    // memoized here -- reused below for whichever of three things actually
    // need it (the product-name fallback, a `change` order's current-total
    // lookup, and the pending-effective-date fallback), rather than issuing
    // up to three separate requests for the same subscription.
    let sub;
    let subFetchAttempted = false;
    async function getSubOnce() {
      if (subFetchAttempted || !detail.subscriptionId) return sub;
      subFetchAttempted = true;
      try {
        sub = await getSubscriptionDetail(detail.subscriptionId, token);
      } catch {
        // Leaves sub undefined -- each caller below already treats that as
        // "couldn't resolve", same as before this was combined into one fetch.
      }
      return sub;
    }

    // Confirmed against real data: `renewal` and `cancellation` type orders
    // carry NO `products` (or `details`) array at all on the order itself --
    // `change`/`sales` orders do. Every order type seen still carries a
    // `subscriptionId`, though, and that subscription's own `name` field is
    // exactly the product name -- confirmed this resolves even for a
    // cancelled subscription. Falls back to it rather than leaving the
    // Product column blank for these order types.
    if (products.length === 0 && detail.subscriptionId) {
      const s = await getSubOnce();
      if (s?.name) products = [{ name: s.name, quantity: totalQuantity(s) }];
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
      const s = await getSubOnce();
      if (s) currentTotal = totalQuantity(s);
    }

    // Provisioned column, for a "pending" (status: processing -- the same
    // status this page's Licenses column already treats as "not final yet",
    // see licensesCellHtml() in client.js) order: Ingram hasn't provisioned
    // anything yet, so `provisioningDate` is empty. By request, show WHEN
    // the change will take effect instead, once detail's been loaded.
    // Primary source: a `change` order's own `details[].description` spells
    // out the new billing period as free text -- confirmed against real
    // data, e.g. "... Recurring (1 Month(s) term) from 2026-09-18 through
    // 2026-10-17" -- the "from" date is the date this change actually
    // activates. Not every order carries this (renewal/cancellation types
    // have no `details` array at all -- same gap the product-name fallback
    // above works around), so when no such date can be found, falls back to
    // the subscription's own next `renewalDate` instead, per request.
    let effectiveDate = null;
    if (detail.status === 'processing') {
      const lineWithDate = (detail.details || []).find((d) => /from\s+\d{4}-\d{2}-\d{2}\s+through/.test(d.description || ''));
      const match = lineWithDate && lineWithDate.description.match(/from\s+(\d{4}-\d{2}-\d{2})\s+through/);
      if (match) {
        effectiveDate = match[1];
      } else if (detail.subscriptionId) {
        const s = await getSubOnce();
        effectiveDate = s?.renewalDate || null;
      }
    }

    return { poNumber: detail.poNumber || null, products, currentTotal, effectiveDate };
  } catch (err) {
    if (err.response?.status === 429 && attempt < MAX_ATTEMPTS) {
      const retryAfterHeader = err.response.headers['retry-after'];
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;
      const backoffMs = retryAfterMs ?? Math.min(1000 * 2 ** (attempt - 1), 15000) + Math.random() * 500;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      return fetchOrderDetailWithRetry(id, token, attempt + 1);
    }
    console.error(`Failed to fetch order detail for ${id}:`, err.message);
    return { poNumber: null, products: [], currentTotal: null, effectiveDate: null };
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
    const data = await getReport(
      sinceDate,
      req.query.client,
      req.query.includeRenewals === 'true',
      req.query.includeAllRenewals === 'true',
      req.query.includeCancelled === 'true',
      req.query.status,
      req.query.product,
      req.query.force === 'true'
    );
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
