const express = require('express');
const {
  getClient,
  listAll,
  excludeMonitoringAlerts,
  resolveCompanyName,
  resolveResourceName,
  getPicklistLabels,
  getTicketUrl,
  mapWithConcurrency,
  aestDayBoundsIso,
  todayAestKey,
} = require('@dashboard/autotask-client');

// A real, generally-available page -- started as just the one widget (see
// TRIAGE_PRIORITY_VALUE's own comment below for the second one added
// since), copied out of the experimental Ticket Dashboards (Test) page
// (packages/ticket-dashboards-test), which stays as-is (still
// restrictedTo one account while the rest of it is being tried out).

// "P1 - CRITICAL" -- confirmed live against Tickets' own priority picklist
// (value 4). Same confirmed value Ticket Dashboards (Test) already uses
// for its own identical widget -- see that page's own server.js for the
// two real "critical" values this account has (this priority vs. status
// 58, "License Update (CRITICAL)", a narrow license-renewal workflow
// status, not general urgency) and why priority is the right one.
const CRITICAL_PRIORITY_VALUE = 4;

// "!! SET PRIORITY" -- confirmed live against the same priority picklist
// as CRITICAL_PRIORITY_VALUE above (a fresh GET against Tickets' own
// priority field, not guessed/reused from anywhere else -- this account's
// picklist has several superficially similar values, e.g. "!! TO BE
// SCHEDULED" (12, this widget's original value, by request changed to this
// one instead), "P3 - SCHEDULED" (7), and plain "Scheduled" (6), none of
// which is this one).
const TRIAGE_PRIORITY_VALUE = 2;

// "!! TO BE SCHEDULED" -- confirmed live against the same priority picklist,
// by request ("Scheduled Me" widget).
const TO_BE_SCHEDULED_PRIORITY_VALUE = 12;

// "P1 - CANNOT BE MOVED" -- confirmed live, and already the real value this
// tenant's own Strety automation uses for its "EOD - TODAY Jobs Missed"
// metric (packages/strety-autotask-sync/metrics.js), by request ("DO TODAY"
// widget).
const P1_CANNOT_BE_MOVED_PRIORITY_VALUE = 10;

// "Customer Note Added" -- confirmed live against Tickets' own status
// picklist, by request ("Client Updates" widget).
const CUSTOMER_NOTE_ADDED_STATUS_VALUE = 19;

// "Open" here is simply "has no completedDate yet" -- same definition (and
// same caveat -- a status-20 "Billing - Contract" ticket sitting in
// billing still counts as open, slightly overstating the count relative
// to Completed Tickets' own stricter definition) as Ticket Dashboards
// (Test) uses for its own openTickets.
//
// Filtered by priority IN THE QUERY ITSELF, not fetched-then-filtered --
// unlike Ticket Dashboards (Test)'s own copy of this function, this page
// has no OTHER widget that needs the full open-ticket set (this is a
// single-widget page, see this file's own top comment), so there's no
// reason to pull every open ticket (hundreds, account-wide) across the
// wire just to keep a handful of critical ones. Confirmed the hard way
// this genuinely mattered, not just tidiness -- during a Rotate cycle,
// the shell preloads the next page and gives it a fixed buffer
// (ROTATE_PRELOAD_BUFFER_MS in app.js) to finish its own refresh before
// swapping it in; fetching the full open-ticket list routinely ran past
// that buffer, so this page would show its previous (stale) data for a
// moment after switching to it instead of the freshly-loaded one. This
// is still functionally identical to the old fetch-all-then-filter --
// excludeMonitoringAlerts() is a per-ticket filter, indifferent to
// whether it's handed 400 tickets or 15.
// Shared by both this page's widgets (Critical (P1) and Triage Now,
// below) -- same query shape, just a different priority value each time.
async function fetchOpenTicketsByPriority(client, priorityValue) {
  const tickets = await listAll(client.tickets, [
    { op: 'notExist', field: 'completedDate' },
    { op: 'eq', field: 'priority', value: priorityValue },
  ]);
  return excludeMonitoringAlerts(tickets);
}

// Open tickets with the given status (e.g. "Customer Note Added"), by
// request ("Client Updates" widget) -- same open/exclude-Monitoring-Alerts
// shape as fetchOpenTicketsByPriority() above, just filtered by status
// instead of priority.
async function fetchOpenTicketsByStatus(client, statusValue) {
  const tickets = await listAll(client.tickets, [
    { op: 'notExist', field: 'completedDate' },
    { op: 'eq', field: 'status', value: statusValue },
  ]);
  return excludeMonitoringAlerts(tickets);
}

// "Due today or earlier" -- a CALENDAR-DATE comparison, not a moment-in-time
// one (due anytime today still counts, regardless of what time it is right
// now) -- same AEST-anchored boundary (and the same confirmed-working `lt`
// operator against AEST midnight TOMORROW, rather than an untested `lte`)
// packages/strety-autotask-sync/metrics.js's own tomorrowAestMidnightUtcIso()
// already uses for its "EOD - TODAY Jobs Missed"/"EOD - Urgent/Deadlines"
// metrics -- reusing the shared aestDayBoundsIso()/todayAestKey() helpers
// here instead of a second copy of that bespoke function.
function tomorrowAestMidnightUtcIso() {
  return aestDayBoundsIso(todayAestKey()).endISO;
}

// "DO TODAY" -- open tickets (no completedDate) with priority "P1 - CANNOT
// BE MOVED", due today or earlier, by request. Monitoring Alerts
// deliberately INCLUDED, not excluded -- same real call this dashboard's own
// Strety automation already made for the identical "EOD - TODAY Jobs Missed"
// metric ("an automated alert that's been escalated to this priority is
// exactly as urgent as a human-raised one").
async function fetchDoTodayTickets(client) {
  return listAll(client.tickets, [
    { op: 'notExist', field: 'completedDate' },
    { op: 'eq', field: 'priority', value: P1_CANNOT_BE_MOVED_PRIORITY_VALUE },
    { op: 'lt', field: 'dueDateTime', value: tomorrowAestMidnightUtcIso() },
  ]);
}

// "Overdue tickets" banner -- a COUNT only, by request ("a red banner... with
// a count but not a widget"), same real definition this dashboard's own
// Strety automation already uses for its "EOD - Tickets Overdue" metric:
// open, excluding Monitoring Alerts, excluding priority "!! SET PRIORITY"/
// "!! TO BE SCHEDULED" (those two already have their own dedicated
// triage/scheduling widgets -- an overdue ticket already called out there
// shouldn't ALSO inflate this banner), due date strictly in the past (a
// moment-in-time comparison -- unlike "DO TODAY" above, "overdue" means the
// due time itself has already passed, not just "due today").
async function fetchOverdueCount(client) {
  const nowIso = new Date().toISOString();
  const tickets = await listAll(client.tickets, [
    { op: 'notExist', field: 'completedDate' },
    { op: 'lt', field: 'dueDateTime', value: nowIso },
  ]);
  return excludeMonitoringAlerts(tickets).filter(
    (t) => ![TRIAGE_PRIORITY_VALUE, TO_BE_SCHEDULED_PRIORITY_VALUE].includes(t.priority)
  ).length;
}

const router = express.Router();

// Shapes one priority-group's raw tickets into the plain row shape both
// widgets' own tables need -- status/client/resource names all resolved
// from the SAME pre-warmed caches (resolveCompanyName()/
// resolveResourceName() both cache internally; see the batched
// mapWithConcurrency() calls below that warm them ONCE across BOTH
// groups combined, not once per widget) so a client/resource appearing in
// both the Critical and Triage Now lists is still only ever looked up
// once.
async function shapeTicketRows(client, tickets, statusLabels) {
  const rows = await Promise.all(
    tickets.map(async (t) => ({
      id: t.id,
      status: statusLabels.get(t.status) || `#${t.status}`,
      ticketNumber: t.ticketNumber,
      // Shown under the Ticket # in small grey text, by request -- real
      // Autotask field, same one Tickets Created Today already uses for
      // its own time-of-creation column.
      createDate: t.createDate,
      title: t.title,
      clientName: await resolveCompanyName(client, t.companyID),
      // "Unassigned", not blank -- same convention Completed Tickets'
      // own equivalent resource column already uses for a null resource.
      resourceName: t.assignedResourceID ? await resolveResourceName(client, t.assignedResourceID) : 'Unassigned',
      ticketUrl: await getTicketUrl(t.id),
    }))
  );
  rows.sort((a, b) => (a.ticketNumber || '').localeCompare(b.ticketNumber || ''));
  return rows;
}

router.get('/', async (req, res) => {
  try {
    const client = await getClient();
    // Throttled via mapWithConcurrency (same ~5 req/s rate-limit reasoning
    // as its own comment up in autotask-client/index.js), NOT a flat
    // Promise.all -- firing all 6 of these as independent concurrent
    // POST /query calls the instant the page loads tripped Autotask's
    // rate limit (observed live: every request came back 429) once a
    // third widget row was added on top of the original two.
    const [criticalTickets, triageTickets, doTodayTickets, scheduledMeTickets, clientUpdatesTickets, overdueCount] = await mapWithConcurrency(
      [
        () => fetchOpenTicketsByPriority(client, CRITICAL_PRIORITY_VALUE),
        () => fetchOpenTicketsByPriority(client, TRIAGE_PRIORITY_VALUE),
        () => fetchDoTodayTickets(client),
        () => fetchOpenTicketsByPriority(client, TO_BE_SCHEDULED_PRIORITY_VALUE),
        () => fetchOpenTicketsByStatus(client, CUSTOMER_NOTE_ADDED_STATUS_VALUE),
        () => fetchOverdueCount(client),
      ],
      3,
      (fn) => fn()
    );

    // Pre-resolves each unique client/resource name once, concurrently,
    // across ALL FIVE widgets' tickets combined -- same "warm the cache
    // before the per-row loop" pattern Service Calls' own server.js
    // already uses -- rather than however many duplicate lookups a
    // client/resource appearing on more than one ticket (in any of the
    // lists) would otherwise cause.
    const allTickets = [...criticalTickets, ...triageTickets, ...doTodayTickets, ...scheduledMeTickets, ...clientUpdatesTickets];
    const uniqueCompanyIds = [...new Set(allTickets.map((t) => t.companyID).filter((cid) => cid !== null && cid !== undefined))];
    const uniqueResourceIds = [...new Set(allTickets.map((t) => t.assignedResourceID).filter((rid) => rid !== null && rid !== undefined))];
    // Sequential, not a Promise.all of all three -- now that there are 5
    // widgets' worth of unique companies/resources to resolve instead of
    // 2, running the picklist fetch and both already-throttled
    // mapWithConcurrency(..., 3, ...) passes AT THE SAME TIME could put up
    // to 7 requests in flight together, over Autotask's ~5 req/s limit
    // (same 429 cause as the ticket-group fetches above). Each pass alone
    // still stays within its own concurrency-3 cap.
    const statusLabels = await getPicklistLabels(client.tickets, 'status');
    await mapWithConcurrency(uniqueCompanyIds, 3, (cid) => resolveCompanyName(client, cid));
    await mapWithConcurrency(uniqueResourceIds, 3, (rid) => resolveResourceName(client, rid));

    const [criticalTicketRows, triageTicketRows, doTodayTicketRows, scheduledMeTicketRows, clientUpdatesTicketRows] = await Promise.all([
      shapeTicketRows(client, criticalTickets, statusLabels),
      shapeTicketRows(client, triageTickets, statusLabels),
      shapeTicketRows(client, doTodayTickets, statusLabels),
      shapeTicketRows(client, scheduledMeTickets, statusLabels),
      shapeTicketRows(client, clientUpdatesTickets, statusLabels),
    ]);

    res.json({
      generatedAt: new Date().toISOString(),
      criticalOpenCount: criticalTickets.length,
      criticalTickets: criticalTicketRows,
      triageOpenCount: triageTickets.length,
      triageTickets: triageTicketRows,
      doTodayOpenCount: doTodayTickets.length,
      doTodayTickets: doTodayTicketRows,
      scheduledMeOpenCount: scheduledMeTickets.length,
      scheduledMeTickets: scheduledMeTicketRows,
      clientUpdatesOpenCount: clientUpdatesTickets.length,
      clientUpdatesTickets: clientUpdatesTicketRows,
      overdueCount,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
