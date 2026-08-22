const express = require('express');
const { getClient, mapWithConcurrency, resolveCompanyName, listAll, getTicketUrl, aestDayBoundsIso, excludeMonitoringAlerts } = require('@dashboard/autotask-client');

async function fetchTicketsCreatedOn(client, dateStr) {
  // AEST calendar day, not UTC -- see aestDayBoundsIso() for why.
  const { startISO, endISO } = aestDayBoundsIso(dateStr);

  const tickets = await listAll(client.tickets, [
    { op: 'gte', field: 'createDate', value: startISO },
    { op: 'lt', field: 'createDate', value: endISO },
  ]);
  // "Monitoring Alert" (issueType 14) excluded client-side, not via an
  // Autotask query filter -- see excludeMonitoringAlerts()'s own comment
  // for why a `noteq` query filter silently drops every not-yet-triaged
  // ticket too (confirmed a real production bug on this exact page).
  return excludeMonitoringAlerts(tickets);
}

const router = express.Router();

router.get('/', async (req, res) => {
  const date = req.query.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Query param "date" is required in YYYY-MM-DD format.' });
  }

  try {
    const client = await getClient();
    const tickets = await fetchTicketsCreatedOn(client, date);

    const uniqueCompanyIDs = [...new Set(tickets.map((t) => t.companyID).filter((id) => id !== null && id !== undefined))];
    await mapWithConcurrency(uniqueCompanyIDs, 3, (id) => resolveCompanyName(client, id));

    const enriched = [];
    for (const t of tickets) {
      enriched.push({
        id: t.id,
        ticketNumber: t.ticketNumber,
        ticketUrl: await getTicketUrl(t.id),
        title: t.title,
        companyID: t.companyID,
        company: await resolveCompanyName(client, t.companyID),
        createDate: t.createDate,
        priority: t.priority,
        status: t.status,
      });
    }
    enriched.sort((a, b) => new Date(a.createDate) - new Date(b.createDate));

    const byCompanyMap = new Map();
    for (const t of enriched) {
      const key = t.companyID ?? 'unknown';
      if (!byCompanyMap.has(key)) {
        byCompanyMap.set(key, { companyId: t.companyID, companyName: t.company, tickets: [] });
      }
      byCompanyMap.get(key).tickets.push(t);
    }
    const byCompany = [...byCompanyMap.values()]
      .map((g) => ({ ...g, count: g.tickets.length }))
      .sort((a, b) => a.companyName.localeCompare(b.companyName));

    res.json({
      date,
      totalCount: enriched.length,
      byCompany,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;