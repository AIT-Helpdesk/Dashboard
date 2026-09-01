const express = require('express');
const {
  getClient,
  listAll,
  getPicklistLabels,
  excludeMonitoringAlerts,
  aestDayBoundsIso,
  todayAestKey,
  isoDateAest,
  resolveCompanyName,
  resolveResourceName,
  getTicketUrl,
  mapWithConcurrency,
} = require('@dashboard/autotask-client');

// Experimental first cut at pulling Autotask "dashboard"-style metrics into
// this app -- Autotask itself has no API for the actual visual Dashboard
// widgets you see logged into their web UI (those aren't exposed over the
// REST API at all), so this reconstructs the closest useful equivalent from
// the same live Tickets data every other page here already reads: how many
// tickets are open right now (broken down by status/queue/priority), plus a
// created-vs-closed trend. See this package's own README for why access is
// currently restricted to one account (packages/shell/server.js's
// restrictedTo mechanism) while this is being tried out.

const TREND_WINDOW_DAYS = 30;

// "P1 - CRITICAL" -- confirmed live against Tickets' own priority picklist
// (value 4). Two real values matched "critical" on this account (the other
// being status 58, "License Update (CRITICAL)", a narrow license-renewal
// workflow status, not a general urgency marker) -- confirmed with Amber
// this widget means priority, matching every other breakdown on this page
// (byPriority) and the normal MSP sense of "critical tickets".
const CRITICAL_PRIORITY_VALUE = 4;

// "Open" here is simply "has no completedDate yet" -- the same field Autotask
// itself sets on the 5 ("Complete") transition. NOT the same definition
// Completed Tickets uses for the mirror case (which also treats status 20,
// "Billing - Contract", as done via resolvedDateTime, since those tickets
// never get a completedDate at all -- see that page's own server.js). Kept
// deliberately simple for this first test cut: a status-20 ticket sitting in
// billing still counts as "open" here, which slightly overstates the open
// count relative to Completed Tickets' stricter definition. Worth tightening
// if this page graduates past "test".
async function fetchOpenTickets(client) {
  const tickets = await listAll(client.tickets, [{ op: 'notExist', field: 'completedDate' }]);
  return excludeMonitoringAlerts(tickets);
}

// Groups a ticket list by one picklist field, resolving each code to its real
// label via the field's own live metadata (not a hardcoded map -- see
// getPicklistLabels()'s own comment for why: these are genuine Autotask
// picklists, not fixed enums this app owns). Sorted busiest-first.
function groupCounts(tickets, field, labels) {
  const counts = new Map();
  for (const t of tickets) {
    const key = t[field] ?? null;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({
      value,
      label: value === null ? 'Unassigned' : labels.get(value) || `#${value}`,
      count,
    }))
    .sort((a, b) => b.count - a.count);
}

// `days` consecutive AEST calendar dates ("YYYY-MM-DD"), ending with today --
// pure calendar arithmetic (Date.UTC as a neutral calculator), same pattern
// as @dashboard/autotask-client's own weekDatesFrom().
function lastNDaysAest(n) {
  const [y, m, d] = todayAestKey().split('-').map(Number);
  return Array.from({ length: n }, (_, i) => {
    const dt = new Date(Date.UTC(y, m - 1, d - (n - 1 - i)));
    return dt.toISOString().slice(0, 10);
  });
}

function shortDateLabel(dateStr) {
  return new Date(`${dateStr}T00:00:00.000Z`).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    timeZone: 'Australia/Brisbane',
  });
}

// Created-vs-closed counts for each of the last TREND_WINDOW_DAYS AEST days.
// Fetched as two broad range queries (one for createDate, one -- in two parts,
// same status-5-vs-status-20 split Completed Tickets uses -- for the closed
// side) and bucketed into days client-side, rather than 30 separate per-day
// queries -- the same "fetch the whole window once, bucket locally" shape
// last12MonthKeys()/monthKeysWindow() already use elsewhere on this
// dashboard.
async function fetchTrend(client) {
  const days = lastNDaysAest(TREND_WINDOW_DAYS);
  const { startISO } = aestDayBoundsIso(days[0]);
  const { endISO } = aestDayBoundsIso(days[days.length - 1]);

  const created = excludeMonitoringAlerts(
    await listAll(client.tickets, [
      { op: 'gte', field: 'createDate', value: startISO },
      { op: 'lt', field: 'createDate', value: endISO },
    ])
  );
  const completedStatus5 = await listAll(client.tickets, [
    { op: 'eq', field: 'status', value: 5 },
    { op: 'gte', field: 'completedDate', value: startISO },
    { op: 'lt', field: 'completedDate', value: endISO },
  ]);
  const completedBilling = await listAll(client.tickets, [
    { op: 'eq', field: 'status', value: 20 },
    { op: 'gte', field: 'resolvedDateTime', value: startISO },
    { op: 'lt', field: 'resolvedDateTime', value: endISO },
  ]);
  const closed = excludeMonitoringAlerts([...completedStatus5, ...completedBilling]);

  const byDay = new Map(days.map((d) => [d, { date: d, label: shortDateLabel(d), created: 0, closed: 0 }]));
  for (const t of created) {
    const bucket = byDay.get(isoDateAest(t.createDate));
    if (bucket) bucket.created += 1;
  }
  for (const t of closed) {
    const bucket = byDay.get(isoDateAest(t.completedDate || t.resolvedDateTime));
    if (bucket) bucket.closed += 1;
  }

  const trend = [...byDay.values()];
  return {
    days: trend,
    totalCreated: trend.reduce((sum, d) => sum + d.created, 0),
    totalClosed: trend.reduce((sum, d) => sum + d.closed, 0),
  };
}

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const client = await getClient();

    // Phased rather than all fired via one big Promise.all -- confirmed the
    // hard way that 5 concurrent top-level queries (open tickets + 3
    // picklist lookups + the trend fetch, which itself issues further
    // requests) bursts past Autotask's ~5 req/s rate limit and comes back as
    // a real 429. 3 concurrent (the picklist lookups) matches Ticket Times'
    // own already-proven-safe precedent; open tickets and the trend fetch
    // each run alone, before and after.
    const openTickets = await fetchOpenTickets(client);
    const [statusLabels, queueLabels, priorityLabels] = await Promise.all([
      getPicklistLabels(client.tickets, 'status'),
      getPicklistLabels(client.tickets, 'queueID'),
      getPicklistLabels(client.tickets, 'priority'),
    ]);
    const trend = await fetchTrend(client);

    const criticalTickets = openTickets.filter((t) => t.priority === CRITICAL_PRIORITY_VALUE);
    // Pre-resolves each unique client/resource name once, concurrently --
    // same "warm the cache before the per-row loop" pattern this file's
    // own resolveCompanyName() calls elsewhere already use. statusLabels
    // is the SAME picklist already fetched above for byStatus -- no
    // second fetch needed.
    const uniqueCriticalCompanyIds = [...new Set(criticalTickets.map((t) => t.companyID).filter((cid) => cid !== null && cid !== undefined))];
    const uniqueCriticalResourceIds = [...new Set(criticalTickets.map((t) => t.assignedResourceID).filter((rid) => rid !== null && rid !== undefined))];
    await Promise.all([
      mapWithConcurrency(uniqueCriticalCompanyIds, 3, (cid) => resolveCompanyName(client, cid)),
      mapWithConcurrency(uniqueCriticalResourceIds, 3, (rid) => resolveResourceName(client, rid)),
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
      openCount: openTickets.length,
      criticalOpenCount: criticalTickets.length,
      criticalTickets: criticalTicketRows,
      byStatus: groupCounts(openTickets, 'status', statusLabels),
      byQueue: groupCounts(openTickets, 'queueID', queueLabels),
      byPriority: groupCounts(openTickets, 'priority', priorityLabels),
      trend,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
