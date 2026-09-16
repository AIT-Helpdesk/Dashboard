const express = require('express');
const { getClient, listAll, fetchByFieldIn, getPicklistLabels, getTicketUrl, mapWithConcurrency, resolveCompanyName } = require('@dashboard/autotask-client');

// Resources.licenseType 7 is "API User" -- same real fact confirmed
// against real data in @dashboard/times' own README, reused here rather
// than re-derived. Excluded from the Resource Name dropdown -- an
// integration service account has no real ticket time of its own to
// narrow down to.
const API_USER_LICENSE_TYPE = 7;

async function fetchAccrualResources(client) {
  const resources = await listAll(client.resources, [{ op: 'eq', field: 'isActive', value: true }]);
  return resources
    .filter((r) => r.licenseType !== API_USER_LICENSE_TYPE)
    .map((r) => ({ id: r.id, name: [r.firstName, r.lastName].filter(Boolean).join(' ').trim() || `Resource #${r.id}` }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// "Work Type" is TimeEntries.billingCodeID -- same field, same real
// confirmed strings, as @dashboard/times' own Work-Type Reconciliation
// section (see that page's README "Confirmed against real data" section):
// 13 real distinct values exist in this tenant, these 4 get their own
// column here, by request, everything else folds into "Other".
// "Accrue--END-No Bill" -- a real space before "Bill", not a hyphen,
// confirmed against real data (times/README.md); the request's own
// "Accrue--END-No-Bill" is normalized to match, same "request spelling ->
// real confirmed spelling" convention that page's own WORK_TYPE_FIXED_LIST
// already established.
const WORK_TYPE_ACCRUE_ING = 'Accrue--ING';
const WORK_TYPE_ACCRUE_END = 'Accrue--END';
const WORK_TYPE_ACCRUE_END_NO_BILL = 'Accrue--END-No Bill';
const WORK_TYPE_STANDARD_SUPPORT = '.Standard Support';

// Same real "Complete" bucket @dashboard/times' own Accrue--ING-by-Status
// table already uses (its own README: real status labels `Complete` id 5
// and `Billing - Contract` id 20) -- reused verbatim here to split the
// two lists, by request ("1st list for Complete tickets (include Billing
// - Contract) and the second list for all others").
const COMPLETE_STATUS_LABELS = new Set(['Complete', 'Billing - Contract']);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// "Work Type" name is resolved via the real BillingCodes entity, NOT
// getPicklistLabels() -- confirmed the hard way (a real diagnostic run
// against this exact route returned "Work Type #29682804" instead of a
// real name): billingCodeID is a reference to a real BillingCodes record,
// not a small-integer picklist value, so getPicklistLabels() (which reads
// Autotask's entityInformation/fields picklist metadata) silently resolves
// nothing for it. Same client.billingCodes + fetchByFieldIn(..., 'id',
// ...) resolution @dashboard/times' own fetchWorkTypeBreakdown() uses.
async function resolveBillingCodeNames(client, entries) {
  const billingCodeIds = [...new Set(entries.map((e) => e.billingCodeID).filter((id) => id !== null && id !== undefined))];
  const billingCodes = billingCodeIds.length > 0 ? await fetchByFieldIn(client.billingCodes, 'id', billingCodeIds) : [];
  return new Map(billingCodes.map((c) => [c.id, c.name]));
}
function resolveWorkType(billingCodeID, nameById) {
  return billingCodeID !== null && billingCodeID !== undefined ? nameById.get(billingCodeID) || `Work Type #${billingCodeID}` : 'No Work Type';
}

// Validates the request and resolves which tickets QUALIFY -- real Accrue
// activity (ANY real Work Type name starting with "Accrue-", single
// hyphen, so it also catches a hypothetical future "Accrue-something")
// somewhere in the SELECTED PERIOD. Confirmed the hard way, by request
// ("are you only showing tickets that HAVE at least one time entry work
// type starting with Accrue-?") -- a real diagnostic run found 259 of 304
// rows had ZERO Accrue-* time and shouldn't have been shown at all; only
// 45 real tickets actually had any.
//
// Also splits those qualifying tickets by real Ticket Status into
// Complete (incl. Billing - Contract) vs Not Complete -- BEFORE either
// route below fetches a ticket's own all-time TimeEntries history (the
// expensive part, see buildRows() below) -- by request ("for the second
// table, don't retrieve the data initially"): the main route only ever
// builds full rows for the Complete list; the Not Complete list's own
// tickets are resolved here too (so the split itself is cheap and always
// correct) but their own history is left unfetched until the "Show
// Incomplete Tickets" button below calls the separate /incomplete route.
async function resolveTicketSplit(client, req) {
  const { from, to } = req.query;
  if (!from || !DATE_RE.test(from)) return { error: 'Query param "from" is required in YYYY-MM-DD format.' };
  if (!to || !DATE_RE.test(to)) return { error: 'Query param "to" is required in YYYY-MM-DD format.' };
  if (to < from) return { error: '"to" must not be before "from".' };

  const fromIso = `${from}T00:00:00.000Z`;
  const toIso = `${to}T00:00:00.000Z`;

  // Only ticket-linked time -- "Use the date to select time entries in
  // that period" -- but this first fetch is used ONLY to decide WHICH
  // tickets qualify, not to compute the columns themselves. Every
  // column's own sum comes from buildRows()'s own all-time fetch -- see
  // that function's comment for why.
  const filter = [
    { op: 'gte', field: 'dateWorked', value: fromIso },
    { op: 'lte', field: 'dateWorked', value: toIso },
    { op: 'exist', field: 'ticketID' },
  ];

  const resourceIdParam = (req.query.resourceId || '').toString();
  if (resourceIdParam) {
    const resourceId = parseInt(resourceIdParam, 10);
    if (!Number.isInteger(resourceId)) return { error: 'Query param "resourceId" must be a real resource id.' };
    filter.push({ op: 'eq', field: 'resourceID', value: resourceId });
  }

  // Ticket Number -> real ticketID, resolved first so the TimeEntries
  // query itself can be scoped to one real ticket -- exact match against
  // Tickets.ticketNumber (the human-readable "T20260101.0001"-style
  // value), not the internal numeric id. A real, typo'd, or since-
  // renumbered ticket number that matches nothing returns an empty result
  // with `ticketNumberNotFound: true` rather than silently falling back
  // to "every ticket in the date range".
  const ticketNumberParam = (req.query.ticketNumber || '').toString().trim();
  if (ticketNumberParam) {
    const matches = await listAll(client.tickets, [{ op: 'eq', field: 'ticketNumber', value: ticketNumberParam }]);
    if (matches.length === 0) return { from, to, ticketNumberNotFound: true, completeTicketIds: [], incompleteTicketIds: [] };
    filter.push({ op: 'eq', field: 'ticketID', value: matches[0].id });
  }

  const periodEntries = await listAll(client.timeEntries, filter);
  if (periodEntries.length === 0) return { from, to, completeTicketIds: [], incompleteTicketIds: [] };

  const periodBillingCodeNameById = await resolveBillingCodeNames(client, periodEntries);
  const qualifyingTicketIds = new Set();
  for (const e of periodEntries) {
    if (resolveWorkType(e.billingCodeID, periodBillingCodeNameById).startsWith('Accrue-')) qualifyingTicketIds.add(e.ticketID);
  }
  if (qualifyingTicketIds.size === 0) return { from, to, completeTicketIds: [], incompleteTicketIds: [] };

  const ticketIds = [...qualifyingTicketIds];
  const tickets = await fetchByFieldIn(client.tickets, 'id', ticketIds);
  const ticketById = new Map(tickets.map((t) => [t.id, t]));
  const statusLabelById = await getPicklistLabels(client.tickets, 'status');

  const completeTicketIds = [];
  const incompleteTicketIds = [];
  for (const ticketId of ticketIds) {
    const ticket = ticketById.get(ticketId);
    const status = ticket && ticket.status !== null && ticket.status !== undefined ? statusLabelById.get(ticket.status) || `Status #${ticket.status}` : 'Unknown';
    (COMPLETE_STATUS_LABELS.has(status) ? completeTicketIds : incompleteTicketIds).push(ticketId);
  }

  return { from, to, completeTicketIds, incompleteTicketIds, ticketById, statusLabelById };
}

// Builds full rows (every column, all-time totals) for exactly the given
// ticket ids -- the expensive part (a second, unfiltered TimeEntries
// fetch per ticket's own ENTIRE history), so callers only pay for it for
// the tickets they actually need rows for.
//
// Every column's own sum comes from each ticket's ENTIRE real history,
// not just the entries inside the selected period -- confirmed with the
// user, by request ("The Accrue--ING values aren't right. Example.
// Ticket T20260729.0029"): that real ticket's own Accrue--ING work
// happened weeks before the Accrue--END work that closed it out, so
// scoping the sums to the selected period alone showed 2.68h, 0.45h, or
// 0h for the exact same real ticket depending on which date range
// happened to be picked -- none of them wrong exactly, just an artifact
// of an arbitrary window clipping a ticket's real total, which also broke
// the whole point of the END-vs-ING reconciliation shading. The date
// date range's job (resolveTicketSplit() above) is only to decide which
// tickets qualify and which list they land in; once a ticket is being
// built here, every column reflects its whole real history, unfiltered
// by date, resource, or (beyond having already resolved it to one
// ticketID) Ticket Number.
async function buildRows(client, ticketIds, ticketById, statusLabelById) {
  if (ticketIds.length === 0) return [];

  const allTimeEntries = await fetchByFieldIn(client.timeEntries, 'ticketID', ticketIds);
  const billingCodeNameById = await resolveBillingCodeNames(client, allTimeEntries);

  // One bucket set per ticket -- the 4 named Work Type sums plus Other,
  // and (per ticket, not globally -- two different tickets' own "Other"
  // mixes can differ) the distinct real Work Type names that actually
  // fell into Other, for the tooltip.
  const byTicket = new Map();
  for (const e of allTimeEntries) {
    if (!byTicket.has(e.ticketID)) {
      byTicket.set(e.ticketID, {
        accrueIng: 0,
        accrueEnd: 0,
        accrueEndNoBill: 0,
        standardSupport: 0,
        other: 0,
        otherWorkTypes: new Set(),
      });
    }
    const bucket = byTicket.get(e.ticketID);
    const hours = e.hoursWorked || 0;
    // Accrue--END / Accrue--END-No Bill entries very often carry a real
    // TimeEntries.offsetHours value on top of hoursWorked -- confirmed
    // against real data, by request ("Accrue--END and --END-NO BILL
    // often have a time offset. please add the time offset when summing
    // the time"): 25 of 28 real END/No-Bill entries for one real week
    // had a real nonzero offsetHours (e.g. 1.4833h, 1.1667h, 2h), each
    // logged alongside a near-zero hoursWorked (~0.0167h, a one-minute
    // "closing click") -- the real accrued time sits in offsetHours, not
    // hoursWorked, for these two work types specifically. Accrue--ING
    // never does this (confirmed: 0 of 49 real ING entries the same week
    // had any offsetHours at all), so ING is deliberately left out of this
    // adjustment. Widened to .STD and Other too, by request ("adjust up
    // or down by any offset entered for .STD and OTHER as well") -- same
    // adjustedHours figure, just applied to two more buckets; offsetHours
    // can be negative as well as positive (an "adjust down" is a real,
    // legitimate case, not just the "closing click" pattern END/No-Bill
    // usually shows), so this is a plain add, not a max(0, ...) floor.
    const adjustedHours = hours + (e.offsetHours || 0);
    const workType = resolveWorkType(e.billingCodeID, billingCodeNameById);
    if (workType === WORK_TYPE_ACCRUE_ING) bucket.accrueIng += hours;
    else if (workType === WORK_TYPE_ACCRUE_END) bucket.accrueEnd += adjustedHours;
    else if (workType === WORK_TYPE_ACCRUE_END_NO_BILL) bucket.accrueEndNoBill += adjustedHours;
    else if (workType === WORK_TYPE_STANDARD_SUPPORT) bucket.standardSupport += adjustedHours;
    else {
      bucket.other += adjustedHours;
      bucket.otherWorkTypes.add(workType);
    }
  }

  const rows = await mapWithConcurrency(ticketIds, 5, async (ticketId) => {
    const bucket = byTicket.get(ticketId);
    const ticket = ticketById.get(ticketId);
    const status = ticket && ticket.status !== null && ticket.status !== undefined ? statusLabelById.get(ticket.status) || `Status #${ticket.status}` : 'Unknown';
    return {
      ticketId,
      ticketNumber: ticket?.ticketNumber || `#${ticketId}`,
      // Between Ticket # and Ticket Title, by request -- resolveCompanyName()
      // caches internally (same convention every other page's own company-
      // name lookup already relies on), so a client with several qualifying
      // tickets is still only ever resolved once.
      clientName: ticket ? await resolveCompanyName(client, ticket.companyID) : '',
      ticketTitle: ticket?.title || '',
      ticketUrl: await getTicketUrl(ticketId),
      status,
      accrueIng: bucket.accrueIng,
      accrueEnd: bucket.accrueEnd,
      accrueEndNoBill: bucket.accrueEndNoBill,
      standardSupport: bucket.standardSupport,
      other: bucket.other,
      otherWorkTypes: [...bucket.otherWorkTypes].sort(),
    };
  });

  const byTicketNumber = (a, b) => (a.ticketNumber || '').localeCompare(b.ticketNumber || '');
  return rows.sort(byTicketNumber);
}

const router = express.Router();

router.get('/resources', async (req, res) => {
  try {
    const client = await getClient();
    res.json({ resources: await fetchAccrualResources(client) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const client = await getClient();
    const split = await resolveTicketSplit(client, req);
    if (split.error) return res.status(400).json({ error: split.error });
    if (split.ticketNumberNotFound) return res.json({ from: split.from, to: split.to, completeRows: [], ticketNumberNotFound: true });

    const completeRows = await buildRows(client, split.completeTicketIds, split.ticketById, split.statusLabelById);
    res.json({ from: split.from, to: split.to, completeRows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// The "Not Complete" list -- fetched on demand only, by request ("for the
// second table, don't retrieve the data initially ... add a button for
// Show Incomplete Tickets"), same "faster by default" reasoning
// @dashboard/times' own Work-Type Reconciliation "Show" button uses.
// Independently re-derives the same qualifying-ticket split the main
// route above does (same "each on-demand route re-derives its own scope
// rather than trying to share it across separate HTTP requests"
// convention that page's own /work-type route already established) --
// only the incomplete half of that split gets its own (expensive)
// all-time-history rows built here.
router.get('/incomplete', async (req, res) => {
  try {
    const client = await getClient();
    const split = await resolveTicketSplit(client, req);
    if (split.error) return res.status(400).json({ error: split.error });
    if (split.ticketNumberNotFound) return res.json({ from: split.from, to: split.to, otherRows: [], ticketNumberNotFound: true });

    const otherRows = await buildRows(client, split.incompleteTicketIds, split.ticketById, split.statusLabelById);
    res.json({ from: split.from, to: split.to, otherRows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
