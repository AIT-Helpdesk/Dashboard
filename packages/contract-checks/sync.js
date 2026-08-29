// Pulls Ingram Micro order data into this package's own database -- the
// "Ingram Micro Subscription Updates" Contract Process Type. Reuses the
// exact method packages/ingram-orders/server.js already uses (same
// @dashboard/ingram-client calls, same early-stopping pagination, same
// per-order detail fetch with 429-retry-with-backoff and the memoized
// subscription lookup) -- adapted to write into db.js instead of returning
// JSON to a client. See this package's README for the full sync design
// (bootstrap vs incremental vs refresh-outstanding).
//
// Loads the root .env itself, same as packages/strety-autotask-sync/sync.js
// -- harmless (dotenv doesn't override already-set vars) when this runs
// inside the already-running shell server (which loads the same file at its
// own startup), and necessary for this to work when run standalone
// (`node sync.js`, e.g. from a future scheduled task -- see README).
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const { getToken, getPage, fetchAllPages, getOrderDetail, getSubscriptionDetail } = require('@dashboard/ingram-client');
const { getClient, listAll, matchesWildcard } = require('@dashboard/autotask-client');
const { upsertOrder, getSyncState, saveSyncState, listOutstandingProcessing, nowIso } = require('./db.js');

const PROCESS_TYPE = 'ingram_subscription';
// Confirmed with Amber during planning: the first-ever sync reaches back to
// 1 August 2026 for ordinary orders (see runSync()'s bootstrap step for the
// separate full-history scan that also catches older still-processing
// stragglers). Australia/Brisbane has no DST, so a plain UTC-midnight
// literal compared against Ingram's UTC creationDate strings is close
// enough for a one-time bootstrap cutoff -- unlike the day-boundary-precise
// aestDayBoundsIso() used for the "Since" filter people actually pick on
// the page, a few hours of slop here doesn't matter.
const BOOTSTRAP_CUTOFF_ISO = '2026-08-01T00:00:00Z';

// Same paginate-and-stop-early method as packages/ingram-orders/server.js's
// fetchOrdersSince() -- Ingram's /orders returns its full history sorted
// newest-first by creationDate by default (confirmed against the real API),
// so walking from offset 0 and stopping the moment an order's creationDate
// falls before the threshold is correct and efficient for "orders since
// date X" without fetching the whole history.
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

// Sums a subscription's own product-line quantities -- same as Ingram
// Orders' totalQuantity(). null (not 0) when the subscription carries no
// product lines, so a caller can tell "no quantity info" apart from a real
// zero.
function totalQuantity(sub) {
  const subProducts = sub.products || [];
  return subProducts.length > 0 ? subProducts.reduce((sum, p) => sum + (typeof p.quantity === 'number' ? p.quantity : 0), 0) : null;
}

// Same fetchOrderDetailWithRetry() as packages/ingram-orders/server.js,
// copied and adapted: the getSubOnce() memoized subscription lookup, the
// product-name fallback for renewal/cancellation orders, the change-order
// current-total lookup, and the pending-date computation (Ingram Orders
// calls this effectiveDate; renamed here to match this package's own
// pending_date column, which -- per request -- is a separate field from
// provisioning_date, never written into it) are all unchanged logic.
// Returns null (rather than a hollow object) on a fetch that still fails
// after every retry -- this is a background job, not a UI render, so
// skipping the order for THIS run and picking it back up on the next sync
// (it stays un-synced, or stays whatever it already was in the DB) is
// better than writing a mostly-empty row.
async function fetchOrderDetailWithRetry(id, token, attempt = 1) {
  const MAX_ATTEMPTS = 6;
  try {
    const detail = await getOrderDetail(id, token);
    let products = (detail.products || [])
      .filter((p) => p.name)
      .map((p) => ({ name: p.name, quantity: typeof p.quantity === 'number' ? p.quantity : null }));

    let sub;
    let subFetchAttempted = false;
    async function getSubOnce() {
      if (subFetchAttempted || !detail.subscriptionId) return sub;
      subFetchAttempted = true;
      try {
        sub = await getSubscriptionDetail(detail.subscriptionId, token);
      } catch {
        // Leaves sub undefined -- each caller below already treats that as "couldn't resolve".
      }
      return sub;
    }

    if (products.length === 0 && detail.subscriptionId) {
      const s = await getSubOnce();
      if (s?.name) products = [{ name: s.name, quantity: totalQuantity(s) }];
    }

    let currentTotal = null;
    if (detail.type === 'change' && detail.subscriptionId && products.some((p) => typeof p.quantity === 'number')) {
      const s = await getSubOnce();
      if (s) currentTotal = totalQuantity(s);
    }

    let pendingDate = null;
    if (detail.status === 'processing') {
      const lineWithDate = (detail.details || []).find((d) => /from\s+\d{4}-\d{2}-\d{2}\s+through/.test(d.description || ''));
      const match = lineWithDate && lineWithDate.description.match(/from\s+(\d{4}-\d{2}-\d{2})\s+through/);
      if (match) {
        pendingDate = match[1];
      } else if (detail.subscriptionId) {
        const s = await getSubOnce();
        pendingDate = s?.renewalDate || null;
      }
    }

    return {
      status: detail.status || null,
      type: detail.type || null,
      creationDate: detail.creationDate || null,
      customerId: detail.customerId || null,
      orderNumber: detail.orderNumber || null,
      poNumber: detail.poNumber || null,
      products,
      currentTotal,
      pendingDate,
    };
  } catch (err) {
    if (err.response?.status === 429 && attempt < MAX_ATTEMPTS) {
      const retryAfterHeader = err.response.headers['retry-after'];
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;
      const backoffMs = retryAfterMs ?? Math.min(1000 * 2 ** (attempt - 1), 15000) + Math.random() * 500;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      return fetchOrderDetailWithRetry(id, token, attempt + 1);
    }
    console.error(`Contract Checks: failed to fetch order detail for ${id}:`, err.message);
    return null;
  }
}

// Same pattern as Workshop's resolveTicketAutotaskId() -- a network blip
// shouldn't block a sync run, so any failure just leaves the ticket
// unlinked rather than failing the whole order.
async function resolveTicketAutotaskId(poNumber) {
  const trimmed = (poNumber || '').trim();
  if (!trimmed) return null;
  try {
    const client = await getClient();
    const matches = await listAll(client.tickets, [{ op: 'eq', field: 'ticketNumber', value: trimmed }]);
    return matches.length === 1 ? matches[0].id : null;
  } catch (err) {
    console.error('Contract Checks: ticket lookup failed for', trimmed, err.message);
    return null;
  }
}

// RN Renewal orders' PO # is never meaningful, by request -- Ingram auto-
// renewals carry over the PO from the original order they're renewing,
// which then wrongly links the renewal to that OLD ticket. Cleared here at
// sync time (never even looked up against Autotask below), not just hidden
// in the UI, so the underlying data stays correct regardless of how it's
// displayed. "RN Renewal" = orderType 'renewal' AND an order number
// starting "RN" (by request) -- not every renewal, only this subset.
function isRnRenewal(orderType, orderNumber) {
  return orderType === 'renewal' && matchesWildcard(orderNumber || '', 'RN*');
}

// Fetches detail, resolves the ticket, and upserts one order into the
// database. `orderStub` is either a real /orders list entry or just an
// {id} (the "refresh outstanding" call site only has the local DB's own
// source_order_id to go on) -- either shape works, since fetchOrderDetailWithRetry's
// own response already carries every field upsertOrder() actually needs.
async function syncOneOrder(orderStub, token, customerNameById) {
  const detail = await fetchOrderDetailWithRetry(orderStub.id, token);
  if (!detail) return false;

  const customerId = detail.customerId || orderStub.customerId || null;
  const orderNumber = detail.orderNumber || orderStub.orderNumber || null;
  const orderType = detail.type || orderStub.type || null;
  const clearPo = isRnRenewal(orderType, orderNumber);
  const poNumber = clearPo ? null : detail.poNumber;
  // No PO means nothing to resolve a ticket link from either -- skip the
  // lookup entirely rather than resolving against the (now-discarded) real
  // PO just to throw the result away.
  const ticketAutotaskId = clearPo ? null : await resolveTicketAutotaskId(detail.poNumber);

  upsertOrder({
    processType: PROCESS_TYPE,
    sourceOrderId: String(orderStub.id),
    orderNumber,
    orderType,
    customerId,
    clientName: customerNameById.get(customerId) || (customerId ? `Customer #${customerId}` : null),
    status: detail.status || orderStub.status || null,
    creationDate: detail.creationDate || orderStub.creationDate || null,
    provisioningDate: orderStub.provisioningDate || null,
    pendingDate: detail.pendingDate,
    poNumber,
    ticketAutotaskId,
    products: detail.products,
    currentTotal: detail.currentTotal,
  });
  return true;
}

// The one job this package runs, either from the "Check for more Orders in
// IM" button (server.js's POST /sync) or, later, standalone via
// `node sync.js` if a scheduled task ever gets added -- see the
// require.main check at the bottom.
async function runSync() {
  const token = await getToken();
  const customers = await fetchCustomers(token);
  const customerNameById = new Map(customers.map((c) => [c.id, c.name]));
  const state = getSyncState(PROCESS_TYPE);

  let newCount = 0;
  let refreshedCount = 0;

  try {
    if (!state.bootstrap_done) {
      // 1a: incremental walk from the fixed bootstrap cutoff to now.
      const newOrders = await fetchOrdersSince(token, BOOTSTRAP_CUTOFF_ISO);
      for (const o of newOrders) {
        if (await syncOneOrder(o, token, customerNameById)) newCount++;
      }

      // 1b: one-time full-history scan for stragglers still 'processing'
      // and older than the bootstrap cutoff -- likely incomplete Annual
      // license changes that predate the normal incremental window (an
      // annual-term change order can sit in 'processing' for months until
      // its actual renewal date). Cheap list-only scan first (no per-order
      // detail -- Ingram's /orders has no confirmed server-side status
      // filter, so this walks every page), THEN detail only for the
      // (expected small) matching set.
      const allStubs = await fetchAllPages('/orders', token);
      const alreadySeen = new Set(newOrders.map((o) => o.id));
      const stragglers = allStubs.filter((o) => o.status === 'processing' && o.creationDate < BOOTSTRAP_CUTOFF_ISO && !alreadySeen.has(o.id));
      for (const o of stragglers) {
        if (await syncOneOrder(o, token, customerNameById)) newCount++;
      }

      const maxCreationDate = newOrders.reduce((max, o) => (o.creationDate > max ? o.creationDate : max), BOOTSTRAP_CUTOFF_ISO);
      saveSyncState(PROCESS_TYPE, { bootstrap_done: 1, last_creation_date_seen: maxCreationDate });
    } else {
      // 2a: incremental walk from the stored cursor to now.
      const cursor = state.last_creation_date_seen || BOOTSTRAP_CUTOFF_ISO;
      const newOrders = await fetchOrdersSince(token, cursor);
      const newIds = new Set();
      for (const o of newOrders) {
        newIds.add(String(o.id));
        if (await syncOneOrder(o, token, customerNameById)) newCount++;
      }

      // 2b: refresh outstanding -- any DB row still 'processing' that
      // wasn't already touched above. This is what catches a status
      // flipping from processing -> completed/cancelled (request #1's
      // "created OR PROCESSED since you last collected them"), and keeps
      // the bootstrap's Annual stragglers current going forward without
      // ever needing another full-history scan.
      const outstanding = listOutstandingProcessing(PROCESS_TYPE);
      for (const row of outstanding) {
        if (newIds.has(row.source_order_id)) continue;
        if (await syncOneOrder({ id: row.source_order_id }, token, customerNameById)) refreshedCount++;
      }

      if (newOrders.length > 0) {
        const maxCreationDate = newOrders.reduce((max, o) => (o.creationDate > max ? o.creationDate : max), cursor);
        saveSyncState(PROCESS_TYPE, { last_creation_date_seen: maxCreationDate });
      }
    }

    const message = `Synced ${newCount} new, refreshed ${refreshedCount} outstanding.`;
    saveSyncState(PROCESS_TYPE, { last_run_at: nowIso(), last_run_ok: 1, last_run_message: message, last_run_new_count: newCount, last_run_refreshed_count: refreshedCount });
    return { ok: true, newCount, refreshedCount, message };
  } catch (err) {
    console.error('Contract Checks sync failed:', err);
    saveSyncState(PROCESS_TYPE, {
      last_run_at: nowIso(),
      last_run_ok: 0,
      last_run_message: err.message,
      last_run_new_count: newCount,
      last_run_refreshed_count: refreshedCount,
    });
    return { ok: false, newCount, refreshedCount, message: err.message };
  }
}

// resolveTicketAutotaskId also exported -- reused by server.js's PATCH
// /items/:id when a user manually edits a row's PO # (Ticket #), by
// request, so the linked Autotask ticket gets re-resolved the same way a
// sync run would resolve it, not a separate copy of this lookup.
module.exports = { runSync, PROCESS_TYPE, resolveTicketAutotaskId };

if (require.main === module) {
  runSync()
    .then((result) => {
      console.log(result.message);
      process.exit(result.ok ? 0 : 1);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
