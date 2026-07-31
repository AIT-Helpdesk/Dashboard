const express = require('express');
const { getClient, mapWithConcurrency, resolveResourceName, resolveCompanyName } = require('@dashboard/autotask-client');

async function fetchTicketsCompletedOn(client, dateStr) {
  const startISO = `${dateStr}T00:00:00.000Z`;
  const endDate = new Date(`${dateStr}T00:00:00.000Z`);
  endDate.setUTCDate(endDate.getUTCDate() + 1);
  const endISO = endDate.toISOString();

  const all = [];
  const pageSize = 500;
  // Safety cap: a single client site won't plausibly complete more than 10k tickets in a day.
  for (let page = 1; page <= 20; page++) {
    const result = await client.tickets.list({
      filter: [
        { op: 'eq', field: 'status', value: 5 },
        { op: 'gte', field: 'completedDate', value: startISO },
        { op: 'lt', field: 'completedDate', value: endISO },
        // issueType 14 = "Monitoring Alert" -- excluded from the dashboard by request.
        { op: 'noteq', field: 'issueType', value: 14 },
      ],
      page,
      pageSize,
    });

    const batch = result.data || [];
    all.push(...batch);
    if (batch.length < pageSize) break;
  }
  return all;
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

    const enriched = [];
    for (const t of tickets) {
      enriched.push({
        id: t.id,
        ticketNumber: t.ticketNumber,
        title: t.title,
        companyID: t.companyID,
        company: await resolveCompanyName(client, t.companyID),
        completedByResourceID: t.completedByResourceID || null,
        completedBy: t.completedByResourceID ? await resolveResourceName(client, t.completedByResourceID) : 'Unassigned',
        completedDate: t.completedDate,
        priority: t.priority,
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
      .map((g) => ({ ...g, count: g.tickets.length }))
      .sort((a, b) => b.count - a.count);

    res.json({
      date,
      totalCount: enriched.length,
      byResource,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;