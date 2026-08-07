const express = require('express');
const {
  getClient,
  mapWithConcurrency,
  resolveResourceName,
  resolveCompanyName,
  listAll,
  getTicketUrl,
  getTicketUdf,
} = require('@dashboard/autotask-client');

const WEEKDAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// The Monday (UTC midnight) of the calendar week containing `dateStr` --
// getUTCDay() is Sunday=0..Saturday=6, so `(day + 6) % 7` is how many days
// back from `dateStr` Monday falls (0 when `dateStr` already is a Monday).
function mondayOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d;
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// Same "completed" definition as Completed Tickets: status 5 (Complete) by
// `completedDate`, plus status 20 (Billing - Contract) by `resolvedDateTime`
// since that status never gets a `completedDate` set. Both queries scoped to
// the whole Monday-Sunday week in one shot rather than per-day, since a
// single ticket only needs classifying by day once the results are back.
async function fetchTicketsCompletedInWeek(client, weekStartISO, weekEndISO) {
  const completed = await listAll(client.tickets, [
    { op: 'eq', field: 'status', value: 5 },
    { op: 'gte', field: 'completedDate', value: weekStartISO },
    { op: 'lt', field: 'completedDate', value: weekEndISO },
    { op: 'noteq', field: 'issueType', value: 14 },
  ]);

  const billing = await listAll(client.tickets, [
    { op: 'eq', field: 'status', value: 20 },
    { op: 'gte', field: 'resolvedDateTime', value: weekStartISO },
    { op: 'lt', field: 'resolvedDateTime', value: weekEndISO },
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

    const monday = mondayOf(date);
    const weekStartISO = monday.toISOString();
    const weekEndDate = new Date(monday);
    weekEndDate.setUTCDate(weekEndDate.getUTCDate() + 7);
    const weekEndISO = weekEndDate.toISOString();

    // The 7 calendar dates (Monday..Sunday) this week covers -- drives both
    // the day buckets below and the day headings the client renders.
    const weekDates = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday);
      d.setUTCDate(d.getUTCDate() + i);
      return isoDate(d);
    });

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
        company: await resolveCompanyName(client, t.companyID),
        completedBy: t.completedByResourceID ? await resolveResourceName(client, t.completedByResourceID) : 'Unassigned',
        completedDate: effectiveDate,
        dayKey: isoDate(new Date(effectiveDate)),
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
