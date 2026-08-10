const express = require('express');
const {
  getClient,
  mapWithConcurrency,
  resolveResourceName,
  resolveCompanyName,
  listAll,
  fetchByFieldIn,
  getTicketUrl,
  getTicketUdf,
  aestDayBoundsIso,
} = require('@dashboard/autotask-client');

async function fetchTicketsCompletedOn(client, dateStr) {
  // AEST calendar day, not UTC -- see aestDayBoundsIso() for why.
  const { startISO, endISO } = aestDayBoundsIso(dateStr);

  // status 5 = "Complete", filtered by completedDate as usual.
  const completed = await listAll(client.tickets, [
    { op: 'eq', field: 'status', value: 5 },
    { op: 'gte', field: 'completedDate', value: startISO },
    { op: 'lt', field: 'completedDate', value: endISO },
    // issueType 14 = "Monitoring Alert" -- excluded from the dashboard by request.
    { op: 'noteq', field: 'issueType', value: 14 },
  ]);

  // status 20 = "Billing - Contract" -- included as completed by request, but these
  // tickets never get a completedDate set (Autotask only populates that on the
  // transition to status 5). resolvedDateTime is the closest equivalent: when the
  // work was actually finished, before the ticket got routed to billing.
  const billing = await listAll(client.tickets, [
    { op: 'eq', field: 'status', value: 20 },
    { op: 'gte', field: 'resolvedDateTime', value: startISO },
    { op: 'lt', field: 'resolvedDateTime', value: endISO },
    { op: 'noteq', field: 'issueType', value: 14 },
  ]);

  return [...completed, ...billing];
}

const router = express.Router();

router.get('/', async (req, res) => {
  const date = req.query.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Query param "date" is required in YYYY-MM-DD format.' });
  }

  try {
    const client = await getClient();
    const tickets = await fetchTicketsCompletedOn(client, date);

    const uniqueResourceIDs = [...new Set(tickets.map((t) => t.completedByResourceID).filter(Boolean))];
    const uniqueCompanyIDs = [...new Set(tickets.map((t) => t.companyID).filter((id) => id !== null && id !== undefined))];

    await mapWithConcurrency(uniqueResourceIDs, 3, (id) => resolveResourceName(client, id));
    await mapWithConcurrency(uniqueCompanyIDs, 3, (id) => resolveCompanyName(client, id));

    // Hours logged against these specific tickets -- ALL of their time entries,
    // not just ones dated on the ticket's completion day (a ticket completed
    // today can easily carry time logged on earlier days too, and that work
    // still counts toward "how many hours did this ticket take"). Grouped by
    // ticket ID so each row/group below can total just its own tickets.
    const ticketIds = tickets.map((t) => t.id);
    const timeEntries = ticketIds.length > 0
      ? await fetchByFieldIn(client.timeEntries, 'ticketID', ticketIds)
      : [];
    const hoursByTicketId = new Map();
    for (const te of timeEntries) {
      hoursByTicketId.set(te.ticketID, (hoursByTicketId.get(te.ticketID) || 0) + (te.hoursWorked || 0));
    }

    const enriched = [];
    for (const t of tickets) {
      enriched.push({
        id: t.id,
        ticketNumber: t.ticketNumber,
        ticketUrl: await getTicketUrl(t.id),
        title: t.title,
        companyID: t.companyID,
        company: await resolveCompanyName(client, t.companyID),
        completedByResourceID: t.completedByResourceID || null,
        completedBy: t.completedByResourceID ? await resolveResourceName(client, t.completedByResourceID) : 'Unassigned',
        completedDate: t.completedDate || t.resolvedDateTime,
        priority: t.priority,
        askForReview: getTicketUdf(t, 'Ask For Review'),
        hoursWorked: hoursByTicketId.get(t.id) || 0,
      });
    }

    const byResourceMap = new Map();
    for (const t of enriched) {
      const key = t.completedByResourceID || 'unassigned';
      if (!byResourceMap.has(key)) {
        byResourceMap.set(key, { resourceId: t.completedByResourceID, resourceName: t.completedBy, tickets: [] });
      }
      byResourceMap.get(key).tickets.push(t);
    }
    const byResource = [...byResourceMap.values()]
      .map((g) => ({
        ...g,
        count: g.tickets.length,
        hoursWorked: g.tickets.reduce((sum, t) => sum + t.hoursWorked, 0),
        tickets: [...g.tickets].sort((a, b) => a.company.localeCompare(b.company)),
      }))
      .sort((a, b) => b.count - a.count);

    res.json({
      date,
      totalCount: enriched.length,
      totalHoursWorked: enriched.reduce((sum, t) => sum + t.hoursWorked, 0),
      byResource,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;