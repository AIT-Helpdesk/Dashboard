const express = require('express');
const { matchesWildcard, aestDayBoundsIso, getTicketUrl, getClient, fetchByFieldIn, getPicklistLabels, resolveCompanyName, mapWithConcurrency } = require('@dashboard/autotask-client');
const { TOGGLE_FIELDS, setToggle, updateItemFields, listItemsRaw, getItemHistory, getToggleHistories, getHistoryCounts, listTemplates, getTemplate, setTemplate, getItem } = require('./db.js');
const { runSync, PROCESS_TYPE, resolveTicketAutotaskId } = require('./sync.js');

// Edit Template (below) is restricted to Amber, by request -- same pattern
// TC Elite Rollout's own COLUMN_ADMIN_EMAIL uses. Checked here again, not
// just in client.js's matching gate, since a client-side-only check is
// trivially bypassed by anyone hitting the API directly.
const CONTRACT_CHECKS_ADMIN_EMAIL = 'amber@ambientit.com.au';
function isContractChecksAdmin(req) {
  const email = req.session.user?.email;
  return !!email && email.toLowerCase() === CONTRACT_CHECKS_ADMIN_EMAIL;
}

// Saving a Ticket Note, by request, also closes out the real linked
// Autotask ticket: posts the note text as a real ticket note (title below)
// and sets the ticket's status to Complete. noteType/status are the exact
// values already confirmed safe for THIS Autotask tenant elsewhere in this
// codebase (packages/workshop/server.js's own TICKET_NOTE_TYPE/
// TICKET_NOTE_PUBLISH, and packages/completed-tickets/server.js's "status
// 5 = Complete") -- reused rather than re-verified, since the Autotask
// field-metadata endpoints (entityInformation) are returning 401 for this
// integration at the moment, so a fresh independent check isn't possible
// right now. "Internal & Co-Managed" is the closest confirmed-safe match
// this tenant has for "Internal" -- there's no plainer "Internal Only"
// option already confirmed working here (see Workshop's own comment on
// why it picked this value). Revisit if a stricter option turns out to
// exist and matters here.
// Two titles, by request -- "Write Note (Don't Close)" must be unmistakable
// in the ticket's own note list that the status was deliberately NOT
// touched, not just a shorter/differently-worded version of the close note.
const TICKET_NOTE_TITLE_CLOSING = 'Closing Ticket using Dashboard Contract Checks';
const TICKET_NOTE_TITLE_NOT_CLOSING = 'NOT Closing Ticket using Dashboard Contract Checks';
const TICKET_NOTE_TYPE = 3; // "Task Notes"
const TICKET_NOTE_PUBLISH = 4; // "Internal & Co-Managed"
const TICKET_STATUS_COMPLETE = 5;
// "Billing - Contract" -- the same confirmed status id this dashboard
// already relies on elsewhere (packages/strety-autotask-sync/metrics.js's
// own CLOSED_STATUSES, cross-referenced against packages/client-summary/
// server.js), not a fresh guess.
const TICKET_STATUS_BILLING_CONTRACT = 20;
// FIX BILLING / Needs Internal Update -- the "reopen ticket to..." choices
// on the ALL DONE untick confirmation, by request. Freshly verified (not
// reused from elsewhere) against this tenant's real live ticket status
// picklist (Tickets entityInformation/fields), which is reachable again --
// the 401 noted above for TICKET_NOTE_TYPE/TICKET_NOTE_PUBLISH was a
// temporary state at the time that comment was written, not a permanent
// block.
const TICKET_STATUS_FIX_BILLING = 50;
const TICKET_STATUS_NEEDS_INTERNAL_UPDATE = 15;
// The untick confirmation's own status choices, by request -- validated
// against this set server-side (not just left to whatever the client's
// fixed <select> happens to send) so a stray/tampered value can't set the
// ticket to an arbitrary status through this route.
const REOPEN_STATUS_CHOICES = [TICKET_STATUS_BILLING_CONTRACT, TICKET_STATUS_FIX_BILLING, TICKET_STATUS_NEEDS_INTERNAL_UPDATE];
const TICKET_STATUS_LABELS = {
  [TICKET_STATUS_BILLING_CONTRACT]: 'Billing - Contract',
  [TICKET_STATUS_FIX_BILLING]: 'FIX Billing',
  [TICKET_STATUS_NEEDS_INTERNAL_UPDATE]: 'Needs Internal Update',
};
const TICKET_NOTE_TITLE_REOPENING = 'Reopening Ticket using Dashboard Contract Checks';

// autotask-node's own Tickets.update()/patch() both PUT/PATCH to
// /Tickets/{id} -- confirmed directly against the real API this tenant
// returns a genuine 405 "does not support http method" for BOTH verbs at
// that path (not an auth/outage artifact -- reproduced through this exact
// route in production, twice, before this fix). Bypassing the library's
// own (apparently mismatched) Tickets entity entirely here, calling the
// underlying client.axios directly instead -- client.axios is the same
// authenticated axios instance the library itself uses internally
// (AutotaskClient exposes it as a public property), so this reuses the
// exact same auth/base-URL setup, just a different endpoint shape:
// Autotask's real, working convention for this tenant is PATCH to the bare
// COLLECTION endpoint with `id` in the body, not PATCH/PUT to /{entity}/{id}
// -- confirmed working in production for the Complete case.
async function setTicketStatus(ticketAutotaskId, status) {
  // Explicit logging on both sides, deliberately -- calling client.axios
  // directly (bypassing the library's own Tickets entity) also bypasses
  // whatever request logging that entity's executeRequest() wrapper
  // normally provides, confirmed against real logs: the note-posting call
  // (which DOES go through the library's own ticketNotes entity) logs a
  // full "Making request"/"Request completed" pair, this one logged
  // nothing at all either way -- no evidence of success OR failure. That
  // made a real incident impossible to diagnose after the fact.
  console.log(`Contract Checks: setting ticket ${ticketAutotaskId} to status ${status}...`);
  try {
    const client = await getClient();
    const res = await client.axios.patch('/Tickets', { id: ticketAutotaskId, status });
    console.log(`Contract Checks: ticket ${ticketAutotaskId} status update succeeded (HTTP ${res.status}).`);
    return { ok: true };
  } catch (err) {
    console.error(`Contract Checks: failed to update ticket ${ticketAutotaskId} to status ${status}:`, err.message);
    return { ok: false, error: err.message };
  }
}

// Reopening a ticket (unticking ALL DONE to any status other than "Leave as
// COMPLETE"), by request, leaves the same kind of note trail closing one
// does -- a reviewer looking at the ticket's own note history should be
// able to see it was reopened via this dashboard, by whom, when, and to
// what status, not just find the status changed with no explanation. No
// note for "Leave as COMPLETE" -- nothing actually changed on the ticket in
// that case, so there's nothing to describe.
async function postReopenNote(ticketAutotaskId, targetStatus, actor) {
  const client = await getClient();
  const statusLabel = TICKET_STATUS_LABELS[targetStatus] || `status ${targetStatus}`;
  const description = [
    `Ticket reopened -- status changed to ${statusLabel}.`,
    '',
    '-------------------------',
    `Reopened by: ${actor.name} -- ${new Date().toLocaleString()}`,
  ].join('\n');
  try {
    await client.ticketNotes.create(ticketAutotaskId, {
      title: TICKET_NOTE_TITLE_REOPENING,
      description,
      noteType: TICKET_NOTE_TYPE,
      publish: TICKET_NOTE_PUBLISH,
    });
    return { ok: true };
  } catch (err) {
    console.error(`Contract Checks: failed to post reopen note for ticket ${ticketAutotaskId}:`, err.message);
    return { ok: false, error: err.message };
  }
}

// Note-first, fail-closed -- same shape as postTicketNoteAndClose() below
// (if the note fails, don't even attempt the status change), so a reopened
// ticket never ends up with a real status change but no note explaining it.
async function reopenTicketWithNote(ticketAutotaskId, targetStatus, actor) {
  const noteResult = await postReopenNote(ticketAutotaskId, targetStatus, actor);
  if (!noteResult.ok) {
    return { ok: false, statusReverted: false, newStatus: targetStatus, notePosted: false, error: `Note: ${noteResult.error}` };
  }
  const statusResult = await setTicketStatus(ticketAutotaskId, targetStatus);
  if (!statusResult.ok) {
    return { ok: false, statusReverted: false, newStatus: targetStatus, notePosted: true, error: `Status: ${statusResult.error}` };
  }
  return { ok: true, statusReverted: true, newStatus: targetStatus, notePosted: true };
}

// Best-effort is NOT the right shape here (unlike Workshop's fire-and-forget
// audit notes) -- this is a deliberate, consequential action the user is
// initiating (closing a real ticket), so it's awaited and its outcome
// reported back to the client rather than silently swallowed on failure.
// `bulkWithList` (array of strings, e.g. "T20260824.0006 (orders CH005820,
// CH005821)"), when non-empty, is a bulk-close (see POST /items/bulk-close
// below) -- adds a "Bulk Closed with:" line naming every OTHER TICKET
// closed in the same batch, by request, before the Closed by/timestamp
// line. Deliberately excludes the ticket this note is itself being posted
// to -- "closed WITH these others" reads oddly listing itself. `noteText`
// is either one order's own text (a single close, or a bulk order that's
// the only one on its ticket) or, when several selected orders share the
// same real ticket, POST /items/bulk-close pre-merges all of their own
// text into one string (each section headed "Order: <number>") before it
// ever reaches this function -- either way this function just posts
// whatever it's given as ONE note, never more than one per ticket.
// Which of the per-order checkboxes are ticked, by request -- named
// explicitly in the note so a reviewer can see what was actually confirmed
// without switching back to the dashboard. Only the ticked ones are listed
// (by request -- "no need to mention the unticked ones"); ALL DONE itself
// isn't in this list since it's the very toggle that's triggering the note.
const CHECK_FIELD_LABELS = {
  checked_contract: 'Checked Contract',
  m365_ok: 'M365 OK',
  tc_elite: 'TC ELITE',
  tc_ess: 'TC ESS',
  others: 'OTHERS',
};
function ticketChecksLine(row) {
  const ticked = Object.entries(CHECK_FIELD_LABELS)
    .filter(([field]) => row[`${field}_at`])
    .map(([, label]) => label);
  return ticked.length > 0 ? `Checks ticked: ${ticked.join(', ')}` : null;
}

// One order's own contribution to a ticket note: its Ticket Note text (or
// the same "(no note text)" fallback a blank one always got) plus which
// checkboxes are ticked on THAT order. `includeHeader` adds the "Order:
// <number>" line bulk-close needs when several orders share one note (see
// POST /items/bulk-close below) -- a single close passes false, since
// there's only ever one order in that note.
function orderNoteBody(item, { includeHeader }) {
  const parts = [];
  if (includeHeader) parts.push(`Order: ${item.order_number}`);
  parts.push(item.ticket_note || '(no note text)');
  const checksLine = ticketChecksLine(item);
  if (checksLine) parts.push(checksLine);
  return parts.join('\n');
}

// closeTicket (default true), by request -- "Write Note (Don't Close)" posts
// the same note, titled distinctly (see TICKET_NOTE_TITLE_NOT_CLOSING
// above), but deliberately skips the status change. That's a deliberate
// outcome, not a failure -- statusClosed simply stays false while ok stays
// true, so the existing "only alert the user on failure" logic on the
// client correctly stays quiet for it.
async function postTicketNoteAndClose(ticketAutotaskId, noteText, actor, bulkWithList = null, closeTicket = true) {
  const client = await getClient();
  const result = { notePosted: false, statusClosed: false, error: null };

  // Who actually closed it (or noted it) and when, by request -- Autotask's
  // own note "created by" would otherwise just show this integration's own
  // API user, not the real staff member who clicked ALL DONE in the
  // dashboard, since the note is posted via a service account.
  const byLabel = closeTicket ? 'Closed by' : 'Noted by';
  const bulkLabel = closeTicket ? 'Bulk Closed with' : 'Bulk Noted with';

  const lines = [noteText || '(no note text)', '', '-------------------------'];
  if (bulkWithList && bulkWithList.length > 0) {
    lines.push(`${bulkLabel}: ${bulkWithList.join(', ')}`);
  }
  lines.push(`${byLabel}: ${actor.name} -- ${new Date().toLocaleString()}`);
  const description = lines.join('\n');

  try {
    await client.ticketNotes.create(ticketAutotaskId, {
      title: closeTicket ? TICKET_NOTE_TITLE_CLOSING : TICKET_NOTE_TITLE_NOT_CLOSING,
      description,
      noteType: TICKET_NOTE_TYPE,
      publish: TICKET_NOTE_PUBLISH,
    });
    result.notePosted = true;
  } catch (err) {
    console.error(`Contract Checks: failed to post ticket note for ticket ${ticketAutotaskId}:`, err.message);
    result.error = `Note: ${err.message}`;
    return { ok: false, ...result };
  }

  if (!closeTicket) {
    return { ok: true, ...result };
  }

  const statusResult = await setTicketStatus(ticketAutotaskId, TICKET_STATUS_COMPLETE);
  if (!statusResult.ok) {
    result.error = `Status: ${statusResult.error}`;
    return { ok: false, ...result };
  }
  result.statusClosed = true;

  return { ok: true, ...result };
}

// snake_case DB row -> camelCase API shape. products_json is parsed back
// into the same {name, quantity} array shape Ingram Orders already uses on
// the wire, so the client's licensesCellHtml()-style rendering can be
// reused verbatim.
function shapeItem(row) {
  return {
    id: row.id,
    processType: row.process_type,
    customerId: row.customer_id,
    orderNumber: row.order_number,
    orderType: row.order_type,
    clientName: row.client_name,
    status: row.status,
    creationDate: row.creation_date,
    provisioningDate: row.provisioning_date,
    pendingDate: row.pending_date,
    poNumber: row.po_number,
    ticketAutotaskId: row.ticket_autotask_id,
    products: JSON.parse(row.products_json || '[]'),
    currentTotal: row.current_total,
    checkedContractAt: row.checked_contract_at,
    checkedContractByName: row.checked_contract_by_name,
    infoQuestion: row.info_question,
    infoAnswer: row.info_answer,
    m365OkAt: row.m365_ok_at,
    m365OkByName: row.m365_ok_by_name,
    tcEliteAt: row.tc_elite_at,
    tcEliteByName: row.tc_elite_by_name,
    tcEssAt: row.tc_ess_at,
    tcEssByName: row.tc_ess_by_name,
    othersAt: row.others_at,
    othersByName: row.others_by_name,
    ticketNote: row.ticket_note,
    allDoneAt: row.all_done_at,
    allDoneByName: row.all_done_by_name,
  };
}

// Orders for these products are hidden entirely, by request -- not a
// toggleable filter, a permanent exclusion. Wildcard, not exact equality --
// confirmed against real synced data the actual name carries a trailing
// SKU/term qualifier that varies ("Windows 11 Home to Pro Upgrade for
// Microsoft 365 Business (NCE COM BAS PER 1TM)"), same "(NCE COM MTH)"-style
// suffix variance seen elsewhere in Ingram's own product names. Add more
// patterns here if another product turns out to be the same kind of noise.
const HIDDEN_PRODUCT_PATTERNS = ['Windows 11 Home to Pro Upgrade*'];
function hasHiddenProduct(o) {
  return (o.products || []).some((p) => HIDDEN_PRODUCT_PATTERNS.some((pattern) => matchesWildcard(p.name, pattern)));
}

// Mirrors packages/ingram-orders/server.js's buildReport() -- the same
// renewals/cancelled three-state gate (Show Renewals partial / Show ALL
// Renewals / Show Cancelled, including the nonRenewalClientIds trick for
// the partial mode) and client grouping, adapted to filter an array of
// already-synced local rows instead of live Ingram orders. showAllDone
// is the one gate Ingram Orders has no equivalent of (request #10) -- off
// by default, same "outer gate" shape as the others.
function buildResponse(items, { filterTerm, statusTerm, productTerm, includeRenewals, includeAllRenewals, includeCancelled, showAllDone, hideRenewalOrProcessingOnly }) {
  const nonRenewalClientIds = new Set();
  for (const o of items) {
    if (hasHiddenProduct(o)) continue;
    if (o.orderType === 'renewal') continue;
    if (!includeCancelled && o.status === 'cancelled') continue;
    if (statusTerm && !matchesWildcard(o.status || '', statusTerm)) continue;
    if (filterTerm && !matchesWildcard(o.clientName || '', filterTerm)) continue;
    nonRenewalClientIds.add(o.customerId);
  }

  const byClientMap = new Map();
  for (const o of items) {
    if (hasHiddenProduct(o)) continue;
    if (!showAllDone && o.allDoneAt) continue;
    if (o.orderType === 'renewal') {
      if (includeAllRenewals) {
        // include unconditionally
      } else if (includeRenewals && nonRenewalClientIds.has(o.customerId)) {
        // this client has another surviving order -- include the renewal too
      } else {
        continue;
      }
    }
    if (!includeCancelled && o.status === 'cancelled') continue;
    if (statusTerm && !matchesWildcard(o.status || '', statusTerm)) continue;
    if (filterTerm && !matchesWildcard(o.clientName || '', filterTerm)) continue;
    if (productTerm && !(o.products || []).some((p) => matchesWildcard(p.name, productTerm))) continue;

    const key = o.customerId || o.clientName || 'unknown';
    if (!byClientMap.has(key)) byClientMap.set(key, { customerId: o.customerId, clientName: o.clientName, orders: [] });
    byClientMap.get(key).orders.push(o);
  }

  // Client groups sorted alphabetically by request -- orders WITHIN a
  // client stay newest-first regardless (already true here for free:
  // db.js's listItemsRaw() selects with ORDER BY creation_date DESC, and
  // nothing above re-sorts, so push() above preserves that order).
  let byClient = [...byClientMap.values()]
    .map((g) => ({ ...g, count: g.orders.length }))
    .sort((a, b) => (a.clientName || '').localeCompare(b.clientName || ''));

  // Hide clients with only Type=Renewal or Status=Processing, by request --
  // a client with nothing BUT renewals/still-processing orders (among what's
  // already visible after every other filter above) has nothing actionable
  // to check right now, so the whole client group drops out. Applied after
  // every other gate (renewals/cancelled/status/product/ALL DONE), not
  // instead of them -- this only ever removes MORE, on top of what's
  // already been filtered per-order.
  if (hideRenewalOrProcessingOnly) {
    byClient = byClient.filter((g) => g.orders.some((o) => o.orderType !== 'renewal' && o.status !== 'processing'));
  }

  const matched = byClient.flatMap((g) => g.orders);
  const statusCounts = {};
  for (const o of matched) {
    const key = o.status || 'unknown';
    statusCounts[key] = (statusCounts[key] || 0) + 1;
  }

  return { totalCount: matched.length, statusCounts, byClient };
}

// Client/status/title for the ticket-number hover tooltip, by request --
// none of this is fetched anywhere else on this page (getTicketUrl() above
// just builds a URL from the known ticketAutotaskId, no ticket record
// lookup at all). Called AFTER buildResponse() with only the orders it's
// actually about to return, not the full pre-filter set -- fetching
// details for orders that got filtered out would be pure waste. One
// batched "id in [...]" query for every distinct linked ticket still
// visible, not one request per row. Cached for 5 minutes per ticket
// (short, deliberately -- unlike a note or a URL, a ticket's status is
// exactly the kind of thing that changes often and this tooltip's whole
// point is showing it accurately) so repeated page loads/refreshes in a
// short span don't redo the same work.
const TICKET_DETAILS_CACHE_TTL_MS = 5 * 60 * 1000;
const ticketDetailsCache = new Map(); // ticketAutotaskId -> { data, expiresAt }

async function attachTicketDetails(orders) {
  const neededIds = [...new Set(orders.filter((o) => o.ticketAutotaskId).map((o) => o.ticketAutotaskId))];
  if (neededIds.length === 0) return;

  const now = Date.now();
  const idsToFetch = neededIds.filter((id) => {
    const cached = ticketDetailsCache.get(id);
    return !cached || now >= cached.expiresAt;
  });

  if (idsToFetch.length > 0) {
    try {
      const client = await getClient();
      const [tickets, statusLabels] = await Promise.all([
        fetchByFieldIn(client.tickets, 'id', idsToFetch),
        getPicklistLabels(client.tickets, 'status'),
      ]);
      const companyIds = [...new Set(tickets.map((t) => t.companyID).filter((id) => id != null))];
      // Warms resolveCompanyName()'s own cache with bounded concurrency
      // first (same pattern Contract Services' server.js already uses),
      // rather than each ticket below awaiting its own company lookup one
      // at a time.
      await mapWithConcurrency(companyIds, 3, (id) => resolveCompanyName(client, id));
      for (const t of tickets) {
        ticketDetailsCache.set(t.id, {
          data: {
            title: t.title || null,
            status: statusLabels.get(t.status) || (t.status != null ? `Status ${t.status}` : null),
            clientName: t.companyID != null ? await resolveCompanyName(client, t.companyID) : null,
          },
          expiresAt: now + TICKET_DETAILS_CACHE_TTL_MS,
        });
      }
    } catch (err) {
      // Best-effort -- this tooltip is a nice-to-have, not something worth
      // failing the whole page load over. Orders whose ticket details
      // couldn't be fetched just fall back to whatever's already cached
      // (possibly nothing), same as any other cache miss.
      console.error('Contract Checks: failed to fetch ticket details for tooltip:', err.message);
    }
  }

  for (const o of orders) {
    if (!o.ticketAutotaskId) continue;
    const cached = ticketDetailsCache.get(o.ticketAutotaskId);
    if (!cached) continue;
    o.ticketStatus = cached.data.status;
    o.ticketTitle = cached.data.title;
    o.ticketClientName = cached.data.clientName;
  }
}

// Flags an order's linked ticket as having passed through "Rewst - Stage
// Done" at some point in its status history, by request (Contract Checks
// and Check Client both show a small icon in the PO # cell when true).
// Confirmed against the real API: TicketHistory can't be filtered by
// multiple ticket ids at once ("you are required to supply one and only
// one ticketID equals filter") -- unlike attachTicketDetails() above, this
// genuinely needs one request per distinct ticket, not one batched query.
// Bounded concurrency (mapWithConcurrency), not fully sequential, to keep
// that from being painfully slow with several tickets on screen at once.
//
// Cached asymmetrically, deliberately -- history is append-only, so once a
// ticket is confirmed to have passed through this status that fact can
// never become false again (cached ~indefinitely, just for basic memory
// hygiene); a "no" result, by contrast, can genuinely change the moment
// this ticket next hits that status, so it's only cached briefly and gets
// rechecked periodically.
const REWST_FLAG_TRUE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REWST_FLAG_FALSE_CACHE_TTL_MS = 20 * 60 * 1000;
const rewstFlagCache = new Map(); // ticketAutotaskId -> { value: boolean, expiresAt }

async function attachRewstStageDoneFlags(orders) {
  const neededIds = [...new Set(orders.filter((o) => o.ticketAutotaskId).map((o) => o.ticketAutotaskId))];
  if (neededIds.length === 0) return;

  const now = Date.now();
  const idsToFetch = neededIds.filter((id) => {
    const cached = rewstFlagCache.get(id);
    return !cached || now >= cached.expiresAt;
  });

  if (idsToFetch.length > 0) {
    const client = await getClient();
    await mapWithConcurrency(idsToFetch, 5, async (id) => {
      try {
        const historyRes = await client.ticketHistory.list({ filter: { ticketID: id } });
        const rows = historyRes.data || historyRes || [];
        const hasRewst = rows.some((r) => r.action === 'Status Changed' && /Rewst - Stage Done/i.test(r.detail || ''));
        rewstFlagCache.set(id, { value: hasRewst, expiresAt: now + (hasRewst ? REWST_FLAG_TRUE_CACHE_TTL_MS : REWST_FLAG_FALSE_CACHE_TTL_MS) });
      } catch (err) {
        // Best-effort, same reasoning as attachTicketDetails() above -- and
        // deliberately left OUT of the cache on failure (not cached as
        // false), so a transient error here doesn't get remembered as a
        // real "no" for the next 20 minutes.
        console.error(`Contract Checks: failed to fetch ticket history for Rewst flag (ticket ${id}):`, err.message);
      }
    });
  }

  for (const o of orders) {
    if (!o.ticketAutotaskId) continue;
    const cached = rewstFlagCache.get(o.ticketAutotaskId);
    if (cached) o.hasRewstStageDone = cached.value;
  }
}

// Pulled out of GET / below into its own function, by request -- so the new
// Check Client page (packages/check-client) can call this exact same
// DB-read-plus-enrichment step in-process (via router.loadEnrichedItems,
// attached below) instead of duplicating it. Behavior is unchanged from
// when this lived inline in the route -- getTicketUrl() caches across
// invocations (@dashboard/autotask-client), so this only costs a real
// request the first time any given ticketAutotaskId is looked up.
async function loadEnrichedItems(processType, sinceIso) {
  const rawRows = listItemsRaw(processType, sinceIso);
  const itemIds = rawRows.map((r) => r.id);
  const toggleHistories = getToggleHistories(itemIds);
  const historyCounts = getHistoryCounts(itemIds);

  return Promise.all(
    rawRows.map(async (row) => {
      const shaped = shapeItem(row);
      shaped.ticketUrl = row.ticket_autotask_id ? await getTicketUrl(row.ticket_autotask_id) : null;
      shaped.toggleHistory = toggleHistories[row.id] || {};
      shaped.historyCount = historyCounts[row.id] || 0;
      return shaped;
    })
  );
}

const router = express.Router();
router.use(express.json());

router.get('/', async (req, res) => {
  // "All" checkbox in the filter bar, by request -- no date restriction at
  // all, so "since" isn't required in this case (and is ignored if sent
  // anyway -- the checkbox also disables the Since input client-side).
  const allDates = req.query.all === 'true';
  const sinceDate = req.query.since;
  if (!allDates && (!sinceDate || !/^\d{4}-\d{2}-\d{2}$/.test(sinceDate))) {
    return res.status(400).json({ error: 'Query param "since" is required in YYYY-MM-DD format (or pass all=true).' });
  }
  try {
    const startISO = allDates ? null : aestDayBoundsIso(sinceDate).startISO; // AEST midnight of the selected date, not UTC
    const processType = req.query.processType || PROCESS_TYPE;
    const items = await loadEnrichedItems(processType, startISO);

    const filterTerm = req.query.client;
    const statusTerm = req.query.status;
    const productTerm = req.query.product;
    const includeRenewals = req.query.includeRenewals === 'true';
    const includeAllRenewals = req.query.includeAllRenewals === 'true';
    const includeCancelled = req.query.includeCancelled === 'true';
    const showAllDone = req.query.showAllDone === 'true';
    const hideRenewalOrProcessingOnly = req.query.hideRenewalOrProcessingOnly === 'true';

    const { totalCount, statusCounts, byClient } = buildResponse(items, {
      filterTerm,
      statusTerm,
      productTerm,
      includeRenewals,
      includeAllRenewals,
      includeCancelled,
      showAllDone,
      hideRenewalOrProcessingOnly,
    });
    // Only the orders actually being returned, by request -- see
    // attachTicketDetails()'s own comment for why this runs after
    // filtering, not before. Run together, not sequentially -- they hit
    // Autotask independently and don't depend on each other's results.
    const visibleOrders = byClient.flatMap((g) => g.orders);
    await Promise.all([attachTicketDetails(visibleOrders), attachRewstStageDoneFlags(visibleOrders)]);

    res.json({
      asOf: new Date().toISOString(),
      sinceDate: allDates ? null : sinceDate,
      allDates,
      processType,
      filterTerm: filterTerm || null,
      statusTerm: statusTerm || null,
      productTerm: productTerm || null,
      includeRenewals,
      includeAllRenewals,
      includeCancelled,
      showAllDone,
      hideRenewalOrProcessingOnly,
      totalCount,
      statusCounts,
      byClient,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// The "Check for more Orders in IM" button (request #11).
router.post('/sync', async (req, res) => {
  try {
    const result = await runSync();
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// One checkbox, one toggle -- body { field, value }. field is validated
// against TOGGLE_FIELDS (checked_contract/m365_ok/tc_elite/tc_ess/others/
// all_done); setToggle() stamps or clears the date-time and always
// audits (see db.js's own comment on why, unlike Workshop's equipment
// checklist).
router.patch('/items/:id/toggle', async (req, res) => {
  const { field, value, closeTicket, reopenStatus } = req.body || {};
  if (!TOGGLE_FIELDS.includes(field)) {
    return res.status(400).json({ error: `field must be one of: ${TOGGLE_FIELDS.join(', ')}` });
  }

  // Validated up front, before setToggle() runs below -- rejecting a bad
  // reopenStatus AFTER the checkbox has already flipped in the DB would
  // leave the untick "successful" locally but the response reading as an
  // error, which is confusing. 'leave' means "leave the ticket as
  // COMPLETE" (by request) -- deliberately not sending any status change
  // at all, not the same as reopening it TO Complete.
  if (field === 'all_done' && !value && reopenStatus !== 'leave' && !REOPEN_STATUS_CHOICES.includes(Number(reopenStatus))) {
    return res.status(400).json({ error: `reopenStatus must be one of ${REOPEN_STATUS_CHOICES.join(', ')}, or "leave".` });
  }

  // Locked once ALL DONE is ticked, by request -- every OTHER checkbox
  // stops being editable until ALL DONE itself is unticked first. ALL DONE
  // is deliberately exempt from its own lock (otherwise there'd be no way
  // to ever unlock a row again). Checked here (not just left to the client
  // to grey out) so a stale page, or a direct API call, can't bypass it.
  if (field !== 'all_done') {
    const existing = getItem(Number(req.params.id));
    if (existing && existing.all_done_at) {
      return res.status(400).json({ error: 'Untick ALL DONE before changing any other checkbox on this order.' });
    }
  }

  const actor = { email: req.session.user.email, name: req.session.user.name };
  const updated = setToggle(Number(req.params.id), field, !!value, actor);
  if (!updated) return res.status(404).json({ error: 'Item not found.' });

  // Closing out the real Autotask ticket, by request -- moved here from
  // the Ticket Note save (see git history) to instead fire when ALL DONE
  // gets TICKED specifically (not unticked, and not any other toggle).
  // Posts whatever's currently saved in this item's own Ticket Note field
  // (not re-typed here -- ALL DONE is a plain checkbox, no text of its
  // own) -- skipped entirely (not an error) when there's no linked ticket,
  // same as before. `closeTicket` (default true unless explicitly false) is
  // the "Write Note (Don't Close)" option, by request -- ALL DONE still
  // gets ticked locally either way; only the real Autotask status change is
  // conditional.
  // Unticking ALL DONE, by request, asks which status to reopen the ticket
  // to (see reopenStatus validation above) instead of always sending it
  // back to "Billing - Contract" -- posts a reopen note (postReopenNote,
  // above) describing the action, then makes the status change
  // (reopenTicketWithNote) -- unlike the old behavior, which changed status
  // with no note at all. "Leave as COMPLETE" skips both the note and the
  // status change entirely -- a deliberate no-op, not a failure, so ok
  // stays true. Same skip-if-no-linked-ticket rule as the ticking-ON case.
  let ticketAction = null;
  if (field === 'all_done' && updated.ticket_autotask_id) {
    if (value) {
      ticketAction = await postTicketNoteAndClose(
        updated.ticket_autotask_id,
        orderNoteBody(updated, { includeHeader: false }),
        actor,
        null,
        closeTicket !== false
      );
    } else if (reopenStatus === 'leave') {
      ticketAction = { ok: true, statusReverted: false, statusLeftAsComplete: true };
    } else {
      ticketAction = await reopenTicketWithNote(updated.ticket_autotask_id, Number(reopenStatus), actor);
    }
  }

  res.json({ ok: true, ticketAction });
});

// Bulk close, by request -- client.js's row-selection checkboxes gate
// WHEN this fires (only once the last visible selected row's ALL DONE gets
// ticked), but every actual write happens here, server-side, all at once.
// Ticks ALL DONE for every item in the batch (each gets its own audit
// entry, same as an individual toggle), then for every item with a
// resolved ticket posts that item's OWN note (even if blank, same
// fallback as a single close) with a "Bulk Closed with:" line naming
// every OTHER ticket in the batch that also has one. Items without a
// resolved ticket still get ALL DONE ticked locally -- same
// skip-the-Autotask-part-only rule a single close already follows.
router.post('/items/bulk-close', async (req, res) => {
  const itemIds = Array.isArray(req.body?.itemIds) ? req.body.itemIds.map(Number).filter(Number.isInteger) : [];
  if (itemIds.length === 0) return res.status(400).json({ error: 'itemIds (a non-empty array) is required.' });
  // "Write Note (Don't Close)" (default true unless explicitly false), by
  // request -- one choice for the whole batch, since the confirm dialog
  // that produces it is only asked once per batch, not once per item.
  const closeTicket = req.body?.closeTicket !== false;

  const items = itemIds.map((id) => getItem(id)).filter(Boolean);
  if (items.length !== itemIds.length) return res.status(404).json({ error: 'One or more items were not found.' });

  const customerIds = new Set(items.map((i) => i.customer_id));
  if (customerIds.size > 1) {
    return res.status(400).json({ error: 'All selected items must belong to the same client.' });
  }

  const actor = { email: req.session.user.email, name: req.session.user.name };

  // Tick ALL DONE for every selected item regardless of ticket grouping --
  // each Ingram order is still its own row/record in this dashboard, with
  // its own independent audit trail, even when several of them share one
  // real Autotask ticket below.
  for (const item of items) {
    setToggle(item.id, 'all_done', true, actor);
  }

  // Group by the REAL ticket, by request -- "sometimes the same ticket
  // number will be on several rows... merge the notes all into one note...
  // you only need to close each ticket once as well." One
  // postTicketNoteAndClose() call per DISTINCT ticket_autotask_id, not one
  // per item, so a ticket shared by N orders gets exactly one merged note
  // and one status change, never N of each.
  const groupsByTicket = new Map(); // ticketAutotaskId -> items[]
  const itemsWithoutTicket = [];
  for (const item of items) {
    if (item.ticket_autotask_id) {
      if (!groupsByTicket.has(item.ticket_autotask_id)) groupsByTicket.set(item.ticket_autotask_id, []);
      groupsByTicket.get(item.ticket_autotask_id).push(item);
    } else {
      itemsWithoutTicket.push(item);
    }
  }

  // "Bulk Closed with" now lists OTHER TICKETS in the batch (one entry per
  // distinct ticket, all its order numbers together), not one entry per
  // order -- orders sharing a ticket already show up together in that
  // ticket's own merged note via their own "Order:" headers, so repeating
  // them again in every other ticket's note would be redundant.
  const ticketLabels = [...groupsByTicket.entries()].map(([ticketId, groupItems]) => ({
    ticketId,
    label: `${groupItems[0].po_number} (order${groupItems.length > 1 ? 's' : ''} ${groupItems.map((i) => i.order_number).join(', ')})`,
  }));

  console.log(`Contract Checks: bulk-close starting for ${items.length} item(s) across ${groupsByTicket.size} ticket(s): ${items.map((i) => i.order_number).join(', ')}`);
  const results = [];
  for (const [ticketId, groupItems] of groupsByTicket) {
    console.log(`Contract Checks: bulk-close processing ticket ${ticketId} (orders: ${groupItems.map((i) => i.order_number).join(', ')})...`);
    // Each order's own note content, prefixed with its own order number, by
    // request -- even a blank one still gets a "(no note text)" line under
    // its own header, same as a single close never silently drops an
    // order's section just because it had nothing typed. Each order's own
    // ticked checkboxes go under its own section too, not just once for the
    // whole ticket -- orders sharing a ticket can have different checks
    // ticked.
    const mergedNoteText = groupItems.map((i) => orderNoteBody(i, { includeHeader: true })).join('\n\n-------------------------\n\n');
    const bulkWithList = ticketLabels.filter((t) => t.ticketId !== ticketId).map((t) => t.label);
    const ticketAction = await postTicketNoteAndClose(ticketId, mergedNoteText, actor, bulkWithList, closeTicket);
    console.log(`Contract Checks: bulk-close result for ticket ${ticketId}:`, JSON.stringify(ticketAction));
    for (const item of groupItems) {
      results.push({ itemId: item.id, orderNumber: item.order_number, ticketAction });
    }
  }
  for (const item of itemsWithoutTicket) {
    results.push({ itemId: item.id, orderNumber: item.order_number, ticketAction: null });
  }
  console.log(`Contract Checks: bulk-close finished for ${items.length} item(s).`);

  res.json({ ok: true, results });
});

// The Info Q&A stamp + Ticket Note free-text fields -- body carries
// whichever of { infoQuestion, infoAnswer, ticketNote } is being saved.
router.patch('/items/:id', async (req, res) => {
  const body = req.body || {};

  // Locked once ALL DONE is ticked, by request -- same rule as the
  // checkbox toggle route above, scoped here to Info Q&A/Ticket Note only
  // (PO # correction stays allowed even on a done order -- fixing a wrong
  // ticket link isn't the kind of "still working on this order" edit ALL
  // DONE is meant to guard against).
  if ('infoQuestion' in body || 'infoAnswer' in body || 'ticketNote' in body) {
    const existing = getItem(Number(req.params.id));
    if (existing && existing.all_done_at) {
      return res.status(400).json({ error: 'Untick ALL DONE before changing Info or Ticket Note on this order.' });
    }
  }

  const fields = {};
  if ('infoQuestion' in body) fields.infoQuestion = body.infoQuestion ? String(body.infoQuestion).trim() : null;
  if ('infoAnswer' in body) fields.infoAnswer = body.infoAnswer ? String(body.infoAnswer).trim() : null;
  if ('ticketNote' in body) fields.ticketNote = body.ticketNote ? String(body.ticketNote).trim() : null;
  // Manually editing the PO # (Ticket #), by request -- re-resolves the
  // linked Autotask ticket the same way sync.js's own syncOneOrder() does,
  // so a correction here also fixes the ticket link, not just the display
  // text. async route -- this is a real Autotask lookup, not a DB read.
  if ('poNumber' in body) {
    fields.poNumber = body.poNumber ? String(body.poNumber).trim() : null;
    fields.ticketAutotaskId = await resolveTicketAutotaskId(fields.poNumber);
  }

  const actor = { email: req.session.user.email, name: req.session.user.name };
  const updated = updateItemFields(Number(req.params.id), fields, actor);
  if (!updated) return res.status(404).json({ error: 'Item not found.' });
  res.json({ ok: true });
});

// Full audit trail for one item -- every toggle (ON and OFF) and every
// text-field edit, most recent first. Powers the shared History modal
// (packages/shell/public/styles.css's .history-modal-*, same pattern
// packages/workshop/client.js's openHistoryModal() already uses).
router.get('/items/:id/history', (req, res) => {
  const history = getItemHistory(Number(req.params.id)).map((h) => ({
    field: h.field,
    oldValue: h.old_value,
    newValue: h.new_value,
    changedAt: h.changed_at,
    changedByName: h.changed_by_name,
  }));
  res.json({ history });
});

// DB-backed canned text ("Get Note Template"/"Edit Template" in the Ticket
// Note popup, client.js) -- see db.js's own comment on templates for why
// this exists (a real Autotask feature this replaced has no REST API).

// Key/name/last-updated for every template, no content -- for a future
// picker once a second template exists (only 'ticket_note' today). Not
// used by the client yet.
router.get('/templates', (req, res) => {
  res.json({
    templates: listTemplates().map((t) => ({ key: t.key, name: t.name, updatedAt: t.updated_at, updatedByName: t.updated_by_name })),
  });
});

router.get('/templates/:key', (req, res) => {
  const template = getTemplate(req.params.key);
  if (!template) return res.status(404).json({ error: 'Template not found.' });
  res.json({ key: template.key, name: template.name, content: template.content, updatedAt: template.updated_at, updatedByName: template.updated_by_name });
});

router.patch('/templates/:key', (req, res) => {
  if (!isContractChecksAdmin(req)) {
    return res.status(403).json({ error: 'Editing the note template is restricted to Amber for now.' });
  }
  const { name, content } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'name (a non-empty string) is required.' });
  if (typeof content !== 'string') return res.status(400).json({ error: 'content (a string) is required.' });
  const actor = { email: req.session.user.email, name: req.session.user.name };
  const template = setTemplate(req.params.key, { name: name.trim(), content }, actor);
  res.json({ key: template.key, name: template.name, content: template.content, updatedAt: template.updated_at, updatedByName: template.updated_by_name });
});

// Attached to the router (a function, so it can carry extra named
// properties) rather than changed on module.exports itself -- the shell
// still needs `require('./server.js')` to BE the router it mounts. Lets the
// new Check Client page (packages/check-client) call this exact same
// item-loading + filter/group logic in-process, instead of duplicating it
// or making an HTTP round-trip back into this same server.
router.loadEnrichedItems = loadEnrichedItems;
router.buildResponse = buildResponse;
// Lets Check Client's own /orders route add the same Rewst - Stage Done
// icon flag to its results, by request -- it calls loadEnrichedItems/
// buildResponse above directly too, bypassing this file's own GET / route
// (and therefore never running this function on its own).
router.attachRewstStageDoneFlags = attachRewstStageDoneFlags;

module.exports = router;
