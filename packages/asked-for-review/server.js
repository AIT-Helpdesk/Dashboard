const express = require('express');
const {
  getClient,
  mapWithConcurrency,
  resolveResourceName,
  resolveCompanyName,
  listAll,
  getTicketUrl,
  getTicketUdf,
  aestToUtcIso,
  WEEKDAY_LABELS,
  mondayOf,
  weekDatesFrom,
  isoDateAest,
  excludeMonitoringAlerts,
} = require('@dashboard/autotask-client');

// Same "completed" definition as Completed Tickets: status 5 (Complete) by
// `completedDate`, plus status 20 (Billing - Contract) by `resolvedDateTime`
// since that status never gets a `completedDate` set. Both queries scoped to
// the whole Monday-Sunday week in one shot rather than per-day, since a
// single ticket only needs classifying by day once the results are back.
// issueType 14 (Monitoring Alert) excluded client-side via
// excludeMonitoringAlerts(), not an Autotask query filter -- see that
// function's own comment for why (confirmed a real production bug: a
// `noteq` query filter silently drops every not-yet-triaged ticket too).
async function fetchTicketsCompletedInWeek(client, weekStartISO, weekEndISO) {
  const completed = await listAll(client.tickets, [
    { op: 'eq', field: 'status', value: 5 },
    { op: 'gte', field: 'completedDate', value: weekStartISO },
    { op: 'lt', field: 'completedDate', value: weekEndISO },
  ]);

  const billing = await listAll(client.tickets, [
    { op: 'eq', field: 'status', value: 20 },
    { op: 'gte', field: 'resolvedDateTime', value: weekStartISO },
    { op: 'lt', field: 'resolvedDateTime', value: weekEndISO },
  ]);

  return excludeMonitoringAlerts([...completed, ...billing]);
}

const router = express.Router();

router.get('/', async (req, res) => {
  const date = req.query.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Query param "date" is required in YYYY-MM-DD format.' });
  }

  try {
    const client = await getClient();

    const monday = mondayOf(date); // {year, month, day} -- AEST calendar Monday
    const weekStartISO = aestToUtcIso(monday.year, monday.month, monday.day);
    const weekEndISO = aestToUtcIso(monday.year, monday.month, monday.day + 7);

    // The 7 calendar dates (Monday..Sunday) this week covers -- drives both
    // the day buckets below and the day headings the client renders.
    const weekDates = weekDatesFrom(monday);

    const tickets = await fetchTicketsCompletedInWeek(client, weekStartISO, weekEndISO);

    // "Asked for Review" -- by request, only tickets where the "Ask For
    // Review" UDF is ASK, not every ticket completed this week.
    const asked = tickets.filter((t) => getTicketUdf(t, 'Ask For Review') === 'ASK');

    const uniqueResourceIDs = [...new Set(asked.map((t) => t.completedByResourceID).filter(Boolean))];
    const uniqueCompanyIDs = [...new Set(asked.map((t) => t.companyID).filter((id) => id !== null && id !== undefined))];
    await mapWithConcurrency(uniqueResourceIDs, 3, (id) => resolveResourceName(client, id));
    await mapWithConcurrency(uniqueCompanyIDs, 3, (id) => resolveCompanyName(client, id));

    const enriched = [];
    for (const t of asked) {
      const effectiveDate = t.completedDate || t.resolvedDateTime;
      enriched.push({
        id: t.id,
        ticketNumber: t.ticketNumber,
        ticketUrl: await getTicketUrl(t.id),
        title: t.title,
        // Status 20 = "Billing - Contract" (see fetchTicketsCompletedInWeek
        // above) -- flagged per-ticket, by request, so the client can call
        // it out visually against the more common status-5 "Complete" rows.
        billingContract: t.status === 20,
        company: await resolveCompanyName(client, t.companyID),
        completedBy: t.completedByResourceID ? await resolveResourceName(client, t.completedByResourceID) : 'Unassigned',
        completedDate: effectiveDate,
        dayKey: isoDateAest(effectiveDate),
      });
    }

    const days = weekDates.map((dayDate, i) => {
      const dayTickets = enriched
        .filter((t) => t.dayKey === dayDate)
        .sort((a, b) => a.company.localeCompare(b.company));
      return {
        date: dayDate,
        label: WEEKDAY_LABELS[i],
        tickets: dayTickets,
        count: dayTickets.length,
      };
    });

    res.json({
      date,
      weekStart: weekDates[0],
      weekEnd: weekDates[6],
      totalCount: enriched.length,
      days,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
