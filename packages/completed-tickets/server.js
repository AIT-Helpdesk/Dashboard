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
  excludeMonitoringAlerts,
  fetchRoleHourlyRates,
  fetchWorkTypeModifiers,
  fetchBillingItemsByTimeEntryId,
  resolveChargeableValue,
  fetchServiceDeskAndProfessionalServicesMembership,
} = require('@dashboard/autotask-client');

// Same real confirmed prefix @dashboard/times' own Billable $ box (and
// @dashboard/ticket-times) use to single out T&M TC Elite* contracts --
// duplicated here rather than imported, same "separate page package"
// convention every other small shared constant on this dashboard already
// follows. Originally split the page-level total into "To Invoice"/"TC
// Elite" (by request: "Separate this total into 2 amounts. - To Invoice:
// $value (TC Elite: $value) ... The TC Elite total is for where the
// Contract associated with the ticket is 'T&M TC Elite*' and all others
// sum up in the To Invoice $$. Do the same with Completed Tickets
// page."), then "To Invoice" was itself split further into Posted/Pending
// (by request: "break up To Invoice into Posted and Pending ... Leave
// the TC Elite $$ as the one figure").
const TM_TC_ELITE_PREFIX = 'T&M TC Elite';

// From/To + quick-date buttons, by request ("use the From and To date
// style selectors and the 6 buttons like on the Time Summaries Page on
// the Completed Tickets and Ticket Times Pages. Both should default to
// Today") -- replaces the original single-date picker. `fromKey`/`toKey`
// are both inclusive (the UI's own From/To fields); the real query
// window is [start of fromKey's AEST day, start of the AEST day AFTER
// toKey) -- aestDayBoundsIso() on each end gives exactly those two real
// instants without needing a separate "add a day" helper here.
async function fetchTicketsCompletedInRange(client, fromKey, toKey) {
  const { startISO } = aestDayBoundsIso(fromKey);
  const { endISO } = aestDayBoundsIso(toKey);

  // status 5 = "Complete", filtered by completedDate as usual.
  const completed = await listAll(client.tickets, [
    { op: 'eq', field: 'status', value: 5 },
    { op: 'gte', field: 'completedDate', value: startISO },
    { op: 'lt', field: 'completedDate', value: endISO },
  ]);

  // status 20 = "Billing - Contract" -- included as completed by request, but these
  // tickets never get a completedDate set (Autotask only populates that on the
  // transition to status 5). resolvedDateTime is the closest equivalent: when the
  // work was actually finished, before the ticket got routed to billing.
  const billing = await listAll(client.tickets, [
    { op: 'eq', field: 'status', value: 20 },
    { op: 'gte', field: 'resolvedDateTime', value: startISO },
    { op: 'lt', field: 'resolvedDateTime', value: endISO },
  ]);

  // "Monitoring Alert" (issueType 14) excluded client-side, not via an
  // Autotask query filter -- see excludeMonitoringAlerts()'s own comment
  // (@dashboard/autotask-client) for why a `noteq` query filter silently
  // drops every not-yet-triaged ticket too (confirmed a real production bug).
  return excludeMonitoringAlerts([...completed, ...billing]);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const router = express.Router();

router.get('/', async (req, res) => {
  const from = req.query.from;
  const to = req.query.to;
  if (!from || !DATE_RE.test(from)) return res.status(400).json({ error: 'Query param "from" is required in YYYY-MM-DD format.' });
  if (!to || !DATE_RE.test(to)) return res.status(400).json({ error: 'Query param "to" is required in YYYY-MM-DD format.' });
  if (to < from) return res.status(400).json({ error: '"to" must not be before "from".' });

  try {
    const client = await getClient();
    const [rawTickets, { leadership }] = await Promise.all([fetchTicketsCompletedInRange(client, from, to), fetchServiceDeskAndProfessionalServicesMembership(client)]);

    // Leadership Team omitted entirely, by request -- same convention
    // @dashboard/ticket-times already established. Unlike that page (which
    // drops individual TimeEntries rows, since a ticket there can carry
    // several technicians' own entries), this page's own unit is one
    // ticket credited to exactly one completedByResourceID, so the whole
    // ticket row is dropped here rather than a partial entry within it.
    const tickets = rawTickets.filter((t) => !leadership.has(t.completedByResourceID));

    const uniqueResourceIDs = [...new Set(tickets.map((t) => t.completedByResourceID).filter(Boolean))];
    const uniqueCompanyIDs = [...new Set(tickets.map((t) => t.companyID).filter((id) => id !== null && id !== undefined))];

    await mapWithConcurrency(uniqueResourceIDs, 3, (id) => resolveResourceName(client, id));
    await mapWithConcurrency(uniqueCompanyIDs, 3, (id) => resolveCompanyName(client, id));

    const ticketsById = new Map(tickets.map((t) => [t.id, t]));

    // Contract name per ticket -- moved up ahead of the TimeEntries loop
    // below so isTcEliteTicket() is available while accumulating the
    // page-level Posted/Pending/TC Elite split (not shown per-row/table,
    // only used for that one top-of-page split).
    const contractIds = [...new Set(tickets.map((t) => t.contractID).filter(Boolean))];
    const contracts = contractIds.length > 0 ? await fetchByFieldIn(client.contracts, 'id', contractIds) : [];
    const contractNameById = new Map(contracts.map((c) => [c.id, c.contractName]));
    function isTcEliteTicket(ticket) {
      const contractName = ticket.contractID ? contractNameById.get(ticket.contractID) : null;
      return Boolean(contractName && contractName.startsWith(TM_TC_ELITE_PREFIX));
    }

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

    // Chargeable $ value of a ticket, by request ("use these data sources
    // and formulas for 'awaiting approve and post', posted and invoiced to
    // show the dollar value of the times shown (only for the specific
    // person, not the whole ticket)"). Unlike hoursByTicketId above (a
    // deliberately ticket-wide total across EVERY technician who ever
    // logged time on it, see that map's own comment), this is scoped to
    // just the entries belonging to the one resource each row is actually
    // grouped/credited to -- completedByResourceID -- keyed
    // "ticketID:resourceID" so a ticket with time from several technicians
    // never mixes their $ together under whichever one happened to
    // complete it. See @dashboard/autotask-client's own
    // resolveChargeableValue() for the real, 100%-verified formula.
    const [roleRatesById, billingItemByTeId] = await Promise.all([
      fetchRoleHourlyRates(client),
      fetchBillingItemsByTimeEntryId(
        client,
        timeEntries.map((te) => te.id)
      ),
    ]);
    const workTypeModifiersById = await fetchWorkTypeModifiers(
      client,
      timeEntries.map((te) => te.billingCodeID)
    );
    // Page-level Invoiced/Posted/Pending/TC Elite totals accumulated in
    // this same pass (one resolveChargeableValue() call per entry, not a
    // second one later), by request -- went through a couple of
    // revisions: first "To Invoice"/"TC Elite" (2 figures), then "break
    // up To Invoice into Posted and Pending" (Posted meaning NOT yet
    // invoiced), then clarified the other way ("Posted to include
    // Invoiced and Posted"), then finally settled as all 4 kept separate:
    // "Let's have Invoiced, Posted, Pending and TC Elite." Invoiced =
    // state 'invoiced'. Posted = has a real BillingItems row but hasn't
    // reached an invoice yet (state 'posted' or 'posted-non-billable' --
    // the latter always $0 anyway). Pending = has NOT gone through
    // Approve and Post at all yet (state 'awaiting'), a computed estimate
    // rather than a real posted dollar figure. Scoped to just the
    // completing resource's own entries, same "only for the specific
    // person" rule this page's own per-ticket `dollars` already follows
    // -- a colleague's own time on the same ticket doesn't count toward
    // the page-level split either.
    const dollarsByTicketAndResource = new Map();
    let totalInvoicedDollars = 0;
    let totalPostedDollars = 0;
    let totalPendingDollars = 0;
    let totalTcEliteDollars = 0;
    for (const te of timeEntries) {
      const key = `${te.ticketID}:${te.resourceID}`;
      const { state, value } = resolveChargeableValue(te, billingItemByTeId, roleRatesById, workTypeModifiersById);
      const v = value || 0;
      dollarsByTicketAndResource.set(key, (dollarsByTicketAndResource.get(key) || 0) + v);

      const ticket = ticketsById.get(te.ticketID);
      if (!ticket || te.resourceID !== ticket.completedByResourceID) continue;
      if (isTcEliteTicket(ticket)) {
        totalTcEliteDollars += v;
      } else if (state === 'invoiced') {
        totalInvoicedDollars += v;
      } else if (state === 'awaiting') {
        totalPendingDollars += v;
      } else {
        // 'posted' or 'posted-non-billable'.
        totalPostedDollars += v;
      }
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
        dollars: dollarsByTicketAndResource.get(`${t.id}:${t.completedByResourceID}`) || 0,
        isTcElite: isTcEliteTicket(t),
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
        dollars: g.tickets.reduce((sum, t) => sum + t.dollars, 0),
        tickets: [...g.tickets].sort((a, b) => a.company.localeCompare(b.company)),
      }))
      .sort((a, b) => b.count - a.count);

    // Invoiced/Posted/Pending/TC Elite already accumulated above, per
    // entry, in the same pass that built dollarsByTicketAndResource --
    // see that loop's own comment.
    res.json({
      from,
      to,
      totalCount: enriched.length,
      totalHoursWorked: enriched.reduce((sum, t) => sum + t.hoursWorked, 0),
      totalDollars: enriched.reduce((sum, t) => sum + t.dollars, 0),
      totalInvoicedDollars,
      totalPostedDollars,
      totalPendingDollars,
      totalTcEliteDollars,
      byResource,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;