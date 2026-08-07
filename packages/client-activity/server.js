const express = require('express');
const {
  getClient,
  listAll,
  fetchByFieldIn,
  getTicketUrl,
  getCompanyUrl,
  getPicklistLabels,
  matchesWildcard,
  resolveSingleCompany,
  last12MonthKeys,
  monthKeyOf,
  monthLabel,
  monthKeysWindow,
} = require('@dashboard/autotask-client');

// Statuses treated as "done" (closed for Currently Open / Completed purposes).
// Autotask's actual per-status "SLA Event" mapping (None/First Response/
// Resolution Plan/Resolved) isn't exposed anywhere in the REST API's field or
// picklist metadata -- confirmed by grepping the full Tickets
// entityInformation/fields response for "sla" and finding nothing -- so this
// is matched against status LABEL instead, by request, using the dashboard's
// standard wildcard convention (matchesWildcard()). A pattern with no `*`
// matches by substring, same as everywhere else this convention is used, so
// e.g. 'complete' would also catch a hypothetical future "Complete - Merged"
// status, not just the literal "Complete".
const DONE_STATUS_PATTERNS = [
  'complete',
  'fix*',
  'maybe done*',
  'needs*',
  'close if no reply',
  'shipping confirmation',
  'ready*',
  'billing - *',
  'rewst - stage done',
];
function computeDoneStatusIds(statusLabels) {
  const ids = new Set();
  for (const [code, label] of statusLabels) {
    if (DONE_STATUS_PATTERNS.some((pattern) => matchesWildcard(label, pattern))) ids.add(code);
  }
  return ids;
}

const router = express.Router();

router.get('/', async (req, res) => {
  const clientSearch = (req.query.client || '').trim();
  if (!clientSearch) {
    return res.status(400).json({ error: 'Query param "client" is required.' });
  }
  const companyId = req.query.companyId ? Number(req.query.companyId) : null;

  try {
    const client = await getClient();

    const resolved = await resolveSingleCompany(client, clientSearch, companyId);
    if (resolved.status !== 'ok') {
      return res.json({ client: clientSearch, ...resolved });
    }
    const company = resolved.company;

    const monthKeys = last12MonthKeys();
    const { windowStart, windowEnd } = monthKeysWindow(monthKeys);

    // Every ticket ever raised for this company, not just ones in the 12-month
    // window -- needed for two reasons besides the "created" count: (1) a
    // ticket opened long ago can still be sitting open today (the snapshot
    // below), and (2) it can have fresh TimeEntries logged against it this
    // month even though the ticket itself is old, so the full ticket-ID set is
    // what scopes the time-entry lookup. Excludes "Monitoring Alert" (issueType
    // 14), same convention as Completed Tickets / Tickets Created.
    const [allTickets, statusLabels, priorityLabels] = await Promise.all([
      listAll(client.tickets, [
        { op: 'eq', field: 'companyID', value: company.id },
        { op: 'noteq', field: 'issueType', value: 14 },
      ]),
      getPicklistLabels(client.tickets, 'status'),
      getPicklistLabels(client.tickets, 'priority'),
    ]);
    const doneStatusIds = computeDoneStatusIds(statusLabels);

    // Created / Completed per month. "Completed" date: status 5 ("Complete")
    // uses completedDate, since that's the one status Autotask actually
    // populates it for; every other done status falls back to resolvedDateTime
    // (same fallback Completed Tickets already uses for status 20, generalized
    // to the full done-status set).
    const createdByMonth = new Map(monthKeys.map((k) => [k, 0]));
    const completedByMonth = new Map(monthKeys.map((k) => [k, 0]));
    for (const t of allTickets) {
      if (t.createDate >= windowStart && t.createDate < windowEnd) {
        createdByMonth.set(monthKeyOf(t.createDate), createdByMonth.get(monthKeyOf(t.createDate)) + 1);
      }
      const completedDate = t.status === 5 ? t.completedDate : doneStatusIds.has(t.status) ? t.resolvedDateTime : null;
      if (completedDate && completedDate >= windowStart && completedDate < windowEnd) {
        const key = monthKeyOf(completedDate);
        if (completedByMonth.has(key)) completedByMonth.set(key, completedByMonth.get(key) + 1);
      }
    }
    const ticketMonths = monthKeys.map((key) => ({
      key,
      label: monthLabel(key),
      created: createdByMonth.get(key),
      completed: completedByMonth.get(key),
    }));

    // Currently-open snapshot (not date-scoped -- a ticket opened well outside
    // the 12-month window is still open today and belongs in this count).
    const openTickets = allTickets.filter((t) => !doneStatusIds.has(t.status));
    function countBy(items, labels, field, groupLabel) {
      const counts = new Map();
      for (const item of items) {
        let label = labels.get(item[field]) || `#${item[field]}`;
        if (groupLabel) label = groupLabel(label);
        counts.set(label, (counts.get(label) || 0) + 1);
      }
      return [...counts.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
    }
    // All "TO DO*" statuses (TO DO, TO DO - Configure, TO DO - Investigate, ...)
    // collapse into one "TO DO" row in the status breakdown -- by request, this
    // grouping is status-only, not applied to the priority breakdown.
    function groupToDoStatuses(label) {
      return matchesWildcard(label, 'to do*') ? 'TO DO' : label;
    }
    const openByStatus = countBy(openTickets, statusLabels, 'status', groupToDoStatuses);
    const openByPriority = countBy(openTickets, priorityLabels, 'priority');

    // Recent tickets: created within the window, newest first.
    const recentTickets = [];
    for (const t of allTickets) {
      if (!(t.createDate >= windowStart && t.createDate < windowEnd)) continue;
      recentTickets.push({
        id: t.id,
        ticketNumber: t.ticketNumber,
        ticketUrl: await getTicketUrl(t.id),
        title: t.title,
        status: statusLabels.get(t.status) || `#${t.status}`,
        done: doneStatusIds.has(t.status),
        priority: priorityLabels.get(t.priority) || `#${t.priority}`,
        createDate: t.createDate,
        // Time to close: from the (latest) Resolution Plan SLA event to the
        // Resolved SLA event -- both are direct Ticket fields holding the
        // actual timestamp each event fired, not a running history, so this is
        // already "the last one" by construction. Only set when both fired.
        resolutionPlanDateTime: t.resolutionPlanDateTime || null,
        resolvedDateTime: t.resolvedDateTime || null,
      });
    }
    recentTickets.sort((a, b) => new Date(b.createDate) - new Date(a.createDate));

    // Hours logged per month, billable vs non-billable, scoped to this
    // company's tickets (project/task time entries aren't covered -- see
    // README). TimeEntries has no companyID of its own, only ticketID/taskID,
    // so it's joined via the full ticket-ID set above.
    const ticketIds = allTickets.map((t) => t.id);
    const timeEntries = ticketIds.length > 0
      ? await fetchByFieldIn(client.timeEntries, 'ticketID', ticketIds, [
          { op: 'gte', field: 'dateWorked', value: windowStart },
          { op: 'lt', field: 'dateWorked', value: windowEnd },
        ])
      : [];
    const hoursByMonth = new Map(monthKeys.map((k) => [k, { billable: 0, nonBillable: 0 }]));
    for (const te of timeEntries) {
      const bucket = hoursByMonth.get(monthKeyOf(te.dateWorked));
      if (!bucket) continue; // shouldn't happen given the dateWorked filter, but safe
      if (te.isNonBillable) bucket.nonBillable += te.hoursWorked || 0;
      else bucket.billable += te.hoursWorked || 0;
    }
    const hourMonths = monthKeys.map((key) => {
      const h = hoursByMonth.get(key);
      return { key, label: monthLabel(key), billable: h.billable, nonBillable: h.nonBillable, total: h.billable + h.nonBillable };
    });
    const hourTotals = hourMonths.reduce(
      (acc, m) => ({ billable: acc.billable + m.billable, nonBillable: acc.nonBillable + m.nonBillable, total: acc.total + m.total }),
      { billable: 0, nonBillable: 0, total: 0 }
    );

    res.json({
      client: clientSearch,
      status: 'ok',
      companyId: company.id,
      companyName: company.companyName,
      companyUrl: await getCompanyUrl(company.id),
      ticketMonths,
      hourMonths,
      hourTotals,
      openByStatus,
      openByPriority,
      openTotal: openTickets.length,
      recentTickets,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
