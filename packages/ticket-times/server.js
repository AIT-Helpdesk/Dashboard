const express = require('express');
const {
  getClient,
  mapWithConcurrency,
  resolveResourceName,
  resolveCompanyName,
  listAll,
  fetchByFieldIn,
  getTicketUrl,
} = require('@dashboard/autotask-client');

// TimeEntries.dateWorked is a date-only field -- Autotask always stores it as
// midnight UTC of the calendar date the technician logged against (confirmed
// against real data), not a real instant. Unlike completedDate/createDate
// elsewhere on this dashboard, it needs no AEST offset conversion: an exact
// match against midnight UTC of the selected date IS the selected day,
// because that's the same calendar date the technician's own (AEST) clock
// showed when they entered it.
async function fetchTimeEntriesOn(client, dateStr) {
  return listAll(client.timeEntries, [
    { op: 'eq', field: 'dateWorked', value: `${dateStr}T00:00:00.000Z` },
    // Time can also be logged against Tasks (project work) with no ticketID
    // at all -- this page is ticket time only, so those are excluded.
    { op: 'exist', field: 'ticketID' },
  ]);
}

const router = express.Router();

router.get('/', async (req, res) => {
  const date = req.query.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Query param "date" is required in YYYY-MM-DD format.' });
  }

  try {
    const client = await getClient();
    const entries = await fetchTimeEntriesOn(client, date);

    if (entries.length === 0) {
      return res.json({ date, totalCount: 0, totalHoursWorked: 0, byResource: [] });
    }

    const ticketIds = [...new Set(entries.map((e) => e.ticketID))];
    const tickets = await fetchByFieldIn(client.tickets, 'id', ticketIds);
    const ticketsById = new Map(tickets.map((t) => [t.id, t]));

    const uniqueResourceIDs = [...new Set(entries.map((e) => e.resourceID).filter(Boolean))];
    const uniqueCompanyIDs = [...new Set(tickets.map((t) => t.companyID).filter((id) => id !== null && id !== undefined))];
    await mapWithConcurrency(uniqueResourceIDs, 3, (id) => resolveResourceName(client, id));
    await mapWithConcurrency(uniqueCompanyIDs, 3, (id) => resolveCompanyName(client, id));

    // The same ticket can carry entries from more than one technician (or
    // more than one entry from the same technician) on the same day -- sum
    // hours per technician+ticket pair, not per entry, so each technician's
    // row shows only their own hours on that ticket for THIS day, never
    // someone else's hours or the ticket's all-time total.
    const rowsByKey = new Map();
    for (const e of entries) {
      const ticket = ticketsById.get(e.ticketID);
      if (!ticket) continue; // ticket deleted/inaccessible since the entry was logged -- skip rather than crash
      const key = `${e.resourceID || 'unassigned'}:${e.ticketID}`;
      if (!rowsByKey.has(key)) {
        rowsByKey.set(key, { ticketId: e.ticketID, resourceId: e.resourceID || null, hoursWorked: 0 });
      }
      rowsByKey.get(key).hoursWorked += e.hoursWorked || 0;
    }

    const rows = [];
    for (const r of rowsByKey.values()) {
      const ticket = ticketsById.get(r.ticketId);
      rows.push({
        id: ticket.id,
        ticketNumber: ticket.ticketNumber,
        ticketUrl: await getTicketUrl(ticket.id),
        title: ticket.title,
        companyID: ticket.companyID,
        company: await resolveCompanyName(client, ticket.companyID),
        resourceId: r.resourceId,
        resourceName: r.resourceId ? await resolveResourceName(client, r.resourceId) : 'Unassigned',
        hoursWorked: r.hoursWorked,
      });
    }

    const byResourceMap = new Map();
    for (const r of rows) {
      const key = r.resourceId || 'unassigned';
      if (!byResourceMap.has(key)) {
        byResourceMap.set(key, { resourceId: r.resourceId, resourceName: r.resourceName, tickets: [] });
      }
      byResourceMap.get(key).tickets.push(r);
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
      totalCount: new Set(rows.map((r) => r.id)).size,
      totalHoursWorked: rows.reduce((sum, r) => sum + r.hoursWorked, 0),
      byResource,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
