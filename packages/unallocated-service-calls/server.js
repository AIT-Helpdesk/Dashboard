const express = require('express');
const {
  getClient,
  listAll,
  fetchByFieldIn,
  mapWithConcurrency,
  resolveCompanyName,
  getTicketUrl,
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
// linked can have some tickets staffed and others not. "Unallocated" here
// means NONE of a call's linked tickets have any resource assigned at all
// (confirmed against real data: 5 of 6 real August service calls had a
// resource on their one ticket link; the 6th -- created fresh, no resource
// added yet -- had none, and is exactly the kind of gap this page exists to
// surface).
//
// A call's own `companyID`/`description`/`startDateTime`/`endDateTime` are
// used directly; there's no distinct "To Do" entity in Autotask's REST API
// to also include here (checked exhaustively -- see this page's README).
async function buildReport(monthKey) {
  const client = await getClient();
  const [y, m] = monthKey.split('-').map(Number);
  const monthStartISO = aestToUtcIso(y, m, 1);
  const monthEndISO = aestToUtcIso(y, m + 1, 1);

  // isComplete=false -- a completed service call has nothing left to staff,
  // so it's not a real "unallocated" gap regardless of whether a resource
  // was ever assigned. Scoped to calls STARTING in the selected month (a
  // calendar's natural placement -- a call is shown on the day it begins),
  // not calls merely overlapping it.
  const serviceCalls = await listAll(client.serviceCalls, [
    { op: 'gte', field: 'startDateTime', value: monthStartISO },
    { op: 'lt', field: 'startDateTime', value: monthEndISO },
    { op: 'eq', field: 'isComplete', value: false },
  ]);

  const todayKey = todayAestKey();
  const gridDates = buildMonthGrid(monthKey);

  if (serviceCalls.length === 0) {
    return { month: monthKey, todayKey, gridDates, totalCount: 0, byDay: {} };
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
  const allocatedScTicketIds = new Set(resources.map((r) => r.serviceCallTicketID));

  function isAllocated(serviceCallId) {
    const scTicketIds = scTicketIdsByServiceCallId.get(serviceCallId) || [];
    // A call with NO linked ticket at all can never have a resource (the
    // only resource-assignment path requires a ServiceCallTickets row), so
    // it counts as unallocated too, same as one whose ticket(s) have zero
    // resources.
    return scTicketIds.some((id) => allocatedScTicketIds.has(id));
  }

  const unallocated = serviceCalls.filter((sc) => !isAllocated(sc.id));

  const relatedTicketIds = [...new Set(unallocated.flatMap((sc) => ticketIdsByServiceCallId.get(sc.id) || []))];
  const tickets = relatedTicketIds.length > 0 ? await fetchByFieldIn(client.tickets, 'id', relatedTicketIds) : [];
  const ticketById = new Map(tickets.map((t) => [t.id, t]));

  const uniqueCompanyIds = [...new Set(unallocated.map((sc) => sc.companyID).filter((id) => id !== null && id !== undefined))];
  await mapWithConcurrency(uniqueCompanyIds, 3, (id) => resolveCompanyName(client, id));

  const rows = [];
  for (const sc of unallocated) {
    const ticketIds = ticketIdsByServiceCallId.get(sc.id) || [];
    const relatedTickets = [];
    for (const tid of ticketIds) {
      const t = ticketById.get(tid);
      if (!t) continue;
      relatedTickets.push({ id: t.id, ticketNumber: t.ticketNumber, title: t.title, ticketUrl: await getTicketUrl(t.id) });
    }
    rows.push({
      id: sc.id,
      companyId: sc.companyID,
      companyName: await resolveCompanyName(client, sc.companyID),
      description: sc.description || null,
      startDateTime: sc.startDateTime,
      endDateTime: sc.endDateTime,
      dayKey: isoDateAest(sc.startDateTime),
      tickets: relatedTickets,
    });
  }
  rows.sort((a, b) => new Date(a.startDateTime) - new Date(b.startDateTime));

  const byDay = {};
  for (const r of rows) {
    if (!byDay[r.dayKey]) byDay[r.dayKey] = [];
    byDay[r.dayKey].push(r);
  }

  return { month: monthKey, todayKey, gridDates, totalCount: rows.length, byDay };
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
const reportCacheByMonth = new Map(); // monthKey -> { data, expiresAt }
const inFlightByMonth = new Map();

async function getReport(monthKey, force) {
  const cached = reportCacheByMonth.get(monthKey);
  if (!force && cached && Date.now() < cached.expiresAt) return cached.data;
  if (!inFlightByMonth.has(monthKey)) {
    const build = buildReport(monthKey)
      .then((data) => {
        reportCacheByMonth.set(monthKey, { data, expiresAt: Date.now() + REPORT_CACHE_TTL_MS });
        return data;
      })
      .finally(() => {
        inFlightByMonth.delete(monthKey);
      });
    inFlightByMonth.set(monthKey, build);
  }
  return inFlightByMonth.get(monthKey);
}

const router = express.Router();

router.get('/', async (req, res) => {
  const month = req.query.month;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'Query param "month" is required in YYYY-MM format.' });
  }
  try {
    const data = await getReport(month, req.query.force === 'true');
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
