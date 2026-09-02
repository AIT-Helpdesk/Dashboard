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
const { upsertOrder, getItemBySource, getSyncState, saveSyncState, listOutstandingProcessing, listCompletedMissingProvisioningDate, nowIso } = require('./db.js');

const PROCESS_TYPE = 'ingram_subscription';
// A subscription that's terminated OUTSIDE Ingram's own ordering system --
// e.g. Ingram terminates it directly, no `cancellation`-type order ever
// gets raised for it -- never shows up in the orders-based sync above at
// all (confirmed with Amber: "there won't be an order"). Ingram's own
// /subscriptions list endpoint reports current STATUS directly though, so
// this is synced separately from the orders sync above -- but written into
// THIS SAME process_type (by request -- Amber wants terminations sitting
// in the normal "Ingram Micro Subscription Updates" list, not off in a
// separate Process Type of their own), tagged as its own order_type
// ('termination', never a real Ingram order type) so it's still clearly
// distinguishable within that shared list (Type/Status columns both read
// "Termination"/"Terminated").
//
// TWO Ingram statuses count as "ended" here, not just 'terminated' --
// confirmed live via a real missed case (a Business Standard subscription
// for "Brett Emery - Nevahnek" that ended 2026-09-01 with genuinely no
// order behind it, exactly the gap this feature exists to catch, but
// Ingram reported it as status 'removed', not 'terminated'). 'removed' is
// a MUCH bigger bucket though (confirmed live: ~1,056 company-wide vs. 3
// 'terminated' at the same moment) -- most of it looks like routine
// month-to-month NCE subscription turnover (a fresh subscription record
// every renewal cycle, the old one marked 'removed'), not real endings.
// TERMINATION_CUTOFF_DATE below is what keeps that bucket from flooding
// this page with noise (confirmed with Amber: "we only want to get things
// that are terminated and their subscription end date in since 1/8/2026"
// -- 17 rows total across both statuses with that scoping, vs. ~1,059
// unscoped). Every row synced from either status still lands with the
// same literal status: 'terminated' below -- Ingram's status vocabulary
// split is plumbing, not something Amber's staff need to see two
// different words for.
// source_order_id is Ingram's own SUBSCRIPTION id here rather than an order
// id -- TERMINATION_ID_PREFIX keeps it in its own namespace within the
// UNIQUE(process_type, source_order_id) key now that it shares a
// process_type with orders, since Ingram's order ids and subscription ids
// are separate, unconfirmed-disjoint numbering sequences (no observed
// collision, but nothing rules one out either) -- prefixing costs nothing
// and removes the question entirely.
const TERMINATION_ID_PREFIX = 'sub-';
const TERMINATION_STATUSES = ['terminated', 'removed'];
// Confirmed with Amber during planning: the first-ever sync reaches back to
// 1 August 2026 for ordinary orders (see runSync()'s bootstrap step for the
// separate full-history scan that also catches older still-processing
// stragglers). Australia/Brisbane has no DST, so a plain UTC-midnight
// literal compared against Ingram's UTC creationDate strings is close
// enough for a one-time bootstrap cutoff -- unlike the day-boundary-precise
// aestDayBoundsIso() used for the "Since" filter people actually pick on
// the page, a few hours of slop here doesn't matter.
const BOOTSTRAP_CUTOFF_ISO = '2026-08-01T00:00:00Z';
// Same real cutoff date as orders' own BOOTSTRAP_CUTOFF_ISO above (by
// request, same "since 1/8/2026" scope in both places) -- plain date-string
// comparison against a subscription's own expirationDate ('YYYY-MM-DD'),
// which is what actually bounds the 'removed'-status noise described above.
const TERMINATION_CUTOFF_DATE = BOOTSTRAP_CUTOFF_ISO.slice(0, 10);

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
      // Confirmed live: the per-order detail endpoint carries its own real
      // provisioningDate, same field/value as the /orders list stub's own
      // copy -- not previously read here, which was the actual bug: the
      // "refresh outstanding" resync path (syncOneOrder below, called with
      // just {id}, no list stub at all) had no provisioningDate to fall
      // back on, so a status flip from processing -> completed picked up
      // via THAT path landed with provisioning_date left permanently blank.
      provisioningDate: detail.provisioningDate || null,
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
    // detail's own copy wins -- it's always present (fetched every call),
    // while orderStub.provisioningDate is only ever populated when this
    // order came from a /orders list page (the list stub carries it too);
    // the refresh-outstanding path below passes just {id}, so orderStub
    // never has it there at all. See fetchOrderDetailWithRetry's own
    // comment on this same field for the bug this fixes.
    provisioningDate: detail.provisioningDate || orderStub.provisioningDate || null,
    pendingDate: detail.pendingDate,
    poNumber,
    ticketAutotaskId,
    products: detail.products,
    currentTotal: detail.currentTotal,
  });
  return true;
}

// Terminations, unlike orders, have no per-event date to cursor on --
// Ingram's /subscriptions list reports current STATUS, not a "terminated
// on" timestamp, so there's no equivalent of fetchOrdersSince()'s "walk
// forward from where we left off" here. Instead: every run pulls the FULL
// current ended list across BOTH TERMINATION_STATUSES (a fixed cutoff, not
// a moving cursor -- there's nothing to "walk forward" from with only a
// current-status snapshot to work with either way), then narrows to
// TERMINATION_CUTOFF_DATE (see both constants' own comments above for why
// -- 'removed' alone is far too large to sync unscoped).
//
// "Only flag NEW terminations" (Amber's choice) means the ONE-TIME,
// expensive work -- the per-subscription detail fetch, for products -- only
// ever runs for a subscription id not already in the DB, via the same
// UNIQUE(process_type, source_order_id) row every item here is keyed on.
// (PO#/ticket resolution used to be part of that one-time work too, but is
// gone entirely now -- see the upsertOrder() call below's own comment on
// why.) It does NOT mean an already-known termination row is frozen
// forever, though -- the cheap fields the LIST response already carries for
// free (status/client name/dates) refresh on EVERY run, same "sync-driven
// fields stay current, human-entered fields never get touched" convention
// the orders sync's own refresh-outstanding pass already follows
// (upsertOrder's UPDATE path never touches checked_contract/the checkboxes/
// ticket_note/all_done regardless). This is also what self-heals a row
// synced under an earlier, less accurate date field (see the
// creationDate/provisioningDate comment below) the next time this runs,
// without needing a one-off backfill script.
async function syncTerminations(token, customerNameById) {
  const byStatus = await Promise.all(TERMINATION_STATUSES.map((status) => fetchAllPages('/subscriptions', token, { status })));
  // Confirmed live: some 'removed'/'terminated' subscriptions carry an
  // expirationDate years in the future (e.g. a handful of "Windows 11 Home
  // to Pro Upgrade" perpetual-license SKUs dated 2027/2035/2036) despite
  // already being ended TODAY -- that field is evidently the SKU's own
  // nominal term end, not a real "when did this actually end" signal for
  // those rows. Excluded here (by request, after finding a batch of these
  // in the live data) same as anything before TERMINATION_CUTOFF_DATE --
  // a termination whose own "end date" hasn't happened yet is nonsensical
  // to show as one. Same UTC-vs-AEST few-hours-of-slop tolerance as
  // BOOTSTRAP_CUTOFF_ISO's own comment -- not day-boundary-precise, and
  // doesn't need to be.
  const todayDate = new Date().toISOString().slice(0, 10);
  const ended = byStatus.flat().filter((sub) => {
    const end = sub.expirationDate || '';
    return end >= TERMINATION_CUTOFF_DATE && end <= todayDate;
  });
  let newCount = 0;

  for (const sub of ended) {
    const id = TERMINATION_ID_PREFIX + sub.id;
    const existing = getItemBySource(PROCESS_TYPE, id);

    let products = [];

    if (existing) {
      // Preserve the expensive field already resolved on this row's first
      // sync -- never re-fetched for a subscription already known.
      try {
        products = JSON.parse(existing.products_json || '[]');
      } catch {
        products = [];
      }
    } else {
      try {
        const detail = await getSubscriptionDetail(sub.id, token);
        products = (detail.products || []).filter((p) => p.name).map((p) => ({ name: p.name, quantity: typeof p.quantity === 'number' ? p.quantity : null }));
      } catch (err) {
        // Same "don't fail the whole sync over one subscription's detail
        // call" reasoning as fetchOrderDetailWithRetry -- the row still
        // gets synced below, just without product/license info this run
        // (a later run won't retry it either, since it'll already exist by
        // then, but losing that one cosmetic detail is far better than
        // losing the termination flag entirely over a transient failure).
        console.error(`Contract Checks: failed to fetch termination detail for subscription ${id}:`, err.message);
      }
      newCount++;
    }

    // PO # is deliberately left blank here, always, by request -- Ingram's
    // own `attributes.PONumber` on a terminated/removed subscription is
    // stale leftover data from whenever the subscription was last actually
    // ordered/changed, not anything meaningful about the termination
    // itself, so showing it (or resolving a ticket link from it) would be
    // actively misleading rather than merely incomplete. This never
    // overwrites a PO # a human enters manually via the edit pencil either
    // -- upsertOrder()'s own po_number_manual protection (db.js) applies
    // here exactly the same as it does for orders.
    upsertOrder({
      processType: PROCESS_TYPE,
      sourceOrderId: id,
      orderNumber: sub.name || null,
      orderType: 'termination',
      customerId: sub.customerId || null,
      clientName: customerNameById.get(sub.customerId) || (sub.customerId ? `Customer #${sub.customerId}` : null),
      status: 'terminated',
      // The subscription's own end date, by request -- NOT lastModifiedDate
      // (an earlier version of this used that instead, but it's actually
      // when the non-renewal DECISION was recorded, e.g. months before the
      // term actually ends, not when the subscription itself terminates).
      // expirationDate is the real "when did/does this end" field, so it
      // drives both the Since-date filter (creationDate, same field every
      // other row here sorts/filters by) and the Provisioned column
      // (provisioningDate) -- both intentionally the same date for a
      // termination row, since there's nothing else meaningfully
      // "provisioned" about one; reusing that column beats adding a new
      // one just for this. Falls back to lastModifiedDate/creationDate only
      // if a row genuinely has no expirationDate at all, so filtering never
      // breaks outright, but that's not expected to actually happen
      // (confirmed live -- present on every terminated subscription seen).
      creationDate: sub.expirationDate || sub.lastModifiedDate || sub.creationDate || null,
      provisioningDate: sub.expirationDate || null,
      pendingDate: null,
      poNumber: null,
      ticketAutotaskId: null,
      products,
      currentTotal: null,
    });
  }

  return newCount;
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
  let newTerminationsCount = 0;

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
      //
      // Also includes any row already 'completed' but still missing its
      // provisioning_date -- a real, confirmed bug (see
      // fetchOrderDetailWithRetry's own comment on provisioningDate above):
      // a status flip caught THROUGH THIS SAME refresh-outstanding path
      // (rather than the fresh-orders paths above, which get it from the
      // list stub) previously landed with provisioning_date left blank
      // forever, since nothing ever refetched a 'completed' row again once
      // it left 'processing'. Self-healing -- once a row picks up a real
      // date it stops matching this query, so it's a one-time catch-up for
      // every row already stuck this way, not a repeated no-op re-check.
      const outstanding = [...listOutstandingProcessing(PROCESS_TYPE), ...listCompletedMissingProvisioningDate(PROCESS_TYPE)];
      for (const row of outstanding) {
        if (newIds.has(row.source_order_id)) continue;
        if (await syncOneOrder({ id: row.source_order_id }, token, customerNameById)) refreshedCount++;
      }

      if (newOrders.length > 0) {
        const maxCreationDate = newOrders.reduce((max, o) => (o.creationDate > max ? o.creationDate : max), cursor);
        saveSyncState(PROCESS_TYPE, { last_creation_date_seen: maxCreationDate });
      }
    }

    // Runs every call regardless of the orders bootstrap/incremental branch
    // above -- see syncTerminations()'s own comment for why it's a full
    // snapshot rather than something with its own cursor/bootstrap state.
    newTerminationsCount = await syncTerminations(token, customerNameById);

    const message = `Synced ${newCount} new, refreshed ${refreshedCount} outstanding, ${newTerminationsCount} new termination${newTerminationsCount === 1 ? '' : 's'}.`;
    saveSyncState(PROCESS_TYPE, { last_run_at: nowIso(), last_run_ok: 1, last_run_message: message, last_run_new_count: newCount, last_run_refreshed_count: refreshedCount });
    return { ok: true, newCount, refreshedCount, newTerminationsCount, message };
  } catch (err) {
    console.error('Contract Checks sync failed:', err);
    saveSyncState(PROCESS_TYPE, {
      last_run_at: nowIso(),
      last_run_ok: 0,
      last_run_message: err.message,
      last_run_new_count: newCount,
      last_run_refreshed_count: refreshedCount,
    });
    return { ok: false, newCount, refreshedCount, newTerminationsCount, message: err.message };
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
