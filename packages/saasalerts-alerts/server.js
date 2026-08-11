const express = require('express');
const { get } = require('@dashboard/saasalerts-client');
const {
  getCompanyUrl,
  matchesWildcard,
  aestToUtcIso,
  mondayOf,
  weekDatesFrom,
  isoDateAest,
  WEEKDAY_LABELS,
} = require('@dashboard/autotask-client');

// Confirmed against the real API: alertStatus is `low` for the overwhelming
// majority of events (routine sign-ins etc. -- 92,705 of 92,849 events in a
// single 24h test window, 99.8%). This page is a genuine ALERTS feed, not a
// raw activity log, so it's scoped to medium+critical by design, with no
// toggle to include low -- showing low-severity noise would defeat the
// point. The API's alertStatus filter takes exactly one value per request
// (confirmed, same constraint Ingram's `status` filter has), so this is two
// requests merged, not one.
const SEVERITIES = ['critical', 'medium'];

// SaaS Alerts customers' Autotask company mapping, cached the same way and
// TTL as the SaaS Alerts Customers page -- fetched independently here rather
// than shared, since this page only needs the id -> Autotask URL lookup, not
// the full customer record set that page displays.
const MAPPING_CACHE_TTL_MS = 20 * 60 * 1000;
let mappingCache = null; // { data: Map<customerId, url>, expiresAt }
let mappingInFlight = null;

async function getAutotaskUrlByCustomerId() {
  if (mappingCache && Date.now() < mappingCache.expiresAt) return mappingCache.data;
  if (!mappingInFlight) {
    mappingInFlight = (async () => {
      const customers = await get('/reports/customers');
      const map = new Map();
      for (const c of customers) {
        const mapping = (c.mappedToPSA || []).find((m) => m.product === 'autotaskpsa');
        if (mapping) map.set(c.id, await getCompanyUrl(mapping.mappedTo));
      }
      mappingCache = { data: map, expiresAt: Date.now() + MAPPING_CACHE_TTL_MS };
      return map;
    })().finally(() => {
      mappingInFlight = null;
    });
  }
  return mappingInFlight;
}

// 4 weeks total, by request: the selected date's own Monday-Sunday week,
// plus the 3 weeks before it.
const CHART_WEEKS = 4;

// Confirmed against the real API: the `size` param has an undocumented hard
// ceiling somewhere between 10,000 and 12,000 -- exceeding it doesn't error
// or clamp, it silently returns ZERO results (discovered the hard way: a
// `size: 15000` request for a real 28-day range with a genuine 7,400 events
// came back completely empty). Staying safely under that ceiling matters
// more than fetching in one shot, so `size` is derived per request from the
// cheap, uncapped /reports/events/count endpoint rather than guessed at a
// fixed number -- see fetchAlertsInRange() below.
const SIZE_CAP = 10000;

// The whole CHART_WEEKS-week range in one pair of (count + list) requests
// per severity, not one pair per day or per week -- this both powers the
// chart AND supplies the selected day's own detail rows (filtered back out
// of the same fetch below). Sized exactly to each severity's real count
// (capped at SIZE_CAP, see above) rather than a fixed guess -- if the real
// count ever exceeds SIZE_CAP, that's logged rather than silently
// truncated/broken.
async function fetchAlertsInRange(rangeStartISO, rangeEndISO) {
  const bySeverity = await Promise.all(
    SEVERITIES.map(async (alertStatus) => {
      const { total } = await get('/reports/events/count', { start: rangeStartISO, end: rangeEndISO, alertStatus });
      if (total === 0) return [];
      if (total > SIZE_CAP) console.warn(`SaaS Alerts: ${alertStatus} events for this date range (${total}) exceed the safe ${SIZE_CAP}-row fetch ceiling -- results will be truncated.`);
      const size = Math.min(total, SIZE_CAP);
      return get('/reports/events', { start: rangeStartISO, end: rangeEndISO, alertStatus, size, timeSort: 'desc' });
    })
  );
  return bySeverity.flat();
}

async function buildReport(dateStr, filterTerm) {
  const currentMonday = mondayOf(dateStr); // {year, month, day} -- AEST calendar Monday of the SELECTED week
  // The Monday (CHART_WEEKS - 1) full weeks before currentMonday -- since
  // currentMonday is already a Monday, subtracting a multiple of 7 calendar
  // days lands exactly on an earlier Monday, no need to re-run mondayOf() on it.
  const chartStartCalendar = new Date(Date.UTC(currentMonday.year, currentMonday.month - 1, currentMonday.day - (CHART_WEEKS - 1) * 7));
  const chartStartMonday = {
    year: chartStartCalendar.getUTCFullYear(),
    month: chartStartCalendar.getUTCMonth() + 1,
    day: chartStartCalendar.getUTCDate(),
  };

  const rangeStartISO = aestToUtcIso(chartStartMonday.year, chartStartMonday.month, chartStartMonday.day);
  const rangeEndISO = aestToUtcIso(currentMonday.year, currentMonday.month, currentMonday.day + 7); // end of the SELECTED week
  const chartDates = weekDatesFrom(chartStartMonday, CHART_WEEKS * 7); // CHART_WEEKS consecutive Mon..Sun weeks, oldest first

  const [events, autotaskUrlByCustomerId] = await Promise.all([fetchAlertsInRange(rangeStartISO, rangeEndISO), getAutotaskUrlByCustomerId()]);

  // The client-name filter (when given) narrows BOTH the chart and the
  // detail table to that client -- applied once here, before either is
  // built, so the two always agree with each other.
  const enriched = [];
  for (const e of events) {
    const customerName = e.customer?.name || 'Unknown';
    if (filterTerm && !matchesWildcard(customerName, filterTerm)) continue;
    if (!e.time) continue; // no timestamp to bucket into a day -- shouldn't happen, but don't crash on it
    const ticket = (e.psaTicket || []).find((t) => t.type === 'autotaskpsa' && t.link);
    enriched.push({
      time: e.time,
      dayKey: isoDateAest(e.time),
      severity: e.alertStatus || null,
      event: e.jointDesc || e.jointType || 'Event',
      detail: e.jointDescAdditional || null,
      user: e.user?.fullName || e.user?.name || null,
      customerId: e.customer?.id || null,
      customerName,
      autotaskUrl: e.customer?.id ? autotaskUrlByCustomerId.get(e.customer.id) || null : null,
      ticketNumber: ticket ? ticket.ticketNumber : null,
      ticketUrl: ticket ? ticket.link : null,
    });
  }

  // One bucket per day across both weeks, critical/medium counted separately
  // so the chart can show the severity split, not just a combined total.
  // WEEKDAY_LABELS[i % 7] cycles Monday..Sunday once per week across the
  // CHART_WEEKS * 7 entries.
  const chart = chartDates.map((d, i) => {
    const dayEvents = enriched.filter((e) => e.dayKey === d);
    const critical = dayEvents.filter((e) => e.severity === 'critical').length;
    const medium = dayEvents.filter((e) => e.severity === 'medium').length;
    return { date: d, label: WEEKDAY_LABELS[i % 7], critical, medium, total: critical + medium };
  });

  const rows = enriched.filter((e) => e.dayKey === dateStr).sort((a, b) => (b.time || '').localeCompare(a.time || ''));

  return {
    date: dateStr,
    chartStart: chartDates[0],
    chartEnd: chartDates[chartDates.length - 1],
    currentWeekStart: chartDates[(CHART_WEEKS - 1) * 7], // where the SELECTED week begins within the chart -- lets the client accent that one boundary specifically, distinct from the other (earlier) week boundaries
    filterTerm: filterTerm || null,
    totalCount: rows.length,
    rows,
    chart,
  };
}

const router = express.Router();

router.get('/', async (req, res) => {
  const date = req.query.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Query param "date" is required in YYYY-MM-DD format.' });
  }
  try {
    const data = await buildReport(date, req.query.client);
    res.json(data);
  } catch (err) {
    console.error(err);
    const detail = err.response ? `SaaS Alerts API returned HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    res.status(500).json({ error: detail });
  }
});

module.exports = router;
