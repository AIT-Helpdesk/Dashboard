const express = require('express');
const {
  getClient,
  mapWithConcurrency,
  resolveResourceName,
  resolveCompanyName,
  listAll,
  getTicketUrl,
  getTicketUdf,
  toAest,
  aestToUtcIso,
} = require('@dashboard/autotask-client');

const WEEKDAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// The Monday (as {year, month, day} AEST calendar fields) of the week
// containing `dateStr`. Day-of-week is pure calendar arithmetic -- it
// doesn't depend on time zone as long as the computation itself doesn't
// cross a day boundary, so Date.UTC() is used here purely as a neutral
// calendar calculator, not to mean "UTC" in the AEST-vs-UTC sense; the
// AEST-specific part only starts once this calendar day gets converted to
// a real UTC instant for querying, via aestToUtcIso() below. getUTCDay() is
// Sunday=0..Saturday=6, so `(day + 6) % 7` is how many days back from
// `dateStr` Monday falls (0 when `dateStr` already is a Monday).
function mondayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const asCalendar = new Date(Date.UTC(y, m - 1, d));
  const back = (asCalendar.getUTCDay() + 6) % 7;
  asCalendar.setUTCDate(asCalendar.getUTCDate() - back);
  return { year: asCalendar.getUTCFullYear(), month: asCalendar.getUTCMonth() + 1, day: asCalendar.getUTCDate() };
}

// "YYYY-MM-DD" for a real timestamp, in AEST -- e.g. bucketing a ticket's
// actual completedDate into the AEST day it was completed on, not the UTC day.
function isoDateAest(instant) {
  return toAest(instant).toISOString().slice(0, 10);
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

    const monday = mondayOf(date); // {year, month, day} -- AEST calendar Monday
    const weekStartISO = aestToUtcIso(monday.year, monday.month, monday.day);
    const weekEndISO = aestToUtcIso(monday.year, monday.month, monday.day + 7);

    // The 7 calendar dates (Monday..Sunday) this week covers -- drives both
    // the day buckets below and the day headings the client renders. Pure
    // calendar arithmetic again (see mondayOf()'s comment), so Date.UTC() as
    // a neutral calculator is fine here too.
    const weekDates = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(Date.UTC(monday.year, monday.month - 1, monday.day + i));
      return d.toISOString().slice(0, 10);
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
