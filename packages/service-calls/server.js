const express = require('express');
const {
  getClient,
  listAll,
  fetchByFieldIn,
  mapWithConcurrency,
  resolveCompanyName,
  resolveResourceName,
  resolveResourceIdByEmail,
  getTicketUrl,
  getPicklistLabels,
  aestToUtcIso,
  mondayOf,
  weekDatesFrom,
  isoDateAest,
  todayAestKey,
} = require('@dashboard/autotask-client');

// Autotask's ServiceCalls entity carries no resource field of its own --
// confirmed via field info (16 fields, none of them a resource). A resource
// is assigned per-TICKET-on-the-call, via ServiceCallTicketResources (keyed
// by serviceCallTicketID, the ServiceCallTickets join row's own id, not the
// service call or ticket id directly) -- a call with more than one ticket
// linked can have some tickets staffed and others not, and in principle
// different tickets on the same call could carry different resources.
// "Allocated" means at least one resource is assigned across ANY of a
// call's linked tickets; every distinct resource found across all of them
// is shown (confirmed against real data: 5 of 6 real August service calls
// had a resource on their one ticket link; the 6th -- created fresh, no
// resource added yet -- had none).
//
// A call's own `companyID`/`description`/`startDateTime`/`endDateTime` are
// used directly; there's no distinct "To Do" entity in Autotask's REST API
// to also include here (checked exhaustively -- see this page's README).
//
// Every non-cancelled/non-deleted service call starting in the month is
// included, regardless of completion state -- this is a full "what's
// scheduled" calendar, not just a staffing-gap finder, by request. Each row
// still carries its own `isComplete` so the client can hide completed calls
// by default ("Show Completed", off by default) without a refetch.
async function buildReport(monthKey, currentUserEmail) {
  const client = await getClient();
  const [y, m] = monthKey.split('-').map(Number);
  const monthStartISO = aestToUtcIso(y, m, 1);
  const monthEndISO = aestToUtcIso(y, m + 1, 1);

  const serviceCalls = await listAll(client.serviceCalls, [
    { op: 'gte', field: 'startDateTime', value: monthStartISO },
    { op: 'lt', field: 'startDateTime', value: monthEndISO },
  ]);

  const todayKey = todayAestKey();
  const gridDates = buildMonthGrid(monthKey);

  if (serviceCalls.length === 0) {
    return { month: monthKey, todayKey, gridDates, totalCount: 0, unallocatedCount: 0, byDay: {} };
  }

  const serviceCallIds = serviceCalls.map((sc) => sc.id);
  const scTickets = await fetchByFieldIn(client.serviceCallTickets, 'serviceCallID', serviceCallIds);

  const ticketIdsByServiceCallId = new Map(); // serviceCallId -> [ticketId, ...]
  const scTicketIdsByServiceCallId = new Map(); // serviceCallId -> [serviceCallTicket join row id, ...]
  for (const t of scTickets) {
    if (!ticketIdsByServiceCallId.has(t.serviceCallID)) ticketIdsByServiceCallId.set(t.serviceCallID, []);
    ticketIdsByServiceCallId.get(t.serviceCallID).push(t.ticketID);
    if (!scTicketIdsByServiceCallId.has(t.serviceCallID)) scTicketIdsByServiceCallId.set(t.serviceCallID, []);
    scTicketIdsByServiceCallId.get(t.serviceCallID).push(t.id);
  }

  const allScTicketIds = scTickets.map((t) => t.id);
  const resources = allScTicketIds.length > 0 ? await fetchByFieldIn(client.serviceCallTicketResources, 'serviceCallTicketID', allScTicketIds) : [];
  const resourceIdsByScTicketId = new Map(); // serviceCallTicket join row id -> Set<resourceId>
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

  const relatedTicketIds = [...new Set(serviceCalls.flatMap((sc) => ticketIdsByServiceCallId.get(sc.id) || []))];
  const [tickets, ticketStatusLabels, serviceCallStatusLabels] = await Promise.all([
    relatedTicketIds.length > 0 ? fetchByFieldIn(client.tickets, 'id', relatedTicketIds) : [],
    getPicklistLabels(client.tickets, 'status'),
    // ServiceCalls.status -- confirmed against the real, LIVE picklist
    // (fetched directly from Autotask's own entityInformation/fields, not
    // any external tool's cache, which was serving a stale 4-value list
    // during investigation): 1 New, 2 Complete, 101 Canceled, 102 Canceled
    // by Client, 103 Onsite Arranged, 104 Onsite TBA -- the last two added
    // to Autotask after this page was first built.
    getPicklistLabels(client.serviceCalls, 'status'),
  ]);
  const ticketById = new Map(tickets.map((t) => [t.id, t]));

  const uniqueCompanyIds = [...new Set(serviceCalls.map((sc) => sc.companyID).filter((id) => id !== null && id !== undefined))];
  const uniqueResourceIds = [...new Set(resources.map((r) => r.resourceID))];
  const [, , currentUserResourceId] = await Promise.all([
    mapWithConcurrency(uniqueCompanyIds, 3, (id) => resolveCompanyName(client, id)),
    mapWithConcurrency(uniqueResourceIds, 3, (id) => resolveResourceName(client, id)),
    // Resolved from the dashboard's own auth session (Entra email), not a
    // query param, so there's no way to spoof "mine" via the URL -- same
    // pattern Ticket Times uses for pinning the signed-in user's own group.
    resolveResourceIdByEmail(client, currentUserEmail),
  ]);

  const rows = [];
  let unallocatedCount = 0;
  for (const sc of serviceCalls) {
    const ticketIds = ticketIdsByServiceCallId.get(sc.id) || [];
    const relatedTickets = [];
    for (const tid of ticketIds) {
      const t = ticketById.get(tid);
      if (!t) continue;
      relatedTickets.push({
        id: t.id,
        ticketNumber: t.ticketNumber,
        title: t.title,
        status: ticketStatusLabels.get(t.status) || `#${t.status}`,
        ticketUrl: await getTicketUrl(t.id),
      });
    }
    const resourceIds = resourceIdsFor(sc.id);
    const resourceNames = [];
    for (const rid of resourceIds) resourceNames.push(await resolveResourceName(client, rid));
    resourceNames.sort((a, b) => a.localeCompare(b));
    if (resourceNames.length === 0) unallocatedCount++;

    rows.push({
      id: sc.id,
      companyId: sc.companyID,
      companyName: await resolveCompanyName(client, sc.companyID),
      description: sc.description || null,
      startDateTime: sc.startDateTime,
      endDateTime: sc.endDateTime,
      dayKey: isoDateAest(sc.startDateTime),
      allocated: resourceNames.length > 0,
      resourceNames,
      // Server always returns every call regardless of completion state --
      // "Show Completed" (default off) is a client-side filter over this
      // flag, same as "Show Unallocated Only" is over `allocated`, so
      // toggling either never needs a refetch.
      isComplete: !!sc.isComplete,
      // The call's own status label (New/Complete/Onsite Arranged/Onsite
      // TBA/etc, see the getPicklistLabels() call above) -- distinct from
      // `isComplete`/`allocated`, which drive the entry's background fill;
      // this drives a separate left-border accent for the "Onsite" statuses
      // specifically, by request.
      serviceCallStatus: serviceCallStatusLabels.get(sc.status) || `#${sc.status}`,
      // Whether the signed-in user is one of this call's assigned
      // resources -- drives a full-outline accent, distinct from the
      // Onsite-status left-border accent above, so the two can combine
      // (a call can be both "mine" and Onsite Arranged, e.g.).
      isMine: !!currentUserResourceId && resourceIds.includes(currentUserResourceId),
      tickets: relatedTickets,
    });
  }
  rows.sort((a, b) => new Date(a.startDateTime) - new Date(b.startDateTime));

  const byDay = {};
  for (const r of rows) {
    if (!byDay[r.dayKey]) byDay[r.dayKey] = [];
    byDay[r.dayKey].push(r);
  }

  return { month: monthKey, todayKey, gridDates, totalCount: rows.length, unallocatedCount, byDay };
}

// Full Monday-start weeks covering every day of the given month -- e.g.
// August 2026 (starts Saturday, ends Monday) needs the preceding Monday
// through the following Sunday, so the grid always renders complete weeks
// rather than a ragged first/last row. Returned as plain "YYYY-MM-DD"
// dates so client.js doesn't need to duplicate any AEST/calendar math --
// this is the one place gridDates gets computed.
function buildMonthGrid(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const firstOfMonth = `${monthKey}-01`;
  const lastOfMonth = `${monthKey}-${String(daysInMonth).padStart(2, '0')}`;
  const gridStart = mondayOf(firstOfMonth);
  const gridEndMonday = mondayOf(lastOfMonth);
  const startDate = new Date(Date.UTC(gridStart.year, gridStart.month - 1, gridStart.day));
  const endDate = new Date(Date.UTC(gridEndMonday.year, gridEndMonday.month - 1, gridEndMonday.day + 6));
  const totalDays = Math.round((endDate - startDate) / 86400000) + 1;
  return weekDatesFrom(gridStart, totalDays);
}

const REPORT_CACHE_TTL_MS = 10 * 60 * 1000; // shorter than most pages' 20 min -- staffing gaps are exactly the kind of thing that gets fixed within the hour, so a stale "still unallocated" is more actively misleading here than elsewhere
const reportCacheByKey = new Map(); // "monthKey|email" -> { data, expiresAt }
const inFlightByKey = new Map();

// Cache key includes the signed-in user's email, not just the month -- each
// row's `isMine` flag depends on who's asking, so caching by month alone
// would leak one user's "mine" highlighting into another user's view of the
// same month.
async function getReport(monthKey, currentUserEmail, force) {
  const key = `${monthKey}|${(currentUserEmail || '').toLowerCase()}`;
  const cached = reportCacheByKey.get(key);
  if (!force && cached && Date.now() < cached.expiresAt) return cached.data;
  if (!inFlightByKey.has(key)) {
    const build = buildReport(monthKey, currentUserEmail)
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
  const month = req.query.month;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'Query param "month" is required in YYYY-MM format.' });
  }
  try {
    const data = await getReport(month, req.session?.user?.email, req.query.force === 'true');
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
