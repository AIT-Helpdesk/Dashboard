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

// "!! TO BE SCHEDULED" -- confirmed live against the same priority
// picklist as CRITICAL_PRIORITY_VALUE above (a fresh GET against Tickets'
// own priority field, not guessed/reused from anywhere else -- this
// account's picklist has several superficially similar values, e.g. "P3 -
// SCHEDULED" (7) and plain "Scheduled" (6), neither of which is this one).
const TRIAGE_PRIORITY_VALUE = 12;

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
    const [criticalTickets, triageTickets] = await Promise.all([
      fetchOpenTicketsByPriority(client, CRITICAL_PRIORITY_VALUE),
      fetchOpenTicketsByPriority(client, TRIAGE_PRIORITY_VALUE),
    ]);

    // Pre-resolves each unique client/resource name once, concurrently,
    // across BOTH widgets' tickets combined -- same "warm the cache
    // before the per-row loop" pattern Service Calls' own server.js
    // already uses -- rather than however many duplicate lookups a
    // client/resource appearing on more than one ticket (in either or
    // both lists) would otherwise cause.
    const allTickets = [...criticalTickets, ...triageTickets];
    const uniqueCompanyIds = [...new Set(allTickets.map((t) => t.companyID).filter((cid) => cid !== null && cid !== undefined))];
    const uniqueResourceIds = [...new Set(allTickets.map((t) => t.assignedResourceID).filter((rid) => rid !== null && rid !== undefined))];
    const [statusLabels] = await Promise.all([
      getPicklistLabels(client.tickets, 'status'),
      mapWithConcurrency(uniqueCompanyIds, 3, (cid) => resolveCompanyName(client, cid)),
      mapWithConcurrency(uniqueResourceIds, 3, (rid) => resolveResourceName(client, rid)),
    ]);

    const [criticalTicketRows, triageTicketRows] = await Promise.all([
      shapeTicketRows(client, criticalTickets, statusLabels),
      shapeTicketRows(client, triageTickets, statusLabels),
    ]);

    res.json({
      generatedAt: new Date().toISOString(),
      criticalOpenCount: criticalTickets.length,
      criticalTickets: criticalTicketRows,
      triageOpenCount: triageTickets.length,
      triageTickets: triageTicketRows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
