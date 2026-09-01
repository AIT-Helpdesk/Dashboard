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

// A real, generally-available page -- just the one widget by request,
// copied out of the experimental Ticket Dashboards (Test) page
// (packages/ticket-dashboards-test), which stays as-is (still
// restrictedTo one account while the rest of it is being tried out).

// "P1 - CRITICAL" -- confirmed live against Tickets' own priority picklist
// (value 4). Same confirmed value Ticket Dashboards (Test) already uses
// for its own identical widget -- see that page's own server.js for the
// two real "critical" values this account has (this priority vs. status
// 58, "License Update (CRITICAL)", a narrow license-renewal workflow
// status, not general urgency) and why priority is the right one.
const CRITICAL_PRIORITY_VALUE = 4;

// "Open" here is simply "has no completedDate yet" -- same definition (and
// same caveat -- a status-20 "Billing - Contract" ticket sitting in
// billing still counts as open, slightly overstating the count relative
// to Completed Tickets' own stricter definition) as Ticket Dashboards
// (Test) uses for its own openTickets.
async function fetchOpenTickets(client) {
  const tickets = await listAll(client.tickets, [{ op: 'notExist', field: 'completedDate' }]);
  return excludeMonitoringAlerts(tickets);
}

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const client = await getClient();
    const openTickets = await fetchOpenTickets(client);
    const criticalTickets = openTickets.filter((t) => t.priority === CRITICAL_PRIORITY_VALUE);

    // Pre-resolves each unique client/resource name once, concurrently --
    // same "warm the cache before the per-row loop" pattern Service Calls'
    // own server.js already uses -- rather than however many duplicate
    // lookups a client/resource with more than one critical ticket open
    // would otherwise cause (resolveCompanyName()/resolveResourceName()
    // both cache internally, so this is the only real network cost
    // either way, just batched instead of serial).
    const uniqueCompanyIds = [...new Set(criticalTickets.map((t) => t.companyID).filter((cid) => cid !== null && cid !== undefined))];
    const uniqueResourceIds = [...new Set(criticalTickets.map((t) => t.assignedResourceID).filter((rid) => rid !== null && rid !== undefined))];
    const [statusLabels] = await Promise.all([
      getPicklistLabels(client.tickets, 'status'),
      mapWithConcurrency(uniqueCompanyIds, 3, (cid) => resolveCompanyName(client, cid)),
      mapWithConcurrency(uniqueResourceIds, 3, (rid) => resolveResourceName(client, rid)),
    ]);

    const criticalTicketRows = await Promise.all(
      criticalTickets.map(async (t) => ({
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
    criticalTicketRows.sort((a, b) => (a.ticketNumber || '').localeCompare(b.ticketNumber || ''));

    res.json({
      generatedAt: new Date().toISOString(),
      criticalOpenCount: criticalTickets.length,
      criticalTickets: criticalTicketRows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
