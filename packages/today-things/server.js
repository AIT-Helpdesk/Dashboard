const express = require('express');
const {
  getClient,
  listAll,
  fetchByFieldIn,
  mapWithConcurrency,
  resolveCompanyName,
  resolveResourceName,
  getTicketUrl,
  getPicklistLabels,
  aestToUtcIso,
  isoDateAest,
  todayAestKey,
} = require('@dashboard/autotask-client');

// A real, generally-available TV Boards page -- the first section is
// Service Calls, by request ("Let's put Service calls on this page
// first"), more to follow later. Read-only itself (no write routes of its
// own) -- every mutation (Open ticket/Change Date/Time/Mark Complete/
// Onsite TBA/Onsite Arranged) is a cross-page call straight to Service
// Calls' own already-live routes (packages/service-calls/server.js),
// exactly the same way What's On's Service Calls section already does it
// -- there's nothing about ServiceCalls.isComplete/status/dates that's
// specific to THIS page, so there's no reason to duplicate those writes
// here.

// Ticket status IDs that count as "closed" -- same [5, 20] convention as
// What's On's own identical constant (packages/whats-on/server.js: 5 =
// "Complete", 20 = "Billing - Contract"). Used by the Overdue group below
// to drop a stale, still-incomplete call whose linked ticket has since
// closed -- the call record itself was simply never marked complete,
// noise rather than something this board still needs to surface.
const CLOSED_TICKET_STATUSES = [5, 20];

// Same join/resolution logic as What's On's own buildServiceCallRows()
// (packages/whats-on/server.js) -- see that function's own comment for
// the full "why" (ServiceCalls has no resource field of its own,
// ServiceCallTickets/ServiceCallTicketResources have to be joined to find
// who's allocated). Trimmed down from that copy: no currentUserResourceId
// -- this page has no "Just Mine" filter (not asked for). requireOpenTicket
// IS carried over (by request, once the Overdue group was added below) --
// same meaning as What's On's own: additionally drops any call with no
// linked ticket at all, or whose linked ticket has since closed.
async function buildServiceCallRows(client, serviceCalls, { requireOpenTicket } = {}) {
  if (serviceCalls.length === 0) return [];

  const scTickets = await fetchByFieldIn(client.serviceCallTickets, 'serviceCallID', serviceCalls.map((sc) => sc.id));
  const scTicketIdsByServiceCallId = new Map();
  // The linked ticket is "the first one" -- same convention Service
  // Calls' own README documents for this exact join.
  const ticketIdByServiceCallId = new Map();
  for (const t of scTickets) {
    if (!scTicketIdsByServiceCallId.has(t.serviceCallID)) scTicketIdsByServiceCallId.set(t.serviceCallID, []);
    scTicketIdsByServiceCallId.get(t.serviceCallID).push(t.id);
    if (!ticketIdByServiceCallId.has(t.serviceCallID)) ticketIdByServiceCallId.set(t.serviceCallID, t.ticketID);
  }

  const ticketIds = [...new Set([...ticketIdByServiceCallId.values()].filter((id) => id !== null && id !== undefined))];
  const [ticketRows, ticketStatusLabels, serviceCallStatusLabels] = await Promise.all([
    ticketIds.length > 0 ? fetchByFieldIn(client.tickets, 'id', ticketIds) : [],
    getPicklistLabels(client.tickets, 'status'),
    getPicklistLabels(client.serviceCalls, 'status'),
  ]);
  const ticketsById = new Map(ticketRows.map((t) => [t.id, t]));

  let eligibleServiceCalls = serviceCalls;
  if (requireOpenTicket) {
    eligibleServiceCalls = serviceCalls.filter((sc) => {
      const ticketId = ticketIdByServiceCallId.get(sc.id);
      if (ticketId === undefined || ticketId === null) return false;
      const ticket = ticketsById.get(ticketId);
      return ticket !== undefined && !CLOSED_TICKET_STATUSES.includes(ticket.status);
    });
  }
  if (eligibleServiceCalls.length === 0) return [];

  const allScTicketIds = scTickets.map((t) => t.id);
  const resources = allScTicketIds.length > 0 ? await fetchByFieldIn(client.serviceCallTicketResources, 'serviceCallTicketID', allScTicketIds) : [];
  const resourceIdsByScTicketId = new Map();
  for (const r of resources) {
    if (!resourceIdsByScTicketId.has(r.serviceCallTicketID)) resourceIdsByScTicketId.set(r.serviceCallTicketID, new Set());
    resourceIdsByScTicketId.get(r.serviceCallTicketID).add(r.resourceID);
  }
  function resourceIdsFor(serviceCallId) {
    const scTicketIds = scTicketIdsByServiceCallId.get(serviceCallId) || [];
    const ids = new Set();
    for (const scTicketId of scTicketIds) {
      for (const rid of resourceIdsByScTicketId.get(scTicketId) || []) ids.add(rid);
    }
    return [...ids];
  }

  const uniqueCompanyIds = [...new Set(eligibleServiceCalls.map((sc) => sc.companyID).filter((id) => id !== null && id !== undefined))];
  const uniqueResourceIds = [...new Set(resources.map((r) => r.resourceID))];
  await Promise.all([
    mapWithConcurrency(uniqueCompanyIds, 3, (id) => resolveCompanyName(client, id)),
    mapWithConcurrency(uniqueResourceIds, 3, (id) => resolveResourceName(client, id)),
  ]);

  const rows = [];
  for (const sc of eligibleServiceCalls) {
    const resourceIds = resourceIdsFor(sc.id);
    const resourceNames = [];
    for (const rid of resourceIds) resourceNames.push(await resolveResourceName(client, rid));
    resourceNames.sort((a, b) => a.localeCompare(b));
    const ticketId = ticketIdByServiceCallId.get(sc.id) || null;
    const ticket = ticketId ? ticketsById.get(ticketId) : null;
    rows.push({
      id: sc.id,
      companyName: await resolveCompanyName(client, sc.companyID),
      description: sc.description || null,
      startDateTime: sc.startDateTime,
      // Not shown directly -- carried through only for the Change Date/Time
      // action's own pre-fill, same as What's On's identical row shape.
      endDateTime: sc.endDateTime,
      dayKey: isoDateAest(sc.startDateTime),
      allocated: resourceNames.length > 0,
      resourceNames,
      isComplete: !!sc.isComplete,
      ticketUrl: ticketId ? await getTicketUrl(ticketId) : null,
      ticketNumber: ticket ? ticket.ticketNumber : null,
      ticketTitle: ticket ? ticket.title : null,
      ticketStatus: ticket ? ticketStatusLabels.get(ticket.status) || `#${ticket.status}` : null,
      serviceCallStatus: serviceCallStatusLabels.get(sc.status) || `#${sc.status}`,
    });
  }
  return rows;
}

// Today's, tomorrow's, and Overdue's calls, fetched and shaped
// separately (not merged into one list the way What's On's identical
// today/tomorrow fetch does) -- this page renders them as genuinely
// separate tables (a chronological + a resource-grouped view per group),
// not one mixed list with a day tag telling them apart, so there's no
// reason to combine them here just to split them again client-side.
// Today and Tomorrow side by side with their own resource-grouped view,
// then Overdue with its own pair below that -- three day-scoped groups,
// by request.
//
// isComplete=false in every query, by request-equivalent reasoning to
// What's On's own identical filter -- an already-finished call isn't
// useful on a "what's on" board the way it still is on Service Calls' own
// full calendar. Today and Tomorrow both show every incomplete call
// regardless of ticket linkage/status (same as What's On's own today/
// tomorrow group). Overdue -- calls from before today, still not marked
// complete -- uses the SAME `requireOpenTicket: true` restriction What's
// On's own past-incomplete group uses, over the same 2-week window:
// confirmed against real data (see that page's own comment) that dropping
// this filter pulls in over a thousand ancient rows on tickets that
// closed ages ago, pure noise rather than anything actionable on a wall
// display.
async function fetchTodayTomorrowOverdue() {
  const client = await getClient();
  const today = todayAestKey();
  const [ty, tm, td] = today.split('-').map(Number);
  const todayStartISO = aestToUtcIso(ty, tm, td);
  const tomorrowStartISO = aestToUtcIso(ty, tm, td + 1);
  const dayAfterStartISO = aestToUtcIso(ty, tm, td + 2);
  const overduePastStartISO = aestToUtcIso(ty, tm, td - 14);

  const [todayCalls, tomorrowCalls, overdueCalls] = await Promise.all([
    listAll(client.serviceCalls, [
      { op: 'gte', field: 'startDateTime', value: todayStartISO },
      { op: 'lt', field: 'startDateTime', value: tomorrowStartISO },
      { op: 'eq', field: 'isComplete', value: false },
    ]),
    listAll(client.serviceCalls, [
      { op: 'gte', field: 'startDateTime', value: tomorrowStartISO },
      { op: 'lt', field: 'startDateTime', value: dayAfterStartISO },
      { op: 'eq', field: 'isComplete', value: false },
    ]),
    listAll(client.serviceCalls, [
      { op: 'gte', field: 'startDateTime', value: overduePastStartISO },
      { op: 'lt', field: 'startDateTime', value: todayStartISO },
      { op: 'eq', field: 'isComplete', value: false },
    ]),
  ]);

  const [todayRows, tomorrowRows, overdueRows] = await Promise.all([
    buildServiceCallRows(client, todayCalls),
    buildServiceCallRows(client, tomorrowCalls),
    buildServiceCallRows(client, overdueCalls, { requireOpenTicket: true }),
  ]);

  // Today/Tomorrow: chronological (by start time), same default order
  // Service Calls' own page and What's On both already use. Overdue:
  // latest first (reversed), by request-equivalent reasoning to What's
  // On's own identical ordering for its past-incomplete group -- the most
  // recently missed call surfaces at the top of its own table rather than
  // the bottom.
  todayRows.sort((a, b) => new Date(a.startDateTime) - new Date(b.startDateTime));
  tomorrowRows.sort((a, b) => new Date(a.startDateTime) - new Date(b.startDateTime));
  overdueRows.sort((a, b) => new Date(b.startDateTime) - new Date(a.startDateTime));

  return { today: todayRows, tomorrow: tomorrowRows, overdue: overdueRows };
}

// Short-lived cache, same reasoning Service Calls' own REPORT_CACHE_TTL_MS
// gives for its own 10-minute window -- a staffing gap fixed within the
// hour is exactly the kind of thing that should stop showing as
// unallocated promptly on a board meant to be glanced at through the day,
// not left stale for the default 20-minute window most other pages here
// use.
const CACHE_TTL_MS = 10 * 60 * 1000;
let cached = null; // { data, expiresAt }
let inFlight = null;

async function getTodayTomorrowOverdue(force) {
  if (!force && cached && Date.now() < cached.expiresAt) return cached.data;
  if (!inFlight) {
    inFlight = fetchTodayTomorrowOverdue()
      .then((data) => {
        cached = { data, expiresAt: Date.now() + CACHE_TTL_MS };
        return data;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const { today, tomorrow, overdue } = await getTodayTomorrowOverdue(req.query.force === 'true');
    res.json({ asOf: new Date().toISOString(), today, tomorrow, overdue });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
